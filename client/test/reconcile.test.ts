import { describe, it, expect } from "vitest";
import { decide, sameIgnoringEol, isConnectionError, reconcileAll, reconcileDelta, reconcileLocalConfig, reconcilePath, switchTo, resolveConfigConflict, ReconcileDeps, DeleteRateGuard, MAX_BASE_TEXT_BYTES, MAX_PULL_RETRIES } from "../src/reconcile";
import { BaseStore, conflictCopyName, originalOfConflictCopy, isConflictCopy, deriveNoteConflicts } from "../src/base";
import { SyncApi, VaultIo, SyncState, ChunkCache, pushFile } from "../src/sync";
import { sha256hex } from "../src/chunker";
import { ChangesResponse, CommitConflictError, CommitRequest, FileMeta } from "../src/protocol";
import { isSafeVaultPath } from "../src/pathsafe";

const H = (h: string) => ({ hash: h });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("decide", () => {
  it("local-only new -> push", () => expect(decide(H("a"), null, null)).toBe("push"));
  it("remote-only new -> pull", () => expect(decide(null, null, H("b"))).toBe("pull"));
  it("equal both sides -> in-sync", () => expect(decide(H("x"), H("x"), H("x"))).toBe("in-sync"));
  it("pre-existing divergence, no base -> conflict-copy", () => expect(decide(H("a"), null, H("b"))).toBe("conflict-copy"));
  it("only remote changed -> pull", () => expect(decide(H("a"), H("a"), H("b"))).toBe("pull"));
  it("only local changed -> push", () => expect(decide(H("b"), H("a"), H("a"))).toBe("push"));
  it("both changed -> merge", () => expect(decide(H("b"), H("a"), H("c"))).toBe("merge"));
  it("remote deleted, local unchanged -> delete-local", () => expect(decide(H("a"), H("a"), null)).toBe("delete-local"));
  it("remote deleted, local edited -> edit-wins-keep-local", () => expect(decide(H("b"), H("a"), null)).toBe("edit-wins-keep-local"));
  it("local deleted, remote unchanged -> delete-remote", () => expect(decide(null, H("a"), H("a"))).toBe("delete-remote"));
  it("local deleted, remote edited -> edit-wins-pull", () => expect(decide(null, H("a"), H("b"))).toBe("edit-wins-pull"));
  it("nothing anywhere -> in-sync", () => expect(decide(null, null, null)).toBe("in-sync"));
});

function fakeServer() {
  const chunks = new Map<string, Uint8Array>(); const files = new Map<string, FileMeta>(); let version = 1;
  // Deletion TOMBSTONES, like the real server: deleteFile records one, and changes() returns those
  // past `since`. This is what makes a delete PROPAGATE — a file merely absent from `files` with no
  // tombstone is "this server never had it" (wrong/fresh/restored server), NOT a deletion.
  const deletions: { path: string; version: number }[] = [];
  const api: SyncApi = {
    async changes(since) { return { version, upserts: [...files.values()].filter((f) => f.version > since), deletes: deletions.filter((d) => d.version > since) } as ChangesResponse; },
    async fileMeta(p) { return files.get(p) ?? null; },
    async missing(hs) { return hs.filter((h) => !chunks.has(h)); },
    async getChunk(h) { return chunks.get(h)!; },
    async putChunk(h, b) { chunks.set(h, b); },
    async commit(r: CommitRequest) { const m: FileMeta = { ...r, version: ++version }; files.set(r.path, m); return m; },
    async deleteFile(p) { if (files.delete(p)) deletions.push({ path: p, version: ++version }); },
  };
  return { api, chunks, files, deletions };
}
function fakeIo(seed: Record<string, string> = {}) {
  const m = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, enc(v)]));
  const io: VaultIo & { m: Map<string, Uint8Array> } = {
    m,
    async list() { const r = new Map<string, { mtime: number; size: number }>(); for (const k of m.keys()) r.set(k, { mtime: 0, size: m.get(k)!.length }); return r; },
    async read(p) { const b = m.get(p); if (!b) throw new Error("ENOENT"); return b; },
    async write(p, b) { m.set(p, b); },
    async remove(p) { m.delete(p); },
    // Streamed writer: accumulate appended chunks, commit to the map on close.
    async appendWrite(p) {
      let buf = new Uint8Array(0);
      return {
        append: async (b: Uint8Array) => { const n = new Uint8Array(buf.length + b.length); n.set(buf); n.set(b, buf.length); buf = n; },
        close: async () => { m.set(p, buf); },
        abort: async () => {},
      };
    },
  };
  return io;
}
function deps(api: SyncApi, io: VaultIo, extra: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return { api, io, base: new BaseStore(), cache: new Map() as ChunkCache, state: { version: 0 }, device: "Dev", ...extra };
}
async function serverPut(api: SyncApi, path: string, text: string) {
  await pushFile(api, fakeIo({ [path]: text }), { version: 0 }, new Map() as ChunkCache, path);
}
async function serverPutBytes(api: SyncApi, path: string, bytes: Uint8Array) {
  const io = fakeIo(); io.m.set(path, bytes);
  await pushFile(api, io, { version: 0 }, new Map() as ChunkCache, path);
}
// A VaultIo that applies the production path guard (mirrors ObsidianVaultIo, R24): read/exists/write/
// remove refuse a traversing/absolute server-supplied path so it can never touch the "filesystem".
function guardedIo(seed: Record<string, string> = {}) {
  const io = fakeIo(seed);
  const raw = { read: io.read.bind(io), write: io.write.bind(io), remove: io.remove.bind(io) };
  io.read = async (p) => { if (!isSafeVaultPath(p)) throw new Error("unsafe path refused"); return raw.read(p); };
  io.exists = async (p) => (isSafeVaultPath(p) ? io.m.has(p) : false);
  io.write = async (p, b) => { if (!isSafeVaultPath(p)) throw new Error("unsafe path refused"); return raw.write(p, b); };
  io.remove = async (p) => { if (!isSafeVaultPath(p)) throw new Error("unsafe path refused"); return raw.remove(p); };
  return io;
}

describe("SEC-DATA: DeleteRateGuard defeats a paced-tombstone vault drain", () => {
  it("catches cumulative deletes against a high-water mark even when no single pass trips the ratio", () => {
    let t = 1_000_000;
    const g = new DeleteRateGuard(60 * 60 * 1000, 0.5, 6, () => t);
    // Pass 1: 100-file vault, delete 40 (40% < 50% per-pass ratio → per-pass guard would NOT fire).
    g.observe(100);
    expect(g.wouldExceed(40)).toBe(false);   // 40/100 = 0.40 < 0.5
    g.record(40);
    // Pass 2: base shrank to 60 (the drain). Delete another 20 — 20/60 = 0.33, still under the STATELESS
    // per-pass ratio, but cumulative 40+20=60 against the peak of 100 = 0.60 >= 0.5 → guard fires.
    g.observe(60);
    expect(g.wouldExceed(20)).toBe(true);
  });

  it("does not fire on a legitimate small delete, and resets after a quiet window", () => {
    let t = 0;
    const g = new DeleteRateGuard(1000, 0.5, 6, () => t);
    g.observe(100);
    expect(g.wouldExceed(10)).toBe(false);   // 10% — fine
    g.record(10);
    // A quiet window passes → peak + count reset, so a later legitimate batch isn't penalized by history.
    t += 2000;
    g.observe(100);
    expect(g.wouldExceed(40)).toBe(false);   // fresh window: 40/100 < 0.5
  });

  it("ignores tiny vaults (below BULK_DELETE_MIN) so a 3-file vault isn't second-guessed", () => {
    let t = 0;
    const g = new DeleteRateGuard(1000, 0.5, 6, () => t);
    g.observe(3);
    expect(g.wouldExceed(3)).toBe(false);    // peak 3 < min 6 → never guards
  });
});

describe("R24: a compromised server cannot exfiltrate an out-of-vault file via a traversing tombstone", () => {
  it("a traversing tombstone path is never read or pushed; a real file still syncs", async () => {
    const { api, chunks, files } = fakeServer();
    // The "vault" also contains an out-of-vault secret addressable by a traversing key (simulating the
    // adapter escaping base via `..`), plus a legitimate note.
    const io = guardedIo({ "../../../.ssh/id_rsa": "SUPER SECRET KEY", "note.md": "real note" });
    let readSecret = false;
    const origRead = io.read.bind(io);
    io.read = async (p) => { const b = await origRead(p); if (p.includes("..")) readSecret = true; return b; };
    // A malicious server pushes a tombstone for the traversing path (would resolve to push→exfil if unguarded).
    const delta: ChangesResponse = { version: 5, upserts: [], deletes: [{ path: "../../../.ssh/id_rsa", version: 5 }] };
    await reconcileDelta(deps(api, io), delta);
    // The guarded read blocks the escape → the file reads as absent → decide()=in-sync → a SILENT SAFE
    // no-op: the secret is never read, never chunked, never uploaded. (Unguarded, decide()=push here.)
    expect(readSecret).toBe(false);
    expect(files.has("../../../.ssh/id_rsa")).toBe(false);
    for (const b of chunks.values()) expect(dec(b)).not.toContain("SUPER SECRET");
    // A subsequent normal push of a real note still works (guard doesn't break legit paths).
    await pushFile(api, io, { version: 0 }, new Map() as ChunkCache, "note.md");
    expect(files.has("note.md")).toBe(true);
  });
});

describe("reconcileAll", () => {
  it("uploads local-only and downloads remote-only", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, "remote.md", "from server");
    const io = fakeIo({ "local.md": "from client" });
    await reconcileAll(deps(api, io));
    expect(files.has("local.md")).toBe(true);
    expect(dec((io as any).m.get("remote.md"))).toBe("from server");
  });

  it("is idempotent — a second reconcile re-downloads nothing (the resumable-sync basis)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "a.md", "A"); await serverPut(api, "b.md", "B");
    const io = fakeIo({});
    const d = deps(api, io, { base: new BaseStore() });
    await reconcileAll(d);                                  // first pass: pulls both files
    let writes = 0; const orig = (io as any).write.bind(io);
    (io as any).write = async (p: string, b: Uint8Array) => { writes++; return orig(p, b); };
    await reconcileAll(d);                                  // second pass: everything already in-sync
    expect(writes).toBe(0);                                 // nothing re-fetched — an interrupted sync would resume, not restart
    expect(dec((io as any).m.get("a.md")!)).toBe("A");
  });

  it("pre-existing divergence, no base -> conflict-copy keeps BOTH (never clobbers)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "note.md", "SERVER version");
    const io = fakeIo({ "note.md": "LOCAL version" });
    await reconcileAll(deps(api, io));
    const m = (io as any).m as Map<string, Uint8Array>;
    expect(dec(m.get("note.md")!)).toBe("SERVER version");
    const copies = [...m.keys()].filter((k) => k.includes("(conflict"));
    expect(copies.length).toBe(1);
    expect(dec(m.get(copies[0])!)).toBe("LOCAL version");
  });

  it("NO-BASE BINARY divergence (read-write): keeps BOTH as a conflict copy — never lossy-collapsed (critique F1)", async () => {
    const { api } = fakeServer();
    const remote = new Uint8Array([0x41, 0x80]); // invalid-UTF-8 bytes that a lossy TextDecoder maps
    const local = new Uint8Array([0x41, 0x81]);  // to the SAME "A�" string — must NOT be treated equal
    await serverPutBytes(api, "img.png", remote);
    const io = fakeIo(); io.m.set("img.png", local);
    const conf: string[] = [];
    await reconcileAll(deps(api, io, { onConflict: (p) => conf.push(p) }));
    const m = io.m;
    expect([...m.get("img.png")!]).toEqual([...remote]); // remote canonical at the path
    const copies = [...m.keys()].filter((k) => k.includes("(conflict"));
    expect(copies.length).toBe(1);
    expect([...m.get(copies[0])!]).toEqual([...local]);  // local PRESERVED (no silent clobber)
    expect(conf.length).toBe(1);
  });

  it("does NOT count a remote file this device DECLINES as pending — reports it as declined instead", async () => {
    const { api } = fakeServer();
    await serverPut(api, "note.md", "hi");                            // accepted (a note)
    await serverPut(api, ".obsidian/plugins/dataview/main.js", "x");  // declined (config off on this device)
    const io = fakeIo({});
    const pend: number[] = []; const declined: string[][] = [];
    await reconcileAll(deps(api, io, {
      accepts: (p) => !p.startsWith(".obsidian/"),                    // notes only — decline config
      onProgress: (n: number) => pend.push(n),
      onDeclined: (ps: string[]) => declined.push(ps),
    }));
    expect(Math.max(...pend)).toBe(1);                                // only note.md is pending, NOT the plugin file
    expect(declined.flat()).toContain(".obsidian/plugins/dataview/main.js"); // surfaced as declined
    expect(io.m.has("note.md")).toBe(true);                           // the accepted note pulled
    expect(io.m.has(".obsidian/plugins/dataview/main.js")).toBe(false); // the declined file did NOT pull
  });

  it("a CONNECTION failure (DNS) ABORTS the pass — one error, not one-per-file", async () => {
    const { api } = fakeServer();
    for (let i = 0; i < 20; i++) await serverPut(api, `n${i}.md`, `v${i}`); // 20 remote files to pull
    const io = fakeIo({});
    // every pull fails with the host-resolution error mobile reports when it resumes before DNS is ready
    const down: SyncApi = { ...api, async getChunk() { throw new Error('Request Failed. UnknownHostException Unable to resolve host "notes2.example": No address associated with hostname'); } };
    const errs: string[] = [];
    await expect(reconcileAll(deps(down, io, { onFileError: (p) => errs.push(p) }))).rejects.toThrow(/UnknownHost/i);
    expect(errs).toEqual([]); // NO per-file noise — the whole pass aborted on the connection error
  });

  it("a single-file error is still ISOLATED (a connection abort must not swallow real per-file failures)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "ok.md", "fine");
    await serverPut(api, "bad.md", "boom");
    const io = fakeIo({});
    const origWrite = io.write.bind(io);
    (io as any).write = async (p: string, b: Uint8Array) => { if (p === "bad.md") throw new Error("disk full"); return origWrite(p, b); };
    const errs: string[] = [];
    await reconcileAll(deps(api, io, { onFileError: (p) => errs.push(p) })); // must NOT throw
    expect(errs).toEqual(["bad.md"]);                 // the one bad file is isolated…
    expect(dec((io as any).m.get("ok.md")!)).toBe("fine"); // …and the others sync
  });

  it("isConnectionError classifies host/connection failures but NOT per-file content/read errors", () => {
    expect(isConnectionError(new Error('UnknownHostException Unable to resolve host "x": No address associated with hostname'))).toBe(true);
    expect(isConnectionError(new Error("getaddrinfo ENOTFOUND notes2.example"))).toBe(true);
    expect(isConnectionError(new Error("connect ECONNREFUSED 10.0.0.1:8080"))).toBe(true);
    expect(isConnectionError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(true);
    expect(isConnectionError(new Error("disk full"))).toBe(false);
    expect(isConnectionError(new Error("ENOENT"))).toBe(false); // NOT ENOTFOUND
    expect(isConnectionError(new Error("chunk a1b2c3 failed content verification"))).toBe(false);
    expect(isConnectionError(new Error("unsafe path refused"))).toBe(false);
  });

  it("config scan fast-path: an unchanged config file (matching size+mtime) is NOT re-read/hashed", async () => {
    const { api } = fakeServer();
    const io = fakeIo({ ".obsidian/app.json": "{}" });
    let reads = 0; const origRead = io.read.bind(io);
    (io as any).read = async (p: string) => { reads++; return origRead(p); };
    const base = new BaseStore();
    const bytes = enc("{}");
    base.set(".obsidian/app.json", { hash: await sha256hex(bytes) });
    base.stampStat(".obsidian/app.json", bytes.length, 0); // fakeIo.list reports mtime 0, size = length → matches
    await reconcileLocalConfig(deps(api, io, { base }));
    expect(reads).toBe(0); // skipped by the (size,mtime) fast-path — no read, no SHA-256
  });

  it("config scan still DETECTS a new local config file and pushes it (no stale stat to skip it)", async () => {
    const { api, files } = fakeServer();
    const io = fakeIo({ ".obsidian/app.json": "new-config" });
    await reconcileLocalConfig(deps(api, io, { base: new BaseStore() })); // empty base → not skipped → push
    expect(files.has(".obsidian/app.json")).toBe(true);
  });

  it("config scan stamps an unchanged-but-unstamped file so the NEXT scan skips it", async () => {
    const { api } = fakeServer();
    const io = fakeIo({ ".obsidian/app.json": "{}" });
    const base = new BaseStore();
    base.set(".obsidian/app.json", { hash: await sha256hex(enc("{}")) }); // hash matches, but NO stat stamp yet
    await reconcileLocalConfig(deps(api, io, { base }));       // pass 1: reads+hashes, confirms equal, stamps
    let reads = 0; const origRead = io.read.bind(io);
    (io as any).read = async (p: string) => { reads++; return origRead(p); };
    await reconcileLocalConfig(deps(api, io, { base }));       // pass 2: stat now matches → skipped
    expect(reads).toBe(0);
  });

  it("sameIgnoringEol: line-ending + trailing-newline differences are cosmetic; real edits are not", () => {
    expect(sameIgnoringEol(enc("a\r\nb\r\n"), enc("a\nb"))).toBe(true);  // CRLF vs LF, no trailing NL
    expect(sameIgnoringEol(enc("a\nb\n\n"), enc("a\nb"))).toBe(true);    // extra trailing blank lines
    expect(sameIgnoringEol(enc("a\nb"), enc("a\nB"))).toBe(false);       // a real content edit
    expect(sameIgnoringEol(enc("a\nb"), enc("a\nb\nc"))).toBe(false);    // an added line
  });

  it("reconcileAll reports PENDING work (not files examined) and drives to 0", async () => {
    const { api } = fakeServer();
    await serverPut(api, "a.md", "A"); await serverPut(api, "b.md", "B"); // 2 remote-new → pull
    const io = fakeIo({ "c.md": "C" });                                    // 1 local-new → push
    const seen: number[] = [];
    await reconcileAll(deps(api, io, { onProgress: (pending: number) => seen.push(pending) }));
    expect(seen[0]).toBe(3);                    // 3 files actually need transfer
    expect(seen[seen.length - 1]).toBe(0);      // drives to 0
  });

  it("reconcileAll counts only files that NEED work — an already-in-sync vault reports 0 pending", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "hello");
    const io = fakeIo({ "n.md": "hello" });
    const base = new BaseStore(); base.set("n.md", { hash: await sha256hex(enc("hello")) });
    const seen: number[] = [];
    await reconcileAll(deps(api, io, { base, onProgress: (pending: number) => seen.push(pending) }));
    expect(Math.max(...seen)).toBe(0); // nothing to do → never any pending, total (1 file) is irrelevant
  });

  it("no-base divergence that is ONLY line endings -> converge on remote, NO conflict copy (issueFalseEolConflict)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "note.md", "line1\r\nline2\r\n");  // server copy: Windows CRLF
    const io = fakeIo({ "note.md": "line1\nline2" });        // local copy: LF, no trailing newline — same text
    await reconcileAll(deps(api, io));
    const m = (io as any).m as Map<string, Uint8Array>;
    expect([...m.keys()].filter((k) => k.includes("(conflict")).length).toBe(0); // NOT flagged as a conflict
    expect(dec(m.get("note.md")!)).toBe("line1\r\nline2\r\n");                    // converged on the remote bytes
  });

  it("both-changed mergeable -> three-way merge (auto-merge)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "l1\nl2\nl3\n");
    const io = fakeIo({ "n.md": "l1\nl2\nl3\n" });
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("l1\nl2\nl3\n")), text: "l1\nl2\nl3\n" });
    const d = deps(api, io, { base });
    (io as any).m.set("n.md", enc("L1\nl2\nl3\n"));   // local edits line 1
    await serverPut(api, "n.md", "l1\nl2\nL3\n");       // remote edits line 3
    await reconcileAll(d);
    const merged = dec((io as any).m.get("n.md"));
    expect(merged).toContain("L1"); expect(merged).toContain("L3");
  });

  it("delete-vs-edit -> edit wins (content preserved)", async () => {
    const { api, files } = fakeServer();
    // base: both have v1; local edits, remote deletes.
    await serverPut(api, "d.md", "v1");
    const io = fakeIo({ "d.md": "v1-EDITED" });
    const base = new BaseStore();
    base.set("d.md", { hash: await sha256hex(enc("v1")), text: "v1" });
    files.delete("d.md"); // remote deleted it
    await reconcileAll(deps(api, io, { base }));
    // edit wins: local content kept AND re-pushed to the server
    expect(dec((io as any).m.get("d.md"))).toBe("v1-EDITED");
    expect(files.has("d.md")).toBe(true);
  });

  it("RESTORES (never deletes) a local file the empty server has no tombstone for", async () => {
    // Empty/fresh/restored server (or the WRONG server after a vault switch): the file is absent
    // but there's NO deletion tombstone, so it is NOT a real delete. The safe action is to restore
    // it to the server, never to destroy local data. (Durable fix for the vault-switch data loss.)
    const { api, files } = fakeServer(); // empty server, no tombstones
    const io = fakeIo({ "keep.md": "important" });
    const base = new BaseStore();
    base.set("keep.md", { hash: await sha256hex(enc("important")) });
    await reconcileAll(deps(api, io, { base }));
    expect((io as any).m.has("keep.md")).toBe(true);   // NOT deleted
    expect(files.has("keep.md")).toBe(true);           // RESTORED to the server
    expect(base.get("keep.md")).toBeDefined();
  });

  it("onKeptAbsent (D0019) fires for a kept absent-without-tombstone file, not for a real tombstone", async () => {
    // A reset pass reports every local file KEPT because it was absent from the server with no
    // tombstone (the restore branch) so main can batch them into one review notice; a genuinely
    // tombstoned delete must NOT be reported (it's a real deletion, not an ambiguous keep).
    const { api } = fakeServer();
    await serverPut(api, "stay.md", "s");   // stays on the server → remote non-empty (empty-remote guard off)
    await serverPut(api, "tomb.md", "t");   // will be tombstoned
    const io = fakeIo({ "keep.md": "important", "tomb.md": "t", "stay.md": "s" });
    const base = new BaseStore();
    base.set("keep.md", { hash: await sha256hex(enc("important")) }); // synced before, now absent w/o tombstone
    base.set("tomb.md", { hash: await sha256hex(enc("t")) });
    base.set("stay.md", { hash: await sha256hex(enc("s")) });
    await api.deleteFile("tomb.md");         // a REAL deletion → tombstone
    const kept: string[] = [];
    await reconcileAll(deps(api, io, { base, onKeptAbsent: (p) => kept.push(p) }));
    expect(kept).toEqual(["keep.md"]);                  // only the absent-without-tombstone file
    expect((io as any).m.has("keep.md")).toBe(true);    // kept (restored)
    expect((io as any).m.has("tomb.md")).toBe(false);   // real tombstone still deletes
    expect((io as any).m.has("stay.md")).toBe(true);    // in-sync, untouched
  });

  it("skips a file larger than the sync limit (no push, path untouched)", async () => {
    const { api, files } = fakeServer();
    const io = fakeIo({ "big.md": "x".repeat(100), "ok.md": "small" });
    const skipped: string[] = [];
    await reconcileAll(deps(api, io, { maxSyncBytes: 10, onSkip: (p) => skipped.push(p) }));
    expect(skipped).toContain("big.md");
    expect(files.has("big.md")).toBe(false); // over-limit file not pushed
    expect(files.has("ok.md")).toBe(true);   // small file still syncs
  });

  it("reconcilePath (event path) gates a large local file — no push", async () => {
    const { api, files } = fakeServer();
    const io = fakeIo({ "big.md": "x".repeat(100) });
    const skipped: string[] = [];
    await reconcilePath(deps(api, io, { maxSyncBytes: 10, onSkip: (p) => skipped.push(p) }), "big.md", 100);
    expect(skipped).toContain("big.md");
    expect(files.has("big.md")).toBe(false);
  });

  it("reconcilePath (event path): RESTORES a file the empty server has no tombstone for", async () => {
    const { api, files } = fakeServer(); // empty (lost index → /meta 404 for everything)
    const io = fakeIo({ "keep.md": "data" });
    const base = new BaseStore();
    base.set("keep.md", { hash: await sha256hex(enc("data")) });
    await reconcilePath(deps(api, io, { base }), "keep.md", 4);
    expect((io as any).m.has("keep.md")).toBe(true); // NOT deleted by a stray event
    expect(files.has("keep.md")).toBe(true);          // restored to the server
  });

  it("delete-local PROPAGATES a real server tombstone (deleted on the peer)", async () => {
    // The correct trigger for delete-local: a genuine deletion the server TOMBSTONED — not mere
    // absence. Distinguishing the two is the whole point (absence = wrong/fresh server → restore).
    const { api } = fakeServer();
    await serverPut(api, "gone.md", "x");
    await serverPut(api, "other.md", "still here");
    const io = fakeIo({ "gone.md": "x", "other.md": "still here" });
    const base = new BaseStore();
    base.set("gone.md", { hash: await sha256hex(enc("x")) });
    base.set("other.md", { hash: await sha256hex(enc("still here")) });
    await api.deleteFile("gone.md"); // a REAL deletion → records a tombstone
    await reconcileAll(deps(api, io, { base }));
    expect((io as any).m.has("gone.md")).toBe(false);  // tombstoned deletion propagates
    expect((io as any).m.has("other.md")).toBe(true);  // untouched
  });

  it("DATA-LOSS REGRESSION: two reconciles against a wrong/empty server never delete local files", async () => {
    // The exact vault-switch failure: a client with a populated base points at a DIFFERENT/empty
    // server. Pass 1 kept the files (empty-remote guard) but our own pushes made the remote
    // non-empty, so pass 2's ratio guard no longer fired and silently deleted them. With tombstone-
    // gated delete-local, NEITHER pass deletes — both restore. Guards absence across passes.
    const { api } = fakeServer(); // fresh server, no tombstones for our files
    const io = fakeIo({ "Welcome.md": "hi", "test file.md": "notes" });
    const base = new BaseStore();
    base.set("Welcome.md", { hash: await sha256hex(enc("hi")) });
    base.set("test file.md", { hash: await sha256hex(enc("notes")) });
    const d = deps(api, io, { base });
    await reconcileAll(d); // pass 1
    await reconcileAll(d); // pass 2 — the pass that used to delete
    expect((io as any).m.has("Welcome.md")).toBe(true);
    expect((io as any).m.has("test file.md")).toBe(true);
  });
});

describe("switchTo (one-time vault switch resolution)", () => {
  it("download: target wins — pulls target, drops local-only files, resets stale base", async () => {
    const { api } = fakeServer();
    await serverPut(api, "a.md", "SERVER a");
    await serverPut(api, "b.md", "SERVER b");
    const io = fakeIo({ "a.md": "LOCAL a", "c.md": "LOCAL only" });
    const base = new BaseStore();
    base.set("stale.md", { hash: "deadbeef" }); // leftover from the OLD vault
    await switchTo(deps(api, io, { base }), "download");
    const m = (io as any).m as Map<string, Uint8Array>;
    expect(dec(m.get("a.md")!)).toBe("SERVER a"); // target overwrites local divergence
    expect(dec(m.get("b.md")!)).toBe("SERVER b"); // target-only pulled
    expect(m.has("c.md")).toBe(false);             // local-only discarded
    expect(base.get("stale.md")).toBeUndefined();  // old ancestor reset
    expect(base.get("a.md")).toBeDefined();        // rebuilt for the target
  });

  it("upload: local wins — pushes local, drops target-only files", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, "y.md", "SERVER y");
    await serverPut(api, "z.md", "SERVER z only");
    const io = fakeIo({ "x.md": "LOCAL x", "y.md": "LOCAL y" });
    await switchTo(deps(api, io), "upload");
    expect(files.has("x.md")).toBe(true);  // local-only pushed
    expect(files.has("z.md")).toBe(false); // target-only removed
    // Confirm the server now mirrors local by pulling into a fresh vault.
    const io2 = fakeIo({});
    await reconcileAll(deps(api, io2));
    const m2 = (io2 as any).m as Map<string, Uint8Array>;
    expect(dec(m2.get("y.md")!)).toBe("LOCAL y"); // target's y overwritten by local
    expect(dec(m2.get("x.md")!)).toBe("LOCAL x");
    expect(m2.has("z.md")).toBe(false);
  });

  it("merge: union — pushes local-only, pulls target-only, conflict-copies divergence (nothing lost)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "r.md", "remote only");
    await serverPut(api, "d.md", "SERVER d");
    const io = fakeIo({ "l.md": "local only", "d.md": "LOCAL d" });
    await switchTo(deps(api, io), "merge");
    const m = (io as any).m as Map<string, Uint8Array>;
    expect(dec(m.get("r.md")!)).toBe("remote only"); // target-only pulled
    expect(m.has("l.md")).toBe(true);                 // local-only kept
    expect(dec(m.get("d.md")!)).toBe("SERVER d");      // remote canonical on divergence
    const copies = [...m.keys()].filter((k) => k.includes("(conflict"));
    expect(copies.length).toBe(1);                     // divergence preserved as a copy
    expect(dec(m.get(copies[0])!)).toBe("LOCAL d");
  });

  it("download into an EMPTY local vault (the auto case) just fetches the target", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n1.md", "one");
    await serverPut(api, "n2.md", "two");
    const io = fakeIo({}); // empty — nothing to lose
    await switchTo(deps(api, io), "download");
    const m = (io as any).m as Map<string, Uint8Array>;
    expect(dec(m.get("n1.md")!)).toBe("one");
    expect(dec(m.get("n2.md")!)).toBe("two");
  });
});

describe("streamed reassembly of large downloads (B9 Part B)", () => {
  const big = "x".repeat(9 * 1024 * 1024); // >= STREAM_MIN_BYTES (8 MiB)

  it("streams a large remote file to disk on pull", async () => {
    const { api } = fakeServer();
    await serverPut(api, "big.bin", big);
    const io = fakeIo({});
    await reconcileAll(deps(api, io));
    expect(dec((io as any).m.get("big.bin")!)).toBe(big);
  });

  it("R16 HIGH: a streamed download whose reassembly ≠ the declared hash is REJECTED, not laundered", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, "big.bin", big);
    // Corrupt server MANIFEST: the declared file hash no longer matches its (valid, content-addressed)
    // chunks — the size-preserving case the per-chunk + total-size checks can't catch.
    files.get("big.bin")!.hash = "0".repeat(64);
    const io = fakeIo({});
    const base = new BaseStore();
    const errs: string[] = [];
    await reconcileAll(deps(api, io, { base, onFileError: (p) => errs.push(p) }));
    expect(errs).toContain("big.bin");                 // integrity failure surfaced + isolated
    expect((io as any).m.has("big.bin")).toBe(false);   // corrupt download REMOVED, not left on disk
    expect(base.get("big.bin")).toBeUndefined();        // NOT laundered into base → never re-pushed as authoritative
  });

  it("a large download bypasses the size gate when streaming; without streaming it's skipped", async () => {
    // WITH streaming (appendWrite present) + a low gate → streamed, not skipped
    {
      const { api } = fakeServer();
      await serverPut(api, "big.bin", big);
      const io = fakeIo({});
      const skipped: string[] = [];
      await reconcileAll(deps(api, io, { maxSyncBytes: 1024 * 1024, onSkip: (p) => skipped.push(p) }));
      expect(skipped).not.toContain("big.bin");
      expect(dec((io as any).m.get("big.bin")!)).toBe(big);
    }
    // WITHOUT streaming (no appendWrite) → skipped (buffered path stays gated)
    {
      const { api } = fakeServer();
      await serverPut(api, "big.bin", big);
      const io = fakeIo({});
      delete (io as any).appendWrite;
      const skipped: string[] = [];
      await reconcileAll(deps(api, io, { maxSyncBytes: 1024 * 1024, onSkip: (p) => skipped.push(p) }));
      expect(skipped).toContain("big.bin");
      expect((io as any).m.has("big.bin")).toBe(false);
    }
  });
});

describe("read-only shared vault (never mutates the server)", () => {
  it("does not upload a local-only file (skips the push)", async () => {
    const { api, files } = fakeServer();
    const io = fakeIo({ "local.md": "mine" });
    const ro: string[] = [];
    await reconcileAll(deps(api, io, { readOnly: true, onReadOnly: (p) => ro.push(p) }));
    expect(files.has("local.md")).toBe(false); // not uploaded to the owner's vault
    expect(ro).toContain("local.md");
  });

  it("still pulls the owner's files", async () => {
    const { api } = fakeServer();
    await serverPut(api, "shared.md", "from owner");
    const io = fakeIo({});
    await reconcileAll(deps(api, io, { readOnly: true }));
    expect(dec((io as any).m.get("shared.md")!)).toBe("from owner");
  });

  it("does not delete on the owner's vault (skips delete-remote)", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, "keep.md", "owner file"); // exists on server + base, not locally
    const io = fakeIo({});
    const base = new BaseStore();
    base.set("keep.md", { hash: await sha256hex(enc("owner file")) });
    // locally absent + base present + remote present-unchanged => decide = delete-remote; read-only must skip it
    await reconcileAll(deps(api, io, { base, readOnly: true }));
    expect(files.has("keep.md")).toBe(true); // NOT deleted on the server
  });

  it("on divergence: owner's version is canonical, local kept as a LOCAL copy, nothing pushed", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, "n.md", "OWNER edit");
    const io = fakeIo({ "n.md": "MY edit" });
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("v1")), text: "v1" }); // both sides changed from base
    const ro: string[] = [];
    await reconcileAll(deps(api, io, { base, readOnly: true, onReadOnly: (p) => ro.push(p) }));
    const m = (io as any).m as Map<string, Uint8Array>;
    expect(dec(m.get("n.md")!)).toBe("OWNER edit");         // owner canonical at the path
    const copies = [...m.keys()].filter((k) => k.includes("(conflict"));
    expect(copies.length).toBe(1);
    expect(dec(m.get(copies[0])!)).toBe("MY edit");          // local edit kept locally
    expect([...files.keys()].some((k) => k.includes("(conflict"))).toBe(false); // NOT pushed
    expect(ro).toContain("n.md");
  });

  it("NO-BASE divergence: adopts the owner's version WITHOUT a conflict copy (field: read-only PNGs spuriously copied)", async () => {
    const { api, files } = fakeServer();
    const remote = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x01]);
    const local = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x02]); // different bytes, no common base
    await serverPutBytes(api, "assets/img.png", remote);
    const io = fakeIo(); io.m.set("assets/img.png", local);
    const conf: string[] = []; const ro: string[] = [];
    await reconcileAll(deps(api, io, { readOnly: true, onConflict: (p) => conf.push(p), onReadOnly: (p) => ro.push(p) }));
    const m = io.m;
    expect([...m.get("assets/img.png")!]).toEqual([...remote]); // owner canonical, adopted byte-for-byte
    expect([...m.keys()].filter((k) => k.includes("(conflict"))).toEqual([]); // NO litter copy on a read-only share
    expect(conf).toEqual([]); // not flagged as a conflict
    expect(ro).toEqual([]);   // not reported as "won't sync"
    expect([...files.keys()].some((k) => k.includes("(conflict"))).toBe(false);
  });

  it("an EXISTING conflict copy on a read-only share is NOT reported as 'won't sync' (noise suppression)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "keep.md", "owner");
    // a leftover conflict copy sits locally (local-only new file); on read-only it can't push
    const io = fakeIo({ "keep.md": "owner", "keep (conflict Pixel 9 20260712193013-09ba63).md": "old local" });
    const ro: string[] = [];
    await reconcileAll(deps(api, io, { readOnly: true, onReadOnly: (p) => ro.push(p) }));
    expect(ro).toEqual([]); // the conflict-copy file is deliberately local — not a failed sync
  });
});

describe("config sync: additive + adjudicated (never auto-delete, never resurrect)", () => {
  const CP = ".obsidian/community-plugins.json";
  const PLG = ".obsidian/plugins/foo/main.js";

  it("accepts=false → a filtered config path is skipped entirely (no write, no base, no delete)", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, PLG, "plugin code"); // server has it
    const io = fakeIo({});                     // local doesn't
    const base = new BaseStore();
    const conflicts: string[] = [];
    await reconcileAll(deps(api, io, { base, accepts: (p) => !p.startsWith(".obsidian/plugins/"), onConfigConflict: (p) => conflicts.push(p) }));
    expect((io as any).m.has(PLG)).toBe(false); // not pulled
    expect(files.has(PLG)).toBe(true);          // not deleted on the server
    expect(base.get(PLG)).toBeUndefined();      // NO phantom base recorded
    expect(conflicts).toEqual([]);              // just ignored, not even a conflict
  });

  it("does NOT manufacture a delete-remote from a filtered path w/ a phantom base (the reported data-loss bug)", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, PLG, "plugin code");
    const io = fakeIo({});
    const base = new BaseStore();
    base.set(PLG, { hash: await sha256hex(enc("plugin code")) }); // phantom base from an earlier dropped write
    await reconcileAll(deps(api, io, { base, accepts: (p) => !p.startsWith(".obsidian/plugins/") }));
    expect(files.has(PLG)).toBe(true); // server keeps the plugin — no phantom deletion
  });

  it("additive: an accepted config file present only on the server is pulled (defer to data)", async () => {
    const { api } = fakeServer();
    await serverPut(api, CP, `["foo"]`);
    const io = fakeIo({});
    await reconcileAll(deps(api, io, { accepts: () => true }));
    expect(dec((io as any).m.get(CP)!)).toBe(`["foo"]`);
  });

  it("removal (local gone, remote==base) → PROPAGATES: server file deleted (auto-remove, D0013)", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, CP, `["foo"]`);          // remote still has it
    const io = fakeIo({});                          // genuinely removed locally
    const base = new BaseStore();
    base.set(CP, { hash: await sha256hex(enc(`["foo"]`)) }); // we HELD it (evidenced removal)
    const conflicts: string[] = [];
    await reconcileAll(deps(api, io, { base, accepts: () => true, onConfigConflict: (p) => conflicts.push(p) }));
    expect(conflicts).toEqual([]);                 // a genuine removal is NOT adjudicated — it propagates
    expect(files.has(CP)).toBe(false);             // server file removed (auto-remove everywhere)
  });

  it("removal (server TOMBSTONED it, local==base) → PROPAGATES: local file deleted (auto-remove, D0013)", async () => {
    const { api } = fakeServer();
    await serverPut(api, CP, `["foo"]`);
    await serverPut(api, "other.md", "keeps the manifest non-empty");
    const io = fakeIo({ [CP]: `["foo"]`, "other.md": "keeps the manifest non-empty" });
    const base = new BaseStore();
    base.set(CP, { hash: await sha256hex(enc(`["foo"]`)) });
    base.set("other.md", { hash: await sha256hex(enc("keeps the manifest non-empty")) });
    await api.deleteFile(CP); // a REAL config removal on another device → server records a tombstone
    const conflicts: string[] = [];
    await reconcileAll(deps(api, io, { base, accepts: () => true, onConfigConflict: (p) => conflicts.push(p) }));
    expect(conflicts).toEqual([]);                 // a genuine (tombstoned) removal propagates, not adjudicated
    expect((io as any).m.has(CP)).toBe(false);     // local file removed (the server's removal applied)
  });

  it("divergence (both differ, no common base) → adjudicate, NO crash, NO garbage conflict copy", async () => {
    const { api, files } = fakeServer();            // the exact reported log case
    await serverPut(api, CP, `["foo","server"]`);
    const io = fakeIo({ [CP]: `["foo","local"]` });
    const conflicts: string[] = [];
    await reconcileAll(deps(api, io, { accepts: () => true, onConfigConflict: (p) => conflicts.push(p) }));
    expect(conflicts).toContain(CP);
    const copies = [...(io as any).m.keys()].filter((k: string) => k.includes("(conflict"));
    expect(copies.length).toBe(0);                              // no garbage conflict-copy file
    expect(dec((io as any).m.get(CP)!)).toBe(`["foo","local"]`); // local kept as-is
    expect([...files.keys()].some((k) => k.includes("(conflict"))).toBe(false); // nothing pushed
  });

  it("resolveConfigConflict('local') on divergence pushes the local copy canonical", async () => {
    const { api } = fakeServer();
    await serverPut(api, CP, `["server"]`);
    const io = fakeIo({ [CP]: `["local"]` });
    await resolveConfigConflict(deps(api, io, { accepts: () => true }), CP, "local");
    const io2 = fakeIo({});
    await reconcileAll(deps(api, io2, { accepts: () => true }));
    expect(dec((io2 as any).m.get(CP)!)).toBe(`["local"]`); // server now holds local's version
  });

  it("resolveConfigConflict('remote') on divergence pulls the server copy", async () => {
    const { api } = fakeServer();
    await serverPut(api, CP, `["server"]`);
    const io = fakeIo({ [CP]: `["local"]` });
    await resolveConfigConflict(deps(api, io, { accepts: () => true }), CP, "remote");
    expect(dec((io as any).m.get(CP)!)).toBe(`["server"]`);
  });

  it("resolveConfigConflict('local') when removed locally propagates the removal to the server", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, CP, `["foo"]`);
    const io = fakeIo({}); // removed here
    await resolveConfigConflict(deps(api, io, { accepts: () => true }), CP, "local");
    expect(files.has(CP)).toBe(false); // user chose the removal → server drops it
  });

  it("resolveConfigConflict('remote') when removed locally restores it (user-chosen)", async () => {
    const { api } = fakeServer();
    await serverPut(api, CP, `["foo"]`);
    const io = fakeIo({});
    await resolveConfigConflict(deps(api, io, { accepts: () => true }), CP, "remote");
    expect(dec((io as any).m.get(CP)!)).toBe(`["foo"]`);
  });

  it("per-file isolation: one file's write error does not abort the whole reconcile", async () => {
    const { api } = fakeServer();
    await serverPut(api, "good.md", "ok");
    await serverPut(api, "bad.md", "boom");
    const io = fakeIo({});
    const origWrite = (io as any).write.bind(io);
    (io as any).write = async (p: string, b: Uint8Array) => { if (p === "bad.md") throw new Error("disk full"); return origWrite(p, b); };
    const errs: string[] = [];
    await reconcileAll(deps(api, io, { onFileError: (p) => errs.push(p) }));
    expect(errs).toContain("bad.md");
    expect(dec((io as any).m.get("good.md")!)).toBe("ok"); // the other file still synced
  });
});

// R13: the frequent tick runs a CONFIG-ONLY re-hash (cheap) instead of a whole-vault reconcile.
// It must push local config edits/removals (which fire no reliable vault event) WITHOUT touching notes.
describe("reconcileLocalConfig (config-only scan, R13)", () => {
  const CP = ".obsidian/app.json";

  it("pushes a LOCAL config edit and leaves NOTES untouched", async () => {
    const { api } = fakeServer();
    await serverPut(api, CP, "OLD");
    await serverPut(api, "note.md", "NOTE");
    const io = fakeIo({ [CP]: "NEW-LOCAL", "note.md": "NOTE-CHANGED-LOCALLY" });
    const base = new BaseStore();
    base.set(CP, { hash: await sha256hex(enc("OLD")), text: "OLD" });
    base.set("note.md", { hash: await sha256hex(enc("NOTE")), text: "NOTE" });
    await reconcileLocalConfig(deps(api, io, { base, accepts: () => true }));
    const after = await api.changes(0);
    const cfg = after.upserts.find((m) => m.path === CP)!;
    const note = after.upserts.find((m) => m.path === "note.md")!;
    expect(cfg.hash).toBe(await sha256hex(enc("NEW-LOCAL"))); // config edit pushed
    expect(note.hash).toBe(await sha256hex(enc("NOTE")));      // a locally-changed NOTE is NOT touched by the config-only scan
  });

  it("propagates a LOCAL config removal (base present, file gone)", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, CP, "cfg");
    const io = fakeIo({}); // config file removed locally (no vault event on mobile)
    const base = new BaseStore();
    base.set(CP, { hash: await sha256hex(enc("cfg")), text: "cfg" }); // we HELD it → evidenced removal
    await reconcileLocalConfig(deps(api, io, { base, accepts: () => true }));
    expect(files.has(CP)).toBe(false); // auto-remove propagated to the server
  });

  it("is a NO-OP when config is unchanged vs base (no spurious push)", async () => {
    const { api } = fakeServer();
    await serverPut(api, CP, "same");
    const before = (await api.changes(0)).version;
    const io = fakeIo({ [CP]: "same" });
    const base = new BaseStore();
    base.set(CP, { hash: await sha256hex(enc("same")), text: "same" });
    await reconcileLocalConfig(deps(api, io, { base, accepts: () => true }));
    expect((await api.changes(0)).version).toBe(before); // nothing committed
  });
});

describe("critique fixes — data integrity + correctness", () => {
  const CP = ".obsidian/community-plugins.json";

  it("CO-1: both-absent clears the stale base, so recreating with identical content is pushed, not deleted", async () => {
    const { api, files } = fakeServer();
    const io = fakeIo({});                                   // file absent locally
    const base = new BaseStore();
    base.set("x.md", { hash: await sha256hex(enc("v1")) });  // base has it; neither side does
    const d = deps(api, io, { base });
    await reconcileAll(d);                                    // both absent + base present → in-sync + CLEAR base
    expect(base.get("x.md")).toBeUndefined();                // stale base cleared
    (io as any).m.set("x.md", enc("v1"));                    // recreate locally with the SAME bytes base held
    await reconcileAll(d);                                    // local present, base absent, remote absent → push
    expect(files.has("x.md")).toBe(true);                    // pushed, NOT deleted
    expect((io as any).m.has("x.md")).toBe(true);
  });

  it("DI-1: a partial-shrink server that dropped files WITHOUT tombstones — restore, never delete", async () => {
    // Restore-from-backup / reindex-over-incomplete-dir advertises some files, silently drops others,
    // and has NO tombstones for the dropped ones. Every dropped file is restored, not deleted.
    const { api, files } = fakeServer();
    const seed: Record<string, string> = {}; for (let i = 0; i < 8; i++) seed[`n${i}.md`] = `c${i}`;
    const io = fakeIo(seed);
    const base = new BaseStore(); for (let i = 0; i < 8; i++) base.set(`n${i}.md`, { hash: await sha256hex(enc(`c${i}`)) });
    for (let i = 0; i < 3; i++) await serverPut(api, `n${i}.md`, `c${i}`); // only 3 of 8 advertised (5 dropped, no tombstones)
    await reconcileAll(deps(api, io, { base }));
    for (let i = 3; i < 8; i++) {
      expect((io as any).m.has(`n${i}.md`)).toBe(true); // the 5 dropped NOT deleted
      expect(files.has(`n${i}.md`)).toBe(true);          // restored to the server
    }
  });

  it("deletes exactly the files the server TOMBSTONED (a real small delete propagates)", async () => {
    const { api } = fakeServer();
    const seed: Record<string, string> = {}; for (let i = 0; i < 8; i++) seed[`n${i}.md`] = `c${i}`;
    const io = fakeIo(seed);
    const base = new BaseStore(); for (let i = 0; i < 8; i++) base.set(`n${i}.md`, { hash: await sha256hex(enc(`c${i}`)) });
    for (let i = 0; i < 8; i++) await serverPut(api, `n${i}.md`, `c${i}`); // all 8 synced
    await api.deleteFile("n6.md"); await api.deleteFile("n7.md");           // 2 REAL deletions → tombstones
    await reconcileAll(deps(api, io, { base }));
    expect((io as any).m.has("n6.md")).toBe(false); // tombstoned delete propagates
    expect((io as any).m.has("n7.md")).toBe(false);
    for (let i = 0; i < 6; i++) expect((io as any).m.has(`n${i}.md`)).toBe(true); // the rest untouched
  });

  it("DI-2: rejects a downloaded file whose reassembled bytes don't match the claimed hash", async () => {
    const { api, chunks, files } = fakeServer();
    await serverPut(api, "n.md", "good content");
    for (const h of files.get("n.md")!.chunks) chunks.set(h, enc("CORRUPTED")); // rot the stored blob
    const io = fakeIo({});
    const errs: string[] = [];
    await reconcileAll(deps(api, io, { onFileError: (p) => errs.push(p) }));
    expect((io as any).m.has("n.md")).toBe(false); // corrupt bytes NOT written
    expect(errs).toContain("n.md");                 // surfaced as a per-file error
  });

  it("CO-3: config edit-vs-delete is adjudicated, not silently resurrected", async () => {
    const { api } = fakeServer();
    await serverPut(api, CP, `["edited-remotely"]`);          // remote EDITED
    const io = fakeIo({});                                    // locally REMOVED
    const base = new BaseStore();
    base.set(CP, { hash: await sha256hex(enc(`["original"]`)) }); // both diverged from this base
    const conflicts: string[] = [];
    await reconcileAll(deps(api, io, { base, accepts: () => true, onConfigConflict: (p) => conflicts.push(p) }));
    expect(conflicts).toContain(CP);               // edit-wins-pull on config → adjudicate
    expect((io as any).m.has(CP)).toBe(false);     // NOT resurrected locally
  });

  it("PROTO-1: pushFile does NOT advance the poll cursor (concurrent remote commits aren't skipped)", async () => {
    const { api } = fakeServer();
    const io = fakeIo({ "a.md": "hi" });
    const state = { version: 5 };
    await pushFile(api, io, state, new Map() as ChunkCache, "a.md"); // commits, bumps the SERVER version
    expect(state.version).toBe(5); // our poll cursor must stay put, so changes(5) still returns any remote commit
  });

  it("PROTO-2: a corrupt blob on the MERGE path is rejected, not merged over the local file", async () => {
    const { api, chunks, files } = fakeServer();
    await serverPut(api, "n.md", "REMOTE");
    const io = fakeIo({ "n.md": "LOCAL" });
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("BASE")), text: "BASE" }); // both diverged from base → merge/conflict-copy
    for (const h of files.get("n.md")!.chunks) chunks.set(h, enc("CORRUPT")); // rot the remote blob
    const errs: string[] = [];
    await reconcileAll(deps(api, io, { base, onFileError: (p) => errs.push(p) }));
    expect(dec((io as any).m.get("n.md")!)).toBe("LOCAL"); // local NOT overwritten with corrupt bytes
    expect(errs).toContain("n.md");
  });
});

describe("originalOfConflictCopy — derive the pending-conflict set from filenames", () => {
  it("round-trips conflictCopyName back to the original path (with dir + ext + tag)", () => {
    const copy = conflictCopyName("notes/foo.md", "MyLaptop", new Date(Date.UTC(2026, 6, 8, 13, 15, 0)), "abc123");
    expect(copy).toBe("notes/foo (conflict MyLaptop 20260708131500-abc123).md");
    expect(originalOfConflictCopy(copy)).toBe("notes/foo.md");
  });
  it("recovers the original even when the device name has spaces and there's no tag", () => {
    const copy = conflictCopyName("a b.md", "My Phone 12", new Date(Date.UTC(2026, 0, 1, 0, 0, 0)), "");
    expect(originalOfConflictCopy(copy)).toBe("a b.md");
  });
  it("returns null for ordinary files, including a user file that merely mentions '(conflict …)'", () => {
    expect(originalOfConflictCopy("notes/foo.md")).toBeNull();
    expect(originalOfConflictCopy("a (conflict about war).md")).toBeNull(); // no 14-digit timestamp
    expect(isConflictCopy("plain.md")).toBe(false);
  });
});

describe("deriveNoteConflicts — the SINGLE source of truth (D-conflict-model): conflicts ARE vault files", () => {
  it("derives conflicts from the vault file list; ignores ordinary files AND look-alike user files", () => {
    const copy = conflictCopyName("notes/foo.md", "Phone", new Date(Date.UTC(2026, 6, 8, 13, 15, 0)), "abc123");
    const paths = ["notes/foo.md", copy, "a (conflict about war).md", "readme.md"];
    const derived = deriveNoteConflicts(paths);
    expect(derived).toEqual([{ copy, original: "notes/foo.md" }]); // only the real owned copy
  });
  it("empty vault → no conflicts (and a resolved copy simply drops out on the next derivation)", () => {
    expect(deriveNoteConflicts([])).toEqual([]);
    const copy = conflictCopyName("n.md", "Dev", new Date(Date.UTC(2026, 0, 1, 0, 0, 0)), "aa11bb");
    expect(deriveNoteConflicts([copy]).length).toBe(1);        // present → listed
    expect(deriveNoteConflicts(["n.md"]).length).toBe(0);      // copy gone → not a conflict, no stale entry
  });
});

describe("C1: a present-but-unreadable file is never propagated as a deletion", () => {
  it("a transient local read error on a synced file does NOT delete it on the server", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "hello");                 // server has it, unchanged (R === B)
    const io = fakeIo({ "n.md": "hello" });                // and it's present locally (list() sees it)
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("hello")), text: "hello" }); // previously synced
    // Simulate an antivirus/cloud-placeholder read failure while list() still reports the file present.
    const badIo = { ...io, read: async (p: string) => { if (p === "n.md") throw new Error("EBUSY"); return io.read(p); } };
    const errs: string[] = [];
    await reconcileAll(deps(api, badIo as any, { base, onFileError: (p) => errs.push(p) }));
    // Must be SKIPPED, not deleted: the server still has the file (no phantom delete-remote to peers).
    expect((await api.changes(0)).upserts.some((m) => m.path === "n.md")).toBe(true);
    expect(errs).toContain("n.md");
  });
});

describe("conflict handling: merge where clean, else conflict copy + device name", () => {
  it("cleanly-mergeable concurrent edits are auto-merged (no copy)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "l1\nl2\nl3\n");
    const io = fakeIo({ "n.md": "l1\nl2\nl3\n" });
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("l1\nl2\nl3\n")), text: "l1\nl2\nl3\n" });
    (io as any).m.set("n.md", enc("L1\nl2\nl3\n"));   // local edits line 1
    await serverPut(api, "n.md", "l1\nl2\nL3\n");       // remote edits line 3 (non-overlapping)
    await reconcileAll(deps(api, io, { base }));
    const merged = dec((io as any).m.get("n.md")!);
    expect(merged).toContain("L1"); expect(merged).toContain("L3"); // both edits merged
    expect([...(io as any).m.keys()].some((k: string) => k.includes("(conflict"))).toBe(false); // no copy
  });

  it("overlapping edits that can't merge cleanly fall back to a conflict copy", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "l1\nl2\nl3\n");
    const io = fakeIo({ "n.md": "l1\nl2\nl3\n" });
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("l1\nl2\nl3\n")), text: "l1\nl2\nl3\n" });
    (io as any).m.set("n.md", enc("l1\nLOCAL\nl3\n"));  // local edits line 2
    await serverPut(api, "n.md", "l1\nREMOTE\nl3\n");     // remote edits the SAME line 2 (overlap)
    await reconcileAll(deps(api, io, { base }));
    const m = (io as any).m as Map<string, Uint8Array>;
    expect(dec(m.get("n.md")!)).toBe("l1\nREMOTE\nl3\n"); // remote canonical when merge can't be clean
    const copies = [...m.keys()].filter((k) => k.includes("(conflict"));
    expect(copies.length).toBe(1);
    expect(dec(m.get(copies[0])!)).toBe("l1\nLOCAL\nl3\n"); // local kept as a copy
  });

  it("the device name flows into the conflict-copy filename", async () => {
    const { api } = fakeServer();
    await serverPut(api, "note.md", "SERVER");
    const io = fakeIo({ "note.md": "LOCAL" }); // no base -> conflict-copy
    await reconcileAll(deps(api, io, { device: "MyLaptop" }));
    const copy = [...(io as any).m.keys()].find((k: string) => k.includes("(conflict"));
    expect(copy).toContain("MyLaptop");
  });
});

describe("commit CAS (optimistic concurrency)", () => {
  it("a reconcile push sends the current remote version as the CAS expected_version", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, "n.md", "v1");
    const rmeta = files.get("n.md")!;
    const hv1 = await sha256hex(enc("v1"));
    const base = new BaseStore(); base.set("n.md", { hash: hv1 }); // last-synced == remote (B===R)
    const io = fakeIo({ "n.md": "v2" });                           // locally edited → decide 'push'
    let sent: CommitRequest | undefined;
    const spy: SyncApi = { ...api, async commit(r) { sent = r; return api.commit(r); } };
    await reconcileAll(deps(spy, io, { base }));
    expect(sent?.expectedVersion).toBe(rmeta.version); // CAS base = the remote version we saw
  });

  it("a 409 CommitConflictError on push is isolated — local kept, base NOT advanced (next reconcile merges)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "v1");
    const hv1 = await sha256hex(enc("v1"));
    const base = new BaseStore(); base.set("n.md", { hash: hv1 });
    const io = fakeIo({ "n.md": "v2" });
    const conflicting: SyncApi = { ...api, async commit() { throw new CommitConflictError("server advanced"); } };
    const errors: string[] = [];
    await reconcileAll(deps(conflicting, io, { base, onFileError: (p) => errors.push(p) }));
    expect(errors).toContain("n.md");                  // conflict isolated per-file, never fatal
    expect(dec((io as any).m.get("n.md"))).toBe("v2");  // local edit preserved, not clobbered
    expect(base.get("n.md")?.hash).toBe(hv1);           // base unchanged → next pass sees divergence → merge
  });

  it("Round-6 CONC: a CAS conflict on the SINGLE-PATH event reconcile is isolated (no throw → engine won't flap offline)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "v1");
    const hv1 = await sha256hex(enc("v1"));
    const base = new BaseStore(); base.set("n.md", { hash: hv1 }); // base==remote → local edit decides 'push'
    const io = fakeIo({ "n.md": "v2" });
    const conflicting: SyncApi = { ...api, async commit() { throw new CommitConflictError("advanced"); } };
    const errors: string[] = [];
    // Must RESOLVE (not reject): a throw here becomes failToOffline in the engine — an offline flap
    // on a routine concurrent edit. It isolates the conflict instead and converges next pass.
    await expect(reconcilePath(deps(conflicting, io, { base, onFileError: (p) => errors.push(p) }), "n.md", 2)).resolves.toBeUndefined();
    expect(errors).toContain("n.md");
    expect(dec((io as any).m.get("n.md"))).toBe("v2"); // local edit preserved
    expect(base.get("n.md")?.hash).toBe(hv1);          // base unchanged → merges next pass
  });

  it("Round-6 CONC: a non-conflict error on the single-path reconcile STILL propagates (engine goes offline)", async () => {
    const { api } = fakeServer();
    const io = fakeIo({ "n.md": "v2" });
    const broken: SyncApi = { ...api, async fileMeta() { throw new Error("network down"); } };
    // A genuine connectivity error must NOT be swallowed — the engine should go offline + reconnect.
    await expect(reconcilePath(deps(broken, io), "n.md", 2)).rejects.toThrow("network down");
  });
});

describe("reconcileDelta (RS-3 incremental remote reconcile)", () => {
  it("reconciles ONLY the delta's paths — a full-vault change is left untouched", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, "changed.md", "from server");
    const delta = await api.changes(0);                    // upserts:[changed.md], deletes:[]
    const io = fakeIo({ "untouched.md": "local-only, not in the delta" });
    await reconcileDelta(deps(api, io), delta);
    expect(dec((io as any).m.get("changed.md"))).toBe("from server"); // the delta path pulled
    expect(files.has("untouched.md")).toBe(false);          // NOT pushed — it wasn't in the delta
  });

  it("applies a delta tombstone (real positive-evidence deletion)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "gone.md", "v1");
    const io = fakeIo({ "gone.md": "v1" });
    const base = new BaseStore(); base.set("gone.md", { hash: await sha256hex(enc("v1")) });
    const d = deps(api, io, { base });
    await api.deleteFile("gone.md");                        // server records a tombstone
    const delta = await api.changes(0);                     // upserts:[], deletes:[gone.md]
    await reconcileDelta(d, delta);
    expect((io as any).m.has("gone.md")).toBe(false);       // deleted locally on the tombstone
  });

  it("guards a suspicious MASS tombstone delta (keeps the files)", async () => {
    const { api } = fakeServer();
    const seed: Record<string, string> = {}; for (let i = 0; i < 10; i++) seed[`f${i}.md`] = "x";
    const io = fakeIo(seed);
    const base = new BaseStore();
    const hx = await sha256hex(enc("x"));
    for (let i = 0; i < 10; i++) base.set(`f${i}.md`, { hash: hx });
    // A delta that tombstones 8 of 10 base files at once (>= the ratio) — treated as a mass-delete.
    const delta = { version: 100, upserts: [], deletes: Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.md`, version: 90 + i })) };
    const guarded: string[] = [];
    await reconcileDelta(deps(api, io, { base, onGuard: (p) => guarded.push(p) }), delta as any);
    for (let i = 0; i < 8; i++) expect((io as any).m.has(`f${i}.md`)).toBe(true); // kept, not deleted
    expect(guarded.length).toBe(8);
  });
});

describe("RS-4 base-text cap", () => {
  it("keeps merge-ancestor text for a small file but hash-only for a large one", async () => {
    const { api } = fakeServer();
    const small = "small note";
    const large = "x".repeat(MAX_BASE_TEXT_BYTES + 10); // just over the 1 MiB cap
    const io = fakeIo({ "small.md": small, "large.md": large });
    const base = new BaseStore();
    await reconcileAll(deps(api, io, { base }));
    expect(base.get("small.md")?.text).toBe(small);       // small text kept (3-way merge works)
    expect(base.get("large.md")?.text).toBeUndefined();    // over the cap -> hash-only base
    expect(base.get("large.md")?.hash).toBeTruthy();       // still tracked (conflict-copies on divergence)
  });
});

// R14 perf (Finding 2): a whole-vault reconcile must NOT re-read + re-hash a file whose (size,mtime)
// are unchanged since it was last confirmed in-sync — the scan-skip cache.
describe("R14 perf: scan-skip cache", () => {
  it("a second whole-vault pass does NOT re-read an unchanged file", async () => {
    const { api } = fakeServer();
    await serverPut(api, "a.md", "content A");
    const io = fakeIo({ "a.md": "content A" });
    const base = new BaseStore();
    const d = deps(api, io, { base });
    await reconcileAll(d); // first pass: reads + hashes + stamps (size,mtime) into base
    let reads = 0;
    const orig = (io as any).read.bind(io);
    (io as any).read = async (p: string) => { reads++; return orig(p); };
    await reconcileAll(d); // second pass: (size,mtime) unchanged → scan-skip, no read
    expect(reads).toBe(0);
  });

  it("R15 DI#1: a scan-hit never delete-locals on an ASSUMED hash (masked edit + server tombstone keeps the file)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "AAA");
    await api.deleteFile("n.md");                 // server TOMBSTONES it → rmeta now absent for n.md
    const io = fakeIo({ "n.md": "BBB" });          // locally EDITED to same-LENGTH content (size+mtime match the stamp)
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("AAA")), size: 3, mtime: 0 }); // stamped as in-sync at "AAA"
    await reconcileAll(deps(api, io, { base }));
    // scan-skip is gated on rmeta PRESENT, so a tombstoned path is READ (not assumed) → local != base
    // → edit-wins-keep-local preserves + re-pushes it. It must NOT be silently delete-local'd.
    expect(dec(await io.read("n.md"))).toBe("BBB");
  });

  it("a CHANGED file (different size) is still re-read and re-synced", async () => {
    const { api } = fakeServer();
    await serverPut(api, "a.md", "v1");
    const io = fakeIo({ "a.md": "v1" });
    const base = new BaseStore();
    const d = deps(api, io, { base });
    await reconcileAll(d);
    await io.write("a.md", enc("v2-longer")); // size + mtime differ from the stamped hint
    let reads = 0;
    const orig = (io as any).read.bind(io);
    (io as any).read = async (p: string) => { reads++; return orig(p); };
    await reconcileAll(d);
    expect(reads).toBeGreaterThan(0);                          // cache MISS → re-read
    expect((await api.changes(0)).upserts.find((m) => m.path === "a.md")!.hash)
      .toBe(await sha256hex(enc("v2-longer")));                 // and the change was pushed
  });
});

// R14: the incremental delta/config-scan paths must not silently strand a transiently-failed file
// (below the cursor → not retried until the 15-min full scan) or flap the whole engine offline.
describe("R14 sync-correctness fixes", () => {
  it("sync#1: a failed remote pull holds the delta cursor below its version so it's retried", async () => {
    const { api } = fakeServer();
    await serverPut(api, "a.md", "A"); // server version 2
    await serverPut(api, "b.md", "B"); // server version 3
    const io = fakeIo({});
    const origWrite = (io as any).write.bind(io);
    (io as any).write = async (p: string, b: Uint8Array) => { if (p === "a.md") throw new Error("disk full"); return origWrite(p, b); };
    const state = { version: 1 };
    const delta = await api.changes(1); // upserts a.md(v2)+b.md(v3), delta.version=3
    const errs: string[] = [];
    await reconcileDelta(deps(api, io, { state, accepts: () => true, onFileError: (p) => errs.push(p) }), delta);
    expect(errs).toContain("a.md");
    expect(state.version).toBe(1);         // held below a.md's failed version (2), NOT advanced to 3
    expect((io as any).m.has("b.md")).toBe(true); // the healthy sibling still applied (isolation)
  });

  it("sync#1: a clean delta still advances the cursor fully (no regression)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "a.md", "A");
    await serverPut(api, "b.md", "B");
    const io = fakeIo({});
    const state = { version: 1 };
    const delta = await api.changes(1);
    await reconcileDelta(deps(api, io, { state, accepts: () => true }), delta);
    expect(state.version).toBe(delta.version); // no failures → cursor advances to the server version
  });

  it("R18: a permanently-failing pull stops pinning the cursor after MAX_PULL_RETRIES + fires onPullExhausted", async () => {
    const { api } = fakeServer();
    await serverPut(api, "keep.md", "anchor");
    const io = fakeIo({});
    const state = { version: 0 };
    const budget = new Map<string, { version: number; count: number }>();
    const exhausted: string[] = [];
    const d = deps(api, io, { state, retryBudget: budget, onPullExhausted: (p) => exhausted.push(p), onFileError: () => {} });
    await reconcileAll(d); // keep.md syncs; cursor advances to the server version
    // Add a file whose download will ALWAYS fail (simulate a corrupt server copy).
    await serverPut(api, "bad.md", "payload");
    const badV = (await api.changes(0)).upserts.find((m) => m.path === "bad.md")!.version;
    (api as any).getChunk = async () => { throw new Error("corrupt chunk fetch"); };
    // Poll repeatedly. Under budget the cursor is HELD below bad.md; once exhausted it advances past.
    for (let i = 0; i < MAX_PULL_RETRIES; i++) {
      await reconcileDelta(d, await api.changes(state.version));
    }
    expect(exhausted).toContain("bad.md");                 // gave up after MAX_PULL_RETRIES failures
    expect((io as any).m.has("bad.md")).toBe(false);        // never applied (corrupt)
    expect(state.version).toBeGreaterThanOrEqual(badV);     // cursor advanced PAST it (no longer re-downloaded every poll)
  });

  it("R20: switchTo(upload) does NOT restore old base for a failed push (local preserved, never silently overwritten)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "shared.md", "TARGET"); // the target vault already holds shared.md, different content
    await serverPut(api, "keep.md", "k");
    const io = fakeIo({ "shared.md": "LOCAL-WINS", "keep.md": "k" });
    const base = new BaseStore();
    base.set("shared.md", { hash: await sha256hex(enc("OLD")) }); // stale OLD-vault base
    const realCommit = api.commit.bind(api);
    (api as any).commit = async (req: any) => { if (req.path === "shared.md") throw new Error("push failed"); return realCommit(req); };
    const errs: string[] = [];
    await switchTo(deps(api, io, { base, onFileError: (p) => errs.push(p) }), "upload");
    expect(errs).toContain("shared.md");
    // Base must NOT be restored to the old-vault entry — leaving it null makes the retry conflict-COPY
    // (preserving LOCAL), never decide()=pull that would silently overwrite local with the target's copy.
    expect(base.get("shared.md")).toBeUndefined();
  });

  it("sync#2: reconcileLocalConfig isolates a per-file error instead of flapping the engine offline", async () => {
    const { api } = fakeServer();
    await serverPut(api, ".obsidian/app.json", "cfg");
    const io = fakeIo({ ".obsidian/app.json": "local-edit" });
    const base = new BaseStore();
    base.set(".obsidian/app.json", { hash: await sha256hex(enc("cfg")), text: "cfg" });
    (api as any).fileMeta = async () => { throw new Error("HTTP 500"); }; // transient error reconciling this file
    const errs: string[] = [];
    // Pre-fix this threw out of reconcileLocalConfig → doReconcileAll → engine offline. Now isolated.
    await reconcileLocalConfig(deps(api, io, { base, accepts: () => true, onFileError: (p) => errs.push(p) }));
    expect(errs).toContain(".obsidian/app.json");
  });
});

describe("crit-round: the delta reconcile path guards a present-but-unreadable file (C1 no longer inert)", () => {
  it("a delta TOMBSTONE for a present-but-unreadable file does NOT clear base or delete it (no resurrection)", async () => {
    const { api } = fakeServer();
    const io = fakeIo({ "x.md": "hello" });
    io.exists = async (p) => io.m.has(p);                 // vault reports the file PRESENT
    const realRead = io.read.bind(io);
    io.read = async (p) => { if (p === "x.md") throw new Error("EBUSY (AV lock / unhydrated placeholder)"); return realRead(p); };
    const d = deps(api, io);
    d.base.set("x.md", { hash: await sha256hex(enc("hello")), size: 5, mtime: 0 });
    const errs: string[] = []; d.onFileError = (p) => errs.push(p);
    await reconcileDelta(d, { version: 5, upserts: [], deletes: [{ path: "x.md", version: 5 }] } as ChangesResponse);
    expect(io.m.has("x.md")).toBe(true);                  // file NOT removed
    expect(d.base.get("x.md")).toBeTruthy();              // base NOT cleared → won't re-push (resurrect) next pass
    expect(errs).toContain("x.md");                       // isolated as a per-file skip, retried next poll
  });

  it("a delta upsert whose hash equals base (R===B) for an unreadable file does NOT delete it server-side", async () => {
    const { api, files } = fakeServer();
    const hx = await sha256hex(enc("hello"));
    let deleted = false;
    const realDelete = api.deleteFile.bind(api);
    (api as any).deleteFile = async (p: string) => { deleted = true; return realDelete(p); };
    const io = fakeIo({ "x.md": "hello" });
    io.exists = async (p) => io.m.has(p);
    io.read = async () => { throw new Error("EBUSY"); };
    const d = deps(api, io);
    d.base.set("x.md", { hash: hx, size: 5, mtime: 0 });
    // remote reports x.md unchanged (hash === base) — the R===B delta that used to yield delete-remote.
    await reconcileDelta(d, { version: 5, upserts: [{ path: "x.md", hash: hx, size: 5, mtime: 0, chunks: [], version: 5 } as any], deletes: [] } as ChangesResponse);
    expect(deleted).toBe(false);                          // never propagated a phantom deletion
    expect(d.base.get("x.md")).toBeTruthy();
  });
});

describe("crit-round: the delete-local restore is CAS-guarded (no lost update)", () => {
  it("restoring an absent-without-tombstone file commits with expectedVersion 0", async () => {
    const { api } = fakeServer();
    const io = fakeIo({ "x.md": "restore me" });
    const d = deps(api, io);
    d.base.set("x.md", { hash: await sha256hex(enc("restore me")), size: 10, mtime: 0 });
    let seenExpected: number | undefined = -1;
    const realCommit = api.commit.bind(api);
    (api as any).commit = async (r: CommitRequest) => { seenExpected = r.expectedVersion; return realCommit(r); };
    // Full reconcile: local present, base present, remote ABSENT, no tombstone → delete-local → restore.
    await reconcileAll(d);
    expect(seenExpected).toBe(0);                          // "expected absent" → a concurrent create 409s instead of clobbering
  });
});

describe("crit-round: a 'download' vault switch cannot mass-delete local files against a partial manifest", () => {
  it("refuses to remove local-only files when the target manifest is suspiciously incomplete", async () => {
    const { api } = fakeServer();
    const seed: Record<string, string> = {};
    for (let i = 0; i < 10; i++) seed[`n${i}.md`] = `c${i}`;
    const io = fakeIo(seed);
    await serverPut(api, "n0.md", "c0");                  // target has only 1 of the 10 local files
    const d = deps(api, io);
    const guarded: string[] = []; d.onGuard = (p) => guarded.push(p);
    await switchTo(d, "download");
    for (let i = 1; i < 10; i++) expect(io.m.has(`n${i}.md`)).toBe(true); // local-only notes preserved
    expect(guarded.length).toBeGreaterThan(0);            // the mass-delete was guarded, not silently applied
  });

  it("still mirrors a genuine (mostly-overlapping) target — normal download deletes the few real extras", async () => {
    const { api } = fakeServer();
    const seed: Record<string, string> = {};
    for (let i = 0; i < 10; i++) seed[`n${i}.md`] = `c${i}`;
    const io = fakeIo(seed);
    for (let i = 0; i < 9; i++) await serverPut(api, `n${i}.md`, `c${i}`); // target has 9/10 — only n9 is a local extra
    const d = deps(api, io);
    await switchTo(d, "download");
    expect(io.m.has("n9.md")).toBe(false);                // the single genuine extra IS removed (ratio not tripped)
    expect(io.m.has("n0.md")).toBe(true);
  });
});

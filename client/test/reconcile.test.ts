import { describe, it, expect } from "vitest";
import { decide, reconcileAll, reconcilePath, switchTo, resolveConfigConflict, ReconcileDeps } from "../src/reconcile";
import { BaseStore } from "../src/base";
import { SyncApi, VaultIo, SyncState, ChunkCache, pushFile } from "../src/sync";
import { sha256hex } from "../src/chunker";
import { ChangesResponse, CommitRequest, FileMeta } from "../src/protocol";

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
  const api: SyncApi = {
    async changes(since) { return { version, upserts: [...files.values()].filter((f) => f.version > since), deletes: [] } as ChangesResponse; },
    async fileMeta(p) { return files.get(p) ?? null; },
    async missing(hs) { return hs.filter((h) => !chunks.has(h)); },
    async getChunk(h) { return chunks.get(h)!; },
    async putChunk(h, b) { chunks.set(h, b); },
    async commit(r: CommitRequest) { const m: FileMeta = { ...r, version: ++version }; files.set(r.path, m); return m; },
    async deleteFile(p) { files.delete(p); },
  };
  return { api, chunks, files };
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
  return { api, io, base: new BaseStore(), cache: new Map() as ChunkCache, state: { version: 0 }, device: "Dev", strategy: "auto-merge", ...extra };
}
async function serverPut(api: SyncApi, path: string, text: string) {
  await pushFile(api, fakeIo({ [path]: text }), { version: 0 }, new Map() as ChunkCache, path);
}

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

  it("C2: refuses bulk delete-local when the server manifest is empty but base is non-empty", async () => {
    const { api } = fakeServer(); // empty server (e.g. lost index)
    const io = fakeIo({ "keep.md": "important" });
    const base = new BaseStore();
    base.set("keep.md", { hash: await sha256hex(enc("important")) });
    const guarded: string[] = [];
    await reconcileAll(deps(api, io, { base, onGuard: (p) => guarded.push(p) }));
    expect((io as any).m.has("keep.md")).toBe(true);   // NOT deleted
    expect(guarded).toContain("keep.md");               // guard fired
    expect(base.get("keep.md")).toBeDefined();          // base preserved
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

  it("reconcilePath (event path) applies the C2 guard — no delete-local vs a wholesale-empty server", async () => {
    const { api } = fakeServer(); // empty (lost index → /meta 404 for everything)
    const io = fakeIo({ "keep.md": "data" });
    const base = new BaseStore();
    base.set("keep.md", { hash: await sha256hex(enc("data")) });
    const guarded: string[] = [];
    await reconcilePath(deps(api, io, { base, onGuard: (p) => guarded.push(p) }), "keep.md", 4);
    expect((io as any).m.has("keep.md")).toBe(true); // NOT deleted by a stray event
    expect(guarded).toContain("keep.md");
  });

  it("still honors delete-local when the server has other files (not a suspicious empty)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "other.md", "still here"); // server non-empty
    const io = fakeIo({ "gone.md": "x", "other.md": "still here" });
    const base = new BaseStore();
    base.set("gone.md", { hash: await sha256hex(enc("x")) });
    base.set("other.md", { hash: await sha256hex(enc("still here")) });
    await reconcileAll(deps(api, io, { base }));
    expect((io as any).m.has("gone.md")).toBe(false);  // legit delete still happens
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

  it("removal (remote gone, local==base) → PROPAGATES: local file deleted (auto-remove, D0013)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "other.md", "keeps the manifest non-empty (no C2)"); // avoid the empty-server guard
    const io = fakeIo({ [CP]: `["foo"]`, "other.md": "keeps the manifest non-empty (no C2)" });
    const base = new BaseStore();
    base.set(CP, { hash: await sha256hex(enc(`["foo"]`)) });
    base.set("other.md", { hash: await sha256hex(enc("keeps the manifest non-empty (no C2)")) });
    const conflicts: string[] = [];
    await reconcileAll(deps(api, io, { base, accepts: () => true, onConfigConflict: (p) => conflicts.push(p) }));
    expect(conflicts).toEqual([]);                 // genuine removal propagates, not adjudicated
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

  it("DI-1: refuses bulk delete-local when the server manifest lost >= half of base (partial shrink)", async () => {
    const { api } = fakeServer();
    const seed: Record<string, string> = {}; for (let i = 0; i < 8; i++) seed[`n${i}.md`] = `c${i}`;
    const io = fakeIo(seed);
    const base = new BaseStore(); for (let i = 0; i < 8; i++) base.set(`n${i}.md`, { hash: await sha256hex(enc(`c${i}`)) });
    for (let i = 0; i < 3; i++) await serverPut(api, `n${i}.md`, `c${i}`); // only 3 of 8 advertised (5 lost)
    const guarded: string[] = [];
    await reconcileAll(deps(api, io, { base, onGuard: (p) => guarded.push(p) }));
    for (let i = 3; i < 8; i++) expect((io as any).m.has(`n${i}.md`)).toBe(true); // the 5 missing NOT deleted
    expect(guarded.length).toBeGreaterThan(0);
  });

  it("DI-1: still deletes when only a small fraction is missing (below the bulk threshold)", async () => {
    const { api } = fakeServer();
    const seed: Record<string, string> = {}; for (let i = 0; i < 8; i++) seed[`n${i}.md`] = `c${i}`;
    const io = fakeIo(seed);
    const base = new BaseStore(); for (let i = 0; i < 8; i++) base.set(`n${i}.md`, { hash: await sha256hex(enc(`c${i}`)) });
    for (let i = 0; i < 6; i++) await serverPut(api, `n${i}.md`, `c${i}`); // 6 of 8 (only 2 missing = 25%)
    await reconcileAll(deps(api, io, { base }));
    expect((io as any).m.has("n6.md")).toBe(false); // genuine small delete still applies
    expect((io as any).m.has("n7.md")).toBe(false);
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
});

describe("settings drive behavior: conflict strategy + device name", () => {
  it("conflictStrategy 'auto-merge' merges cleanly-mergeable concurrent edits", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "l1\nl2\nl3\n");
    const io = fakeIo({ "n.md": "l1\nl2\nl3\n" });
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("l1\nl2\nl3\n")), text: "l1\nl2\nl3\n" });
    (io as any).m.set("n.md", enc("L1\nl2\nl3\n"));   // local edits line 1
    await serverPut(api, "n.md", "l1\nl2\nL3\n");       // remote edits line 3 (non-overlapping)
    await reconcileAll(deps(api, io, { base, strategy: "auto-merge" }));
    const merged = dec((io as any).m.get("n.md")!);
    expect(merged).toContain("L1"); expect(merged).toContain("L3"); // both edits merged
    expect([...(io as any).m.keys()].some((k: string) => k.includes("(conflict"))).toBe(false); // no copy
  });

  it("conflictStrategy 'conflict-file' NEVER auto-merges — keeps both as a conflict copy", async () => {
    const { api } = fakeServer();
    await serverPut(api, "n.md", "l1\nl2\nl3\n");
    const io = fakeIo({ "n.md": "l1\nl2\nl3\n" });
    const base = new BaseStore();
    base.set("n.md", { hash: await sha256hex(enc("l1\nl2\nl3\n")), text: "l1\nl2\nl3\n" });
    (io as any).m.set("n.md", enc("L1\nl2\nl3\n"));   // same cleanly-mergeable edit as above
    await serverPut(api, "n.md", "l1\nl2\nL3\n");
    await reconcileAll(deps(api, io, { base, strategy: "conflict-file" }));
    const m = (io as any).m as Map<string, Uint8Array>;
    expect(dec(m.get("n.md")!)).toBe("l1\nl2\nL3\n"); // remote canonical — NOT merged
    const copies = [...m.keys()].filter((k) => k.includes("(conflict"));
    expect(copies.length).toBe(1);
    expect(dec(m.get(copies[0])!)).toBe("L1\nl2\nl3\n"); // local kept as a copy
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

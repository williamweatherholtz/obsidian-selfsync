import { describe, it, expect } from "vitest";
import { decide, reconcileAll, ReconcileDeps } from "../src/reconcile";
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

import { describe, it, expect } from "vitest";
import { MountedIo, MountedApi, isDataPath } from "../src/mountio";
import { Mount } from "../src/mounts";
import { VaultIo, SyncApi } from "../src/sync";
import { FileMeta, ChangesResponse, CommitRequest } from "../src/protocol";

const mk = (mountPoint: string, sourcePath = "", direction: "pull" | "sync" = "pull"): Mount =>
  ({ source: { owner: "will", vaultId: "asi", sourcePath }, mountPoint, direction });

const meta = (path: string, over: Partial<FileMeta> = {}): FileMeta =>
  ({ path, hash: "h", size: 1, mtime: 100, version: 1, chunks: ["c"], ...over });

// A minimal in-memory VaultIo recording the LOCAL paths each op actually touches.
function fakeIo(files: Record<string, { size: number; mtime: number }>, opts: { withExists?: boolean; withAppend?: boolean } = {}): VaultIo & { reads: string[]; writes: string[]; removes: string[] } {
  const reads: string[] = [], writes: string[] = [], removes: string[] = [];
  const io: any = {
    reads, writes, removes,
    list: async () => new Map(Object.entries(files).map(([p, s]) => [p, s])),
    read: async (p: string) => { reads.push(p); return new Uint8Array([1]); },
    write: async (p: string) => { writes.push(p); },
    remove: async (p: string) => { removes.push(p); },
  };
  if (opts.withExists) io.exists = async (p: string) => { reads.push("exists:" + p); return p in files; };
  if (opts.withAppend) io.appendWrite = async (p: string) => { writes.push("append:" + p); return { append: async () => {}, close: async () => {}, abort: async () => {} }; };
  return io;
}

// A minimal in-memory SyncApi recording SOURCE paths, returning canned changes/meta.
function fakeApi(changes: ChangesResponse, byPath: Record<string, FileMeta>): SyncApi & { committed: CommitRequest[]; deleted: string[]; metaAsked: string[] } {
  const committed: CommitRequest[] = [], deleted: string[] = [], metaAsked: string[] = [];
  return {
    committed, deleted, metaAsked,
    changes: async () => changes,
    fileMeta: async (p: string) => { metaAsked.push(p); return byPath[p] ?? null; },
    commit: async (req: CommitRequest) => { committed.push(req); return meta(req.path, { version: 9 }); },
    deleteFile: async (p: string) => { deleted.push(p); },
    missing: async (h: string[]) => h,
    getChunk: async () => new Uint8Array(),
    putChunk: async () => {},
  } as any;
}

describe("isDataPath — the data-only boundary", () => {
  it("rejects the .obsidian config/plugin tree, accepts notes/attachments", () => {
    expect(isDataPath("notes/a.md")).toBe(true);
    expect(isDataPath("attachments/img.png")).toBe(true);
    expect(isDataPath(".obsidian")).toBe(false);
    expect(isDataPath(".obsidian/plugins/x/main.js")).toBe(false);
    expect(isDataPath("")).toBe(false);
    expect(isDataPath(".obsidianx/a.md")).toBe(true); // name-prefix sibling is NOT the config folder
  });
  it("is CASE-FOLDED so a case variant can't bypass on a case-insensitive FS", () => {
    expect(isDataPath(".Obsidian/app.json")).toBe(false);
    expect(isDataPath(".OBSIDIAN/x")).toBe(false);
  });
});

describe("MountedIo — local-side prefix translation", () => {
  const mount = mk("Work/ASI");
  it("read/write/remove prefix the mountPoint onto the mount-relative path", async () => {
    const io = fakeIo({});
    const m = new MountedIo(io, mount);
    await m.read("notes/a.md"); await m.write("notes/b.md", new Uint8Array()); await m.remove("notes/c.md");
    expect(io.reads).toEqual(["Work/ASI/notes/a.md"]);
    expect(io.writes).toEqual(["Work/ASI/notes/b.md"]);
    expect(io.removes).toEqual(["Work/ASI/notes/c.md"]);
  });
  it("list() returns ONLY the mount subtree, re-keyed to mount-relative + data-only-filtered", async () => {
    const io = fakeIo({
      "Work/ASI/notes/a.md": { size: 1, mtime: 10 },
      "Work/ASI/.obsidian/x.json": { size: 2, mtime: 20 },   // config under the mount → dropped (data-only)
      "Work/Other/b.md": { size: 3, mtime: 30 },             // outside the mount → dropped
      "Work/ASIx/c.md": { size: 4, mtime: 40 },              // name-prefix sibling → dropped (segment boundary)
    });
    const list = await new MountedIo(io, mount).list();
    expect([...list.keys()]).toEqual(["notes/a.md"]);
    expect(list.get("notes/a.md")).toEqual({ size: 1, mtime: 10 });
  });
  it("mirrors the base's exists/appendWrite CAPABILITY (present when base has them, absent otherwise)", async () => {
    const bare = new MountedIo(fakeIo({}), mount);
    expect(bare.exists).toBeUndefined();
    expect(bare.appendWrite).toBeUndefined();
    const full = fakeIo({ "Work/ASI/notes/a.md": { size: 1, mtime: 1 } }, { withExists: true, withAppend: true });
    const mio = new MountedIo(full, mount);
    expect(await mio.exists!("notes/a.md")).toBe(true);
    expect(await mio.exists!("notes/missing.md")).toBe(false);
    await mio.appendWrite!("notes/big.md");
    expect(full.reads).toContain("exists:Work/ASI/notes/a.md");
    expect(full.writes).toContain("append:Work/ASI/notes/big.md");
  });
});

describe("MountedApi — source-side prefix translation", () => {
  const mount = mk("Work/ASI", "Projects", "sync");
  it("changes(): source paths → mount-relative, dropping outside-subtree + config", async () => {
    const api = fakeApi({
      version: 5,
      upserts: [meta("Projects/notes/a.md"), meta("Reference/b.md"), meta("Projects/.obsidian/x.json")],
      deletes: [{ path: "Projects/notes/gone.md", version: 3 }, { path: "Elsewhere/x.md", version: 4 }],
    }, {});
    const r = await new MountedApi(api, mount).changes(0);
    expect(r.version).toBe(5); // cursor still advances over the source vault's global version
    expect(r.upserts.map((u) => u.path)).toEqual(["notes/a.md"]); // Reference/* outside subtree, .obsidian/* config → dropped
    expect(r.deletes.map((d) => d.path)).toEqual(["notes/gone.md"]);
  });
  it("fileMeta(): asks the SOURCE path, returns the meta re-keyed to mount-relative", async () => {
    const api = fakeApi({ version: 0, upserts: [], deletes: [] }, { "Projects/notes/a.md": meta("Projects/notes/a.md", { hash: "H" }) });
    const m = await new MountedApi(api, mount).fileMeta("notes/a.md");
    expect(api.metaAsked).toEqual(["Projects/notes/a.md"]);
    expect(m).toMatchObject({ path: "notes/a.md", hash: "H" });
    expect(await new MountedApi(api, mount).fileMeta("notes/missing.md")).toBeNull();
  });
  it("commit()/deleteFile() prefix sourcePath and re-key the returned meta", async () => {
    const api = fakeApi({ version: 0, upserts: [], deletes: [] }, {});
    const mapi = new MountedApi(api, mount);
    const out = await mapi.commit({ path: "notes/a.md", hash: "h", size: 1, mtime: 1, chunks: ["c"] });
    expect(api.committed[0].path).toBe("Projects/notes/a.md");
    expect(out.path).toBe("notes/a.md"); // caller sees mount-relative
    await mapi.deleteFile("notes/gone.md", 7);
    expect(api.deleted).toEqual(["Projects/notes/gone.md"]);
  });
  it("whole-source mount (sourcePath '') passes source paths through unprefixed", async () => {
    const whole = mk("Work/ASI", "", "sync");
    const api = fakeApi({ version: 1, upserts: [meta("notes/a.md")], deletes: [] }, {});
    const r = await new MountedApi(api, whole).changes(0);
    expect(r.upserts.map((u) => u.path)).toEqual(["notes/a.md"]);
  });
});

describe("MountedApi — read-only invariant for a PULL mount (the load-bearing safety net)", () => {
  const pull = mk("Work/ASI", "Projects", "pull");
  it("HARD-REFUSES commit and deleteFile so a pull mount can never mutate its source", async () => {
    const api = fakeApi({ version: 0, upserts: [], deletes: [] }, {});
    const mapi = new MountedApi(api, pull);
    await expect(mapi.commit({ path: "notes/a.md", hash: "h", size: 1, mtime: 1, chunks: ["c"] })).rejects.toThrow(/pull \(read-only\)/);
    await expect(mapi.deleteFile("notes/a.md")).rejects.toThrow(/pull \(read-only\)/);
    expect(api.committed).toEqual([]);
    expect(api.deleted).toEqual([]);
  });
  it("a SYNC mount still refuses to WRITE or DELETE a config path across the boundary (symmetric guards)", async () => {
    const api = fakeApi({ version: 0, upserts: [], deletes: [] }, {});
    const sync = new MountedApi(api, mk("Work/ASI", "Projects", "sync"));
    await expect(sync.commit({ path: ".obsidian/x.json", hash: "h", size: 1, mtime: 1, chunks: ["c"] })).rejects.toThrow(/non-data \(config\)/);
    await expect(sync.deleteFile(".obsidian/x.json")).rejects.toThrow(/non-data \(config\)/);
    expect(api.committed).toEqual([]);
    expect(api.deleted).toEqual([]);
  });
  it("fileMeta returns null for a config path — config is invisible across the boundary even via a direct lookup", async () => {
    const api = fakeApi({ version: 0, upserts: [], deletes: [] }, { "Projects/.obsidian/x.json": meta("Projects/.obsidian/x.json") });
    const m = await new MountedApi(api, mk("Work/ASI", "Projects", "sync")).fileMeta(".obsidian/x.json");
    expect(m).toBeNull();
    expect(api.metaAsked).toEqual([]); // short-circuits before touching the source
  });
});

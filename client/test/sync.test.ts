import { describe, it, expect } from "vitest";
import { pull, pushLocal, SyncApi, VaultIo, SyncState } from "../src/sync";
import { ChangesResponse, FileMeta } from "../src/protocol";

function fakeIo(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const io: VaultIo & { files: Map<string,string> } = {
    files,
    async list() { const m = new Map<string,{mtime:number}>(); for (const k of files.keys()) m.set(k,{mtime:0}); return m; },
    async read(p) { return files.get(p) ?? ""; },
    async write(p, d) { files.set(p, d); },
    async remove(p) { files.delete(p); },
  };
  return io;
}

function fakeApi(server: Record<string,string>, resp: ChangesResponse): SyncApi {
  return {
    async changes() { return resp; },
    async getFile(p) { return server[p]; },
    async putFile(p, d, mtime): Promise<FileMeta> { server[p] = d; return { path:p, hash:"h", size:d.length, mtime, version: 9 }; },
    async deleteFile(p) { delete server[p]; },
  };
}

describe("pull", () => {
  it("writes upserts and deletes locally and advances version", async () => {
    const io = fakeIo({ "old.md": "gone" });
    const resp: ChangesResponse = {
      version: 7,
      upserts: [{ path: "new.md", hash: "h", size: 3, mtime: 1, version: 5 }],
      deletes: [{ path: "old.md", version: 6 }],
    };
    const api = fakeApi({ "new.md": "abc" }, resp);
    const state: SyncState = { version: 0 };
    await pull(api, io, state);
    expect(io.files.get("new.md")).toBe("abc");
    expect(io.files.has("old.md")).toBe(false);
    expect(state.version).toBe(7);
  });
});

describe("pushLocal", () => {
  it("skips known paths, pushes new ones, updates version and knownPaths", async () => {
    const server: Record<string, string> = {};
    const io = fakeIo({ "a.md": "aaa", "b.md": "bbb" });
    const resp: ChangesResponse = {
      version: 0,
      upserts: [],
      deletes: [],
    };
    const api = fakeApi(server, resp);
    const knownPaths = new Set(["a.md"]);
    const state: SyncState = { version: 0 };

    await pushLocal(api, io, state, knownPaths);

    expect(server["b.md"]).toBe("bbb");
    expect(server["a.md"]).toBeUndefined();
    expect(knownPaths.has("b.md")).toBe(true);
    expect(state.version).toBe(9);
  });
});

import { describe, it, expect } from "vitest";
import { pull, pushFile, pushLocalNew, SyncApi, VaultIo, SyncState, ChunkCache } from "../src/sync";
import { chunk, sha256hex } from "../src/chunker";
import { ChangesResponse, CommitRequest, FileMeta } from "../src/protocol";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// In-memory fake server implementing the chunk SyncApi.
function fakeServer() {
  const chunks = new Map<string, Uint8Array>();
  const files = new Map<string, FileMeta>();
  let version = 1;
  const api: SyncApi = {
    async changes(since) {
      return { version, upserts: [...files.values()].filter((f) => f.version > since), deletes: [] } as ChangesResponse;
    },
    async missing(hashes) { return hashes.filter((h) => !chunks.has(h)); },
    async getChunk(h) { return chunks.get(h)!; },
    async putChunk(h, b) { chunks.set(h, b); },
    async commit(req: CommitRequest) { const m: FileMeta = { ...req, version: ++version }; files.set(req.path, m); return m; },
    async deleteFile(p) { files.delete(p); },
  };
  return { api, chunks, files };
}

function fakeIo(seed: Record<string, string> = {}) {
  const m = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, enc(v)]));
  const io: VaultIo & { m: Map<string, Uint8Array> } = {
    m,
    async list() { const r = new Map<string, { mtime: number }>(); for (const k of m.keys()) r.set(k, { mtime: 0 }); return r; },
    async read(p) { return m.get(p)!; },
    async write(p, b) { m.set(p, b); },
    async remove(p) { m.delete(p); },
  };
  return io;
}

describe("chunk sync engine", () => {
  it("pushFile uploads only missing chunks then commits", async () => {
    const { api, chunks } = fakeServer();
    const io = fakeIo({ "a.md": "hello world" });
    const cache: ChunkCache = new Map();
    const h = await pushFile(api, io, { version: 0 }, cache, "a.md");
    expect(h).toBe(await sha256hex(enc("hello world")));
    const cs = await chunk(enc("hello world"));
    for (const c of cs) expect(chunks.has(c.hash)).toBe(true);
  });

  it("pushFile re-push of an unchanged file uploads no new chunks (dedup)", async () => {
    const { api } = fakeServer();
    const io = fakeIo({ "a.md": "hello world" });
    const cache: ChunkCache = new Map();
    await pushFile(api, io, { version: 0 }, cache, "a.md");
    // spy: count putChunk calls on a second push of identical content
    let puts = 0;
    const origPut = api.putChunk;
    api.putChunk = async (h, b) => { puts++; return origPut(h, b); };
    await pushFile(api, io, { version: 0 }, cache, "a.md");
    expect(puts).toBe(0); // all chunks already on the server
  });

  it("pull reassembles a file from chunks and writes bytes", async () => {
    const { api } = fakeServer();
    const ioA = fakeIo({ "n.md": "the quick brown fox" });
    await pushFile(api, ioA, { version: 0 }, new Map(), "n.md");
    const ioB = fakeIo();
    const state: SyncState = { version: 0 };
    await pull(api, ioB, state, new Map());
    expect(dec(ioB.m.get("n.md")!)).toBe("the quick brown fox");
    expect(state.version).toBeGreaterThan(0);
  });

  it("pull round-trips a binary file (non-UTF8 bytes) intact", async () => {
    const { api } = fakeServer();
    const bin = new Uint8Array(40000); for (let i = 0; i < bin.length; i++) bin[i] = (i * 37) & 0xff;
    const ioA = fakeIo(); ioA.m.set("img.bin", bin);
    await pushFile(api, ioA, { version: 0 }, new Map(), "img.bin");
    const ioB = fakeIo();
    await pull(api, ioB, { version: 0 }, new Map());
    expect(ioB.m.get("img.bin")).toEqual(bin);
  });

  it("pushLocalNew skips known paths and pushes only new ones", async () => {
    const { api, files } = fakeServer();
    const io = fakeIo({ "a.md": "aaa", "b.md": "bbb" });
    const known = new Set(["a.md"]);
    await pushLocalNew(api, io, { version: 0 }, new Map(), known);
    expect(files.has("b.md")).toBe(true);
    expect(files.has("a.md")).toBe(false);
    expect(known.has("b.md")).toBe(true);
  });
});

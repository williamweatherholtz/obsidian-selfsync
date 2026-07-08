import { describe, it, expect } from "vitest";
import { pushFile, fetchFileBytes, mapPool, streamFileToDisk, SyncApi, VaultIo, ChunkCache } from "../src/sync";
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
    async fileMeta(p) { return files.get(p) ?? null; },
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
    async list() { const r = new Map<string, { mtime: number; size: number }>(); for (const k of m.keys()) r.set(k, { mtime: 0, size: m.get(k)!.length }); return r; },
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
    const { hash: h } = await pushFile(api, io, { version: 0 }, cache, "a.md");
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

  it("fetchFileBytes reassembles a file from its chunk list", async () => {
    const { api } = fakeServer();
    const ioA = fakeIo({ "n.md": "the quick brown fox" });
    await pushFile(api, ioA, { version: 0 }, new Map(), "n.md");
    const meta = (await api.changes(0)).upserts.find((f) => f.path === "n.md")!;
    const bytes = await fetchFileBytes(api, new Map(), meta.chunks);
    expect(dec(bytes)).toBe("the quick brown fox");
  });

  it("fetchFileBytes round-trips a binary file (non-UTF8 bytes) intact", async () => {
    const { api } = fakeServer();
    const bin = new Uint8Array(40000); for (let i = 0; i < bin.length; i++) bin[i] = (i * 37) & 0xff;
    const ioA = fakeIo(); ioA.m.set("img.bin", bin);
    await pushFile(api, ioA, { version: 0 }, new Map(), "img.bin");
    const meta = (await api.changes(0)).upserts.find((f) => f.path === "img.bin")!;
    expect(await fetchFileBytes(api, new Map(), meta.chunks)).toEqual(bin);
  });

  it("mapPool preserves order and bounds concurrency (B11)", async () => {
    let inFlight = 0, peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    const out = await mapPool(items, 6, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2)); // order preserved
    expect(peak).toBeLessThanOrEqual(6);           // never exceeds the limit
    expect(peak).toBeGreaterThan(1);               // genuinely concurrent
  });

  it("streamFileToDisk appends chunks in order and returns true (B9 streaming)", async () => {
    const parts = [enc("111"), enc("22"), enc("3333")];
    const hs = await Promise.all(parts.map((p) => sha256hex(p))); // content-addressed, like the real server
    const store: Record<string, Uint8Array> = {}; hs.forEach((h, i) => (store[h] = parts[i]));
    const api = { async getChunk(h: string) { return store[h]; } } as unknown as SyncApi;
    let written = new Uint8Array(0); let closed = false;
    const io = {
      async list() { return new Map(); }, async read() { throw new Error("no"); }, async write() {}, async remove() {},
      async appendWrite() {
        return {
          append: async (b: Uint8Array) => { const n = new Uint8Array(written.length + b.length); n.set(written); n.set(b, written.length); written = n; },
          close: async () => { closed = true; },
          abort: async () => {},
        };
      },
    } as unknown as VaultIo;
    const ok = await streamFileToDisk(api, new Map() as ChunkCache, io, "big.bin", hs, 9); // "111223333" = 9 bytes
    expect(ok).toBe(true);
    expect(closed).toBe(true);
    expect(dec(written)).toBe("111223333");
  });

  it("streamFileToDisk REJECTS a reassembly whose size ≠ the declared file size (C2)", async () => {
    // A truncated/extra-chunk manifest (e.g. a server index restore mismatched a chunk list to a
    // file hash): each chunk is individually authentic, so per-chunk checks pass, but the whole
    // reassembly is the wrong length. Must abort before close — never write it / launder its hash.
    const good = enc("payload"); const h = await sha256hex(good);
    const api = { async getChunk() { return good; } } as unknown as SyncApi;
    let aborted = false, closed = false;
    const io = {
      async list() { return new Map(); }, async read() { throw new Error("no"); }, async write() {}, async remove() {},
      async appendWrite() { return { append: async () => {}, close: async () => { closed = true; }, abort: async () => { aborted = true; } }; },
    } as unknown as VaultIo;
    await expect(streamFileToDisk(api, new Map() as ChunkCache, io, "f.bin", [h], good.length + 5)).rejects.toThrow(/expected/);
    expect(aborted).toBe(true); expect(closed).toBe(false);
  });

  it("streamFileToDisk REJECTS a chunk whose content doesn't match its hash (DI-2)", async () => {
    // The server returns bytes that don't hash to the requested (content-addressed) hash —
    // e.g. on-disk bit rot. The streamed path must abort, never laundering it onto disk.
    const good = enc("payload"); const goodHash = await sha256hex(good);
    const api = { async getChunk() { return enc("CORRUPTED"); } } as unknown as SyncApi; // wrong bytes
    let aborted = false;
    const io = {
      async list() { return new Map(); }, async read() { throw new Error("no"); }, async write() {}, async remove() {},
      async appendWrite() {
        return { append: async () => {}, close: async () => {}, abort: async () => { aborted = true; } };
      },
    } as unknown as VaultIo;
    await expect(streamFileToDisk(api, new Map() as ChunkCache, io, "f.bin", [goodHash], good.length)).rejects.toThrow(/content verification/);
    expect(aborted).toBe(true);
  });

  it("streamFileToDisk returns false when the io can't stream (mobile fallback)", async () => {
    const api = { async getChunk() { return enc("x"); } } as unknown as SyncApi;
    const io = { async list() { return new Map(); }, async read() { throw new Error("no"); }, async write() {}, async remove() {} } as unknown as VaultIo;
    expect(await streamFileToDisk(api, new Map() as ChunkCache, io, "f", ["a"], 1)).toBe(false);
  });

  it("fetchFileBytes reassembles in order despite out-of-order chunk completion (B11)", async () => {
    const letters = ["a", "b", "c", "d", "e"];
    const store: Record<string, string> = {}; // content-addressed: hash -> letter
    const order: string[] = [];
    for (const l of letters) { const h = await sha256hex(enc(l)); store[h] = l; order.push(h); }
    // later chunks resolve FASTER, so completion order is reversed — output must still be in list order
    const api = {
      async getChunk(h: string) {
        const i = order.indexOf(h);
        await new Promise((r) => setTimeout(r, (order.length - i) * 2));
        return enc(store[h]);
      },
    } as unknown as SyncApi;
    const bytes = await fetchFileBytes(api, new Map() as ChunkCache, order);
    expect(dec(bytes)).toBe("abcde");
  });
});

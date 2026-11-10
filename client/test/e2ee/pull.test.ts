// E3a (2) (3) (4): the engine over E2eeCodec against an in-memory server. A push stores FRAMES under their
// sha256 with hash = sha256(frame stream) and cid over the folded path; the plaintext is cached under the
// frame hash. A pull decodes and checks the cid, never the hash; a mismatching cid or a row without cid is
// not written, logged, and the cursor does not advance past it. The streamed path takes the same check.
import { describe, it, expect } from "vitest";
import { reconcileAll, ReconcileDeps, STREAM_MIN_BYTES } from "../../src/reconcile";
import { BaseStore } from "../../src/base";
import { SyncApi, VaultIo, ChunkCache, pushFile } from "../../src/sync";
import { ChangesResponse, CommitRequest, FileMeta } from "../../src/protocol";
import { E2eeCodec, cacheKey, PLAIN_CODEC } from "../../src/e2ee/codec";
import { createKeyring } from "../../src/e2ee/keyring";
import { deriveSubkeys } from "../../src/e2ee/subkeys";
import { parseFrameHeader } from "../../src/e2ee/frame";
import { sha256hex } from "../../src/chunker";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const FAST = { m_kib: 64, t: 1, p: 1 };

function fakeServer() {
  const chunks = new Map<string, Uint8Array>(); const files = new Map<string, FileMeta>(); let version = 1;
  const api: SyncApi & { files: Map<string, FileMeta>; chunks: Map<string, Uint8Array>; commits: CommitRequest[] } = {
    files, chunks, commits: [],
    async changes(since) { return { version, upserts: [...files.values()].filter((f) => f.version > since), deletes: [] } as ChangesResponse; },
    async fileMeta(p) { return files.get(p) ?? null; },
    async missing(hs) { return hs.filter((h) => !chunks.has(h)); },
    async getChunk(h) { return chunks.get(h)!; },
    async putChunk(h, b) { chunks.set(h, b); },
    async commit(r: CommitRequest) { api.commits.push(r); const m: FileMeta = { ...r, version: ++version }; files.set(r.path, m); return m; },
    async deleteFile(p) { files.delete(p); },
  };
  return api;
}
function fakeIo(seed: Record<string, Uint8Array> = {}, streamed = false) {
  const m = new Map<string, Uint8Array>(Object.entries(seed));
  const io: VaultIo & { m: Map<string, Uint8Array> } = {
    m,
    async list() { const r = new Map<string, { mtime: number; size: number }>(); for (const k of m.keys()) r.set(k, { mtime: 0, size: m.get(k)!.length }); return r; },
    async read(p) { const b = m.get(p); if (!b) throw new Error("ENOENT"); return b; },
    async write(p, b) { m.set(p, b); },
    async remove(p) { m.delete(p); },
  };
  if (streamed) io.appendWrite = async (p) => {
    let buf = new Uint8Array(0);
    return { append: async (b: Uint8Array) => { const n = new Uint8Array(buf.length + b.length); n.set(buf); n.set(b, buf.length); buf = n; }, close: async () => { m.set(p, buf); }, abort: async () => {} };
  };
  return io;
}
async function codec() {
  const { vk, vaultId } = await createKeyring("correct horse battery staple!", { kdf: FAST });
  return E2eeCodec.fromKeys(await deriveSubkeys(vk, vaultId));
}
function deps(api: SyncApi, io: VaultIo, c: E2eeCodec, extra: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return { api, io, base: new BaseStore(), cache: new Map() as ChunkCache, state: { version: 0 }, device: "Dev", codec: c, ...extra };
}

describe("E3a (2) push over the codec", () => {
  it("stores frames under their sha256, commits hash over the frame stream and cid over the folded path, caches plaintext under the frame hash", async () => {
    const srv = fakeServer(); const c = await codec();
    const pt = enc("# Secret\n\nbody of the note\n");
    const io = fakeIo({ "Notes/Secret.md": pt });
    const cache: ChunkCache = new Map();
    const { hash } = await pushFile({ api: srv, io, state: { version: 0 }, cache, codec: c }, "Notes/Secret.md");
    const req = srv.commits[0];
    expect(req.cid).toBe(await c.fileIdentity("Notes/Secret.md", pt));
    expect(hash).toBe(req.cid); // the engine's identity of the pushed file is the cid
    expect(req.size).toBe(pt.length);
    expect(req.chunks.length).toBe(1);
    const frame = srv.chunks.get(req.chunks[0])!;
    expect(dec(frame.subarray(0, 4))).toBe("SSE1");
    expect(parseFrameHeader(frame)!.ptLen).toBe(pt.length);
    expect(await sha256hex(frame)).toBe(req.chunks[0]);
    expect(req.hash).toBe(await sha256hex(frame));
    expect(cache.get(cacheKey(c, req.chunks[0]))).toEqual(pt);
    expect(cache.has(req.chunks[0])).toBe(false); // never under the bare hash (a plain cache key)
    // the server never sees the plaintext
    for (const b of srv.chunks.values()) expect(dec(b)).not.toContain("body of the note");
  });
});

describe("E3a (3) pull over the codec", () => {
  it("a second device decodes the file and verifies the cid; a plaintext codec on the same rows fails closed", async () => {
    const srv = fakeServer(); const c = await codec();
    const pt = enc("hello from device A\n");
    await pushFile({ api: srv, io: fakeIo({ "n.md": pt }), state: { version: 0 }, cache: new Map(), codec: c }, "n.md");
    const io = fakeIo();
    const d = deps(srv, io, c);
    await reconcileAll(d);
    expect(dec(io.m.get("n.md")!)).toBe("hello from device A\n");
    expect(d.base.get("n.md")!.hash).toBe(srv.files.get("n.md")!.cid);
    // the same rows through PLAIN_CODEC: the "file" would be frames, and the hash check refuses them
    const io2 = fakeIo(); const errors: string[] = [];
    await reconcileAll({ ...deps(srv, io2, c), codec: PLAIN_CODEC, onFileError: (p) => errors.push(p) });
    expect(io2.m.has("n.md")).toBe(false);
    expect(errors).toEqual(["n.md"]);
  });

  it("a cid mismatch is not written, is logged, and holds the cursor below the row", async () => {
    const srv = fakeServer(); const c = await codec();
    await pushFile({ api: srv, io: fakeIo({ "ok.md": enc("fine\n") }), state: { version: 0 }, cache: new Map(), codec: c }, "ok.md");
    await pushFile({ api: srv, io: fakeIo({ "bad.md": enc("tampered\n") }), state: { version: 0 }, cache: new Map(), codec: c }, "bad.md");
    const row = srv.files.get("bad.md")!;
    srv.files.set("bad.md", { ...row, cid: "ab".repeat(32) }); // the server (or another path) swapped the cid
    const io = fakeIo(); const errors: { p: string; e: string }[] = [];
    const d = deps(srv, io, c, { onFileError: (p, e: any) => errors.push({ p, e: String(e?.message ?? e) }) });
    await reconcileAll(d);
    expect(io.m.has("ok.md")).toBe(true);
    expect(io.m.has("bad.md")).toBe(false);
    expect(errors.map((x) => x.p)).toEqual(["bad.md"]);
    expect(errors[0].e).toMatch(/integrity check failed for 'bad.md'/);
    expect(d.state.version).toBeLessThan(row.version); // the cursor holds below the failed row
  });

  it("a row without cid in an encrypted vault is not written either", async () => {
    const srv = fakeServer(); const c = await codec();
    await pushFile({ api: srv, io: fakeIo({ "n.md": enc("x\n") }), state: { version: 0 }, cache: new Map(), codec: c }, "n.md");
    const row = srv.files.get("n.md")!;
    const { cid: _drop, ...noCid } = row; srv.files.set("n.md", noCid as FileMeta);
    const io = fakeIo(); const errors: string[] = [];
    const d = deps(srv, io, c, { onFileError: (_p, e: any) => errors.push(String(e?.message ?? e)) });
    await reconcileAll(d);
    expect(io.m.has("n.md")).toBe(false);
    expect(errors[0]).toMatch(/has no cid in an encrypted vault/);
  });

  it("the streamed path checks the cid over the plaintext and refuses a row without cid", async () => {
    const srv = fakeServer(); const c = await codec();
    const big = new Uint8Array(STREAM_MIN_BYTES + 100).map((_, i) => (i * 7) & 0xff);
    await pushFile({ api: srv, io: fakeIo({ "big.bin": big }), state: { version: 0 }, cache: new Map(), codec: c }, "big.bin");
    const io = fakeIo({}, true);
    const d = deps(srv, io, c);
    await reconcileAll(d);
    expect(io.m.get("big.bin")!.length).toBe(big.length);
    expect(io.m.get("big.bin")!.every((b, i) => b === big[i])).toBe(true);
    const row = srv.files.get("big.bin")!;
    srv.files.set("big.bin", { ...row, version: row.version + 1, cid: "cd".repeat(32) });
    const io2 = fakeIo({}, true); const errors: string[] = [];
    await reconcileAll(deps(srv, io2, c, { onFileError: (_p, e: any) => errors.push(String(e?.message ?? e)) }));
    expect(io2.m.has("big.bin")).toBe(false);
    expect(errors[0]).toMatch(/failed the whole-file cid/);
  }, 60000);
});

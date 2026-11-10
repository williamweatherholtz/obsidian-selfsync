// E3a (9): a case-only rename of an encrypted file keeps its identity and causes no push, because the cid
// folds the path by case only. An NFC/NFD respelling on a device that folds normalisation is aliased to the
// server key, so the cid is computed over that key and nothing is pushed either.
import { describe, it, expect } from "vitest";
import { reconcileAll, ReconcileDeps } from "../../src/reconcile";
import { BaseStore } from "../../src/base";
import { SyncApi, VaultIo, ChunkCache, pushFile } from "../../src/sync";
import { ChangesResponse, CommitRequest, FileMeta } from "../../src/protocol";
import { E2eeCodec } from "../../src/e2ee/codec";
import { createKeyring } from "../../src/e2ee/keyring";
import { deriveSubkeys } from "../../src/e2ee/subkeys";

const enc = (s: string) => new TextEncoder().encode(s);
const FAST = { m_kib: 64, t: 1, p: 1 };

function fakeServer() {
  const chunks = new Map<string, Uint8Array>(); const files = new Map<string, FileMeta>(); let version = 1; let commits = 0;
  const api: SyncApi & { files: Map<string, FileMeta>; commitCount: () => number } = {
    files, commitCount: () => commits,
    async changes(since) { return { version, upserts: [...files.values()].filter((f) => f.version > since), deletes: [] } as ChangesResponse; },
    async fileMeta(p) { return files.get(p) ?? null; },
    async missing(hs) { return hs.filter((h) => !chunks.has(h)); },
    async getChunk(h) { return chunks.get(h)!; },
    async putChunk(h, b) { chunks.set(h, b); },
    async commit(r: CommitRequest) { commits++; const m: FileMeta = { ...r, version: ++version }; files.set(r.path, m); return m; },
    async deleteFile(p) { files.delete(p); },
  };
  return api;
}
// A folding filesystem: lookups fold by the given rule, keys keep their first spelling.
function foldingIo(seed: Record<string, string>, fold: (p: string) => string) {
  const m = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, enc(v)]));
  const keyOf = (p: string) => [...m.keys()].find((k) => fold(k) === fold(p));
  const io: VaultIo & { m: Map<string, Uint8Array> } = {
    m,
    async list() { const r = new Map<string, { mtime: number; size: number }>(); for (const k of m.keys()) r.set(k, { mtime: 0, size: m.get(k)!.length }); return r; },
    async read(p) { const k = keyOf(p); if (!k) throw new Error("ENOENT"); return m.get(k)!; },
    async write(p, b) { const k = keyOf(p) ?? p; m.set(k, b); },
    async remove(p) { const k = keyOf(p); if (k) m.delete(k); },
    async exists(p) { return keyOf(p) !== undefined; },
  };
  return io;
}
async function codec() {
  const { vk, vaultId } = await createKeyring("correct horse battery staple!", { kdf: FAST });
  return E2eeCodec.fromKeys(await deriveSubkeys(vk, vaultId));
}
const deps = (api: SyncApi, io: VaultIo, c: E2eeCodec, extra: Partial<ReconcileDeps> = {}): ReconcileDeps =>
  ({ api, io, base: new BaseStore(), cache: new Map() as ChunkCache, state: { version: 0 }, device: "Dev", codec: c, ...extra });

describe("E3a (9) spelling-only renames under E2EE", () => {
  it("a case-only rename on a case-folding device keeps the cid and pushes nothing", async () => {
    const srv = fakeServer(); const c = await codec();
    const io = foldingIo({ "Notes/Plan.md": "the plan\n" }, (p) => p.toLowerCase());
    const d = deps(srv, io, c, { caseInsensitivePaths: true });
    await reconcileAll(d);
    const after = srv.commitCount();
    expect(srv.files.get("Notes/Plan.md")!.cid).toBe(await c.fileIdentity("notes/plan.md", enc("the plan\n")));
    // the user renames by case only: one on-disk file, a new spelling
    const bytes = io.m.get("Notes/Plan.md")!; io.m.delete("Notes/Plan.md"); io.m.set("notes/plan.md", bytes);
    await reconcileAll(d);
    expect(srv.commitCount()).toBe(after);           // no push
    expect(srv.files.size).toBe(1);                   // no second row
    expect(io.m.size).toBe(1);
  });

  it("an NFC/NFD respelling on a normalisation-folding device is aliased and pushes nothing", async () => {
    const srv = fakeServer(); const c = await codec();
    const nfc = "Café.md", nfd = "Café.md";
    const io = foldingIo({ [nfc]: "coffee\n" }, (p) => p.normalize("NFC"));
    const d = deps(srv, io, c, { normalizationInsensitivePaths: true });
    await reconcileAll(d);
    const after = srv.commitCount();
    expect(srv.files.has(nfc)).toBe(true);
    const bytes = io.m.get(nfc)!; io.m.delete(nfc); io.m.set(nfd, bytes); // the OS re-spells the name
    await reconcileAll(d);
    expect(srv.commitCount()).toBe(after);
    expect(srv.files.size).toBe(1);
    expect(srv.files.has(nfc)).toBe(true);           // the server key is unchanged
    // the two spellings are two cids on the server side of the fence: the alias is what keeps them one
    expect(await c.fileIdentity(nfc, bytes)).not.toBe(await c.fileIdentity(nfd, bytes));
  });
});

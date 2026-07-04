import { ChangesResponse, CommitRequest, FileMeta } from "./protocol";
import { chunk, sha256hex } from "./chunker";

export interface VaultIo {
  list(): Promise<Map<string, { mtime: number }>>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}
export interface SyncApi {
  changes(since: number): Promise<ChangesResponse>;
  missing(hashes: string[]): Promise<string[]>;
  getChunk(hash: string): Promise<Uint8Array>;
  putChunk(hash: string, bytes: Uint8Array): Promise<void>;
  commit(req: CommitRequest): Promise<FileMeta>;
  deleteFile(path: string): Promise<void>;
}
export type SyncState = { version: number };
export type ChunkCache = Map<string, Uint8Array>;

// Bound the in-session chunk cache. Chunks arrive as subarray VIEWS into a whole file
// buffer; caching the view would pin the entire source file in RAM (2048 views from
// 2048 files ≈ 2048 whole files, not ~128 MiB — a mobile OOM). We copy each chunk
// (`slice`) so only its ~64 KiB is retained; evict oldest (Map is insertion-ordered).
const MAX_CACHE_ENTRIES = 2048;
function cachePut(cache: ChunkCache, hash: string, bytes: Uint8Array): void {
  if (cache.has(hash)) return;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(hash, bytes.slice()); // detach from the parent file buffer
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Fetch + reassemble a single file's bytes from its chunk list (cache-first).
export async function fetchFileBytes(api: SyncApi, cache: ChunkCache, chunks: string[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const h of chunks) {
    let b = cache.get(h);
    if (!b) { b = await api.getChunk(h); cachePut(cache, h, b); }
    parts.push(b);
  }
  return concat(parts);
}

// Write explicit bytes to a path then push it (used for merged/conflict results).
export async function pushBytes(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache, path: string, bytes: Uint8Array): Promise<string> {
  await io.write(path, bytes);
  return pushFile(api, io, state, cache, path);
}

// Apply server changes since state.version: fetch each upsert's missing chunks
// (cache-first), reassemble, write; apply deletes; advance version.
export async function pull(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache): Promise<void> {
  const resp = await api.changes(state.version);
  for (const f of resp.upserts) {
    const parts: Uint8Array[] = [];
    for (const h of f.chunks) {
      let bytes = cache.get(h);
      if (!bytes) { bytes = await api.getChunk(h); cachePut(cache, h, bytes); }
      parts.push(bytes);
    }
    await io.write(f.path, concat(parts));
  }
  for (const d of resp.deletes) await io.remove(d.path);
  state.version = resp.version;
}

// Chunk a local file, upload only the chunks the server lacks, then commit its
// manifest. Returns the file's SHA-256. Populates the cache with its chunks.
export async function pushFile(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache, path: string): Promise<string> {
  const bytes = await io.read(path);
  const chunks = await chunk(bytes);
  for (const c of chunks) cachePut(cache, c.hash, c.bytes);
  const hashes = chunks.map((c) => c.hash);
  const missing = new Set(await api.missing(hashes));
  for (const c of chunks) if (missing.has(c.hash)) await api.putChunk(c.hash, c.bytes);
  const fileHash = await sha256hex(bytes);
  const meta = await api.commit({ path, hash: fileHash, size: bytes.length, mtime: Date.now(), chunks: hashes });
  state.version = Math.max(state.version, meta.version);
  return fileHash;
}

// Push local files the server doesn't yet know about (initial upload).
export async function pushLocalNew(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache, known: Set<string>): Promise<void> {
  for (const path of (await io.list()).keys()) {
    if (known.has(path)) continue;
    await pushFile(api, io, state, cache, path);
    known.add(path);
  }
}

import { ChangesResponse, CommitRequest, FileMeta } from "./protocol";
import { chunk, sha256hex } from "./chunker";
import { Sha256 } from "./streamhash";

// A streamed, sequential-append write to one file — lets a large file be reassembled to
// disk without ever holding it whole in memory. Close finalizes (atomic rename); abort
// discards the partial.
export interface AppendHandle {
  append(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface VaultIo {
  list(): Promise<Map<string, { mtime: number; size: number }>>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  // O(1) presence check — distinguishes "genuinely absent" from "read failed" so a transient read
  // error on a present file isn't mistaken for a deletion (reconcile C1). Optional: an io without it
  // just forgoes that guard on the single-path event route.
  exists?(path: string): Promise<boolean>;
  // Optional streamed writer for large-file reassembly. Undefined ⇒ not supported on this
  // platform (caller buffers the whole file instead). Present on desktop; absent on mobile.
  appendWrite?(path: string): Promise<AppendHandle>;
}
export interface SyncApi {
  changes(since: number): Promise<ChangesResponse>;
  fileMeta(path: string): Promise<FileMeta | null>;
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
const MAX_CACHE_ENTRIES = 512; // ~32 MiB worst case (64 KiB max chunk) — bounded for mobile WebView RAM (R11-#10)
// Stay comfortably under the server's MAX_MISSING_HASHES=10000 per-request cap when querying which
// chunks the server lacks (R23): a very large file can exceed 10k chunks, so we slice the query.
const MISSING_BATCH = 5000;
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

// How many chunk transfers run at once. Bounds memory + connection use (mobile-safe)
// while overlapping request latency, so a large file no longer transfers one chunk at a time.
export const TRANSFER_CONCURRENCY = 6;

// Run `fn` over `items` with at most `limit` in flight; results keep input order. A pool
// of workers pulls the next index until the list is exhausted (no unbounded fan-out).
// @audit r2 2026-07-18 — FIXED (robustness): a `limit <= 0` (e.g. a future caller deriving it from a
// setting) spawned ZERO workers → Promise.all([]) resolved and the fn NEVER ran, returning a fully
// sparse array of undefined that reads as success. Clamp limit to >= 1 (0 workers only for empty input).
// (Order-preservation via pre-sized results is exemplary; the on-reject continued-work is idempotent/
// content-addressed — a real non-issue, not fixed.)
// @audit-hash sha256:fca9d2dc3c1b27bf
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

// Fetch one chunk, cache-first. A FRESHLY fetched chunk is verified against its content address
// BEFORE it enters the cache, so the cache only ever holds authentic bytes and a later cache HIT
// is safe to trust. Without this, a corrupt blob cached during a (later-aborted) buffered fetch
// could be laundered into a streamed file on a dedup cache hit. (DI-2 / DI-R2#1)
// @audit r2 2026-07-18 — verify-before-cache invariant is exemplary. Two deferred, no fix: (1) a cache
// HIT returns the internal buffer by REFERENCE — every current caller treats it read-only, but a future
// mutator would corrupt the shared content-addressed entry (and every file dedup'ing on that hash), so
// callers MUST NOT mutate the returned buffer; (2) no in-flight dedup for concurrent identical hashes
// (redundant fetch+verify, correctness-safe via idempotent cachePut) — only worth a Map<hash,Promise> if profiled.
async function getVerifiedChunk(api: SyncApi, cache: ChunkCache, hash: string): Promise<Uint8Array> {
  const hit = cache.get(hash);
  if (hit) return hit; // NOTE: aliases the cache entry — callers must treat it as read-only (see @audit above)
  const b = await api.getChunk(hash);
  if ((await sha256hex(b)) !== hash) throw new Error(`chunk ${hash.slice(0, 8)} failed content verification`);
  cachePut(cache, hash, b);
  return b;
}

// Fetch + reassemble a single file's bytes from its chunk list (cache-first). Chunks are
// fetched with bounded concurrency but reassembled in order (mapPool preserves it).
// @audit r2 2026-07-18 — clean, no change: near-perfect concision; the order guarantee is correctly
// delegated to mapPool. (Shares the 6-7-arg positional-list smell of pushBytes/pushFile — see below.)
export async function fetchFileBytes(api: SyncApi, cache: ChunkCache, chunks: string[]): Promise<Uint8Array> {
  const parts = await mapPool(chunks, TRANSFER_CONCURRENCY, (h) => getVerifiedChunk(api, cache, h));
  return concat(parts);
}

// Stream a file's chunks straight to disk (sequential append, ~one chunk in RAM at a time)
// instead of buffering + concatenating the whole file. Returns false if the io can't stream
// (mobile) so the caller falls back to the buffered path. Chunks are appended in list order,
// so reassembly is correct. A mid-stream failure aborts (discards the partial) and rethrows.
export async function streamFileToDisk(api: SyncApi, cache: ChunkCache, io: VaultIo, path: string, chunks: string[], expectedSize: number, expectedHash: string): Promise<boolean> {
  if (!io.appendWrite) return false;
  const h = await io.appendWrite(path);
  try {
    let written = 0;
    const hasher = new Sha256();
    for (const hash of chunks) {
      // DI-2/DI-R2#1: getVerifiedChunk verifies a freshly-fetched chunk before caching, and a
      // cache hit is authentic by construction — so a streamed file is never assembled from an
      // unverified (possibly bit-rotted) blob, even one another file cached earlier.
      const b = await getVerifiedChunk(api, cache, hash);
      await h.append(b); written += b.length; hasher.update(b);
    }
    // Reject a chunk list that doesn't reassemble to the declared SIZE (truncated/extra chunk)…
    if (written !== expectedSize) {
      throw new Error(`streamed reassembly of '${path}' is ${written} bytes, expected ${expectedSize} — not applying (bad chunk manifest?)`);
    }
    // …AND to the declared whole-file HASH. Verifying the INCREMENTALLY-computed hash BEFORE the
    // atomic rename (R17) means a size-preserving bad manifest (reordered/substituted chunks from a
    // corrupt server index) never overwrites `path`, so it can't destroy a racing local write or its
    // conflict copy and can't launder wrong bytes into base + re-push them (the round-2 post-write
    // re-read regressed exactly this). Incremental hashing also keeps the streamed path's memory
    // guarantee (~one chunk in RAM), so it still works for files larger than a single buffer.
    const got = hasher.hexDigest();
    if (got !== expectedHash) {
      throw new Error(`streamed reassembly of '${path}' failed the whole-file hash (got ${got.slice(0, 12)}, expected ${expectedHash.slice(0, 12)}) — not applying (bad chunk manifest?)`);
    }
    await h.close();
    return true;
  } catch (e) {
    await h.abort().catch(() => {});
    throw e;
  }
}

// Write explicit bytes to a path then push it (used for merged/conflict results).
// Returns the PushResult (committed bytes + hash), NOT just the hash: a caller recording a base
// must use the COMMITTED bytes, since a racing local save between io.write and pushFile's re-read
// would otherwise leave base.text and base.hash describing different content. (DI-5 / DI-R2#3)
// @audit r2 2026-07-18 — DI-5 committed-bytes return contract is exemplary (base can't desync). Deferred
// (design, no fix): 7 positional params, 4 of which are the fixed {api,io,state,cache} bundle every caller
// splats off `d` — misordering two same-typed args typechecks clean. Group into a SyncCtx (mirroring
// ReconcileDeps) as a follow-up so call sites shrink and transposition becomes impossible.
export async function pushBytes(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache, path: string, bytes: Uint8Array, expectedVersion?: number): Promise<PushResult> {
  await io.write(path, bytes);
  return pushFile(api, io, state, cache, path, expectedVersion);
}

// The result of a push: the committed file's SHA-256 AND the exact bytes that were hashed +
// committed. Callers that record a base MUST use these bytes (not a fresh re-read) so the base's
// (bytes, hash) pair can never disagree if the file changes mid-operation. (DI-5)
export interface PushResult { hash: string; bytes: Uint8Array; }

// Chunk a local file, upload only the chunks the server lacks, then commit its manifest.
// Returns the committed bytes + their SHA-256. Populates the cache with its chunks.
// `expectedVersion` (optional) is the CAS precondition: the server version this write is based
// on, so the server rejects (409 → CommitConflictError) if it advanced meanwhile. Omitted for
// authoritative overwrites (switch/adjudication) where adopting-over-remote IS the intent.
export async function pushFile(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache, path: string, expectedVersion?: number): Promise<PushResult> {
  const bytes = await io.read(path);
  const chunks = await chunk(bytes);
  for (const c of chunks) cachePut(cache, c.hash, c.bytes);
  const hashes = chunks.map((c) => c.hash);
  // Batch the missing() query under the server's per-request hash cap (MAX_MISSING_HASHES=10000).
  // A file in the ~160–200 MiB band chunks into >10k pieces at the ~16 KiB average chunk size, so a
  // single unbatched call would 400 and the file — under the 200 MiB size gate, so NOT skipped —
  // would silently never sync (R23 MEDIUM). Union the per-batch results. (commit's own hash list
  // stays a single call: ~0.8 MiB at 11.5k hashes, well under the 16 MiB body limit.)
  const missing = new Set<string>();
  for (let i = 0; i < hashes.length; i += MISSING_BATCH) {
    for (const h of await api.missing(hashes.slice(i, i + MISSING_BATCH))) missing.add(h);
  }
  const toPush = chunks.filter((c) => missing.has(c.hash));
  await mapPool(toPush, TRANSFER_CONCURRENCY, (c) => api.putChunk(c.hash, c.bytes));
  const fileHash = await sha256hex(bytes);
  await api.commit({ path, hash: fileHash, size: bytes.length, mtime: Date.now(), chunks: hashes, expectedVersion });
  // NB: do NOT advance state.version here. The commit's returned version can be higher than
  // remote commits we haven't pulled yet; advancing the poll cursor to it would skip them
  // (changes(since) is exclusive), silently missing a concurrent remote change until some
  // unrelated later commit forces a full reconcile. Only reconcileAll advances the cursor.
  return { hash: fileHash, bytes };
}

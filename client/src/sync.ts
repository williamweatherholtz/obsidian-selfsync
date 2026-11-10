import { ChangesResponse, CommitRequest, FileMeta } from "./protocol";
import { chunk } from "./chunker";
import { cacheKey, ContentCodec, PLAIN_CODEC } from "./e2ee/codec";

// A streamed, sequential-append write to one file — lets a large file be reassembled to
// disk without ever holding it whole in memory. Close finalizes (atomic rename); abort
// discards the partial.
export interface AppendHandle {
  append(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface VaultIo {
  list(): Promise<Map<string, { mtime: number; size: number; ctime?: number }>>;
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
  deleteFile(path: string, expectedVersion?: number): Promise<void>; // expectedVersion = optional CAS base (reconcile delete-remote); omit for an authoritative delete
}
export type SyncState = { version: number };
export type ChunkCache = Map<string, Uint8Array>;

// The ambient sync context a write/transfer needs — bundled so a call site passes ONE value instead of
// four positional deps (misordering them is no longer possible). ReconcileDeps has exactly these fields,
// so callers pass `d` directly. (CA-F1: the pushFile/pushBytes/streamFileToDisk parameter-object fix.)
// `codec` (D0104) is the one seam between the engine and the bytes on the wire. Absent ⇒ PLAIN_CODEC, so
// every existing caller and test keeps today's bytes and hashes exactly.
export interface SyncCtx { api: SyncApi; io: VaultIo; state: SyncState; cache: ChunkCache; codec?: ContentCodec; }
export function codecOf(ctx: { codec?: ContentCodec }): ContentCodec { return ctx.codec ?? PLAIN_CODEC; }

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
// (Order-preservation via pre-sized results is exemplary.)
// @audit r3 2026-07-19 — FIXED (boundedPool contract): added a shared abort flag. Previously, when one
// worker's fn threw, Promise.all rejected but the OTHER workers kept pulling next++ and running fn on the
// remaining items — harmless for today's idempotent/content-addressed callers, but a latent trap for any
// future NON-idempotent caller (its remaining ops would run after a sibling had already failed). Now the
// first throw sets `aborted`, so no NEW item starts (in-flight ones settle); the rejection still propagates
// via Promise.all. This makes fail-fast the pool's contract instead of a per-caller bolt-on (isolatedPass's
// own connAbort now rides it), so a non-idempotent caller is safe by construction.
// @audit-hash sha256:fca9d2dc3c1b27bf
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let aborted = false; // set by the first fn rejection → sibling workers stop pulling new items (fail-fast)
  const worker = async () => {
    for (let i = next++; i < items.length && !aborted; i = next++) {
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        aborted = true; // don't start further items once one has failed
        throw e;        // still propagate via Promise.all (behaviour preserved for the caller)
      }
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
// E2EE (D0104): the cache holds PLAINTEXT under the codec-tagged key of the STORED bytes' address. A fresh
// fetch verifies sha256(stored) == hash, then decodes (tag, pad, iv checks), then caches the plaintext.
async function getVerifiedChunk(api: SyncApi, cache: ChunkCache, hash: string, codec: ContentCodec = PLAIN_CODEC): Promise<Uint8Array> {
  const key = cacheKey(codec, hash);
  const hit = cache.get(key);
  if (hit) return hit; // NOTE: aliases the cache entry — callers must treat it as read-only (see @audit above)
  const stored = await api.getChunk(hash);
  if ((await codec.address(stored)) !== hash) throw new Error(`chunk ${hash.slice(0, 8)} failed content verification`);
  const b = await codec.decodeChunk(stored);
  cachePut(cache, key, b);
  return b;
}

// Fetch + reassemble a single file's bytes from its chunk list (cache-first). Chunks are
// fetched with bounded concurrency but reassembled in order (mapPool preserves it).
// @audit r2 2026-07-18 — clean, no change: near-perfect concision; the order guarantee is correctly
// delegated to mapPool. (Shares the 6-7-arg positional-list smell of pushBytes/pushFile — see below.)
export async function fetchFileBytes(api: SyncApi, cache: ChunkCache, chunks: string[], codec: ContentCodec = PLAIN_CODEC): Promise<Uint8Array> {
  const parts = await mapPool(chunks, TRANSFER_CONCURRENCY, (h) => getVerifiedChunk(api, cache, h, codec));
  return concat(parts);
}

// Stream a file's chunks straight to disk (sequential append, ~one chunk in RAM at a time)
// instead of buffering + concatenating the whole file. Returns false if the io can't stream
// (mobile) so the caller falls back to the buffered path. Chunks are appended in list order,
// so reassembly is correct. A mid-stream failure aborts (discards the partial) and rethrows.
// E2EE (D0101, spec section 4.3): on an encrypted vault the whole-file check is the cid over the plaintext,
// not the hash (the cache holds plaintext, so sha256 of the frames cannot be recomputed on a cache hit).
// `expectedCid` is the row's cid; a row without one in an encrypted vault is refused before any write.
export async function streamFileToDisk(ctx: SyncCtx, path: string, chunks: string[], expectedSize: number, expectedHash: string, beforeRename?: () => Promise<void>, expectedCid?: string): Promise<boolean> {
  if (!ctx.io.appendWrite) return false;
  const codec = codecOf(ctx);
  if (codec.encrypted && !expectedCid) throw new Error(`'${path}' has no cid in an encrypted vault — not applying (a pre-E2EE row or a buggy client)`);
  const h = await ctx.io.appendWrite(path);
  try {
    let written = 0;
    const hasher = codec.identityStream(path);
    for (const hash of chunks) {
      // DI-2/DI-R2#1: getVerifiedChunk verifies a freshly-fetched chunk before caching, and a
      // cache hit is authentic by construction — so a streamed file is never assembled from an
      // unverified (possibly bit-rotted) blob, even one another file cached earlier.
      const b = await getVerifiedChunk(ctx.api, ctx.cache, hash, codec);
      await h.append(b); written += b.length; hasher.update(b);
    }
    // Reject a chunk list that doesn't reassemble to the declared SIZE (truncated/extra chunk)…
    if (written !== expectedSize) {
      throw new Error(`streamed reassembly of '${path}' is ${written} bytes, expected ${expectedSize} — not applying (bad chunk manifest?)`);
    }
    // …AND to the declared whole-file IDENTITY. Verifying the INCREMENTALLY-computed hash BEFORE the
    // atomic rename (R17) means a size-preserving bad manifest (reordered/substituted chunks from a
    // corrupt server index) never overwrites `path`, so it can't destroy a racing local write or its
    // conflict copy and can't launder wrong bytes into base + re-push them (the round-2 post-write
    // re-read regressed exactly this). Incremental hashing also keeps the streamed path's memory
    // guarantee (~one chunk in RAM), so it still works for files larger than a single buffer.
    const got = hasher.hexDigest();
    const expected = codec.encrypted ? expectedCid! : expectedHash;
    if (got !== expected) {
      throw new Error(`streamed reassembly of '${path}' failed the whole-file ${codec.encrypted ? "cid" : "hash"} (got ${got.slice(0, 12)}, expected ${expected.slice(0, 12)}) — not applying (bad chunk manifest?)`);
    }
    // Racing-edit SEAM (issueStreamedPullMidEditLoss): the temp is fully written + hash-verified but NOT yet
    // renamed over `path`, so `path` still holds any edit that landed during the stream. beforeRename runs
    // HERE to preserve it (a conflict copy of the original) before close() renames remote over it. A throw
    // here (incl. the config-adjudication abort) hits the catch → h.abort() discards the temp, `path` intact.
    if (beforeRename) await beforeRename();
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
// @audit r3 2026-07-18 — FIXED (design): the {api,io,state,cache} 4-tuple is now a SyncCtx bundle, so
// pushBytes/pushFile/streamFileToDisk take (ctx, path, …) and callers pass `d` — call sites shrink and
// the positional-args transposition the r2 note flagged is gone. DI-5 committed-bytes contract preserved.
export async function pushBytes(ctx: SyncCtx, path: string, bytes: Uint8Array, expectedVersion?: number): Promise<PushResult> {
  await ctx.io.write(path, bytes);
  // Commit the IN-HAND bytes, NOT a re-read (crit R+1): a local save racing between io.write and a
  // re-read would otherwise be committed in place of the merge/union result, silently discarding the
  // REMOTE edit the merge folded in (DI-5 fixed base CONSISTENCY — text/hash agree — but not this LOSS).
  // Committing the exact bytes we hold means a racing save lands on disk and is caught as a fresh local
  // edit on the NEXT reconcile (local ≠ base=merged → push/merge), never overwriting the merge result.
  return commitBytes(ctx, path, bytes, expectedVersion);
}

// The result of a push: the committed file's IDENTITY (sha256 on a plain vault, the cid on an encrypted
// one — D0104: the base holds identities) AND the exact bytes that were hashed + committed. Callers that
// record a base MUST use these bytes (not a fresh re-read) so the base's (bytes, hash) pair can never
// disagree if the file changes mid-operation. (DI-5)
export interface PushResult { hash: string; bytes: Uint8Array; }

// Chunk a local file, upload only the chunks the server lacks, then commit its manifest.
// Returns the committed bytes + their SHA-256. Populates the cache with its chunks.
// `expectedVersion` (optional) is the CAS precondition: the server version this write is based
// on, so the server rejects (409 → CommitConflictError) if it advanced meanwhile. Omitted for
// authoritative overwrites (switch/adjudication) where adopting-over-remote IS the intent.
export async function pushFile(ctx: SyncCtx, path: string, expectedVersion?: number): Promise<PushResult> {
  const bytes = await ctx.io.read(path);
  return commitBytes(ctx, path, bytes, expectedVersion);
}

// Chunk, upload the missing chunks, and commit EXACTLY `bytes` (no disk re-read) — the shared core of
// pushFile (reads first) and pushBytes (writes first). Keeping the committed content = the bytes in hand
// is what makes the merge/union push race-safe (see pushBytes).
async function commitBytes(ctx: SyncCtx, path: string, bytes: Uint8Array, expectedVersion?: number): Promise<PushResult> {
  const codec = codecOf(ctx);
  const chunks = await chunk(bytes);
  // E2EE (D0104, spec section 4.7): encode after chunking. The server stores FRAMES under sha256(frame); the
  // cache holds the PLAINTEXT under the frame address, so a later pull of the same frame is a cache hit.
  // A plain vault's frame is its chunk, so the address is the chunk hash and nothing changes.
  const frames = codec.encrypted ? await Promise.all(chunks.map((c) => codec.encodeChunk(c.bytes))) : chunks.map((c) => c.bytes);
  const hashes = codec.encrypted ? await Promise.all(frames.map((f) => codec.address(f))) : chunks.map((c) => c.hash);
  chunks.forEach((c, i) => cachePut(ctx.cache, cacheKey(codec, hashes[i]), c.bytes));
  // Batch the missing() query under the server's per-request hash cap (MAX_MISSING_HASHES=10000).
  // A file in the ~160–200 MiB band chunks into >10k pieces at the ~16 KiB average chunk size, so a
  // single unbatched call would 400 and the file — under the 200 MiB size gate, so NOT skipped —
  // would silently never sync (R23 MEDIUM). Union the per-batch results. (commit's own hash list
  // stays a single call: ~0.8 MiB at 11.5k hashes, well under the 16 MiB body limit.)
  const missing = new Set<string>();
  for (let i = 0; i < hashes.length; i += MISSING_BATCH) {
    for (const h of await ctx.api.missing(hashes.slice(i, i + MISSING_BATCH))) missing.add(h);
  }
  const toPush = hashes.map((h, i) => ({ hash: h, frame: frames[i] })).filter((c) => missing.has(c.hash));
  await mapPool(toPush, TRANSFER_CONCURRENCY, (c) => ctx.api.putChunk(c.hash, c.frame));
  // hash = sha256 over what the server stores (the frame stream on E2EE, the file on plain); cid = the keyed
  // identity over the folded path and the plaintext, sent only on an encrypted vault. The engine's identity
  // of the pushed file is the cid there, the hash here (D0104: the base holds identities).
  const fileHash = await codec.fileHash(frames);
  const cid = codec.encrypted ? await codec.fileIdentity(path, bytes) : undefined;
  await ctx.api.commit({ path, hash: fileHash, size: bytes.length, mtime: Date.now(), chunks: hashes, expectedVersion, cid });
  // NB: do NOT advance state.version here. The commit's returned version can be higher than
  // remote commits we haven't pulled yet; advancing the poll cursor to it would skip them
  // (changes(since) is exclusive), silently missing a concurrent remote change until some
  // unrelated later commit forces a full reconcile. Only reconcileAll advances the cursor.
  return { hash: cid ?? fileHash, bytes };
}

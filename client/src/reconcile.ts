import { SyncApi, VaultIo, SyncState, ChunkCache, pushFile, pushBytes, fetchFileBytes, streamFileToDisk, mapPool } from "./sync";
import { sha256hex } from "./chunker";
import { BaseStore, BaseEntry, conflictCopyName, isConflictCopy } from "./base";
import { isMergeable, merge3 } from "./merge";
import { ChangesResponse, CommitConflictError, FileMeta } from "./protocol";
import { isEnabledListConfig, mergeEnabledPluginsJson } from "./configsync";

export type Presence = { hash: string } | null;
export type Action =
  | "in-sync" | "push" | "pull" | "delete-local" | "delete-remote"
  | "merge" | "conflict-copy" | "edit-wins-keep-local" | "edit-wins-pull";

// Pure decision: given the local, base (last-synced), and remote hashes for one
// path (null = absent on that side), what should happen? No branch ever silently
// overwrites when both sides changed — divergence is merged or conflict-copied.
export function decide(local: Presence, base: { hash: string } | null, remote: Presence): Action {
  const L = local?.hash ?? null, B = base?.hash ?? null, R = remote?.hash ?? null;
  if (L === null && R === null) return "in-sync";
  if (L !== null && R !== null && L === R) return "in-sync";
  if (L !== null && R === null) {
    if (B === null) return "push";                 // local-only new
    return L === B ? "delete-local" : "edit-wins-keep-local";
  }
  if (L === null && R !== null) {
    if (B === null) return "pull";                 // remote-only new
    return R === B ? "delete-remote" : "edit-wins-pull";
  }
  // both present, L !== R
  if (B === null) return "conflict-copy";          // no common base -> never clobber
  if (B === L) return "pull";                       // only remote changed
  if (B === R) return "push";                       // only local changed
  return "merge";                                   // both changed
}

// Two text blobs are "cosmetically equal" if they differ ONLY by line-ending style (CRLF/CR vs LF)
// and/or trailing blank lines — i.e. the SAME note authored/saved on different OSes (Windows CRLF vs
// mobile LF). Such a pair must NEVER be treated as a conflict: on a first sync / adopt of two
// independent-but-identical copies, decide() has no common base and returns conflict-copy, which
// previously spawned a spurious conflict copy per file (the "46 false conflicts" report). Minimal +
// safe normalization: normalize EOL, strip trailing newlines. Real content differences still conflict.
export function sameIgnoringEol(a: Uint8Array, b: Uint8Array): boolean {
  const norm = (u: Uint8Array) => new TextDecoder().decode(u).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return norm(a) === norm(b);
}

// A CONNECTION-level failure — DNS can't resolve the host, connection refused/reset, network
// unreachable — means the SERVER is unreachable, so it hits EVERY file identically. Isolating it
// per-file (skip + log + continue) turns one outage into a flood of ~one-error-per-file and churns
// the whole vault pointlessly (field: a mobile resume that started syncing before DNS was ready
// logged 200+ "UnknownHostException" lines). Detect it so the reconcile loops ABORT the pass instead
// — the engine then goes offline + backs off ONCE. Matches only host-resolution + connection-
// establishment failures, NEVER a per-file content/read error (a corrupt chunk, a locked file, a
// full disk), which must stay isolated. Kept deliberately narrow (no bare "timeout"/"socket": a
// single huge-file read timeout is a per-file problem, not a whole-connection outage).
export function isConnectionError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /unknownhostexception|unable to resolve host|no address associated with hostname|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|enetunreach|network is unreachable|failed to fetch|fetch failed|err_name_not_resolved|err_internet_disconnected|err_connection_(refused|reset)|err_address_unreachable/.test(m);
}

// Files above this size are skipped (not synced) — reading them whole into RAM would
// OOM a mobile device (Obsidian's adapter/requestUrl don't stream). Overridable per deps.
export const DEFAULT_MAX_SYNC_BYTES = 200 * 1024 * 1024; // 200 MiB

// Bulk-delete guard (C2, widened): refuse to propagate deletions when the server manifest has
// LOST a suspicious fraction of our synced history — not just when it's exactly empty. A partial
// index (a restored-from-backup or reindexed-over-an-incomplete-dir manifest) advertises some
// files and silently drops others; treating those drops as deletions would wipe them on every
// device. Recoverable (re-delete to force); silent mass-loss is not, so we bias to guard.
export const BULK_DELETE_MIN = 6;      // don't second-guess tiny vaults
export const BULK_DELETE_RATIO = 0.5;  // >= half of base missing from a non-empty manifest = suspicious

// SEC-DATA (audit): the per-pass ratio guard above is STATELESS, so a compromised/malicious server can
// defeat it by pacing tombstones at just-under-RATIO of the CURRENT base each poll — the base shrinks
// every pass (delete removes it), so a 1000-file vault drains to ~nothing in ~8 polls while no single
// pass trips the ratio. DeleteRateGuard closes that by measuring CUMULATIVE deletes against a rolling
// HIGH-WATER MARK of base size (a fixed denominator across passes), so a paced drain trips the guard
// once cumulative deletions reach RATIO × peak within the window. In-memory + per-session (an attacker
// pacing across restarts is far slower/noisier, and deletes now go to .trash so they're recoverable);
// the plugin owns one instance and passes it in deps. Absent ⇒ only the per-pass guard applies.
export class DeleteRateGuard {
  private windowStart = 0;
  private deletedInWindow = 0;
  private peakBase = 0;
  constructor(
    private readonly windowMs = 60 * 60 * 1000, // 1h rolling window
    private readonly ratio = BULK_DELETE_RATIO,
    private readonly min = BULK_DELETE_MIN,
    private readonly now: () => number = () => Date.now(),
  ) {}
  // Call once per pass with the current accepted-base size. Rolls the window (a quiet hour resets the
  // peak + count) and tracks the high-water mark within the window.
  observe(baseSize: number): void {
    const t = this.now();
    if (t - this.windowStart > this.windowMs) { this.windowStart = t; this.deletedInWindow = 0; this.peakBase = baseSize; }
    else this.peakBase = Math.max(this.peakBase, baseSize);
  }
  // True if deleting `n` more files now would push cumulative window deletions to >= ratio × peak.
  wouldExceed(n: number): boolean {
    return this.peakBase >= this.min && (this.deletedInWindow + n) / this.peakBase >= this.ratio;
  }
  record(n: number): void { this.deletedInWindow += Math.max(0, n); }
}

// At/above this size a DOWNLOAD is streamed to disk (never buffered whole) when the io
// supports it — which also lets it bypass the buffered size gate. Uploads still buffer
// (chunking reads the whole local file), so they stay gated.
export const STREAM_MIN_BYTES = 8 * 1024 * 1024; // 8 MiB

// How many files a whole-vault / delta reconcile processes concurrently (perf: the file loop was
// strictly sequential, so an initial sync of N notes cost ~N × 3 serial round-trips — minutes on a
// WAN). Each file is independent; JS is single-threaded so the shared base/cache/state mutations
// don't race (state.version is set once AFTER the pass, and pushFile deliberately never touches it).
// Kept MODEST so at most this many files buffer at once (per-file size gate bounds each) — safe on
// mobile. Within a file, chunk transfer is separately parallel (TRANSFER_CONCURRENCY). (Finding 1)
export const FILE_CONCURRENCY = 4;

// After this many CONSECUTIVE failed pulls of the same (path, server-version), stop holding the poll
// cursor open for it — a genuinely-corrupt server copy would otherwise re-download every poll forever
// (R18). It's still re-attempted by the slow full scan and immediately re-tried when the server
// commits a NEW version for the path.
export const MAX_PULL_RETRIES = 5;

// Decide whether to HOLD the poll cursor for a file whose pull just failed. Returns true while the
// file is under its retry budget (hold → retried next poll); false once exhausted (let the cursor
// advance past it, and fire onPullExhausted once). A new server version for the path resets the count.
function holdForRetry(d: ReconcileDeps, path: string, version: number): boolean {
  if (!d.retryBudget) return true; // no budget wired → unbounded hold (pre-R18)
  const cur = d.retryBudget.get(path);
  const count = cur && cur.version === version ? cur.count + 1 : 1;
  d.retryBudget.set(path, { version, count });
  if (count >= MAX_PULL_RETRIES) { d.onPullExhausted?.(path); return false; }
  return true;
}

export interface ReconcileDeps {
  api: SyncApi; io: VaultIo; base: BaseStore; cache: ChunkCache; state: SyncState;
  device: string;
  maxSyncBytes?: number;
  readOnly?: boolean; // a read-only shared vault: pull only, NEVER mutate the server
  // Per-device selective-sync filter. A path this returns false for is skipped ENTIRELY
  // (no pull, no base, no delete): a replica that doesn't ACCEPT a path must never record a
  // base for it, or a dropped/filtered write turns into a phantom deletion of the device that
  // DOES hold it (the data-resurrection twin). Notes always accept; `.obsidian/` is opt-in.
  accepts?: (path: string) => boolean;
  onConflict?: (path: string, copy: string) => void;
  onBaseChanged?: () => void;
  onGuard?: (path: string) => void; // fired when a suspicious bulk-delete is refused (C2)
  // SEC-DATA: cross-pass cumulative delete-rate guard (defeats a paced-tombstone vault drain). Optional;
  // when present it is OR'd with the per-pass ratio guard. The plugin owns one instance across passes.
  deleteGuard?: DeleteRateGuard;
  onSkip?: (path: string, bytes: number) => void; // fired when a too-large file is skipped
  onReadOnly?: (path: string) => void; // fired when a local change can't sync (read-only vault)
  // Progress feedback: the number of files still PENDING transfer this pass (drives to 0). Fired at
  // the start and as each pending file completes — the consumer should throttle. Files that don't need
  // syncing are never counted, so this is "work left", not "files examined". Used for the "N pending" text.
  onProgress?: (pending: number) => void;
  // A config file whose reconcile can't be resolved additively — a removal (base present →
  // gone) or a same-file divergence. NEVER auto-deleted (could lose data a device merely
  // couldn't hold) and NEVER auto-pulled-back (would resurrect a genuine removal); recorded
  // for user adjudication instead. `reason` is the decided action, for the UI/log.
  onConfigConflict?: (path: string, reason: string) => void;
  // A config path that reconciled CLEANLY (added/edited/removed/in-sync, not a divergence) —
  // so any stale "config difference" recorded for it can be pruned. Keeps the pending set current.
  onConfigResolved?: (path: string) => void;
  // One file failed to reconcile. Logged and skipped — a single file must never abort the
  // whole sync (a filtered conflict-copy push once threw here and killed every file's sync).
  onFileError?: (path: string, err: unknown) => void;
  // Remote files present on the server that this device is set NOT to sync (a config surface is off, or
  // a community plugin isn't in the allowlist). Reported so the UI can tell the user WHAT is waiting and
  // how to adopt it — otherwise these look like "stuck" pending work that never transfers.
  onDeclined?: (paths: string[]) => void;
  // The community-plugin ids present ON THE SERVER (from the full manifest). Reported so a device that
  // doesn't have those plugins installed — e.g. a brand-new vault adopting an existing one — can still
  // SEE and adopt them (ticking one pulls its files, which installs it). Fires on the full-scan path.
  onRemotePlugins?: (ids: string[]) => void;
  // O(1) local size for one path (RS-3 incremental reconcile), so the size gate works without a
  // whole-vault io.list(). Absent ⇒ 0 (reconcileOne reads the file to hash it anyway).
  localSizeOf?: (path: string) => number;
  // D0019: fired for a local file KEPT + pushed back because it was absent from the server with NO
  // deletion tombstone (the tombstone-authoritative "restore, never destroy" branch). Normally this
  // is a legitimate keep; when the server's deletion history was RESET (history_floor advanced past
  // the client's stored floor, or the version rewound), these are AMBIGUOUS — a pruned deletion or a
  // never-synced file — so main batches them into ONE notice for the user to review, instead of
  // silently resurrecting them. Purely observational: it never changes the keep-and-push behavior.
  onKeptAbsent?: (path: string) => void;
  // Bounded-retry budget for a remote file whose pull keeps FAILING (R18): a genuinely-corrupt server
  // copy (bad manifest / bit-rot) fails its integrity check every time, and the cursor-hold (R14
  // sync#1) would otherwise re-download it on EVERY poll forever. Keyed by path → {version, count} of
  // CONSECUTIVE failures at that server version; after MAX_PULL_RETRIES the cursor is allowed to
  // advance past it (stop re-pulling) and onPullExhausted fires once. A NEW version for the path (the
  // server re-committed → likely fixed) resets the count; a success clears it. In-memory, plugin-owned
  // so it persists across passes. Absent ⇒ unbounded hold (the pre-R18 behavior).
  retryBudget?: Map<string, { version: number; count: number }>;
  onPullExhausted?: (path: string) => void; // a file's server copy failed to download MAX times — surface it
}

// ---- Shared reconcile primitives (B1: these were copy-pasted across reconcileAll / reconcileDelta /
// reconcilePath / switchTo / reconcileLocalConfig with subtle drift; one home each so the safety-critical
// contracts — selective sync, bulk-delete guarding, cursor holding, per-file error isolation — can't diverge.)

// Selective-sync predicate: a path is accepted unless a per-device filter is set and rejects it. A path
// this device doesn't accept is skipped ENTIRELY (no pull, no base, no delete) — see ReconcileDeps.accepts.
function accepts(d: ReconcileDeps, path: string): boolean { return !d.accepts || d.accepts(path); }

// The STATELESS per-pass bulk-delete ratio predicate (C2, widened): true when this pass would delete a
// suspicious fraction of the accepted `universe` (base or local set) — a wholesale-empty manifest
// (`emptyManifest`, a strong index-loss signal) or >= BULK_DELETE_RATIO of a non-tiny universe. Callers
// OR this with the cumulative DeleteRateGuard where a paced drain is possible (runDeleteGuard).
function isSuspiciousBulkDelete(universe: number, deletes: number, emptyManifest: boolean): boolean {
  return universe > 0 && (emptyManifest
    || (universe >= BULK_DELETE_MIN && deletes / universe >= BULK_DELETE_RATIO));
}

// SEC-DATA: combine the stateless per-pass predicate with the cross-pass cumulative DeleteRateGuard on
// the POLLING paths (reconcileAll/reconcileDelta) — feed the guard this pass's universe, OR its verdict
// in (catches a paced drain the per-pass ratio alone misses), and RECORD the deletes only when we let
// them through. Returns the final verdict (true ⇒ refuse the deletions this pass). The event/one-shot
// paths (reconcilePath, switchTo) use isSuspiciousBulkDelete alone — a paced server drain doesn't route
// through them, and a switch is a single operation with no next pass to accumulate across.
function runDeleteGuard(d: ReconcileDeps, universe: number, deletes: number, emptyManifest: boolean): boolean {
  d.deleteGuard?.observe(universe);
  const suspicious = isSuspiciousBulkDelete(universe, deletes, emptyManifest)
    || (d.deleteGuard?.wouldExceed(deletes) ?? false);
  if (!suspicious && deletes > 0) d.deleteGuard?.record(deletes);
  return suspicious;
}

// Set the poll cursor to the server's authoritative version, but NEVER advance past the earliest change
// that FAILED this pass — hold it just below so the next incremental poll re-fetches + retries it (R14
// sync#1). ASSIGN, not max: a server rewind (reindex/restore, V_s < V_c) must converge, not pin the
// cursor high forever and re-run a full reconcile every idle poll (CONC-R2#3).
function advanceCursor(d: ReconcileDeps, authoritativeVersion: number, failedVersions: number[]): void {
  const minFailed = failedVersions.length ? Math.min(...failedVersions) : Infinity;
  d.state.version = Number.isFinite(minFailed) ? Math.min(authoritativeVersion, minFailed - 1) : authoritativeVersion;
}

// Run each file op under the shared error-isolation contract (Finding 1 / R14 / R18): a whole-CONNECTION
// failure ABORTS the pass (isConnectionError → the engine goes offline+backoff ONCE, not one-error-per-
// file); any other per-file error is ISOLATED (logged, and the cursor held below it for retry until its
// budget runs out). `run` does the work for one path; `versionOf` maps a failed path to the server
// version to hold; `onDone` fires per completed path (progress). Held versions are pushed into `failed`.
async function isolatedPass(
  d: ReconcileDeps,
  items: string[],
  failed: number[],
  run: (p: string) => Promise<void>,
  versionOf: (p: string) => number | undefined,
  onDone: (p: string) => void,
): Promise<void> {
  let connAbort: unknown = null; // a server-unreachable error aborts the whole pass
  await mapPool(items, FILE_CONCURRENCY, async (p) => {
    if (connAbort) throw connAbort; // server unreachable — stop; don't per-file-log the remaining files
    try {
      await run(p);
      d.retryBudget?.delete(p); // reconciled cleanly → reset any failure budget for this path (R18)
    } catch (e) {
      if (isConnectionError(e)) { connAbort = e; throw e; } // whole-connection failure → abort → engine offline+backoff
      d.onFileError?.(p, e);
      const v = versionOf(p);
      if (v !== undefined && holdForRetry(d, p, v)) failed.push(v); // hold below a failed change; stop after MAX (R18)
    } finally {
      onDone(p);
    }
  });
}

// (size,mtime) match the base's stamp ⇒ the file is unchanged since we last confirmed it equals base,
// so its content is still base.hash — the scan-skip heuristic shared by reconcileLocalConfig + reconcileOne
// (a write bumps mtime). Lets a pass run OFTEN without re-hashing every synced file.
function baseStatUnchanged(be: { size?: number; mtime?: number } | null | undefined, st: { size: number; mtime: number } | undefined): boolean {
  return !!(be && st && be.size === st.size && be.mtime === st.mtime);
}

// The hidden config surface. Config paths follow additive + adjudicated semantics, distinct
// from the note reconcile's auto-delete/conflict-copy behavior (see reconcileOne).
const CONFIG_PREFIX = ".obsidian/";
function isConfig(path: string): boolean { return path.startsWith(CONFIG_PREFIX); }

async function readOrNull(io: VaultIo, path: string): Promise<Uint8Array | null> {
  try { return await io.read(path); } catch { return null; }
}

// True ONLY when `path` is definitively gone from disk, confirmed by a DIRECT per-path probe
// (io.exists, else a read) — never the directory LISTING. A listing UNDER-REPORTS when a directory
// fails to enumerate (io.list swallows a per-dir error), a cloud-drive placeholder (OneDrive
// Files-On-Demand) isn't hydrated, or an OS/AV lock hides a file — so a file that is STILL THERE looks
// absent. Returns false on ANY uncertainty (probe throws, or no probe available), so a transient /
// placeholder absence is never mistaken for a deletion. This is the delete-REMOTE analogue of
// delete-local's "a real tombstone, not mere absence" rule (issueFalseAbsenceDelete).
async function confirmedAbsent(io: VaultIo, path: string): Promise<boolean> {
  try {
    if (io.exists) return !(await io.exists(path));
    return (await readOrNull(io, path)) === null;
  } catch {
    return false; // couldn't determine → treat as present; never tombstone on uncertainty
  }
}

function nowUtc(): Date { return new Date(); }

// RS-4 (Round-7 scale): cap the merge-ancestor TEXT kept in the base. The base stored full text for
// every mergeable file, so a large-text vault held a second full copy in RAM and re-serialized all
// of it to data.json on every base change. Keep text only for reasonably-sized text files (the
// common note); a larger text file falls back to hash-only base — it can still sync, it just
// conflict-copies instead of 3-way-merging on divergence (fine for a 1 MB+ note, which is rare).
export const MAX_BASE_TEXT_BYTES = 1024 * 1024; // 1 MiB

// Record a file's post-sync state as the new base (text kept only if mergeable AND under the cap).
function setBase(d: ReconcileDeps, path: string, bytes: Uint8Array, hash: string): void {
  const keepText = isMergeable(path, bytes) && bytes.length <= MAX_BASE_TEXT_BYTES;
  d.base.set(path, keepText ? { hash, text: new TextDecoder().decode(bytes) } : { hash });
  d.onBaseChanged?.();
}

// Bring a remote file down. Large files stream straight to disk (never held whole in RAM)
// when the io supports it; otherwise fetch + write buffered. Base is set to the remote hash;
// the mergeable base TEXT is kept only on the buffered path (streamed files are large and
// non-mergeable, so their base is hash-only).
// If the on-disk content no longer matches what the reconcile decision was based on
// (`expectLocalHash`, null = "expected absent"), a local edit/CREATE raced this pull — preserve
// it as a conflict copy before we overwrite. Covers a racing edit of a present file AND a racing
// create of an expected-absent path (DI-3 / DI-R2#2 / DI-R2#4).
// Returns the conflict-copy path it wrote (so a caller whose subsequent write FAILS can remove the
// now-orphaned copy), or null if no race was detected. The copy name is tagged with the CURRENT
// content's hash — never a stale pre-fetch hash — so the tag always matches the copy's bytes.
// Sentinel: a raced pull of a CONFIG path was routed to adjudication instead of a note copy — the
// caller must NOT overwrite the raced local edit (R13-CR1). Not a real path (leading NUL).
const CONFIG_RACE_MARKER = " config-race";
async function conflictCopyIfRaced(d: ReconcileDeps, path: string, expectLocalHash: string | null): Promise<string | null> {
  const cur = await readOrNull(d.io, path);
  const curHash = cur ? await sha256hex(cur) : null;
  if (curHash !== expectLocalHash && cur) {
    if (isConfig(path)) {
      // A local `.obsidian/` file was rewritten (by its own plugin) DURING this clean pull → a genuine
      // config divergence. Config uses ADJUDICATION, never note-style copies: a stray `(conflict …).json`
      // would be pushed as junk config AND the resolver can't surface it. Record it + tell the caller
      // to leave the raced local edit in place for the user to adjudicate. (R13-CR1)
      d.onConfigConflict?.(path, "local edit raced a pull");
      return CONFIG_RACE_MARKER;
    }
    const copy = conflictCopyName(path, d.device, nowUtc(), curHash?.slice(0, 6) ?? "");
    await d.io.write(copy, cur);
    d.onConflict?.(path, copy);
    return copy;
  }
  return null;
}

// `expectLocalHash` is the local content hash the reconcile decision was based on. `guardRace`
// is true for reconcile-driven pulls (a racing local edit/create must be preserved) and false for
// explicit overwrites (a switch or user adjudication, where adopting remote IS the intent).
async function applyPull(d: ReconcileDeps, path: string, rmeta: FileMeta, expectLocalHash: string | null = null, guardRace = false): Promise<void> {
  if (rmeta.size >= STREAM_MIN_BYTES && d.io.appendWrite) {
    // Streamed large file: run the racing-edit check BEFORE streaming (streamFileToDisk writes +
    // renames atomically, so there's no post-fetch/pre-write seam to insert it into). The narrow
    // window of an edit landing DURING a multi-second large-file stream is the accepted residual.
    const racedCopy = guardRace ? await conflictCopyIfRaced(d, path, expectLocalHash) : null;
    if (racedCopy === CONFIG_RACE_MARKER) return; // config race → adjudicate, don't overwrite the local edit
    try {
      // streamFileToDisk now verifies the whole-file hash INCREMENTALLY, BEFORE its atomic rename
      // (R17), so a bad manifest aborts without ever overwriting `path` — no post-write re-read (which
      // regressed racing-write/conflict-copy safety) and no full-file re-buffer.
      if (await streamFileToDisk(d.api, d.cache, d.io, path, rmeta.chunks, rmeta.size, rmeta.hash)) {
        d.base.set(path, { hash: rmeta.hash });
        d.onBaseChanged?.();
        return;
      }
    } catch (e) {
      // The stream failed AFTER a racing-edit conflict copy was written, but nothing was overwritten
      // — so that copy is just a redundant duplicate of the current file. Remove the orphan before
      // propagating (issueConflictCopyCosmetic). Best-effort; the reconcile still fails the path.
      if (racedCopy) { try { await d.io.remove(racedCopy); } catch { /* best-effort cleanup */ } }
      throw e;
    }
    // streamFileToDisk returned false → fall back to the buffered path. The racing-edit copy (if any)
    // is already made above, so DON'T re-check/re-copy here (that produced a duplicate copy).
    const bytes = await fetchVerified(d, rmeta);
    try {
      await d.io.write(path, bytes);
    } catch (e) {
      if (racedCopy) { try { await d.io.remove(racedCopy); } catch { /* best-effort cleanup */ } } // R14 sync#4
      throw e;
    }
    setBase(d, path, bytes, rmeta.hash);
    return;
  }
  const bytes = await fetchVerified(d, rmeta);
  // Buffered path: check AFTER the fetch (catches a save that landed during the multi-chunk fetch).
  const racedCopy = guardRace ? await conflictCopyIfRaced(d, path, expectLocalHash) : null;
  if (racedCopy === CONFIG_RACE_MARKER) return; // config race → adjudicate, don't overwrite
  try {
    await d.io.write(path, bytes);
  } catch (e) {
    // Orphan cleanup, matching the streamed path (R14 sync#4): the write failed and nothing was
    // overwritten, so a racing-edit conflict copy is just a redundant duplicate of the unchanged
    // local file — remove it before propagating, so we don't surface a spurious conflict.
    if (racedCopy) { try { await d.io.remove(racedCopy); } catch { /* best-effort cleanup */ } }
    throw e;
  }
  setBase(d, path, bytes, rmeta.hash);
}

// R13: cheap periodic pass — re-hash ONLY `.obsidian/` config files (small + few) to catch a LOCAL
// config edit/removal that fired no reliable event (esp. mobile, which lacks the `raw` watcher),
// WITHOUT re-hashing the whole vault. Remote config changes arrive via the delta; a missed local
// NOTE edit is caught by the slower whole-vault scan (doReconcileAll's forceFullScan), not here.
export async function reconcileLocalConfig(d: ReconcileDeps): Promise<void> {
  const local = await d.io.list();
  const candidates = new Set<string>();
  for (const p of local.keys()) if (isConfig(p)) candidates.add(p);
  for (const p of d.base.paths()) if (isConfig(p)) candidates.add(p); // catch a LOCAL removal (base present, file gone)
  for (const p of candidates) {
    if (!accepts(d, p)) continue;
    const be = d.base.get(p);
    const st = local.get(p);
    // Fast-path (perf): if the on-disk (size, mtime) match the stamp from the last time we confirmed
    // this file equals its base, it hasn't changed — skip the read + SHA-256 entirely. This is what
    // lets the scan run OFTEN (mobile has no live `raw` event) without re-hashing every synced plugin's
    // bytes each pass. Same (size,mtime) heuristic the whole-vault scan uses (a write bumps mtime).
    if (baseStatUnchanged(be, st)) continue;
    const cur = await readOrNull(d.io, p);
    const curHash = cur ? await sha256hex(cur) : null;
    if (curHash === (be?.hash ?? null)) {
      // Unchanged vs base, but the stat stamp was missing/stale — record it so the NEXT scan skips
      // the hash (the stamp is dropped on restart, so the first post-restart scan re-hashes once).
      if (st && cur) d.base.stampStat(p, st.size, st.mtime);
      continue;
    }
    try {
      const rmeta = await d.api.fileMeta(p);
      await reconcileOne(d, p, { rmeta: rmeta ?? undefined, localSize: cur?.length ?? 0, locallyPresent: local.has(p) });
    } catch (e) {
      if (isConnectionError(e)) throw e; // server unreachable → abort the config pass (for-loop) → engine offline
      // Isolate EVERY per-file error (R14 sync#2), matching reconcileAll/reconcileDelta — not only
      // CommitConflictError. A momentarily-unreadable config file (AV lock, cloud-drive placeholder)
      // throws the "present but couldn't be read" guard, and re-throwing it here escaped to
      // doReconcileAll → drove the whole engine offline + forced a full re-hash every ~120s.
      d.onFileError?.(p, e);
    }
  }
}

// Fetch a remote file's chunks and VERIFY the reassembly hashes to the claimed value before it's
// used anywhere (written, merged, or adopted on a switch). A corrupt chunk blob (bit rot / bad
// restore) would otherwise be written to the user's note and laundered into "known-good" base, then
// re-served to every device. On mismatch we throw; reconcileAll's per-file guard logs + skips it,
// leaving the good local copy untouched while the rest of the sync proceeds.
async function fetchVerified(d: ReconcileDeps, meta: FileMeta): Promise<Uint8Array> {
  const bytes = await fetchFileBytes(d.api, d.cache, meta.chunks);
  const got = await sha256hex(bytes);
  if (got !== meta.hash) {
    throw new Error(`integrity check failed for '${meta.path}': got ${got.slice(0, 12)}, expected ${meta.hash.slice(0, 12)} — not applying (corrupt download?)`);
  }
  return bytes;
}

// Returns the ChangesResponse it fetched (version + history_floor) so the caller can run the D0019
// reset detection on the CONNECT path too, not just the poll path.
export async function reconcileAll(d: ReconcileDeps): Promise<ChangesResponse> {
  const resp = await d.api.changes(0);
  const remote = new Map<string, FileMeta>();
  for (const f of resp.upserts) remote.set(f.path, f);
  // Report the community-plugin ids the server holds, so the settings UI can offer plugins this device
  // doesn't have installed yet (a fresh vault adopting an existing one). Derived from the full manifest.
  if (d.onRemotePlugins) {
    const rp = new Set<string>();
    for (const p of remote.keys()) { const m = /^\.obsidian\/plugins\/([^/]+)\//.exec(p); if (m) rp.add(m[1]); }
    d.onRemotePlugins([...rp]);
  }
  const local = await d.io.list();
  // Bulk-delete guard (C2, widened): a server manifest that has LOST a suspicious fraction of our
  // synced history — not only one that is exactly empty — is the signature of index loss (partial
  // restore / reindex over an incomplete dir), not a genuine mass delete. Count the base paths this
  // pass would actually delete (missing from the manifest, still local, and accepted by this device)
  // and refuse the batch if that's the whole manifest (empty) or >= BULK_DELETE_RATIO of base.
  // Ratio denominator counts only ACCEPTED base paths: a stale base entry for a path this device
  // no longer accepts is never a deletion candidate, so including it would dilute the ratio and let
  // a genuine mass delete slip under the guard. (DI-R2 note)
  const basePaths = d.base.paths().filter((p) => accepts(d, p));
  const wouldDelete = basePaths.filter((p) => !remote.has(p) && local.has(p)).length;
  // SEC-DATA: per-pass ratio OR'd with the cumulative cross-pass guard (a paced drain never trips the
  // per-pass ratio); the guard records the deletes only when it lets them through (see runDeleteGuard).
  const guardBulkDelete = runDeleteGuard(d, basePaths.length, wouldDelete, remote.size === 0);
  // Positive deletion evidence: only a path the server actually TOMBSTONED may be delete-local'd.
  const tombstoned = new Set(resp.deletes.map((x) => x.path));
  const paths = [...new Set<string>([...local.keys(), ...remote.keys(), ...d.base.paths()])];
  const failedRemote: number[] = []; // server versions whose PULL failed this pass (R14 sync#1)
  // Progress = files that actually need TRANSFER, not files examined (a 900-file vault with 3 changes
  // should show "3 pending", not "897"). Cheaply pre-classify from the maps we already have (remote
  // hash vs base hash, real tombstones, brand-new local) — no local hashing. A same-size local edit
  // isn't detectable here and just isn't counted (minor under-count); it drives honestly to 0.
  const pendingPaths = new Set<string>();
  const declined: string[] = []; // remote files this device is set NOT to sync (config surface off / plugin not allowlisted)
  for (const p of paths) {
    // Only count work this device will ACTUALLY do. A remote file this device doesn't accept (a config
    // surface that's off, or a community plugin not in the allowlist) is skipped by reconcileOne, so
    // counting it as "pending" produced a phantom count that never drains (field: "20+ pending that
    // never do anything"). Track those separately as DECLINED so we can tell the user what's waiting.
    if (!accepts(d, p)) { if (remote.has(p)) declined.push(p); continue; }
    const r = remote.get(p); const b = d.base.get(p);
    if (r) { if ((b?.hash ?? null) !== r.hash) pendingPaths.add(p); }        // remote new/changed → pull/merge
    else if (tombstoned.has(p) && local.has(p)) pendingPaths.add(p);         // a real tombstone to apply
    else if (!b && local.has(p)) pendingPaths.add(p);                        // brand-new local → push
  }
  if (declined.length) d.onDeclined?.(declined); // surface "N files on the server aren't in your sync selection"
  let pending = pendingPaths.size; d.onProgress?.(pending);
  // Files are reconciled with bounded CONCURRENCY (Finding 1) under the shared error-isolation contract:
  // per-file errors stay isolated (one bad file never aborts the pass); a whole-connection failure aborts.
  // Hold the cursor below any failed change so it's retried next poll (R14 sync#1) — covering a failed
  // TOMBSTONE (delete-local) path too (R15 sync#2) — until its retry budget runs out (R18).
  await isolatedPass(d, paths, failedRemote,
    (p) => reconcileOne(d, p, { rmeta: remote.get(p), guardDelete: guardBulkDelete, localSize: local.get(p)?.size ?? 0, hasTombstone: (pp) => tombstoned.has(pp), locallyPresent: local.has(p), localStat: local.get(p) }),
    (p) => remote.get(p)?.version ?? resp.deletes.find((x) => x.path === p)?.version,
    (p) => { if (pendingPaths.has(p)) d.onProgress?.(--pending); },
  );
  advanceCursor(d, resp.version, failedRemote); // authoritative server version, held below the earliest failure
  return resp;
}

// Incremental remote reconcile (RS-3): reconcile ONLY the paths the server reports changed since
// our cursor (delta.upserts + delta.deletes) — NOT the whole vault. A remote poke previously ran
// the full reconcileAll (changes(0) + a re-hash of EVERY local file), which is seconds of CPU +
// battery on a large vault on mobile for a one-file change. Local-only edits are handled by the
// event path; the mass-loss / version-rewind cases route to the full reconcileAll (which carries
// the restore-on-absence + empty-manifest guard). Deletes here arrive as EXPLICIT tombstones
// (positive deletion evidence); a suspicious fraction of accepted base tombstoned at once is still
// guarded. Per-file errors are isolated (one bad file never aborts the batch).
export async function reconcileDelta(d: ReconcileDeps, delta: ChangesResponse): Promise<void> {
  const remote = new Map<string, FileMeta>();
  for (const f of delta.upserts) remote.set(f.path, f);
  const tombstoned = new Set(delta.deletes.map((x) => x.path));
  const baseSet = new Set(d.base.paths().filter((p) => accepts(d, p)));
  const wouldDelete = [...tombstoned].filter((p) => baseSet.has(p)).length;
  // SEC-DATA: same guard as reconcileAll — the delta path also delete-locals on tombstones, so a paced
  // drain must be caught here too (emptyManifest=false: a delta never reports the whole manifest empty).
  const guardBulkDelete = runDeleteGuard(d, baseSet.size, wouldDelete, false);
  const versionOf = (p: string) => remote.get(p)?.version ?? delta.deletes.find((x) => x.path === p)?.version;
  const failed: number[] = []; // change versions that failed to apply this pass (R14 sync#1)
  const changedAll = [...new Set<string>([...remote.keys(), ...tombstoned])];
  // Only count + process what this device will ACTUALLY sync. A remote change this device doesn't
  // accept (surface off / plugin not allowlisted) would be skipped by reconcileOne anyway; excluding
  // it here keeps "pending" honest (no phantom count) and surfaces it as DECLINED instead.
  const changed = changedAll.filter((p) => accepts(d, p)); // the delta IS the pending set (accepted-only)
  const declined = changedAll.filter((p) => !accepts(d, p) && remote.has(p));
  if (declined.length) d.onDeclined?.(declined);
  let pending = changed.length; d.onProgress?.(pending);
  await isolatedPass(d, changed, failed,
    async (p) => {
      // crit-round (data-integrity + sync critics, same root cause): the delta path MUST supply
      // `locallyPresent`, or the C1 "present-but-unreadable ≠ deleted" guard in reconcileOne is inert
      // here — a momentarily-unreadable file (AV lock / unhydrated cloud placeholder) during a poll
      // delta was mis-decided as a deletion (unguarded delete-remote) or cleared-then-resurrected.
      // Default to `true` (assume present) when the io can't answer, so we skip-and-retry rather than
      // destroy; a genuine local deletion still propagates via the event path / full scan (which have
      // authoritative presence). Matches reconcilePath's own io.exists probe.
      const present = d.io.exists ? await d.io.exists(p) : true;
      await reconcileOne(d, p, { rmeta: remote.get(p), guardDelete: guardBulkDelete, localSize: d.localSizeOf?.(p) ?? 0, hasTombstone: (pp) => tombstoned.has(pp), locallyPresent: present });
    },
    versionOf,
    () => d.onProgress?.(--pending),
  );
  advanceCursor(d, delta.version, failed); // authoritative delta version, held below the earliest failure
}

export async function reconcilePath(d: ReconcileDeps, path: string, localSize = 0): Promise<void> {
  // Single-path fetch — no whole-manifest pull per file event.
  const rmeta = await d.api.fileMeta(path);
  // C2 on the event path too: if this would delete a previously-synced file, first
  // confirm the server isn't wholesale-empty (server data loss) — only then does the
  // extra manifest fetch happen, so the common case stays a single /meta call.
  let guardDelete = false;
  let hasTombstone: (p: string) => boolean = () => false;
  if (rmeta === null && d.base.get(path)) {
    // DI-5: apply the SAME widened bulk-delete guard reconcileAll uses — not just the
    // empty-manifest case. A PARTIAL server index loss (restore-from-backup / reindex over an
    // incomplete dir) that drops many-but-not-all files is exactly what the ratio guard exists
    // to catch, and deletions frequently route through this per-event path under live editing.
    const manifest = await d.api.changes(0);
    const remoteSet = new Set(manifest.upserts.map((f) => f.path));
    const tombstoned = new Set(manifest.deletes.map((x) => x.path));
    hasTombstone = (p) => tombstoned.has(p); // delete-local requires a real deletion tombstone
    const basePaths = d.base.paths().filter((p) => accepts(d, p)); // accepted-only denominator (DI-R2 note)
    const wouldDelete = basePaths.filter((p) => !remoteSet.has(p)).length;
    // Per-pass ratio ONLY, no cumulative DeleteRateGuard (A5): a paced SERVER drain propagates via the
    // poll/delta/full-scan paths (which feed the cumulative guard), not this local-event path — so the
    // per-pass partial-index-loss guard is the applicable protection here. emptyManifest = server empty.
    guardDelete = isSuspiciousBulkDelete(basePaths.length, wouldDelete, remoteSet.size === 0);
  }
  // C1 (R10): if the server still has this path (rmeta present), a null local read could yield a
  // destructive delete-remote — so confirm the file is truly gone (not just unreadable) before
  // deciding. O(1) exists check, only when the server-has-it precondition holds.
  const locallyPresent = rmeta && d.io.exists ? await d.io.exists(path) : undefined;
  try {
    await reconcileOne(d, path, { rmeta: rmeta ?? undefined, guardDelete, localSize, hasTombstone, locallyPresent });
  } catch (e) {
    // A CAS 409 (a peer committed this path first) is NOT a connectivity failure. reconcileAll
    // isolates it per-file (skip → next reconcile merges); this single-path event path had no such
    // guard, so the engine turned a routine concurrent-edit conflict into an offline+backoff flap
    // (Round-6 CONC). Isolate it the same way: leave base unchanged so the next reconcile sees the
    // advanced remote and MERGES. Any OTHER error propagates → the engine goes offline + reconnects.
    if (e instanceof CommitConflictError) { d.onFileError?.(path, e); return; }
    throw e;
  }
}

// community-plugins.json is a SET of enabled plugin ids (and gates whether installed plugins RUN), not
// an opaque blob. Adopting a shorter synced copy whole (pull / divergence) would DISABLE a plugin that's
// installed+enabled on THIS device (issueConfigListDisable, the "all my plugins vanished" class). On the
// branches that would overwrite/merge remote INTO local, union-merge it as a grow-only set instead: keep
// every locally-enabled id, add the remote's — so a sync can never disable your plugins. Enables still
// propagate; a disable does not (you toggle it off per device) — the correct, catastrophe-proof asymmetry.
// Returns true if it handled the path (caller returns); false ⇒ wrong action or not a valid string[], so
// fall through to normal opaque-config handling. (Caller pre-checks isEnabledListConfig + rmeta present.)
async function reconcileEnabledPluginList(d: ReconcileDeps, path: string, rmeta: FileMeta, action: Action): Promise<boolean> {
  if (!(action === "pull" || action === "merge" || action === "conflict-copy" || action === "edit-wins-pull")) return false;
  const remoteBytes = await fetchVerified(d, rmeta);
  const remoteStr = new TextDecoder().decode(remoteBytes);
  const liveLocal = await readOrNull(d.io, path);
  const localStr = liveLocal ? new TextDecoder().decode(liveLocal) : "";
  const merged = mergeEnabledPluginsJson(localStr, remoteStr);
  if (merged === null) return false; // not a valid string[] → fall through to normal opaque-config handling
  const localIds = JSON.parse(localStr.trim() || "[]") as string[];
  const remoteIds = JSON.parse(remoteStr.trim() || "[]") as string[];
  const localHasExtra = localIds.some((id) => !remoteIds.includes(id));
  if (!localHasExtra) {
    await d.io.write(path, remoteBytes); // remote ⊇ local → adopt it; nothing is disabled, nothing to push
    setBase(d, path, remoteBytes, rmeta.hash);
  } else {
    const mergedBytes = new TextEncoder().encode(merged); // local has ids the server lacks → preserve them
    await d.io.write(path, mergedBytes);
    if (d.readOnly) {
      setBase(d, path, remoteBytes, rmeta.hash); // can't push on a read-only share; keep the union locally (reads as a kept local edit next pass)
    } else {
      const { hash: mh, bytes: mb } = await pushBytes(d.api, d.io, d.state, d.cache, path, mergedBytes, rmeta.version); // converge the server to the union
      setBase(d, path, mb, mh);
    }
  }
  d.onConfigResolved?.(path);
  return true;
}

// Both sides changed (action "merge") or diverged with no common base (action "conflict-copy"): verify
// the remote, re-read the CURRENT local (a save may have raced the multi-chunk fetch), adopt-on-cosmetic-
// EOL-only, else attempt a clean 3-way merge, else conflict-copy (remote becomes canonical, the current
// local is preserved as a copy). Read-only shares keep the reader's version as a LOCAL copy only for a
// genuine both-sides divergence (action "merge"), never for a no-base first-contact reconciliation.
async function reconcileMergeOrConflict(
  d: ReconcileDeps, path: string, rmeta: FileMeta, action: Action,
  baseEntry: { hash: string; text?: string } | null, localBytes: Uint8Array | null,
): Promise<void> {
  const remoteBytes = await fetchVerified(d, rmeta); // verify before merge/write (a corrupt blob must not be merged in)
  // DI-R3#1: re-read the CURRENT on-disk local AFTER the (multi-chunk, possibly slow) remote fetch and
  // use it for the WHOLE decision — a save that raced the fetch must feed both the auto-merge (latest
  // edit, not a stale snapshot) AND the conflict copy (so it's preserved).
  const liveLocal = (await readOrNull(d.io, path)) ?? localBytes!;
  // Tag the conflict copy with the hash of the bytes we actually write into it (liveLocal), NOT a stale
  // pre-fetch hash — a save racing the fetch changes liveLocal, and a stale tag would mislabel the copy.
  const liveLocalHash = await sha256hex(liveLocal);
  // Cosmetic-only difference (line endings / trailing newline) is NOT a real conflict — adopt remote,
  // record base, spawn NO copy. TEXT ONLY: isMergeable is extension- AND fatal-UTF-8-gated, so a binary
  // attachment is excluded (else the lossy TextDecoder could map two different binaries to one string
  // and silently clobber a local attachment — critique F1 / issueFalseEolConflict).
  if (isMergeable(path, liveLocal) && isMergeable(path, remoteBytes) && sameIgnoringEol(liveLocal, remoteBytes)) {
    await d.io.write(path, remoteBytes);
    setBase(d, path, remoteBytes, rmeta.hash);
    return;
  }
  if (d.readOnly) {
    // Read-only share: the owner's version is canonical and we push nothing. Preserve the reader's
    // version as a LOCAL copy ONLY for a genuine both-sides divergence against a KNOWN base ("merge").
    // A NO-BASE divergence ("conflict-copy") is first-contact reconciliation — adopt the owner's bytes
    // with NO copy (a read-only copy can never sync, so one just litters the vault permanently).
    if (action === "merge") {
      const copy = conflictCopyName(path, d.device, nowUtc(), liveLocalHash.slice(0, 6));
      await d.io.write(copy, liveLocal);
      d.onReadOnly?.(path); d.onConflict?.(path, copy);
    }
    await d.io.write(path, remoteBytes);
    setBase(d, path, remoteBytes, rmeta.hash);
    return;
  }
  // Both sides changed: attempt a clean three-way merge; fall through to a conflict copy only when it
  // can't merge cleanly (overlapping edits) or the file isn't mergeable text.
  const canMerge = action === "merge"
    && isMergeable(path, liveLocal) && isMergeable(path, remoteBytes) && baseEntry?.text !== undefined;
  if (canMerge) {
    const { merged, clean } = merge3(baseEntry!.text!, new TextDecoder().decode(liveLocal), new TextDecoder().decode(remoteBytes));
    if (clean) {
      // DI-R2#3: base from the COMMITTED bytes pushBytes returns, not the pre-write merged bytes. CAS
      // base = the remote version we merged against; a server advance between fetch and push 409s → re-merge.
      const mergedBytes = new TextEncoder().encode(merged);
      const { hash: h, bytes: committed } = await pushBytes(d.api, d.io, d.state, d.cache, path, mergedBytes, rmeta.version);
      setBase(d, path, committed, h);
      return;
    }
  }
  // Fallback / conflict-copy: remote becomes canonical; the current local is kept as a copy.
  const copy = conflictCopyName(path, d.device, nowUtc(), liveLocalHash.slice(0, 6));
  await d.io.write(copy, liveLocal);
  // C4 (R10): register the conflict NOW — the copy is on disk and preserved. pushFile below can throw
  // (network); if onConflict fired only after it, the copy would never reach the "needs review" list.
  d.onConflict?.(path, copy);
  await d.io.write(path, remoteBytes);
  const { hash: ch, bytes: cb } = await pushFile(d.api, d.io, d.state, d.cache, copy);
  d.base.set(copy, isMergeable(copy, cb) ? { hash: ch, text: new TextDecoder().decode(cb) } : { hash: ch });
  setBase(d, path, remoteBytes, rmeta.hash);
}

interface ReconcileOneOpts {
  rmeta?: FileMeta;                            // the server's meta for this path (undefined = server-absent)
  guardDelete?: boolean;                       // a suspicious MASS delete was detected this pass → guard destructive removals
  localSize?: number;                          // O(1) local size for the size gate (0 when unknown; reconcileOne reads to hash anyway)
  hasTombstone?: (p: string) => boolean;       // does the server hold a real deletion tombstone for p? (delete-local requires it)
  locallyPresent?: boolean;                    // does the vault report the file present? (C1: present-but-unreadable ≠ deleted)
  localStat?: { size: number; mtime: number }; // on-disk stat, for the scan-skip fast path
}

// Reconcile ONE path against the server — a dispatcher: selective-sync + size gate, decide(), then the
// enabled-plugin-list special-case, the config-divergence adjudication, and the per-action switch (the
// two large arms — plugin-list union and merge/conflict-copy — live in the helpers above).
async function reconcileOne(d: ReconcileDeps, path: string, opts: ReconcileOneOpts): Promise<void> {
  const { rmeta, guardDelete = false, localSize = 0, hasTombstone = () => false, locallyPresent, localStat } = opts;
  // Selective-sync gate FIRST: a path this device doesn't accept (a `.obsidian/` category it
  // opted out of) is skipped entirely — no pull, no base, no delete. This is the root-cause
  // fix for phantom deletions: if we recorded a base for a filtered path, the next sync would
  // read base-present + local-absent as a deletion and destroy it on the device that holds it.
  if (!accepts(d, path)) return;
  // Size gate: skip a file too large to hold in RAM — BEFORE reading it — and skip the
  // path ENTIRELY (no push, no pull, no delete), so a skipped huge file is never mistaken
  // for a deletion. A large DOWNLOAD (no local file → resolves to a pull) can be STREAMED
  // to disk when the io supports it, so it bypasses the ceiling; large uploads/edits still
  // buffer (chunking reads the whole local file), so they stay gated.
  const max = d.maxSyncBytes ?? DEFAULT_MAX_SYNC_BYTES;
  const remoteSize = rmeta?.size ?? 0;
  const streamableDownload = remoteSize >= STREAM_MIN_BYTES && localSize === 0 && !!d.io.appendWrite;
  if (localSize > max || (remoteSize > max && !streamableDownload)) {
    d.onSkip?.(path, Math.max(localSize, remoteSize));
    return;
  }
  const baseEntry = d.base.get(path) ?? null;
  // SCAN-SKIP (Finding 2): if the file is present and its (size, mtime) are UNCHANGED since we last
  // confirmed it equals `base`, its content is still `base.hash` — skip the read + SHA-256 entirely.
  // This turns each whole-vault pass from O(vault bytes) into O(changed files) (the recurring 15-min
  // full-reconcile re-hash was a real battery/CPU drain on large/mobile vaults). Turns each pass from
  // O(vault bytes) into O(changed files). GATED ON rmeta PRESENT (R15 DI#1): the only branch that acts
  // DESTRUCTIVELY on the assumed hash without a live re-read is delete-local (io.remove), and decide()
  // yields delete-local only when the REMOTE is absent (rmeta undefined). Requiring rmeta present means
  // a scan-hit can reach only in-sync or pull — both safe on an assumed hash (pull re-reads live via
  // conflictCopyIfRaced and conflict-copies a masked edit rather than clobbering it). A real edit
  // updates mtime AND fires a vault event → reconcilePath (always reads), so this only weakens the
  // missed-event backstop for a same-size-AND-same-mtime edit — the standard rsync/Syncthing residual.
  const scanHit = !!(locallyPresent && rmeta && baseStatUnchanged(baseEntry, localStat));
  let localBytes: Uint8Array | null;
  let localHash: string | null;
  if (scanHit) {
    localBytes = null;              // present + unchanged → content is baseEntry.hash; not read
    localHash = baseEntry!.hash;
  } else {
    localBytes = await readOrNull(d.io, path);
    // C1 (R10): a read that FAILS on a file the vault reports PRESENT is a transient error (antivirus
    // lock, unhydrated OneDrive/Dropbox placeholder, FS hiccup) — NOT a deletion. Left unguarded it
    // feeds decide() a null local and yields delete-remote (which has no tombstone/bulk-delete guard),
    // propagating a phantom deletion to every peer. Skip the path this pass instead; the per-file
    // handler logs it and the next reconcile retries. Only relevant for a previously-synced file.
    if (localBytes === null && baseEntry && locallyPresent) {
      throw new Error(`'${path}' is present but couldn't be read right now — skipping (won't be treated as deleted)`);
    }
    localHash = localBytes ? await sha256hex(localBytes) : null;
  }
  const action = decide(
    localHash ? { hash: localHash } : null,
    baseEntry ? { hash: baseEntry.hash } : null,
    rmeta ? { hash: rmeta.hash } : null,
  );
  // community-plugins.json is the enabled-plugin SET — union-merge it so a sync can never disable a
  // locally-enabled plugin (issueConfigListDisable). Handled in reconcileEnabledPluginList; on false
  // (wrong action or not a valid string[]) fall through to normal opaque-config handling below.
  if (isEnabledListConfig(path) && rmeta && await reconcileEnabledPluginList(d, path, rmeta, action)) return;
  // Config sync: adds, edits, and REMOVALS propagate like ordinary sync (auto-remove everywhere,
  // D0013). This is safe because the accepts() gate above guarantees only a device that genuinely
  // holds a path reaches here, so a delete is an EVIDENCED removal (a real tombstone), never a
  // phantom from a filtered/never-had replica — and we never auto-pull a removed file back, so
  // nothing resurrects. The ONE case still adjudicated is genuine DIVERGENCE — the same file
  // edited differently on both sides (merge / conflict-copy) — because a note-style conflict-copy
  // of a config file is filtered out and crashed the whole sync; the user picks which side wins.
  if (isConfig(path)) {
    // Adjudicate genuine divergence (same file edited both sides) AND edit-vs-delete (one side
    // removed, the other edited) — the latter would otherwise silently RESURRECT a removal
    // (edit-wins-pull pulls a locally-deleted config back) or REVERT one (edit-wins-keep-local
    // re-pushes a remotely-deleted config), contradicting the "never auto-resurrect" invariant.
    // Clean adds/edits/removals still propagate.
    if (action === "merge" || action === "conflict-copy" || action === "edit-wins-pull" || action === "edit-wins-keep-local") {
      d.onConfigConflict?.(path, action); return;
    }
    d.onConfigResolved?.(path); // clean (add/edit/remove/in-sync) — drop any stale pending entry, then apply below
  }
  switch (action) {
    case "in-sync":
      if (localBytes && rmeta) {
        setBase(d, path, localBytes, rmeta.hash);
        if (localStat) d.base.stampStat(path, localStat.size, localStat.mtime); // cache the scan-skip hint (Finding 2)
      }
      // Both sides absent but base still present: clear the stale base. Otherwise recreating the
      // file with content equal to the old base hash would read as delete-local and wipe it.
      else if (!localBytes && !rmeta && baseEntry) { d.base.delete(path); d.onBaseChanged?.(); }
      return;
    case "push": {
      if (d.readOnly) {
        // Can't upload to a read-only share. A conflict-copy file is DELIBERATELY local there (it can
        // never sync), so don't report it as a change that "won't sync" — that's just noise every
        // reconcile; the copy is already surfaced via the derived conflict list.
        if (!isConflictCopy(path)) d.onReadOnly?.(path);
        return;
      }
      // CAS: base this write on the remote version we saw (0 if this is a local-only create). If a
      // concurrent commit advanced the server past it, the commit 409s → CommitConflictError →
      // per-file skip → the next reconcile decides merge instead of a silent lost-update overwrite.
      const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, path, rmeta?.version ?? 0);
      setBase(d, path, bytes, h); // base from the COMMITTED bytes, never a separate read (DI-5)
      if (localStat) d.base.stampStat(path, localStat.size, localStat.mtime); // pushed file is unchanged on disk → cache the hint
      return;
    }
    case "pull":
      await applyPull(d, path, rmeta!, localHash, true); // guard a local edit/create racing the fetch (DI-3)
      return;
    case "delete-local":
      // DATA-SAFETY (durable delete guard): only delete a local file when the server has a real
      // deletion TOMBSTONE for it. Mere absence (local==base, remote-absent) is NOT proof of
      // deletion — it also happens when this device is pointed at a WRONG / FRESH / RESTORED server
      // that never had the file. Deleting on absence is what silently wiped local files after a
      // vault switch: the C2 ratio guard fired only on the FIRST (empty) reconcile; once our own
      // pushes made the remote non-empty, the ratio no longer tripped and the "kept" files were
      // deleted on the next pass. Requiring a tombstone is durable across passes. Without one, the
      // safe action is to RESTORE the file to the server, never to destroy local data.
      if (!hasTombstone(path)) {
        // D0019: report this keep-because-absent-without-tombstone so a history-reset pass can batch
        // it into one review notice (it's kept + pushed either way — this is observational only).
        d.onKeptAbsent?.(path);
        if (d.readOnly) { d.onReadOnly?.(path); return; } // read-only share: can't restore; just keep local
        // CAS (crit-round data-integrity): base the restore on "expected absent" (version 0) — the
        // precondition this decision was made on (remote had no copy). If a peer created this path
        // meanwhile, the commit 409s → CommitConflictError → per-file skip → the next reconcile MERGES
        // instead of the restore silently overwriting the peer's just-created content (lost update).
        const { hash: rh, bytes: rb } = await pushFile(d.api, d.io, d.state, d.cache, path, 0);
        setBase(d, path, rb, rh);
        return;
      }
      if (guardDelete) { d.onGuard?.(path); return; } // real tombstone(s) but a suspicious MASS delete — still guard
      await d.io.remove(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "delete-remote":
      if (d.readOnly) { d.onReadOnly?.(path); return; } // can't delete on a read-only share
      // EVIDENCED ABSENCE (issueFalseAbsenceDelete): decide() inferred a deletion because the file was
      // absent from the local LISTING — but a listing under-reports (a directory that failed to
      // enumerate, an un-hydrated OneDrive placeholder, an OS/AV lock), so it may still be on disk.
      // Tombstoning here would delete it FLEET-WIDE. Confirm real absence with a direct per-path probe
      // first; if it's still present (or unknowable), KEEP it — the next reconcile syncs it correctly.
      // Mirrors the delete-local "a real tombstone, not mere absence" discipline above; the single-path
      // route already re-probed via locallyPresent, but the batch route trusts the fallible list().
      if (!(await confirmedAbsent(d.io, path))) return;
      await d.api.deleteFile(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "edit-wins-keep-local": {
      if (d.readOnly) { d.onReadOnly?.(path); return; } // keep the local edit; don't push
      // Remote is absent (someone deleted it) but we edited — re-create it. CAS base = 0 (absent):
      // if a peer re-created it first, this 409s and the next reconcile merges the two versions.
      const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, path, rmeta?.version ?? 0);
      setBase(d, path, bytes, h); // base from the COMMITTED bytes (DI-5)
      return;
    }
    case "edit-wins-pull":
      await applyPull(d, path, rmeta!, localHash, true); // guard a local edit racing the fetch (DI-3)
      return;
    case "merge":
    case "conflict-copy":
      await reconcileMergeOrConflict(d, path, rmeta!, action, baseEntry, localBytes);
      return;
  }
}

// Resolve one adjudicated config conflict by the user's explicit choice. This is the ONLY
// place a config removal/divergence is acted on destructively or resurrectively — and only
// because the user chose it. "local" adopts this device's copy (push it canonical; if the
// local copy is gone, that IS the user choosing the removal → propagate it to the server).
// "remote" adopts the other device's copy (pull it; if the remote copy is gone, adopt that
// removal locally). Base is set to the winner so the next sync sees them agreeing.
export async function resolveConfigConflict(d: ReconcileDeps, path: string, choice: "local" | "remote"): Promise<void> {
  if (choice === "local") {
    const exists = await readOrNull(d.io, path);
    if (exists === null) { await d.api.deleteFile(path); d.base.delete(path); d.onBaseChanged?.(); return; }
    const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, path);
    setBase(d, path, bytes, h); // base from the COMMITTED bytes (DI-5)
  } else {
    const rmeta = await d.api.fileMeta(path);
    if (rmeta === null) { await d.io.remove(path); d.base.delete(path); d.onBaseChanged?.(); return; }
    await applyPull(d, path, rmeta);
  }
}

// How to resolve a one-time switch of which remote vault this local vault syncs to.
export type SwitchMode =
  | "download"  // target wins: adopt the target, discard local divergence
  | "upload"    // local wins: overwrite the target with this vault's content
  | "merge";    // union both: three-way merge / conflict-copy, nothing lost

// Resolve a vault switch. The client's base (last-synced ancestor) belongs to the OLD
// vault and is meaningless against the target, so it is reset here and rebuilt per the
// chosen mode. Unlike reconcileAll (which never clobbers), upload/download are the
// EXPLICIT authoritative overwrites the user selected at switch time; merge defers to
// reconcileAll over an empty base (push local-only, pull remote-only, conflict-copy
// same-path divergence — no data lost). io.list() is already selective-sync-filtered,
// so a switch only ever touches syncable files, never SelfSync's own config.
export async function switchTo(d: ReconcileDeps, mode: SwitchMode): Promise<void> {
  // Snapshot the pre-switch base before clearing it (R19). A file whose authoritative adopt FAILS
  // below (transient chunk error) would otherwise be left with a NULL base, and the next generic
  // reconcile — with local present + base null + remote present — would CONFLICT-COPY it, contradicting
  // the chosen mode (spurious copy on download; local demoted under remote on upload). Restoring its
  // pre-switch base on failure lets the retry re-adopt it via the normal decide() path instead, which
  // is data-safe (never a silent delete) and mode-correct for the common in-sync case.
  const oldBase = new Map(d.base.paths().map((p) => [p, d.base.get(p)!]));
  for (const p of d.base.paths()) d.base.delete(p); // no common ancestor across vaults
  d.retryBudget?.clear(); // R20: the OLD vault's per-path failure counts are meaningless against the target
  d.onBaseChanged?.();
  // R13-SF4: defense-in-depth — never push/delete on the server for a read-only share, even if a
  // caller (or a fail-open `perm` from the server) asked for an upload. The UI already blocks this.
  if (mode === "upload" && d.readOnly) throw new Error("refusing to upload to a read-only shared vault");
  if (mode === "merge") { await reconcileAll(d); return; }

  const max = d.maxSyncBytes ?? DEFAULT_MAX_SYNC_BYTES;
  // DI-1: gate the RAW server manifest through the SAME selective-sync filter reconcileOne uses.
  // Without this, a device that filters out (or has disabled) a `.obsidian/` category would, on
  // an "upload" switch, DELETE every such file on the server (it isn't in the filtered io.list()),
  // wiping another device's plugins/themes/settings; and on a "download" switch it would record a
  // base for a filtered path it never wrote, later reading base-present + local-absent as a
  // delete-remote. A path this device doesn't accept must be untouched by a switch.
  const resp = await d.api.changes(0);
  const remote = new Map<string, FileMeta>();
  for (const f of resp.upserts) if (accepts(d, f.path)) remote.set(f.path, f);
  const local = await d.io.list();

  // Server versions whose adopt FAILED this switch (R18); held below the cursor so the next poll retries.
  const failedRemote: number[] = [];
  if (mode === "download") await switchDownload(d, remote, local, oldBase, max, failedRemote);
  else await switchUpload(d, remote, local, max);
  // HOLD the cursor below any remote file whose adopt FAILED this switch (R18) so the next delta poll
  // re-visits it. Combined with the R19 pre-switch-base RESTORE (a failed download keeps its old base,
  // not null), the retry re-adopts it via the normal decide() path rather than a spurious conflict copy.
  advanceCursor(d, resp.version, failedRemote);
}

// "download" switch — mirror the target INTO this device: adopt each accepted remote file (streaming a
// large one straight to disk, size-gating one we can't stream), then remove local files the target lacks
// (guarded against a partial-manifest mass delete). Each file op is ISOLATED (R17 MEDIUM-2), so one bad
// file can't throw out of the whole switch → OFFLINE → infinite retry loop. A failed adopt RESTORES its
// pre-switch base (R19) so the retry re-adopts cleanly rather than conflict-copying. Populates `failed`.
async function switchDownload(
  d: ReconcileDeps, remote: Map<string, FileMeta>, local: Map<string, { mtime: number; size: number }>,
  oldBase: Map<string, BaseEntry>, max: number, failed: number[],
): Promise<void> {
  for (const [p, meta] of remote) {
    // DI-6: adopt via applyPull — STREAMS a large file straight to disk (never buffered whole) and
    // buffer-verifies a small one, the same path reconcileAll uses. Only a large file we CAN'T stream
    // (no appendWrite) is size-gated + skipped.
    const streamable = meta.size >= STREAM_MIN_BYTES && !!d.io.appendWrite;
    if (meta.size > max && !streamable) { d.onSkip?.(p, meta.size); continue; }
    try { await applyPull(d, p, meta); d.retryBudget?.delete(p); }
    catch (e) {
      d.onFileError?.(p, e);
      const prev = oldBase.get(p); if (prev) d.base.set(p, prev); // R19: restore pre-switch base → clean re-adopt, not a conflict-copy
      if (holdForRetry(d, p, meta.version)) failed.push(meta.version);
    }
  }
  // BULK-DELETE GUARD (crit-round sync): mirroring removes local files the target lacks — but a target
  // reindexed over a PARTIAL directory reports status:"ready" while missing files, so mirroring it would
  // mass-delete legitimate local-only notes. Apply the same ratio guard reconcileAll uses (empty target
  // or >= RATIO of the accepted local set → refuse the removals; the remote files were still adopted).
  const acceptedLocal = [...local.keys()].filter((p) => accepts(d, p));
  const toRemove = acceptedLocal.filter((p) => !remote.has(p));
  // Per-pass ratio only (a switch is a one-shot op — no next pass to accumulate across, so no cumulative guard, A5).
  const guardMassDelete = isSuspiciousBulkDelete(acceptedLocal.length, toRemove.length, remote.size === 0);
  for (const p of toRemove) {
    if (guardMassDelete) { d.onGuard?.(p); continue; } // suspicious mass delete → keep local, don't mirror-delete
    const info = local.get(p)!;
    if (info.size > max) { d.onSkip?.(p, info.size); continue; }
    try { await d.io.remove(p); } catch (e) { d.onFileError?.(p, e); }
  }
}

// "upload" switch — make THIS device authoritative: push every accepted local file (base from the
// COMMITTED bytes, DI-5), then drop remote files this vault lacks. A failed push deliberately leaves
// base NULL (R20, NOT the download R19 restore) so the retry conflict-COPIES rather than letting the
// target silently overwrite the local file the user chose to keep. remote is already accepts-filtered.
async function switchUpload(
  d: ReconcileDeps, remote: Map<string, FileMeta>, local: Map<string, { mtime: number; size: number }>, max: number,
): Promise<void> {
  for (const [p, info] of local) {
    if (!accepts(d, p)) continue;
    if (info.size > max) { d.onSkip?.(p, info.size); continue; }
    try {
      const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, p);
      setBase(d, p, bytes, h);
    } catch (e) {
      d.onFileError?.(p, e); // R20: leave base null → retry conflict-copies, never a silent overwrite
    }
  }
  for (const p of remote.keys()) { // drop remote files this vault lacks
    if (!local.has(p)) { try { await d.api.deleteFile(p); } catch (e) { d.onFileError?.(p, e); } }
  }
}

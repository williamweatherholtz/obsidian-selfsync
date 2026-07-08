import { SyncApi, VaultIo, SyncState, ChunkCache, pushFile, pushBytes, fetchFileBytes, streamFileToDisk } from "./sync";
import { sha256hex } from "./chunker";
import { BaseStore, conflictCopyName } from "./base";
import { isMergeable, merge3 } from "./merge";
import { ChangesResponse, CommitConflictError, FileMeta } from "./protocol";

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

// At/above this size a DOWNLOAD is streamed to disk (never buffered whole) when the io
// supports it — which also lets it bypass the buffered size gate. Uploads still buffer
// (chunking reads the whole local file), so they stay gated.
export const STREAM_MIN_BYTES = 8 * 1024 * 1024; // 8 MiB

export interface ReconcileDeps {
  api: SyncApi; io: VaultIo; base: BaseStore; cache: ChunkCache; state: SyncState;
  device: string; strategy: "auto-merge" | "conflict-file";
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
  onSkip?: (path: string, bytes: number) => void; // fired when a too-large file is skipped
  onReadOnly?: (path: string) => void; // fired when a local change can't sync (read-only vault)
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
}

// The hidden config surface. Config paths follow additive + adjudicated semantics, distinct
// from the note reconcile's auto-delete/conflict-copy behavior (see reconcileOne).
const CONFIG_PREFIX = ".obsidian/";
function isConfig(path: string): boolean { return path.startsWith(CONFIG_PREFIX); }

async function readOrNull(io: VaultIo, path: string): Promise<Uint8Array | null> {
  try { return await io.read(path); } catch { return null; }
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
async function conflictCopyIfRaced(d: ReconcileDeps, path: string, expectLocalHash: string | null): Promise<string | null> {
  const cur = await readOrNull(d.io, path);
  const curHash = cur ? await sha256hex(cur) : null;
  if (curHash !== expectLocalHash && cur) {
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
    try {
      if (await streamFileToDisk(d.api, d.cache, d.io, path, rmeta.chunks)) {
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
    await d.io.write(path, bytes);
    setBase(d, path, bytes, rmeta.hash);
    return;
  }
  const bytes = await fetchVerified(d, rmeta);
  // Buffered path: check AFTER the fetch (catches a save that landed during the multi-chunk fetch).
  if (guardRace) await conflictCopyIfRaced(d, path, expectLocalHash);
  await d.io.write(path, bytes);
  setBase(d, path, bytes, rmeta.hash);
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

export async function reconcileAll(d: ReconcileDeps): Promise<void> {
  const resp = await d.api.changes(0);
  const remote = new Map<string, FileMeta>();
  for (const f of resp.upserts) remote.set(f.path, f);
  const local = await d.io.list();
  // Bulk-delete guard (C2, widened): a server manifest that has LOST a suspicious fraction of our
  // synced history — not only one that is exactly empty — is the signature of index loss (partial
  // restore / reindex over an incomplete dir), not a genuine mass delete. Count the base paths this
  // pass would actually delete (missing from the manifest, still local, and accepted by this device)
  // and refuse the batch if that's the whole manifest (empty) or >= BULK_DELETE_RATIO of base.
  // Ratio denominator counts only ACCEPTED base paths: a stale base entry for a path this device
  // no longer accepts is never a deletion candidate, so including it would dilute the ratio and let
  // a genuine mass delete slip under the guard. (DI-R2 note)
  const basePaths = d.base.paths().filter((p) => !d.accepts || d.accepts(p));
  const wouldDelete = basePaths.filter((p) => !remote.has(p) && local.has(p)).length;
  const guardBulkDelete = basePaths.length > 0 && (remote.size === 0
    || (basePaths.length >= BULK_DELETE_MIN && wouldDelete / basePaths.length >= BULK_DELETE_RATIO));
  // Positive deletion evidence: only a path the server actually TOMBSTONED may be delete-local'd.
  const tombstoned = new Set(resp.deletes.map((x) => x.path));
  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...d.base.paths()]);
  for (const p of paths) {
    try { await reconcileOne(d, p, remote.get(p), guardBulkDelete, local.get(p)?.size ?? 0, (pp) => tombstoned.has(pp)); }
    catch (e) { d.onFileError?.(p, e); } // isolate: one file's failure must never abort the whole sync
  }
  // Set the cursor to the server's authoritative version (a full changes(0) reconcile just made
  // us consistent with it). ASSIGN, not max: if the server REWOUND (reindex/restore, V_s < V_c),
  // max would pin the cursor high forever, so every idle poll sees a mismatch and re-runs a full
  // reconcile indefinitely. Assigning lets the incremental poll path converge again. (CONC-R2#3)
  d.state.version = resp.version;
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
  const baseSet = new Set(d.base.paths().filter((p) => !d.accepts || d.accepts(p)));
  const wouldDelete = [...tombstoned].filter((p) => baseSet.has(p)).length;
  const guardBulkDelete = baseSet.size >= BULK_DELETE_MIN && wouldDelete / baseSet.size >= BULK_DELETE_RATIO;
  for (const p of new Set<string>([...remote.keys(), ...tombstoned])) {
    try { await reconcileOne(d, p, remote.get(p), guardBulkDelete, d.localSizeOf?.(p) ?? 0, (pp) => tombstoned.has(pp)); }
    catch (e) { d.onFileError?.(p, e); }
  }
  d.state.version = delta.version; // assign, not max (rewind convergence) — same as reconcileAll
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
    const basePaths = d.base.paths().filter((p) => !d.accepts || d.accepts(p)); // accepted-only denominator (DI-R2 note)
    const wouldDelete = basePaths.filter((p) => !remoteSet.has(p)).length;
    guardDelete = basePaths.length > 0 && (remoteSet.size === 0
      || (basePaths.length >= BULK_DELETE_MIN && wouldDelete / basePaths.length >= BULK_DELETE_RATIO));
  }
  try {
    await reconcileOne(d, path, rmeta ?? undefined, guardDelete, localSize, hasTombstone);
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

async function reconcileOne(d: ReconcileDeps, path: string, rmeta: FileMeta | undefined, guardDelete = false, localSize = 0, hasTombstone: (p: string) => boolean = () => false): Promise<void> {
  // Selective-sync gate FIRST: a path this device doesn't accept (a `.obsidian/` category it
  // opted out of) is skipped entirely — no pull, no base, no delete. This is the root-cause
  // fix for phantom deletions: if we recorded a base for a filtered path, the next sync would
  // read base-present + local-absent as a deletion and destroy it on the device that holds it.
  if (d.accepts && !d.accepts(path)) return;
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
  const localBytes = await readOrNull(d.io, path);
  const localHash = localBytes ? await sha256hex(localBytes) : null;
  const baseEntry = d.base.get(path) ?? null;
  const action = decide(
    localHash ? { hash: localHash } : null,
    baseEntry ? { hash: baseEntry.hash } : null,
    rmeta ? { hash: rmeta.hash } : null,
  );
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
      if (localBytes && rmeta) setBase(d, path, localBytes, rmeta.hash);
      // Both sides absent but base still present: clear the stale base. Otherwise recreating the
      // file with content equal to the old base hash would read as delete-local and wipe it.
      else if (!localBytes && !rmeta && baseEntry) { d.base.delete(path); d.onBaseChanged?.(); }
      return;
    case "push": {
      if (d.readOnly) { d.onReadOnly?.(path); return; } // can't upload to a read-only share
      // CAS: base this write on the remote version we saw (0 if this is a local-only create). If a
      // concurrent commit advanced the server past it, the commit 409s → CommitConflictError →
      // per-file skip → the next reconcile decides merge instead of a silent lost-update overwrite.
      const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, path, rmeta?.version ?? 0);
      setBase(d, path, bytes, h); // base from the COMMITTED bytes, never a separate read (DI-5)
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
        const { hash: rh, bytes: rb } = await pushFile(d.api, d.io, d.state, d.cache, path);
        setBase(d, path, rb, rh);
        return;
      }
      if (guardDelete) { d.onGuard?.(path); return; } // real tombstone(s) but a suspicious MASS delete — still guard
      await d.io.remove(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "delete-remote":
      if (d.readOnly) { d.onReadOnly?.(path); return; } // can't delete on a read-only share
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
    case "conflict-copy": {
      const remoteBytes = await fetchVerified(d, rmeta!); // verify before merge/write (a corrupt blob must not be merged in)
      // DI-R3#1: re-read the CURRENT on-disk local content AFTER the (multi-chunk, possibly slow)
      // remote fetch and use it for the whole merge/conflict decision. A save that raced the fetch
      // must feed BOTH the auto-merge (so the latest edit is merged, not a stale snapshot) AND the
      // conflict copy (so it's preserved) — the DI-R2#5 fix covered the copies but the clean-merge
      // branch still used the stale pre-fetch localBytes, silently dropping the racing edit.
      const liveLocal = (await readOrNull(d.io, path)) ?? localBytes!;
      // Tag the conflict copy with the hash of the bytes we actually write into it (liveLocal), NOT
      // the pre-fetch localHash — a save that raced the multi-chunk fetch changes liveLocal, and a
      // stale tag would mislabel the copy (issueConflictCopyCosmetic).
      const liveLocalHash = await sha256hex(liveLocal);
      if (d.readOnly) {
        // Read-only share: the owner's version is canonical and we push nothing. Keep the
        // reader's (current) local edit as a LOCAL-only conflict copy so it isn't silently lost.
        const copy = conflictCopyName(path, d.device, nowUtc(), liveLocalHash.slice(0, 6));
        await d.io.write(copy, liveLocal);
        await d.io.write(path, remoteBytes);
        setBase(d, path, remoteBytes, rmeta!.hash);
        d.onReadOnly?.(path); d.onConflict?.(path, copy);
        return;
      }
      const canMerge = action === "merge" && d.strategy === "auto-merge"
        && isMergeable(path, liveLocal) && isMergeable(path, remoteBytes) && baseEntry?.text !== undefined;
      if (canMerge) {
        const { merged, clean } = merge3(baseEntry!.text!, new TextDecoder().decode(liveLocal), new TextDecoder().decode(remoteBytes));
        if (clean) {
          const mergedBytes = new TextEncoder().encode(merged);
          // DI-R2#3: record base from the COMMITTED bytes pushBytes returns, not the pre-write
          // merged bytes — a racing save between write and re-read would otherwise desync base.
          // CAS base = the remote version we merged against; if the server advanced again between
          // our fetch and this push, the commit 409s and the next reconcile re-merges the newer remote.
          const { hash: h, bytes: committed } = await pushBytes(d.api, d.io, d.state, d.cache, path, mergedBytes, rmeta!.version);
          setBase(d, path, committed, h);
          return;
        }
      }
      // Fallback / conflict-copy: remote becomes canonical; the current local is kept as a copy.
      const copy = conflictCopyName(path, d.device, nowUtc(), liveLocalHash.slice(0, 6));
      await d.io.write(copy, liveLocal);
      await d.io.write(path, remoteBytes);
      const { hash: ch, bytes: cb } = await pushFile(d.api, d.io, d.state, d.cache, copy);
      d.base.set(copy, isMergeable(copy, cb) ? { hash: ch, text: new TextDecoder().decode(cb) } : { hash: ch });
      setBase(d, path, remoteBytes, rmeta!.hash);
      d.onConflict?.(path, copy);
      return;
    }
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
  for (const p of d.base.paths()) d.base.delete(p); // no common ancestor across vaults
  d.onBaseChanged?.();
  if (mode === "merge") { await reconcileAll(d); return; }

  const max = d.maxSyncBytes ?? DEFAULT_MAX_SYNC_BYTES;
  // DI-1: gate the RAW server manifest through the SAME selective-sync filter reconcileOne uses.
  // Without this, a device that filters out (or has disabled) a `.obsidian/` category would, on
  // an "upload" switch, DELETE every such file on the server (it isn't in the filtered io.list()),
  // wiping another device's plugins/themes/settings; and on a "download" switch it would record a
  // base for a filtered path it never wrote, later reading base-present + local-absent as a
  // delete-remote. A path this device doesn't accept must be untouched by a switch.
  const accepted = (p: string) => !d.accepts || d.accepts(p);
  const resp = await d.api.changes(0);
  const remote = new Map<string, FileMeta>();
  for (const f of resp.upserts) if (accepted(f.path)) remote.set(f.path, f);
  const local = await d.io.list();

  if (mode === "download") {
    for (const [p, meta] of remote) {
      // DI-6: adopt each remote file via applyPull, which STREAMS a large file straight to disk
      // (never buffering it whole) and buffer-verifies a small one — the same path reconcileAll
      // uses. Only a large file we CAN'T stream (no appendWrite) is size-gated + skipped.
      const streamable = meta.size >= STREAM_MIN_BYTES && !!d.io.appendWrite;
      if (meta.size > max && !streamable) { d.onSkip?.(p, meta.size); continue; }
      await applyPull(d, p, meta);
    }
    for (const [p, info] of local) {            // drop local files the target lacks
      if (!accepted(p) || remote.has(p)) continue;
      if (info.size > max) { d.onSkip?.(p, info.size); continue; }
      await d.io.remove(p);
    }
  } else { // upload
    for (const [p, info] of local) {
      if (!accepted(p)) continue;
      if (info.size > max) { d.onSkip?.(p, info.size); continue; }
      const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, p);
      setBase(d, p, bytes, h); // base from the COMMITTED bytes, not a re-read (DI-5)
    }
    for (const p of remote.keys()) {            // drop remote files this vault lacks
      if (!local.has(p)) await d.api.deleteFile(p); // remote is already accepts-filtered above
    }
  }
  d.state.version = resp.version; // assign, not max — see CONC-R2#3 note in reconcileAll
}

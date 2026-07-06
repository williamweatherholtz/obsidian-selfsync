import { SyncApi, VaultIo, SyncState, ChunkCache, pushFile, pushBytes, fetchFileBytes, streamFileToDisk } from "./sync";
import { sha256hex } from "./chunker";
import { BaseStore, conflictCopyName } from "./base";
import { isMergeable, merge3 } from "./merge";
import { FileMeta } from "./protocol";

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
}

// The hidden config surface. Config paths follow additive + adjudicated semantics, distinct
// from the note reconcile's auto-delete/conflict-copy behavior (see reconcileOne).
const CONFIG_PREFIX = ".obsidian/";
function isConfig(path: string): boolean { return path.startsWith(CONFIG_PREFIX); }

async function readOrNull(io: VaultIo, path: string): Promise<Uint8Array | null> {
  try { return await io.read(path); } catch { return null; }
}

function nowUtc(): Date { return new Date(); }

// Record a file's post-sync state as the new base (text kept only if mergeable).
function setBase(d: ReconcileDeps, path: string, bytes: Uint8Array, hash: string): void {
  d.base.set(path, isMergeable(path, bytes) ? { hash, text: new TextDecoder().decode(bytes) } : { hash });
  d.onBaseChanged?.();
}

// Bring a remote file down. Large files stream straight to disk (never held whole in RAM)
// when the io supports it; otherwise fetch + write buffered. Base is set to the remote hash;
// the mergeable base TEXT is kept only on the buffered path (streamed files are large and
// non-mergeable, so their base is hash-only).
async function applyPull(d: ReconcileDeps, path: string, rmeta: FileMeta): Promise<void> {
  if (rmeta.size >= STREAM_MIN_BYTES && await streamFileToDisk(d.api, d.cache, d.io, path, rmeta.chunks)) {
    d.base.set(path, { hash: rmeta.hash });
    d.onBaseChanged?.();
    return;
  }
  const bytes = await fetchVerified(d, rmeta);
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
  const basePaths = d.base.paths();
  const wouldDelete = basePaths.filter((p) => !remote.has(p) && local.has(p) && (!d.accepts || d.accepts(p))).length;
  const guardBulkDelete = basePaths.length > 0 && (remote.size === 0
    || (basePaths.length >= BULK_DELETE_MIN && wouldDelete / basePaths.length >= BULK_DELETE_RATIO));
  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...d.base.paths()]);
  for (const p of paths) {
    try { await reconcileOne(d, p, remote.get(p), guardBulkDelete, local.get(p)?.size ?? 0); }
    catch (e) { d.onFileError?.(p, e); } // isolate: one file's failure must never abort the whole sync
  }
  // Advance our cursor to the server's version so idle polls can check incrementally.
  d.state.version = Math.max(d.state.version, resp.version);
}

export async function reconcilePath(d: ReconcileDeps, path: string, localSize = 0): Promise<void> {
  // Single-path fetch — no whole-manifest pull per file event.
  const rmeta = await d.api.fileMeta(path);
  // C2 on the event path too: if this would delete a previously-synced file, first
  // confirm the server isn't wholesale-empty (server data loss) — only then does the
  // extra manifest fetch happen, so the common case stays a single /meta call.
  let guardDelete = false;
  if (rmeta === null && d.base.get(path)) {
    const manifest = await d.api.changes(0);
    guardDelete = manifest.upserts.length === 0 && d.base.paths().length > 0;
  }
  await reconcileOne(d, path, rmeta ?? undefined, guardDelete, localSize);
}

async function reconcileOne(d: ReconcileDeps, path: string, rmeta: FileMeta | undefined, guardDelete = false, localSize = 0): Promise<void> {
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
      const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, path);
      setBase(d, path, bytes, h); // base from the COMMITTED bytes, never a separate read (DI-5)
      return;
    }
    case "pull":
      await applyPull(d, path, rmeta!);
      return;
    case "delete-local":
      if (guardDelete) { d.onGuard?.(path); return; } // C2: suspicious empty remote — keep the local file
      await d.io.remove(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "delete-remote":
      if (d.readOnly) { d.onReadOnly?.(path); return; } // can't delete on a read-only share
      await d.api.deleteFile(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "edit-wins-keep-local": {
      if (d.readOnly) { d.onReadOnly?.(path); return; } // keep the local edit; don't push
      const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, path); // re-create remotely
      setBase(d, path, bytes, h); // base from the COMMITTED bytes (DI-5)
      return;
    }
    case "edit-wins-pull":
      await applyPull(d, path, rmeta!);
      return;
    case "merge":
    case "conflict-copy": {
      const remoteBytes = await fetchVerified(d, rmeta!); // verify before merge/write (a corrupt blob must not be merged in)
      if (d.readOnly) {
        // Read-only share: the owner's version is canonical and we push nothing. Keep the
        // reader's local edit as a LOCAL-only conflict copy so it isn't silently lost.
        const copy = conflictCopyName(path, d.device, nowUtc(), localHash?.slice(0, 6) ?? "");
        await d.io.write(copy, localBytes!);
        await d.io.write(path, remoteBytes);
        setBase(d, path, remoteBytes, rmeta!.hash);
        d.onReadOnly?.(path); d.onConflict?.(path, copy);
        return;
      }
      const canMerge = action === "merge" && d.strategy === "auto-merge"
        && isMergeable(path, localBytes!) && isMergeable(path, remoteBytes) && baseEntry?.text !== undefined;
      if (canMerge) {
        const { merged, clean } = merge3(baseEntry!.text!, new TextDecoder().decode(localBytes!), new TextDecoder().decode(remoteBytes));
        if (clean) {
          const bytes = new TextEncoder().encode(merged);
          const h = await pushBytes(d.api, d.io, d.state, d.cache, path, bytes);
          setBase(d, path, bytes, h);
          return;
        }
      }
      // Fallback / conflict-copy: remote becomes canonical; local kept as a copy.
      const copy = conflictCopyName(path, d.device, nowUtc(), localHash?.slice(0, 6) ?? "");
      await d.io.write(copy, localBytes!);
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
  const resp = await d.api.changes(0);
  const remote = new Map<string, FileMeta>();
  for (const f of resp.upserts) remote.set(f.path, f);
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
      if (remote.has(p)) continue;
      if (info.size > max) { d.onSkip?.(p, info.size); continue; }
      await d.io.remove(p);
    }
  } else { // upload
    for (const [p, info] of local) {
      if (info.size > max) { d.onSkip?.(p, info.size); continue; }
      const { hash: h, bytes } = await pushFile(d.api, d.io, d.state, d.cache, p);
      setBase(d, p, bytes, h); // base from the COMMITTED bytes, not a re-read (DI-5)
    }
    for (const p of remote.keys()) {            // drop remote files this vault lacks
      if (!local.has(p)) await d.api.deleteFile(p);
    }
  }
  d.state.version = Math.max(d.state.version, resp.version);
}

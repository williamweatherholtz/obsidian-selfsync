import { SyncApi, VaultIo, SyncState, ChunkCache, pushFile, pushBytes, fetchFileBytes } from "./sync";
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

export interface ReconcileDeps {
  api: SyncApi; io: VaultIo; base: BaseStore; cache: ChunkCache; state: SyncState;
  device: string; strategy: "auto-merge" | "conflict-file";
  maxSyncBytes?: number;
  onConflict?: (path: string, copy: string) => void;
  onBaseChanged?: () => void;
  onGuard?: (path: string) => void; // fired when a suspicious bulk-delete is refused (C2)
  onSkip?: (path: string, bytes: number) => void; // fired when a too-large file is skipped
}

async function readOrNull(io: VaultIo, path: string): Promise<Uint8Array | null> {
  try { return await io.read(path); } catch { return null; }
}

function nowUtc(): Date { return new Date(); }

// Record a file's post-sync state as the new base (text kept only if mergeable).
function setBase(d: ReconcileDeps, path: string, bytes: Uint8Array, hash: string): void {
  d.base.set(path, isMergeable(path, bytes) ? { hash, text: new TextDecoder().decode(bytes) } : { hash });
  d.onBaseChanged?.();
}

export async function reconcileAll(d: ReconcileDeps): Promise<void> {
  const resp = await d.api.changes(0);
  const remote = new Map<string, FileMeta>();
  for (const f of resp.upserts) remote.set(f.path, f);
  // C2: an empty server manifest while we hold synced history (a non-empty base) is
  // the signature of server-side index loss, not a genuine "delete everything". Refuse
  // to propagate the resulting bulk delete-local (push/pull still proceed, so real local
  // files re-populate the server); a genuine delete-all is recoverable by re-deleting.
  const guardBulkDelete = remote.size === 0 && d.base.paths().length > 0;
  const local = await d.io.list();
  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...d.base.paths()]);
  for (const p of paths) await reconcileOne(d, p, remote.get(p), guardBulkDelete, local.get(p)?.size ?? 0);
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
  // Size gate: skip a file too large to hold in RAM — BEFORE reading it — and skip the
  // path ENTIRELY (no push, no pull, no delete), so a skipped huge file is never
  // mistaken for a deletion. Gates both a large local file and a large remote one.
  const max = d.maxSyncBytes ?? DEFAULT_MAX_SYNC_BYTES;
  if (localSize > max || (rmeta?.size ?? 0) > max) {
    d.onSkip?.(path, Math.max(localSize, rmeta?.size ?? 0));
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
  switch (action) {
    case "in-sync":
      if (localBytes && rmeta) setBase(d, path, localBytes, rmeta.hash);
      return;
    case "push": {
      const h = await pushFile(d.api, d.io, d.state, d.cache, path);
      setBase(d, path, localBytes!, h);
      return;
    }
    case "pull": {
      const bytes = await fetchFileBytes(d.api, d.cache, rmeta!.chunks);
      await d.io.write(path, bytes);
      setBase(d, path, bytes, rmeta!.hash);
      return;
    }
    case "delete-local":
      if (guardDelete) { d.onGuard?.(path); return; } // C2: suspicious empty remote — keep the local file
      await d.io.remove(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "delete-remote":
      await d.api.deleteFile(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "edit-wins-keep-local": {
      const h = await pushFile(d.api, d.io, d.state, d.cache, path); // re-create remotely
      setBase(d, path, localBytes!, h);
      return;
    }
    case "edit-wins-pull": {
      const bytes = await fetchFileBytes(d.api, d.cache, rmeta!.chunks);
      await d.io.write(path, bytes); setBase(d, path, bytes, rmeta!.hash);
      return;
    }
    case "merge":
    case "conflict-copy": {
      const remoteBytes = await fetchFileBytes(d.api, d.cache, rmeta!.chunks);
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
      const ch = await pushFile(d.api, d.io, d.state, d.cache, copy);
      d.base.set(copy, isMergeable(copy, localBytes!) ? { hash: ch, text: new TextDecoder().decode(localBytes!) } : { hash: ch });
      setBase(d, path, remoteBytes, rmeta!.hash);
      d.onConflict?.(path, copy);
      return;
    }
  }
}

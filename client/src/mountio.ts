// Phase 2 of composed vaults (D0039, nComposedVaults): the two-sided PREFIX-TRANSLATING adapters that let
// a Mount reuse the EXISTING reconcile engine unchanged. A mount operates in MOUNT-RELATIVE path space; these
// adapters bridge that middle to the two real endpoints — the LOCAL vault (via MountedIo, prefixing the
// mountPoint) and the SOURCE server-vault (via MountedApi, prefixing sourcePath). Both are pure wrappers over
// an injected VaultIo/SyncApi (no Obsidian API, no transport), so the translation + the data-only + read-only
// invariants are exhaustively unit-testable and can never drift from the reconcile that consumes them.
//
// LOAD-BEARING WIRING INVARIANT (the Phase-3 engine MUST honor; these pure adapters CANNOT enforce it —
// issueMountBaseIsolation): a mount's ReconcileDeps MUST be given its OWN BaseStore + SyncState + cursor,
// NEVER the primary scope's. reconcileAll's path universe is (local ∪ remote ∪ base.paths()); if a mount ran
// against the primary's base (full-vault paths) while its io/api are re-keyed to mount-relative space, every
// primary path would read as local-absent + base-present → a phantom mass delete-local/delete-remote. The
// mount engine allocates a fresh, mount-scoped base — verified in the wiring increment's tests, not here.
import { Mount, mountRelFromLocal, localFromMountRel, mountRelFromSource, sourceFromMountRel } from "./mounts";
import { VaultIo, SyncApi, AppendHandle } from "./sync";
import { FileMeta, ChangesResponse, CommitRequest, Deletion } from "./protocol";

// The DATA-ONLY boundary (D0039 keystone): a mount syncs notes/attachments, NEVER config/plugins — because
// when two vaults compose, WHICH one owns a plugin's settings is indeterminate. Reject anything under
// `.obsidian/` (the config/plugin tree, incl. SelfSync's own credential folder) in mount-relative space, so
// a whole-source mount (sourcePath "") can't drag config across the boundary in either direction. The compare
// is CASE-FOLDED: `.Obsidian`/`.OBSIDIAN` resolve to the same real dir on a case-insensitive FS (Win/macOS),
// so a case variant must not slip through as "data".
export function isDataPath(rel: string): boolean {
  const segs = rel.split("/").filter(Boolean);
  return segs.length > 0 && segs[0].toLowerCase() !== ".obsidian";
}

// A VaultIo scoped to ONE mount: mount-relative `<rel>` <-> local `<mountPoint>/<rel>`. list() returns only
// the mount subtree, re-keyed to mount-relative + data-only-filtered, so the reconcile sees a self-contained
// mini-vault that never overlaps the primary scope. Optional exists/appendWrite mirror the base's capability
// (so reconcile's `io.exists ?` capability checks stay honest — a mount over a mobile io still lacks them).
export class MountedIo implements VaultIo {
  exists?: (rel: string) => Promise<boolean>;
  appendWrite?: (rel: string) => Promise<AppendHandle>;
  constructor(private readonly base: VaultIo, private readonly mount: Mount) {
    if (base.exists) this.exists = (rel) => base.exists!(localFromMountRel(mount, rel));
    if (base.appendWrite) this.appendWrite = (rel) => base.appendWrite!(localFromMountRel(mount, rel));
  }
  async list(): Promise<Map<string, { mtime: number; size: number; ctime?: number }>> {
    const out = new Map<string, { mtime: number; size: number; ctime?: number }>();
    for (const [p, stat] of await this.base.list()) {
      const rel = mountRelFromLocal(this.mount, p);
      if (rel !== null && rel !== "" && isDataPath(rel)) out.set(rel, stat);
    }
    return out;
  }
  read(rel: string): Promise<Uint8Array> { return this.base.read(localFromMountRel(this.mount, rel)); }
  write(rel: string, bytes: Uint8Array): Promise<void> { return this.base.write(localFromMountRel(this.mount, rel), bytes); }
  remove(rel: string): Promise<void> { return this.base.remove(localFromMountRel(this.mount, rel)); }
}

// A SyncApi scoped to ONE mount over a base API already bound to the SOURCE server-vault (owner/vaultId): it
// translates mount-relative `<rel>` <-> source `<sourcePath>/<rel>` on every path-bearing call, DROPS anything
// outside this mount's source subtree or non-data on the pull streams (changes), and — the load-bearing safety
// invariant — HARD-REFUSES any write (commit/deleteFile) on a `pull` (read-only) mount, so a read-only mount
// can never mutate its source even if a caller mis-routes. Hash ops (missing/getChunk/putChunk) pass through.
export class MountedApi implements SyncApi {
  constructor(private readonly base: SyncApi, private readonly mount: Mount) {}
  private toRel(m: FileMeta): FileMeta | null {
    const rel = mountRelFromSource(this.mount, m.path);
    return rel === null ? null : { ...m, path: rel };
  }
  async changes(since: number): Promise<ChangesResponse> {
    const r = await this.base.changes(since);
    const upserts = r.upserts.map((m) => this.toRel(m)).filter((m): m is FileMeta => m !== null && isDataPath(m.path));
    const deletes = r.deletes
      .map((d): Deletion | null => { const rel = mountRelFromSource(this.mount, d.path); return rel !== null && isDataPath(rel) ? { ...d, path: rel } : null; })
      .filter((d): d is Deletion => d !== null);
    return { ...r, upserts, deletes }; // version still advances over the source vault's global cursor (filtered paths just aren't this mount's concern)
  }
  async fileMeta(rel: string): Promise<FileMeta | null> {
    if (!isDataPath(rel)) return null; // a config path is invisible across a mount boundary even via a direct meta lookup
    const m = await this.base.fileMeta(sourceFromMountRel(this.mount, rel));
    return m ? { ...m, path: rel } : null;
  }
  async commit(req: CommitRequest): Promise<FileMeta> {
    if (this.mount.direction === "pull") throw new Error("MountedApi: refusing to write to a pull (read-only) mount source");
    if (!isDataPath(req.path)) throw new Error("MountedApi: refusing to write a non-data (config) path across a mount boundary");
    const m = await this.base.commit({ ...req, path: sourceFromMountRel(this.mount, req.path) });
    return { ...m, path: req.path };
  }
  deleteFile(rel: string, expectedVersion?: number): Promise<void> {
    if (this.mount.direction === "pull") return Promise.reject(new Error("MountedApi: refusing to delete on a pull (read-only) mount source"));
    if (!isDataPath(rel)) return Promise.reject(new Error("MountedApi: refusing to delete a non-data (config) path across a mount boundary")); // symmetric with commit's data-only guard
    return this.base.deleteFile(sourceFromMountRel(this.mount, rel), expectedVersion);
  }
  missing(hashes: string[]): Promise<string[]> { return this.base.missing(hashes); }
  getChunk(hash: string): Promise<Uint8Array> { return this.base.getChunk(hash); }
  putChunk(hash: string, bytes: Uint8Array): Promise<void> { return this.base.putChunk(hash, bytes); }
}

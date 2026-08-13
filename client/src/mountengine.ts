// Phase 2/3 of composed vaults (D0039, nComposedVaults): the per-mount RUNTIME that bundles everything a
// single mount's reconcile scope needs, and STRUCTURALLY owns its isolation. The live-sync engine is one
// scope today (one base, one cursor, one transport — all singleton fields on the plugin); a mount is a SECOND
// concurrent scope that REUSES the pure reconcile engine unchanged by supplying its own ReconcileDeps. The
// load-bearing invariant (issueMountBaseIsolation) — each mount MUST have its OWN BaseStore + SyncState +
// delete-guard + retry budget, never the primary's — is made IMPOSSIBLE TO VIOLATE here: MountRuntime always
// constructs its own; a caller cannot inject the primary's. Pure over injected VaultIo/SyncApi/ChunkCache (no
// Obsidian API, no transport), so the isolation + wiring are exhaustively unit-testable.
import { Mount } from "./mounts";
import { MountedIo, MountedApi, isDataPath } from "./mountio";
import { VaultIo, SyncApi, SyncState, ChunkCache } from "./sync";
import { BaseStore, BaseEntry } from "./base";
import { ReconcileDeps, BulkDeleteStrategy, BULK_DELETE_MIN } from "./reconcile";

// A stable per-mount identity for persisting (and looking up) its own base + cursor, independent of array
// order. Uniquely identified by source (owner/vault + subfolder) + local mount point. JSON-encoded (not a
// delimiter-joined string) so a component that legitimately contains `#`/`=`/`>`/`/` — e.g. a folder named
// "C#" — can never collide two DISTINCT mounts onto one key (which would cross-contaminate their base+cursor).
// PERSISTENCE CONTRACT (R8-F2): this string is the on-disk key for mountStateStore in data.json. Changing its
// SHAPE orphans every persisted mount base → each mount re-first-contacts (non-destructive but a conflict-copy
// churn). Safe to change ONLY while composed vaults is unreleased; once shipped, a shape change MUST bump
// dataSchemaVersion + add a migratePersisted step that rewrites old-form keys.
export function mountKey(m: Mount): string {
  return JSON.stringify([m.source.owner, m.source.vaultId, m.source.sourcePath, m.mountPoint]);
}

// The persisted per-mount state (own base snapshot + own cursor + own source-history floor). Stored in settings
// under mountKey(m), the per-mount analogue of the primary's single data.json `base` + per-vault lastVersions +
// historyFloors maps. `historyFloor` is the SOURCE vault's last-seen deletion-history floor — an ADVANCE past
// it means the source truncated its history (a reindex/reset), so tombstones for files deleted before the new
// floor are gone and a delta pass would miss them; the sync loop routes that to a full reconcile (D0019,
// mountResetDetection). Absent (an older data.json / a fresh mount) ⇒ undefined ⇒ the first observation just
// records it, never a false reset (mirrors the primary's `sf !== undefined` guard).
export interface MountPersist { base: Record<string, BaseEntry>; version: number; historyFloor?: number }

// Parse-don't-validate at the persistence boundary (like parseSettings/parseMounts): harden an untrusted
// persisted mountState blob into a well-formed map. A malformed entry is DROPPED (that mount just starts
// fresh — a harmless first-contact), never trusted — so hostile input (a non-numeric version sent as a
// cursor, a string where a base record belongs → fabricated base paths) can't reach the reconcile engine.
export function parseMountState(raw: unknown): Record<string, MountPersist> {
  const out: Record<string, MountPersist> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const version = e.version;
    if (typeof version !== "number" || !Number.isFinite(version) || version < 0) continue;
    if (!e.base || typeof e.base !== "object") continue;
    const base: Record<string, BaseEntry> = {};
    for (const [p, be] of Object.entries(e.base as Record<string, unknown>)) {
      if (!be || typeof be !== "object") continue;
      const r = be as Record<string, unknown>;
      if (typeof r.hash !== "string") continue; // hash is the required identity; no hash → drop the entry
      // Rebuild a CLEAN entry, dropping any type-wrong OPTIONAL field rather than casting the blob through
      // (R8-F3). `text`/`normHash` are load-bearing for three-way merge + content-identity (a wrong-typed
      // normHash could otherwise flip a keep-local into a delete-local); size/mtime are scan-skip hints.
      const entry: BaseEntry = { hash: r.hash };
      if (typeof r.text === "string") entry.text = r.text;
      if (typeof r.normHash === "string") entry.normHash = r.normHash;
      if (typeof r.size === "number" && Number.isFinite(r.size) && r.size >= 0) entry.size = r.size;
      if (typeof r.mtime === "number" && Number.isFinite(r.mtime) && r.mtime >= 0) entry.mtime = r.mtime;
      base[p] = entry;
    }
    const entryOut: MountPersist = { base, version };
    // D0019 (mountResetDetection): preserve a valid persisted source-history floor; a type-wrong/negative one
    // is dropped (→ undefined → the next observation re-seeds it, never a false reset).
    if (typeof e.historyFloor === "number" && Number.isFinite(e.historyFloor) && e.historyFloor >= 1) entryOut.historyFloor = e.historyFloor; // >=1: the server genesis floor is 1; a persisted 0/negative is invalid → drop → re-seed (critique F4)
    out[key] = entryOut;
  }
  return out;
}

// The ambient context a mount needs from the plugin — the SHARED real-vault io + a SOURCE-vault-bound SyncApi
// + the content-addressed chunk cache (safe to share) + device label + optional tuning/callbacks. Everything
// scope-PRIVATE (base/state/guard/retry) is created BY the runtime, never passed in — that is the isolation.
export interface MountRuntimeCtx {
  io: VaultIo;               // the shared Obsidian vault adapter (whole vault; MountedIo scopes it to the mount subtree)
  sourceApi: SyncApi;        // a transport bound to the SOURCE vault (owner/vaultId), same server + token as the primary
  cache: ChunkCache;         // content-addressed — safe to share across scopes
  device: string;
  restore?: MountPersist;    // persisted own base + cursor to resume from (absent ⇒ fresh mount, cursor 0)
  ignorePatterns?: string[];
  maxSyncBytes?: number;
  bulkDeleteStrategy?: BulkDeleteStrategy; // D0041: the GLOBAL incoming bulk-delete confirmation policy applies to mounts too
  bulkDeleteThreshold?: number;
  // Per-mount reconcile callbacks the plugin wires (progress/conflict/error/status). Scope-private truth
  // (base/state/api/io/guard/retry) is never overridable — only these observational hooks.
  callbacks?: Partial<Pick<ReconcileDeps,
    "onProgress" | "onConflict" | "onFileError" | "onGuard" | "onBaseChanged" |
    "onSkip" | "onReadOnly" | "onStage" | "onDeclined" | "onKeptAbsent" | "onPullExhausted">>;
  // Optional source-vault readiness probe (the raw transport's status()) — the mount holds OFFLINE on a not-
  // ready source (mid-reindex/degraded), the same guard the primary connect applies (R4-F4).
  sourceReady?: () => Promise<boolean>;
}

export class MountRuntime {
  readonly base: BaseStore;                                    // OWN — never the primary's (isolation invariant)
  readonly state: SyncState;                                   // OWN cursor
  readonly retryBudget: Map<string, { version: number; count: number }>; // OWN
  private readonly io: MountedIo;
  private readonly api: MountedApi;
  private sawConflict = false; // set when reconcile makes a conflict copy this pass → drives the FSM to `diverged` (R5-MED-1)
  private _held: string[] = []; // D0041: paths this pass held for incoming bulk-delete confirmation
  private _roEdits: string[] = []; // issueMountRoLocalEditBehavior: read-only-mount paths reported this pass as un-syncable local edits
  private histFloor: number | undefined; // D0019 (mountResetDetection): last-seen SOURCE deletion-history floor
  constructor(readonly mount: Mount, private readonly ctx: MountRuntimeCtx) {
    this.base = new BaseStore(ctx.restore?.base ?? {});
    this.state = { version: ctx.restore?.version ?? 0 };
    this.histFloor = ctx.restore?.historyFloor;
    this.retryBudget = new Map();
    this.io = new MountedIo(ctx.io, mount);
    this.api = new MountedApi(ctx.sourceApi, mount);
  }
  get key(): string { return mountKey(this.mount); }
  // Assemble the ReconcileDeps for THIS mount — always over its own base/state/guard/retry + the mounted
  // io/api + the data-only accepts filter. A `pull` mount is readOnly=true: the reconcile then uses the
  // pull-only (read-only-vault) path and never attempts a push, defense-in-depth with MountedApi's hard-refuse
  // of any write on a pull mount. Fresh object each call (deps is a per-call scratch object, matching the
  // primary's deps() contract).
  deps(): ReconcileDeps {
    return {
      api: this.api, io: this.io, base: this.base, cache: this.ctx.cache, state: this.state,
      device: this.ctx.device,
      accepts: isDataPath,                              // data-only, in mount-relative space
      readOnly: this.mount.direction === "pull",        // pull = never mutate the source
      preserveLocalFirstContact: true,                  // a mount composes over EXISTING local data — never adopt-over-local on first contact (R2-F1)
      bulkDeleteStrategy: this.ctx.bulkDeleteStrategy,   // D0041: the global incoming bulk-delete confirmation applies to mounts too
      bulkDeleteThreshold: this.ctx.bulkDeleteThreshold,
      retryBudget: this.retryBudget,
      // R9-B (by design): the timestamp-ignore PATTERNS apply inside a mount, but the primary's
      // `excludedFolders` per-folder OPT-OUT is deliberately NOT passed — those are primary-VAULT-relative
      // paths with no meaningful translation to a different source vault's subtree, so a mount masks all `.md`
      // uniformly per the patterns. (Timestamp-only masking affects churn/cosmetic diffs, never data loss.)
      ignorePatterns: this.ctx.ignorePatterns,
      maxSyncBytes: this.ctx.maxSyncBytes,
      ...this.ctx.callbacks,
      // Intercept onConflict (AFTER the spread, so it wraps the caller's) to record that this pass produced a
      // conflict copy — the driver reads tookConflict() to move the FSM to `diverged` (R5-MED-1). The caller's
      // own onConflict (logging) still runs.
      onConflict: (p: string, copy: string) => { this.sawConflict = true; this.ctx.callbacks?.onConflict?.(p, copy); },
      // D0041: record paths held for incoming bulk-delete confirmation this pass (the caller reads takeHeld()).
      onGuard: (p: string) => { this._held.push(p); this.ctx.callbacks?.onGuard?.(p); },
      // issueMountRoLocalEditBehavior: collect read-only local edits this pass so the driver can AUTHORITATIVELY
      // replace the tracked set on a full pass (a reverted edit stops being reported → drops off, never phantom).
      onReadOnly: (p: string) => { this._roEdits.push(p); this.ctx.callbacks?.onReadOnly?.(p); },
    };
  }
  // Read + reset whether this poll made a conflict copy (drives the scope to `diverged`).
  tookConflict(): boolean { const c = this.sawConflict; this.sawConflict = false; return c; }
  // D0041 held-deletion collection: reset before a poll, take (read+reset) after, so the caller records this
  // pass's held incoming deletions into the review set.
  resetHeld(): void { this._held = []; this._roEdits = []; }
  takeHeld(): string[] { const h = this._held; this._held = []; return h; }
  // issueMountRoLocalEditBehavior: this pass's read-only local edits (the caller replaces the tracked set on a
  // full pass so a reverted/resolved edit drops off — never a phantom "won't sync" entry, F2).
  takeRoEdits(): string[] { const e = this._roEdits; this._roEdits = []; return e; }
  // Is the SOURCE vault ready to sync (not mid-reindex/degraded)? Default true when no probe is wired.
  ready(): Promise<boolean> { return this.ctx.sourceReady ? this.ctx.sourceReady() : Promise.resolve(true); }
  baseNonEmpty(): boolean { return this.base.paths().length > 0; }
  // Mass-local-deletion guard (issueMountFolderDeletedWipesSource, critique F1). Detects that the user removed
  // this mount's CONTENT — the whole mount-point folder, all its files, or most of them — so the driver flags
  // `localGone` and holds instead of delete-remoting the whole subtree from the (possibly shared) source.
  // CONTENT-based, not folder-node existence: on the real adapter an EMPTY folder still exists, so "select all
  // → delete" leaves the node present; keying on the node (the original flawed guard) missed exactly that. Two
  // signals: (a) the mount-point FOLDER is gone (an explicit container delete, any size), or (b) a BULK of the
  // base content is now locally absent (files deleted, folder may remain — the F1 case). Uses a FIXED floor
  // (BULK_DELETE_MIN/RATIO), independent of the user's INCOMING D0041 setting, since wiping a shared source is
  // catastrophic regardless. Below-floor deletions still propagate exactly (D0043). Only meaningful before a
  // FULL pass (a delta poll never scans local, so it never delete-remotes), so the driver gates on that.
  async massLocalDeletion(): Promise<boolean> {
    const basePaths = this.base.paths();
    if (basePaths.length === 0) return false;                          // fresh/empty mount — nothing to protect
    if (this.io.exists && !(await this.io.exists(""))) return true;    // (a) the mount-point folder itself is gone
    const local = await this.io.list();
    let absentPaths = basePaths.filter((p) => !local.has(p));
    // Finding 5 (issueMountDeleteGuardResiduals): io.list() can return a TRANSIENT empty/partial listing (an
    // adapter hiccup, a mid-write, an unhydrated cloud placeholder) — which would spuriously look like a mass
    // deletion and hold the mount as localGone (fail-safe, but a needless manual Reinstate). RE-PROBE each
    // list-absent path individually (indeterminate-treat-as-present): a file io.exists() still finds is NOT
    // absent, so a partial/empty list can't trip the guard. This mirrors reconcileAll's own per-file
    // false-absence re-probe (issueFalseAbsenceDelete) that backstops the actual delete-remote. Cheap in the
    // common case (few absent → tiny loop); the full re-probe only runs when a mass deletion is SUSPECTED (rare),
    // where confirming absence before a possible shared-source wipe is worth the stat calls.
    if (this.io.exists && absentPaths.length > 0) {
      const confirmed: string[] = [];
      for (const p of absentPaths) if (!(await this.io.exists(p))) confirmed.push(p);
      absentPaths = confirmed;
    }
    const absent = absentPaths.length;
    // (b) ALL the content is gone (any size — an emptied mount is a reset gesture, not a shared-source wipe;
    // closes the small <6-file "delete all, leave the empty folder" case), or (c) a BULK (>= the fixed floor)
    // is gone in this pass. The RATIO is dropped on purpose: a delete-remote prunes base, so a ratio against the
    // shrinking base is defeatable (a paced sub-floor drain). D0043 (outgoing deletes are exact/immediate) makes
    // that paced drain LEGITIMATE — each sub-floor batch is a genuine exact deletion, gated on the receive side
    // by each peer's incoming bulk-delete confirmation (D0041); the mass-guard's job is only the one-shot wipe.
    return absent === basePaths.length || absent >= BULK_DELETE_MIN;
  }
  // D0019 (mountResetDetection): the last-seen SOURCE deletion-history floor (undefined until first observed).
  historyFloor(): number | undefined { return this.histFloor; }
  // Record the source's current history floor. MONOTONIC-forward: only ever RAISES the floor, never lowers it
  // (a server floor is monotonic; a lower reported value is noise/skew — storing it would arm a later spurious
  // reset when it climbs back, critique F3). The caller records it only AFTER a successful reconcile, so a
  // failed/partial pass leaves the floor un-advanced and the reset re-fires next poll (critique F1 — mirrors
  // the primary's floor-after-reconcile).
  noteHistoryFloor(floor: number | undefined): void {
    if (floor !== undefined && (this.histFloor === undefined || floor > this.histFloor)) this.histFloor = floor;
  }
  // Snapshot the OWN base + cursor + source-history floor for persistence (stored under this.key).
  toPersist(): MountPersist { return { base: this.base.toJSON(), version: this.state.version, historyFloor: this.histFloor }; }
}

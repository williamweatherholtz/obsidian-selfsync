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
import { ReconcileDeps, DeleteRateGuard } from "./reconcile";

// A stable per-mount identity for persisting (and looking up) its own base + cursor, independent of array
// order. A mount is uniquely identified by its source (owner/vault + subfolder) and its local mount point.
export function mountKey(m: Mount): string {
  return `${m.source.owner}/${m.source.vaultId}#${m.source.sourcePath}=>${m.mountPoint}`;
}

// The persisted per-mount state (own base snapshot + own cursor). Stored in settings under mountKey(m), the
// per-mount analogue of the primary's single data.json `base` + per-vault lastVersions map.
export interface MountPersist { base: Record<string, BaseEntry>; version: number }

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
  // Per-mount reconcile callbacks the plugin wires (progress/conflict/error/status). Scope-private truth
  // (base/state/api/io/guard/retry) is never overridable — only these observational hooks.
  callbacks?: Partial<Pick<ReconcileDeps,
    "onProgress" | "onConflict" | "onFileError" | "onGuard" | "onBaseChanged" |
    "onSkip" | "onReadOnly" | "onStage" | "onDeclined" | "onConflict">>;
}

export class MountRuntime {
  readonly base: BaseStore;                                    // OWN — never the primary's (isolation invariant)
  readonly state: SyncState;                                   // OWN cursor
  readonly deleteGuard: DeleteRateGuard;                       // OWN — shared would cross-contaminate delete-rate accounting
  readonly retryBudget: Map<string, { version: number; count: number }>; // OWN
  private readonly io: MountedIo;
  private readonly api: MountedApi;
  constructor(readonly mount: Mount, private readonly ctx: MountRuntimeCtx) {
    this.base = new BaseStore(ctx.restore?.base ?? {});
    this.state = { version: ctx.restore?.version ?? 0 };
    this.deleteGuard = new DeleteRateGuard();
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
      deleteGuard: this.deleteGuard,
      retryBudget: this.retryBudget,
      ignorePatterns: this.ctx.ignorePatterns,
      maxSyncBytes: this.ctx.maxSyncBytes,
      ...this.ctx.callbacks,
    };
  }
  // Snapshot the OWN base + cursor for persistence (stored under this.key).
  toPersist(): MountPersist { return { base: this.base.toJSON(), version: this.state.version }; }
}

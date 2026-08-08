// Phase 3 of composed vaults (D0039): the per-mount SYNC LOOP — the orchestration that drives each mount's
// reconcile one poll cycle, fail-isolated, advancing its FSM. It reuses the REAL reconcile engine
// (reconcileAll/reconcileDelta) over each mount's own ReconcileDeps, so it is exercised end-to-end in unit
// tests with a fake source api/io (no Obsidian, no transport). main.ts holds only the Obsidian-specific
// construction (transport to the source vault, persistence, status paint) + calls reconcileMountScopes after
// the primary pass. v1 is POLL-DRIVEN on the primary sync cycle (a per-mount real-time WebSocket subscription
// — D0039's "own subscription" — is a deferred enhancement, recorded as a within-epic refinement).
import { MountRuntime } from "./mountengine";
import { MountState, mountTransition } from "./mountfsm";
import { reconcileAll, reconcileDelta, decideReconcileMode } from "./reconcile";

// Consecutive-failure threshold before a mount is declared terminally `failed` (D0039: Failed = repeated
// failure / access revoked / source deleted). Below it, a failure is a transient `offline` that retries.
export const MAX_MOUNT_FAILS = 3;

// A live mount = its isolated runtime + its FSM state + a consecutive-failure counter. `failedAt` (ms) is
// stamped by the caller when the scope reaches `failed`, so it can be retried after a backoff (R4-F2). The
// caller (main.ts) owns the array and reads `.state` for the aggregate status fold after each pass.
export interface MountScope { runtime: MountRuntime; state: MountState; fails: number; failedAt?: number }

export interface MountSyncHooks {
  onEvent?: (scope: MountScope) => void;   // fired on every state change (drives the status light + persistence)
  onError?: (scope: MountScope, err: unknown) => void; // a mount's poll threw (logged; never propagated)
}

// Run ONE poll cycle for one mount against its OWN cursor + source api, reusing the real reconcile engine.
// `forceFull` (first contact / reconnect) runs a whole-subtree reconcileAll; otherwise an incremental delta.
// A data-only mount never has a config scan, so the mode is only noop/full/delta.
export async function pollMount(rt: MountRuntime, opts: { forceFull?: boolean } = {}): Promise<void> {
  const d = rt.deps();
  const before = rt.state.version;
  const delta = await d.api.changes(before);
  const noChange = delta.upserts.length === 0 && delta.deletes.length === 0 && delta.version === before;
  const mode = decideReconcileMode({ forceConfigScan: false, forceFullScan: !!opts.forceFull, reset: false, noChange });
  if (mode === "noop") return;
  if (mode === "full") await reconcileAll(d);
  else await reconcileDelta(d, delta);
}

// Drive ONE mount scope one cycle, advancing its FSM via the pure transition. Detached/unmounting/failed
// scopes are skipped (not active). A first contact (`mounting`) or a reconnect (`offline`) runs a full pass;
// a steady `live` scope runs syncStart→delta→syncSettled. A throw is CAUGHT and never propagates: it advances
// the FSM to `offline` (transient, will retry next cycle) or — after MAX_MOUNT_FAILS consecutive failures —
// to `failed`. This is the fail-isolation boundary: a broken mount can never abort another mount or the
// primary sync.
export async function reconcileMountScope(scope: MountScope, hooks: MountSyncHooks = {}): Promise<void> {
  if (scope.state === "detached" || scope.state === "unmounting" || scope.state === "failed") return;
  const wasMounting = scope.state === "mounting";
  const wasOffline = scope.state === "offline";
  if (scope.state === "live") { scope.state = mountTransition(scope.state, "syncStart"); hooks.onEvent?.(scope); }
  try {
    // R4-F4: on a first-contact / reconnect pass, refuse to reconcile a NOT-READY source (mid-reindex/
    // degraded) — the same guard the primary connect applies — so a partial/degraded manifest can't drive a
    // spurious delete-local. Throwing routes to offline (retries), never failing destructively.
    if ((wasMounting || wasOffline) && !(await scope.runtime.ready())) throw new Error("source vault not ready (reindexing?)");
    await pollMount(scope.runtime, { forceFull: wasMounting || wasOffline });
    scope.fails = 0;
    // Success lands `live` — UNLESS this pass produced a conflict copy, which surfaces as `diverged` ("Needs
    // review") so a mounted-folder conflict isn't hidden behind a green light (R5-MED-1). A clean pass clears
    // a prior diverged back to live.
    scope.state = scope.runtime.tookConflict() ? "diverged" : "live";
    hooks.onEvent?.(scope);
  } catch (err) {
    scope.fails++;
    scope.state = mountTransition(scope.state, scope.fails >= MAX_MOUNT_FAILS ? "fail" : "disconnect");
    hooks.onError?.(scope, err);
    hooks.onEvent?.(scope);
  }
}

// Drive EVERY active mount scope one cycle, each fail-isolated from the others. Sequential (mounts are few and
// share the chunk cache + one connection); a slow/broken mount delays but never breaks the rest. A detached
// scope (freshly configured, or a failed scope reset by the backoff retry) is STARTED here on any pass; each
// mount's own FSM/forceFull logic then handles the full-vs-delta first pass. `isLive` (optional) is re-checked
// BEFORE driving each scope — the caller passes a predicate that returns false for a scope that was removed or
// is being torn down mid-pass, so we never mutate the disk for a mount that's no longer live (R1-F3/F4).
export async function reconcileMountScopes(scopes: readonly MountScope[], hooks: MountSyncHooks = {}, isLive?: (scope: MountScope) => boolean): Promise<void> {
  for (const scope of scopes) {
    if (isLive && !isLive(scope)) continue; // removed / unloading — skip before any reconcile touches disk
    if (scope.state === "detached") scope.state = mountTransition(scope.state, "mount"); // start any not-yet-started mount (incl. a failed scope reset to detached by the backoff retry, R4-F2)
    await reconcileMountScope(scope, hooks);
  }
}

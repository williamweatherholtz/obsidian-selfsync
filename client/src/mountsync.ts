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
export interface MountScope { runtime: MountRuntime; state: MountState; fails: number; failedAt?: number; forceFull?: boolean }

export interface MountSyncHooks {
  onEvent?: (scope: MountScope) => void;   // fired on every state change (drives the status light + persistence)
  onError?: (scope: MountScope, err: unknown) => void; // a mount's poll threw (logged; never propagated)
  onHeld?: (scope: MountScope, paths: string[], authoritative: boolean) => void; // D0041: paths this pass held for confirmation (authoritative = a full pass saw the whole scope → replace, not union)
  onRoEdits?: (scope: MountScope, paths: string[], authoritative: boolean) => void; // issueMountRoLocalEditBehavior: read-only local edits this pass (authoritative = a full pass → REPLACE the tracked set)
}

// Run ONE poll cycle for one mount against its OWN cursor + source api, reusing the real reconcile engine.
// `forceFull` (first contact / reconnect) runs a whole-subtree reconcileAll; otherwise an incremental delta.
// A data-only mount never has a config scan, so the mode is only noop/full/delta.
export async function pollMount(rt: MountRuntime, opts: { forceFull?: boolean } = {}, onLocalGone?: () => void): Promise<void> {
  const d = rt.deps();
  const before = rt.state.version;
  const delta = await d.api.changes(before);
  const noChange = delta.upserts.length === 0 && delta.deletes.length === 0 && delta.version === before;
  // R9-C: a source-global version that went BACKWARDS since our cursor means the SOURCE vault was reindexed/
  // restored (its history was rewritten). Route that through the engine's `reset` path (→ a full reconcile) so
  // the mount re-pulls the whole subtree instead of trusting an incremental delta against a now-meaningless
  // cursor. (Full D0019 history_floor/keptAbsent reset-detection for mounts remains a tracked follow-up.)
  const rewound = delta.version < before;
  const mode = decideReconcileMode({ forceConfigScan: false, forceFullScan: !!opts.forceFull, reset: rewound, noChange });
  if (mode === "noop") return;
  if (mode === "full") {
    // issueMountFolderDeletedWipesSource (critique finding 1): guard BEFORE any local-scanning full reconcile —
    // whether it was triggered by forceFull OR a source rewind (reset). A mass local deletion must never
    // delete-remote the whole subtree from the (possibly shared) source, regardless of what forced the full pass.
    if (await rt.massLocalDeletion()) { onLocalGone?.(); return; }
    await reconcileAll(d);
  } else await reconcileDelta(d, delta); // a delta pass applies the SOURCE's incoming changes (a purely-local mass deletion is never in the delta)
}

// Drive ONE mount scope one cycle, advancing its FSM via the pure transition. Detached/unmounting/failed
// scopes are skipped (not active). A first contact (`mounting`) or a reconnect (`offline`) runs a full pass;
// a steady `live` scope runs syncStart→delta→syncSettled. A throw is CAUGHT and never propagates: it advances
// the FSM to `offline` (transient, will retry next cycle) or — after MAX_MOUNT_FAILS consecutive failures —
// to `failed`. This is the fail-isolation boundary: a broken mount can never abort another mount or the
// primary sync.
export async function reconcileMountScope(scope: MountScope, hooks: MountSyncHooks = {}): Promise<void> {
  if (scope.state === "detached" || scope.state === "unmounting" || scope.state === "failed" || scope.state === "localGone") return;
  const wasMounting = scope.state === "mounting";
  const wasOffline = scope.state === "offline";
  const full = wasMounting || wasOffline || !!scope.forceFull; // forceFull: a Keep asked us to re-push (R11-F2)
  scope.forceFull = false;
  if (scope.state === "live") { scope.state = mountTransition(scope.state, "syncStart"); hooks.onEvent?.(scope); }
  try {
    // R4-F4: on a first-contact / reconnect pass, refuse to reconcile a NOT-READY source (mid-reindex/
    // degraded) — the same guard the primary connect applies — so a partial/degraded manifest can't drive a
    // spurious delete-local. Throwing routes to offline (retries), never failing destructively.
    if ((wasMounting || wasOffline) && !(await scope.runtime.ready())) throw new Error("source vault not ready (reindexing?)");
    scope.runtime.resetHeld(); // D0041: collect this pass's held incoming deletions
    // issueMountFolderDeletedWipesSource (critique finding 1): the mass-local-deletion guard lives INSIDE
    // pollMount, right before any local-scanning reconcileAll — so it covers BOTH the forceFull route and the
    // source-rewind (reset) route to a full pass. On a hit, hold as `localGone` and never propagate.
    let localGone = false;
    await pollMount(scope.runtime, { forceFull: full }, () => { localGone = true; });
    if (localGone) { scope.state = "localGone"; hooks.onEvent?.(scope); return; }
    hooks.onHeld?.(scope, scope.runtime.takeHeld(), full); // record held deletions (a full pass is authoritative → replace)
    hooks.onRoEdits?.(scope, scope.runtime.takeRoEdits(), full); // record read-only edits (full pass → replace, so a reverted edit drops off — F2)
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

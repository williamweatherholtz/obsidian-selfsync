// Phase 2/3 of composed vaults (D0039): the per-mount lifecycle FSM + the aggregate status FOLD. Each mount
// is an INDEPENDENT lifecycle; the single status light is a projection over the primary scope PLUS every
// mount. This module is a PURE state machine (no I/O, no Obsidian) — the same discipline as connstate.ts /
// transportstate.ts / statuslight.ts — so the transitions + the fold are exhaustively unit-testable and the
// glue in main.ts stays a thin projection.

// The mount lifecycle states (D0039). A pull mount lives in the same states; it just never enters a push.
export type MountState =
  | "detached"    // configured but not yet started (or after a clean unmount)
  | "mounting"    // first-contact: connecting to the source vault + initial reconcile
  | "live"        // connected + settled (in sync, watching)
  | "syncing"     // actively transferring
  | "diverged"    // a conflict/divergence awaits resolution (never auto-destructive)
  | "offline"     // lost the connection; will resume (transient)
  | "unmounting"  // tearing down (by user request)
  | "failed";     // a terminal error for this mount (access revoked, source deleted, repeated failure)

export type MountEvent =
  | "mount" | "mounted" | "syncStart" | "syncSettled" | "diverge" | "resolved"
  | "disconnect" | "reconnect" | "unmount" | "unmounted" | "fail" | "retry";

// Pure transition. An event with no defined transition from the current state is a NO-OP (returns the same
// state) — conservative: an unexpected signal never forces a spurious state change. `unmount` and `fail` are
// accepted from any live state (user teardown / terminal error can happen at any time).
export function mountTransition(s: MountState, e: MountEvent): MountState {
  if (e === "unmount" && s !== "detached" && s !== "unmounting") return "unmounting";
  if (e === "fail" && s !== "detached" && s !== "unmounting") return "failed";
  switch (s) {
    case "detached":   return e === "mount" ? "mounting" : s;
    case "mounting":   return e === "mounted" ? "live" : e === "disconnect" ? "offline" : s;
    case "live":       return e === "syncStart" ? "syncing" : e === "diverge" ? "diverged" : e === "disconnect" ? "offline" : s;
    case "syncing":    return e === "syncSettled" ? "live" : e === "diverge" ? "diverged" : e === "disconnect" ? "offline" : s;
    case "diverged":   return e === "resolved" ? "live" : e === "disconnect" ? "offline" : s;
    case "offline":    return e === "reconnect" ? "live" : s;
    case "unmounting": return e === "unmounted" ? "detached" : s;
    case "failed":     return e === "retry" ? "mounting" : s;
    default:           return s;
  }
}

// A scope's coarse HEALTH, the common currency the status light folds over. Ordered worst→best by severity so
// a single ranking combines the primary scope and every mount. `busy` = transient work in flight; `idle` =
// nothing configured/running (a detached mount contributes nothing).
export type Health = "error" | "diverged" | "offline" | "busy" | "ok" | "idle";
const SEVERITY: Record<Health, number> = { error: 5, diverged: 4, offline: 3, busy: 2, ok: 1, idle: 0 };

export function mountHealth(s: MountState): Health {
  switch (s) {
    case "failed":     return "error";
    case "diverged":   return "diverged";
    case "offline":    return "offline";
    case "mounting":
    case "syncing":
    case "unmounting": return "busy";
    case "live":       return "ok";
    case "detached":   return "idle";
  }
}

// Fold N healths to the single worst one (empty ⇒ idle). The status light shows the most-severe scope, so a
// mount in trouble is never hidden by a healthy primary — and a healthy mount never masks a primary problem.
export function foldHealth(healths: readonly Health[]): Health {
  return healths.reduce<Health>((worst, h) => (SEVERITY[h] > SEVERITY[worst] ? h : worst), "idle");
}

// Fold the primary scope's health with every mount's, returning the displayed health AND which scope is the
// REASON (so the light's detail text can name it — "mount 'Work/ASI' offline"). primaryHealth is computed by
// the glue from the existing engine phase; mounts are (label, state) pairs.
export interface AggregateStatus { health: Health; reason: string }
export function aggregateStatus(
  primaryHealth: Health,
  mounts: readonly { label: string; state: MountState }[],
): AggregateStatus {
  let worst: Health = primaryHealth;
  let reason = "primary";
  for (const m of mounts) {
    const h = mountHealth(m.state);
    if (SEVERITY[h] > SEVERITY[worst]) { worst = h; reason = `mount ${m.label}`; }
  }
  return { health: worst, reason };
}

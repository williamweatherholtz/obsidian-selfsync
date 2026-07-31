// The client's status-LIGHT projection + the WS-staleness predicate. The OPERATIONAL sync-lifecycle
// state machine lives in syncengine.ts (the explicit `EngineState` + its run-to-completion pump); this
// module intentionally keeps only the pure DISPLAY projection (Phase + light()) and the pure liveness
// predicate. (crit R+1, issueStateMachineOrphanedAndImplicit: the old duplicate FSM that lived here —
// `SyncEvent` + `transition()` + `SyncMachine` — was SUPERSEDED by the engine and, per syncengine.ts's
// own header, "only ever drove the status LIGHT"; nothing live imported it, so the dead duplicate is
// removed. `Phase` is now purely a display-projection enum, produced by engineStateToPhase.)

// The display projection. The single lossy "offline" is decomposed (connstate.ts / the connection FSM):
// `retrying` = a transient failure being backoff-retried; `lockedOut` = a 429 wait; `blocked` = a failure
// that awaits the user (sign-in rejected / version mismatch / vault gone …) — its specific reason rides in
// the light's `detail`. A genuinely down link is one of these three, never a catch-all "offline".
export type Phase = "off" | "connecting" | "idle" | "syncing" | "retrying" | "lockedOut" | "blocked";

export interface LightSpec { color: string; label: string; tip: string }

// The status light is a pure function of the phase AND whether the realtime (WebSocket) channel is
// currently up. `realtime` matters only when otherwise idle: if the socket dropped but polling still
// succeeds, the data IS current, but the light must NOT claim full "instant sync" health — it says so
// truthfully instead of showing a green "Fully synced" over a dead socket (the status/transport
// dual-truth). Defaults to true so callers that don't track it (and tests) keep the prior behavior.
export function light(phase: Phase, detail = "", realtime = true): LightSpec {
  switch (phase) {
    // Colors are Obsidian CSS variables (resolved against the active theme), not
    // hardcoded hex — so the indicator matches light/dark and custom themes.
    case "idle":       return realtime
      ? { color: "var(--color-green)", label: "SelfSync", tip: `Fully synced${detail ? " (" + detail + ")" : ""}` }
      : { color: "var(--color-yellow)", label: "SelfSync", tip: `Synced — realtime reconnecting, polling${detail ? " (" + detail + ")" : ""}` };
    case "syncing":    return { color: "var(--color-yellow)", label: "SelfSync", tip: `Syncing…${detail ? ` ${detail}` : ""}` };
    case "connecting": return { color: "var(--color-yellow)", label: "SelfSync", tip: "Connecting…" };
    // A down link, decomposed. `blocked` needs the user to act (red); `lockedOut` is a timed wait (orange);
    // `retrying` is a transient backoff (red). The specific reason is passed in `detail`.
    case "retrying":   return { color: "var(--color-red)", label: "SelfSync", tip: detail || "Reconnecting…" };
    case "lockedOut":  return { color: "var(--color-orange)", label: "SelfSync", tip: detail || "Too many attempts — retrying" };
    case "blocked":    return { color: "var(--color-red)", label: "SelfSync", tip: detail || "Sign-in needed — open Settings" };
    case "off":        return { color: "var(--text-faint)", label: "SelfSync", tip: "Not connected" };
  }
}

// The EFFECTIVE display phase: a `syncing` reconcile with nothing queued to transfer (syncPending <= 0) is
// a CHECK, not a state, so it collapses to `idle` — no surface should paint "Syncing…" when there's no
// work. This is the SINGLE projection every display surface shares (the ribbon light AND the settings
// status card). The "hangs on syncing" regression was the card rendering the RAW engine phase via
// statusText(), so it read "Syncing…" whenever the engine sat in a 0-pending reconcile while the light
// (which already used this collapse) correctly showed idle.
export function effectivePhase(phase: Phase, syncPending: number): Phase {
  return phase === "syncing" && syncPending <= 0 ? "idle" : phase;
}

// True when the realtime socket has gone silent past the liveness deadline — no frame (server
// heartbeat OR change) within `staleAfterMs`. Browsers hide protocol ping/pong from JS, so an
// app-level heartbeat is the only signal that a socket is alive vs half-open; this is the pure
// decision the client's liveness timer uses to stop trusting a dead socket and re-dial.
export function isWsStale(lastActivityMs: number, nowMs: number, staleAfterMs: number): boolean {
  return nowMs - lastActivityMs > staleAfterMs;
}

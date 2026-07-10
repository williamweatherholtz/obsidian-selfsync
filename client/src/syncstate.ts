// Explicit finite state machine for the client's sync/connection lifecycle.
// Replaces scattered flags (connState string, ad-hoc setStatus calls) with one
// state + a pure transition function, so the legal transitions are exhaustive and
// testable, and the status light is a pure function of state. Modes only — the
// `applying` re-entrancy guard and timers stay separate (they're locks, not modes).

export type Phase = "off" | "connecting" | "idle" | "syncing" | "offline";

export type SyncEvent =
  | "connect"    // a connection attempt began
  | "connected"  // login + initial reconcile succeeded (now up to date)
  | "syncStart"  // a reconcile/push/pull began
  | "syncDone"   // reconcile succeeded (up to date)
  | "error"      // any op/connection failure
  | "unload";    // plugin unloading

export function transition(s: Phase, e: SyncEvent): Phase {
  if (e === "unload") return "off";
  if (e === "connect") return "connecting";
  switch (s) {
    case "off":
      return s; // only "connect"/"unload" (handled above) move us out of off
    case "connecting":
      return e === "connected" ? "idle" : e === "error" ? "offline" : "connecting";
    case "idle":
      return e === "syncStart" ? "syncing" : e === "error" ? "offline" : "idle";
    case "syncing":
      return e === "syncDone" ? "idle" : e === "error" ? "offline" : "syncing";
    case "offline":
      // Recover on a full reconnect OR a successful sync: a syncDone means a reconcile round-trip
      // just succeeded, which proves we're online again. Without this, a transient per-file error
      // pins the light red forever even though polling keeps succeeding (it never emits "connected").
      return e === "connected" || e === "syncDone" ? "idle" : "offline";
  }
}

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
    case "syncing":    return { color: "var(--color-yellow)", label: "SelfSync", tip: "Syncing…" };
    case "connecting": return { color: "var(--color-yellow)", label: "SelfSync", tip: "Connecting…" };
    case "offline":    return { color: "var(--color-red)", label: "SelfSync", tip: "Offline — retrying" };
    case "off":        return { color: "var(--text-faint)", label: "SelfSync", tip: "Not connected" };
  }
}

// Holds the current phase and fires onChange only on an actual transition.
export class SyncMachine {
  private phase: Phase = "off";
  constructor(private onChange: (phase: Phase) => void) {}
  get(): Phase { return this.phase; }
  dispatch(e: SyncEvent): Phase {
    const next = transition(this.phase, e);
    if (next !== this.phase) { this.phase = next; this.onChange(next); }
    return this.phase;
  }
}

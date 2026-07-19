// Explicit FSM for the realtime WebSocket channel's health (crit R+1, issueStateMachineOrphanedAndImplicit
// D1). Replaces the scattered booleans/closures in main.ts — `realtimeConnected`, the per-socket `opened`
// closure, `this.ws !== ws` identity checks, and the poll-cadence flips — that IMPLICITLY encoded this
// lifecycle and generated a run of race patches (CONC-R2#4/#6, CONC-R3#1, R11-#7). Making the transitions
// a PURE, total function means they are exhaustively unit-testable in isolation (no WebSocket/timer mock):
// main.ts drives it from the socket's open/error/close events + the liveness tick, then APPLIES the
// returned effects. Socket-identity supersession (ignore events from a stale socket) stays in main.ts —
// it's an effect-application concern, not a state transition.
//
// States (this captures BOTH old flags — realtimeConnected AND the per-socket `opened` — without desync):
//   offline  — no live socket (never dialed, torn down, or dropped awaiting a redial/reconnect).
//   dialing  — a socket was created but has NOT reported `open` yet (never opened; poll is the detector).
//   live     — the socket is open + fresh (realtime health; poll downshifts to an idle backstop).
//   degraded — the socket HAD opened but is no longer fresh (an error, or a half-open stale tick). Not
//              realtime (light shows polling), but it counts as "opened" for the close decision.
// `realtimeConnected` is exactly `state === "live"`. The close FORK preserves the old `opened` semantics:
// a close from live/degraded (the socket worked) → a re-dial; a close from dialing (never opened → usually
// a bad/expired token) → a full backed-off reconnect. An `errored` no longer discards the "was open" fact
// (it → degraded, not dialing), so a live socket that errors-then-closes re-dials rather than reconnecting.
export type TransportState = "offline" | "dialing" | "live" | "degraded";
export type TransportEvent = "dial" | "opened" | "errored" | "closed" | "staleTick" | "teardown";

// A description of the side effects a transition implies; main.ts executes them (arms the poll at the
// given cadence, schedules the redial, enqueues the reconnect). Purely data so the FSM stays testable.
export interface TransportEffects {
  poll?: "active" | "idle";  // (re)arm the poll at this cadence (active = WS down, idle = WS healthy backstop)
  redial?: "delayed" | "now"; // re-establish the SOCKET only: delayed (a clean drop that had opened — avoid hammering a flapping server) / now (half-open detected)
  reconnect?: boolean;        // full backed-off reconnect ({connect}) — a socket that NEVER opened, usually a bad/expired token
}

export function transportTransition(s: TransportState, e: TransportEvent): { state: TransportState; effects: TransportEffects } {
  switch (e) {
    case "teardown": return { state: "offline", effects: {} };                       // plugin unloading — caller clears timers/socket
    case "dial":     return { state: "dialing", effects: { poll: "active" } };        // socket created, not yet open
    case "opened":   return { state: "live",    effects: { poll: "idle" } };          // open + fresh → downshift poll
    case "errored":
      // Transient error → drop realtime + upshift poll, but PRESERVE "was opened": a socket that had
      // opened → degraded (so a following close re-dials); one still dialing stays dialing (close reconnects).
      return (s === "live" || s === "degraded")
        ? { state: "degraded", effects: { poll: "active" } }
        : { state: "dialing", effects: { poll: "active" } };
    case "closed":
      // The redial-vs-reconnect fork keys off "ever opened" (live|degraded), NOT just live — so a live
      // socket that errors (→ degraded) then closes still re-dials rather than doing a full reconnect.
      return (s === "live" || s === "degraded")
        ? { state: "offline", effects: { poll: "active", redial: "delayed" } }        // worked then dropped → delayed re-dial
        : { state: "offline", effects: { poll: "active", reconnect: true } };          // never opened → full reconnect
    case "staleTick":
      // Half-open detection fires only while `live` (main.ts guards on the state before dispatching); a
      // stale live socket → degraded + re-dial immediately (it opened, so a later close still re-dials).
      // From any non-live state it is a no-op.
      return s === "live"
        ? { state: "degraded", effects: { poll: "active", redial: "now" } }
        : { state: s, effects: {} };
  }
}

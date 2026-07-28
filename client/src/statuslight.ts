// The status-light DISPLAY state machine — a debounced projection of the engine's operational phase.
//
// Bug it fixes: the light flittered "Fully synced" ⇄ "Syncing… (checking for changes)" roughly once a
// second. A routine poll / config re-hash / path event flips the engine phase idle → syncing(0 pending) →
// idle in well under a second, and painting each flip turned a transient CHECK into a visible STATE. As the
// owner put it: "checking for changes is a state transition, not a state."
//
// The fix, modelled as its own tiny FSM (like transportTransition / finalize): entering `syncing` is
// DEBOUNCED. A syncing phase does not change what the light shows immediately — it only ARMS a timer. If the
// phase settles back to a non-syncing state before the timer fires (the transient-check case), the syncing
// display is never painted and the light stays on its steady state. Only a syncing phase that PERSISTS past
// the debounce (a real, non-trivial transfer) commits to showing "Syncing…". Leaving syncing is immediate.
//
// Pure + total so the whole table is unit-tested with no timers/DOM (statuslight.test): the caller wires a
// real setTimeout to emit the `settle` event and paints `state.shown`; this module owns only the decision.
import { Phase } from "./syncstate";

export type LightEvent =
  | { kind: "phase"; phase: Phase } // the engine's operational phase changed
  | { kind: "settle" };             // the debounce elapsed (the caller's timer fired)

export interface LightDisplay {
  shown: Phase;   // the phase the light is currently PAINTING (what the user sees)
  armed: boolean; // a syncing phase is pending the debounce — not yet shown
}

// What the caller must do to its debounce timer after a transition (the machine has no clock of its own).
export interface LightAction {
  state: LightDisplay;
  arm: boolean;    // (re)start the debounce timer — it will emit `settle` when it fires
  disarm: boolean; // cancel a pending debounce timer
}

export function lightDisplayInit(phase: Phase = "off"): LightDisplay {
  return { shown: phase, armed: false };
}

export function nextLightDisplay(s: LightDisplay, e: LightEvent): LightAction {
  switch (e.kind) {
    case "phase":
      if (e.phase === "syncing") {
        // Already showing a sustained sync → nothing changes (don't re-arm; keep painting "Syncing…").
        if (s.shown === "syncing") return { state: s, arm: false, disarm: false };
        // Entering syncing from a steady state: keep showing the steady state, arm the debounce ONCE.
        // A transient check that settles before it fires is thus never seen.
        return { state: { shown: s.shown, armed: true }, arm: !s.armed, disarm: false };
      }
      // Any non-syncing phase is a real, stable state: show it now, and cancel a pending syncing debounce
      // (this is the settle-before-timer case that kills the flicker).
      return { state: { shown: e.phase, armed: false }, arm: false, disarm: s.armed };
    case "settle":
      // The debounce elapsed. Commit to showing syncing IFF still armed (still syncing) — otherwise a
      // stale timer (the phase already left syncing) is a no-op.
      return s.armed
        ? { state: { shown: "syncing", armed: false }, arm: false, disarm: false }
        : { state: s, arm: false, disarm: false };
  }
}

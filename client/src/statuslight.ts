// The status-light DISPLAY state machine — a minimum-show projection of the engine's operational phase.
//
// HISTORY. This reducer was born to fix a flicker (issueStatusLightFlicker): the light flitted
// "Fully synced" ⇄ "Syncing… (checking for changes)" about once a second, because a routine poll flips the
// engine phase idle → syncing(0 pending) → idle in well under a second, and painting each flip turned a
// transient CHECK into a visible STATE. As the owner put it: "checking for changes is a state transition,
// not a state." The fix then was to DELAY entering `syncing`.
//
// WHY IT INVERTED (2026-09-15). That guarantee now lives entirely UPSTREAM, on the pending gate:
// effectivePhase() maps `syncing` with nothing queued to transfer onto `idle`, so a no-work pass never
// reaches this reducer as `syncing` at all. With the flicker already excluded by "is there real work?",
// the delay only hid the work the user cared about — a one-file save is genuine, reports its transfer, and
// finishes well inside the delay, so the light stayed green for the whole upload and typing produced no
// feedback whatsoever.
//
// THE RULE NOW: real work is shown IMMEDIATELY, then HELD for a minimum time so a fast transfer is
// perceivable instead of blinking past. What gets deferred is the RETURN to a steady state — the opposite
// of before. One exception, and it is load-bearing: an ATTENTION state (a down link — retrying / blocked /
// lockedOut) overrides the hold at once, because a cosmetic minimum must never delay a failure.
//
// Pure + total so the whole table is unit-tested with no timers/DOM (statuslight.test): the caller wires a
// real setTimeout to emit the `settle` event and paints `state.shown`; this module owns only the decision.
import { Phase } from "./syncstate";

export type LightEvent =
  | { kind: "phase"; phase: Phase } // the engine's operational phase changed
  | { kind: "settle" };             // the minimum-show hold elapsed (the caller's timer fired)

export interface LightDisplay {
  shown: Phase;       // the phase the light is currently PAINTING (what the user sees)
  held: boolean;      // `shown` is inside its minimum-show window and may not be replaced by a resting state
  deferred?: Phase;   // the resting phase waiting for the hold to elapse (last one wins)
}

// What the caller must do to its hold timer after a transition (the machine has no clock of its own).
export interface LightAction {
  state: LightDisplay;
  arm: boolean;    // (re)start the hold timer — it will emit `settle` when it fires
  disarm: boolean; // cancel a pending hold timer
}

// A phase the user must not wait to learn about: the link is down or held off. These jump the hold queue.
function isAttention(p: Phase): boolean {
  return p === "retrying" || p === "blocked" || p === "lockedOut";
}

export function lightDisplayInit(phase: Phase = "off"): LightDisplay {
  return { shown: phase, held: false };
}

export function nextLightDisplay(s: LightDisplay, e: LightEvent): LightAction {
  switch (e.kind) {
    case "phase":
      if (e.phase === "syncing") {
        // Already painting a sync: keep painting, drop any pending return-to-steady (more work arrived, so
        // what is shown is still true) and RE-ARM. Re-arming is what makes a save TRAIN read as ONE
        // continuous "Syncing…" instead of a blink per save: Obsidian autosaves roughly every 2s while you
        // type, so a hold anchored on the first save alone expires between saves and the light square-waves
        // green/yellow at ~0.5Hz — the percept behind issueStatusLightFlicker, now in the alarm colour
        // (critique F2). Each save pushes the quiet window out instead; green returns once typing stops.
        if (s.shown === "syncing") {
          return { state: { shown: "syncing", held: true }, arm: true, disarm: s.held };
        }
        // Work started: paint it NOW and arm the quiet window.
        return { state: { shown: "syncing", held: true }, arm: true, disarm: false };
      }
      // A failure is never queued behind the cosmetic hold.
      if (isAttention(e.phase)) {
        return { state: { shown: e.phase, held: false }, arm: false, disarm: s.held };
      }
      // A resting phase during the hold waits for it; the last one to arrive is the one that paints.
      if (s.held) {
        return { state: { shown: s.shown, held: true, deferred: e.phase }, arm: false, disarm: false };
      }
      return { state: { shown: e.phase, held: false }, arm: false, disarm: false };
    case "settle":
      // The hold elapsed: paint whatever was waiting, or keep painting the sustained state.
      return s.deferred !== undefined
        ? { state: { shown: s.deferred, held: false }, arm: false, disarm: false }
        : { state: { shown: s.shown, held: false }, arm: false, disarm: false };
  }
}

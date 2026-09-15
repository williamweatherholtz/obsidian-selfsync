import { describe, it, expect } from "vitest";
import { nextLightDisplay, lightDisplayInit, LightDisplay, LightEvent } from "../src/statuslight";
import { Phase } from "../src/syncstate";

// The status-light DISPLAY FSM. It used to DELAY entering `syncing` (issueStatusLightFlicker): a poll that
// flipped idle → syncing(0 pending) → idle in under a second must never paint "Syncing…", because a check
// is a transition, not a state. That guarantee now lives ENTIRELY on the pending gate upstream
// (effectivePhase: syncing with 0 pending IS idle, see syncstate.test), so a no-work pass never reaches
// this reducer as `syncing` at all — and the delay had become pure cost: a real one-file save is genuine
// work that finishes in well under the delay, so the light sat on green while the edit uploaded and the
// user got no feedback at all (owner report 2026-09-15).
//
// So the rule inverts: real work is shown IMMEDIATELY, and is then HELD for a minimum time so a fast
// transfer is actually perceivable instead of blinking past. Leaving syncing is what gets deferred now.
// An ATTENTION state (a down link) always overrides the hold at once — a failure must never wait behind a
// cosmetic minimum. Pure + total, so the whole table is unit-tested with no timers/DOM.

const PHASES: Phase[] = ["off", "connecting", "idle", "syncing", "retrying", "lockedOut", "blocked"];
const step = (s: LightDisplay, e: LightEvent) => nextLightDisplay(s, e);
const phase = (p: Phase): LightEvent => ({ kind: "phase", phase: p });
const settle: LightEvent = { kind: "settle" };

describe("nextLightDisplay — show-now / hold-minimum status-light FSM", () => {
  it("init shows the given phase, not holding", () => {
    expect(lightDisplayInit()).toEqual({ shown: "off", held: false });
    expect(lightDisplayInit("idle")).toEqual({ shown: "idle", held: false });
  });

  it("a non-syncing phase is shown IMMEDIATELY", () => {
    for (const p of ["off", "connecting", "idle", "retrying"] as Phase[]) {
      const a = step({ shown: "off", held: false }, phase(p));
      expect(a.state).toEqual({ shown: p, held: false });
      expect(a.arm).toBe(false);
    }
  });

  // THE REPORTED BUG: a save is real work, so the light must go yellow the moment it starts.
  it("entering syncing PAINTS syncing at once and arms the minimum-show hold", () => {
    const a = step({ shown: "idle", held: false }, phase("syncing"));
    expect(a.state).toEqual({ shown: "syncing", held: true });
    expect(a.arm).toBe(true);
  });

  it("a sub-hold transfer STAYS visible: idle arrives during the hold and is deferred to settle", () => {
    let a = step(lightDisplayInit("idle"), phase("syncing"));
    expect(a.state.shown).toBe("syncing");
    a = step(a.state, phase("idle"));            // upload finished in ~50ms
    expect(a.state.shown).toBe("syncing");        // still yellow — the user gets to see it
    expect(a.state.deferred).toBe("idle");
    expect(a.disarm).toBe(false);                 // the hold timer keeps running
    const done = step(a.state, settle);           // hold elapsed
    expect(done.state).toEqual({ shown: "idle", held: false });
  });

  it("the LAST deferred phase wins when the hold elapses", () => {
    let s = step(lightDisplayInit("idle"), phase("syncing")).state;
    s = step(s, phase("idle")).state;
    s = step(s, phase("connecting")).state;       // superseded before settle
    expect(s.shown).toBe("syncing");
    expect(step(s, settle).state).toEqual({ shown: "connecting", held: false });
  });

  it("an ATTENTION state overrides the hold IMMEDIATELY (a down link never waits)", () => {
    for (const p of ["retrying", "blocked", "lockedOut"] as Phase[]) {
      const held = step(lightDisplayInit("idle"), phase("syncing")).state;
      const a = step(held, phase(p));
      expect(a.state).toEqual({ shown: p, held: false });
      expect(a.disarm).toBe(true);                // cancel the cosmetic hold
    }
  });

  it("re-entering syncing RE-ARMS the quiet window and clears a stale deferral", () => {
    // not holding any more (the window expired) but still syncing: a new save re-arms
    expect(step({ shown: "syncing", held: false }, phase("syncing")))
      .toEqual({ state: { shown: "syncing", held: true }, arm: true, disarm: false });
    // a second save arriving DURING the hold: still syncing, the pending return-to-idle is dropped, and the
    // window restarts (disarm cancels the in-flight timer, arm starts a fresh one)
    const s = { shown: "syncing" as Phase, held: true, deferred: "idle" as Phase };
    const a = step(s, phase("syncing"));
    expect(a.state).toEqual({ shown: "syncing", held: true });
    expect(a.arm).toBe(true);
    expect(a.disarm).toBe(true);
  });

  // THE FLICKER GUARD, restored at the new seam (issueStatusLightFlicker was discoveredInField; its
  // original guard tested the DELAY that no longer exists, so the property has to be re-pinned here).
  // Obsidian autosaves ~every 2s while you type: each save must EXTEND one continuous yellow, never
  // produce its own blink, and green must return only after typing stops.
  it("a save TRAIN paints ONE continuous syncing, and green returns only after the last save", () => {
    let s = lightDisplayInit("idle");
    let settles = 0;
    for (let i = 0; i < 10; i++) {                 // ten autosaves, each inside the quiet window
      const a = step(s, phase("syncing"));
      s = a.state;
      if (a.arm) settles++;                        // the caller (re)starts its timer
      expect(s.shown).toBe("syncing");             // never drops back to green mid-train
      s = step(s, phase("idle")).state;            // the save lands
      expect(s.shown).toBe("syncing");             // still yellow — deferred, not painted
    }
    expect(settles).toBe(10);                      // each save re-armed, so the window tracks the LAST save
    expect(step(s, settle).state).toEqual({ shown: "idle", held: false }); // quiet → green
  });

  it("a sustained sync keeps painting syncing after the hold elapses with nothing deferred", () => {
    const s = step(lightDisplayInit("idle"), phase("syncing")).state;
    const after = step(s, settle);                // hold done, still syncing
    expect(after.state).toEqual({ shown: "syncing", held: false });
    // and leaving syncing once the hold is over is immediate
    expect(step(after.state, phase("idle")).state).toEqual({ shown: "idle", held: false });
  });

  it("a stale settle with no hold is a no-op", () => {
    expect(step({ shown: "idle", held: false }, settle).state).toEqual({ shown: "idle", held: false });
  });

  it("an ISOLATED save resolves to green on its own settle (no latch across quiet gaps)", () => {
    let s = lightDisplayInit("idle");
    for (let i = 0; i < 20; i++) {                 // saves separated by a settle = quiet between them
      s = step(s, phase("syncing")).state; expect(s.shown).toBe("syncing");
      s = step(s, phase("idle")).state;    expect(s.shown).toBe("syncing"); // deferred
      s = step(s, settle).state;           expect(s.shown).toBe("idle");
    }
  });

  it("is total — every (state, event) yields a valid shown phase and never throws", () => {
    for (const shown of PHASES) for (const held of [false, true]) for (const deferred of [undefined, ...PHASES]) {
      for (const p of PHASES) expect(PHASES).toContain(step({ shown, held, deferred }, phase(p)).state.shown);
      expect(PHASES).toContain(step({ shown, held, deferred }, settle).state.shown);
    }
  });
});

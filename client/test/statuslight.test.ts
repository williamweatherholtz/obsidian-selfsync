import { describe, it, expect } from "vitest";
import { nextLightDisplay, lightDisplayInit, LightDisplay, LightEvent } from "../src/statuslight";
import { Phase } from "../src/syncstate";

// The status-light DISPLAY FSM (issueStatusLightFlicker). This is the "test net" for the fix: it pins the
// load-bearing property — a transient `syncing` that settles before the debounce NEVER becomes visible, so
// the light can't flit "Fully synced" ⇄ "Syncing…". The plugin feeds `phase` events + a timer-driven
// `settle`; this reducer owns the decision and the arm/disarm signals.

const PHASES: Phase[] = ["off", "connecting", "idle", "syncing", "retrying", "lockedOut", "blocked"];
const step = (s: LightDisplay, e: LightEvent) => nextLightDisplay(s, e);
const phase = (p: Phase): LightEvent => ({ kind: "phase", phase: p });
const settle: LightEvent = { kind: "settle" };

describe("nextLightDisplay — debounced status-light display FSM", () => {
  it("init shows the given phase, unarmed", () => {
    expect(lightDisplayInit()).toEqual({ shown: "off", armed: false });
    expect(lightDisplayInit("idle")).toEqual({ shown: "idle", armed: false });
  });

  it("a non-syncing phase is shown IMMEDIATELY (no debounce for real steady states)", () => {
    for (const p of ["off", "connecting", "idle", "offline"] as Phase[]) {
      const a = step({ shown: "off", armed: false }, phase(p));
      expect(a.state).toEqual({ shown: p, armed: false });
      expect(a.arm).toBe(false);
    }
  });

  it("entering syncing from a steady state KEEPS the steady state shown and ARMS the debounce", () => {
    const a = step({ shown: "idle", armed: false }, phase("syncing"));
    expect(a.state).toEqual({ shown: "idle", armed: true }); // still shows idle — NOT syncing
    expect(a.arm).toBe(true);
  });

  it("settle while armed COMMITS to showing syncing", () => {
    const a = step({ shown: "idle", armed: true }, settle);
    expect(a.state).toEqual({ shown: "syncing", armed: false });
  });

  it("THE FLICKER CASE: idle → syncing → idle (before settle) never shows syncing", () => {
    let s = lightDisplayInit("idle");
    s = step(s, phase("syncing")).state;   // arm; still showing idle
    expect(s.shown).toBe("idle");
    const back = step(s, phase("idle"));   // settles back before the timer
    expect(back.state).toEqual({ shown: "idle", armed: false });
    expect(back.disarm).toBe(true);        // caller cancels the pending timer
    // a late/stale settle now must be a no-op (armed was cleared)
    expect(step(back.state, settle).state).toEqual({ shown: "idle", armed: false });
    // repeated sub-second syncing blips never leave "idle"
    for (let i = 0; i < 20; i++) {
      s = step(s, phase("syncing")).state; expect(s.shown).toBe("idle");
      s = step(s, phase("idle")).state;    expect(s.shown).toBe("idle");
    }
  });

  it("THE SUSTAINED CASE: syncing that outlasts the debounce shows 'syncing'", () => {
    let s = lightDisplayInit("idle");
    s = step(s, phase("syncing")).state;   // arm
    s = step(s, settle).state;             // debounce elapsed, still syncing
    expect(s.shown).toBe("syncing");
    // leaving syncing shows the new steady state immediately
    expect(step(s, phase("idle")).state).toEqual({ shown: "idle", armed: false });
  });

  it("re-entering syncing while ALREADY showing it is a no-op (no re-arm)", () => {
    const a = step({ shown: "syncing", armed: false }, phase("syncing"));
    expect(a).toEqual({ state: { shown: "syncing", armed: false }, arm: false, disarm: false });
  });

  it("arm only fires ONCE while a debounce is pending (idempotent arm)", () => {
    const first = step({ shown: "idle", armed: false }, phase("syncing"));
    expect(first.arm).toBe(true);
    const again = step(first.state, phase("syncing")); // already armed
    expect(again.arm).toBe(false);
    expect(again.state).toEqual({ shown: "idle", armed: true });
  });

  it("is total — every (state, event) yields a valid shown phase and never throws", () => {
    for (const shown of PHASES) for (const armed of [false, true]) {
      for (const p of PHASES) expect(PHASES).toContain(step({ shown, armed }, phase(p)).state.shown);
      expect(PHASES).toContain(step({ shown, armed }, settle).state.shown);
    }
  });
});

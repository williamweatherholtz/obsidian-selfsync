import { describe, it, expect } from "vitest";
import { transportTransition, TransportState, TransportEvent } from "../src/transportstate";

// The pure WS-lifecycle FSM (crit R+1, issueStateMachineOrphanedAndImplicit D1). This is the "test net"
// that makes the extraction safe: every (state, event) is exercised, plus the load-bearing scenarios the
// old scattered booleans encoded — the redial-vs-reconnect fork (opened? → re-dial : full reconnect),
// the half-open re-dial, and the idle/active poll cadence.
const t = transportTransition;
const STATES: TransportState[] = ["offline", "dialing", "live", "degraded"];
const EVENTS: TransportEvent[] = ["dial", "opened", "errored", "closed", "staleTick", "teardown"];

describe("transportTransition: total + exhaustive", () => {
  it("is total — every (state, event) yields a valid state and never throws", () => {
    for (const s of STATES) for (const e of EVENTS) {
      const r = t(s, e);
      expect(STATES).toContain(r.state);
    }
  });

  it("dial → dialing + active poll (socket created, not yet open)", () => {
    for (const s of STATES) expect(t(s, "dial")).toEqual({ state: "dialing", effects: { poll: "active" } });
  });

  it("opened → live + idle poll (downshift to the liveness backstop)", () => {
    expect(t("dialing", "opened")).toEqual({ state: "live", effects: { poll: "idle" } });
  });

  it("errored PRESERVES 'was opened': live/degraded → degraded, dialing/offline → dialing (all upshift poll)", () => {
    expect(t("live", "errored")).toEqual({ state: "degraded", effects: { poll: "active" } });
    expect(t("degraded", "errored")).toEqual({ state: "degraded", effects: { poll: "active" } });
    expect(t("dialing", "errored")).toEqual({ state: "dialing", effects: { poll: "active" } });
    expect(t("offline", "errored")).toEqual({ state: "dialing", effects: { poll: "active" } });
  });

  it("closed FROM live/degraded (it had opened) → offline + DELAYED re-dial", () => {
    expect(t("live", "closed")).toEqual({ state: "offline", effects: { poll: "active", redial: "delayed" } });
    expect(t("degraded", "closed")).toEqual({ state: "offline", effects: { poll: "active", redial: "delayed" } });
  });

  it("closed from dialing/offline (never opened) → offline + full RECONNECT (likely a bad/expired token)", () => {
    expect(t("dialing", "closed")).toEqual({ state: "offline", effects: { poll: "active", reconnect: true } });
    expect(t("offline", "closed")).toEqual({ state: "offline", effects: { poll: "active", reconnect: true } });
  });

  it("staleTick FROM live → degraded + re-dial NOW (half-open detected); a no-op otherwise", () => {
    expect(t("live", "staleTick")).toEqual({ state: "degraded", effects: { poll: "active", redial: "now" } });
    expect(t("dialing", "staleTick")).toEqual({ state: "dialing", effects: {} });
    expect(t("degraded", "staleTick")).toEqual({ state: "degraded", effects: {} });
    expect(t("offline", "staleTick")).toEqual({ state: "offline", effects: {} });
  });

  it("teardown → offline from any state (caller clears timers/socket)", () => {
    for (const s of STATES) expect(t(s, "teardown")).toEqual({ state: "offline", effects: {} });
  });

  it("the canonical happy path: offline -dial-> dialing -opened-> live", () => {
    let s: TransportState = "offline";
    s = t(s, "dial").state; expect(s).toBe("dialing");
    s = t(s, "opened").state; expect(s).toBe("live");
  });

  it("a flapping socket that opened re-dials (never reconnects); one that never opened reconnects", () => {
    // opened → dropped → re-dial (delayed), NOT a full reconnect
    const dropped = t("live", "closed");
    expect(dropped.effects.redial).toBe("delayed");
    expect(dropped.effects.reconnect).toBeUndefined();
    // dialing (never opened) → closed → reconnect, NOT a re-dial
    const neverOpened = t("dialing", "closed");
    expect(neverOpened.effects.reconnect).toBe(true);
    expect(neverOpened.effects.redial).toBeUndefined();
  });

  it("a live socket that ERRORS then CLOSES still re-dials (degraded remembers 'was opened')", () => {
    // The regression the `degraded` state guards: a 3-state FSM would drop live→dialing on error, then
    // treat the close as never-opened → a heavy full reconnect. The 4-state model keeps it a re-dial.
    let s: TransportState = "live";
    s = t(s, "errored").state; expect(s).toBe("degraded");
    const closed = t(s, "closed");
    expect(closed.effects.redial).toBe("delayed");
    expect(closed.effects.reconnect).toBeUndefined();
  });
});

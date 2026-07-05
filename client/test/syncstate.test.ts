import { describe, it, expect } from "vitest";
import { transition, light, SyncMachine, Phase } from "../src/syncstate";

describe("sync FSM transitions", () => {
  it("off → connecting → idle on a successful connect", () => {
    let s: Phase = "off";
    s = transition(s, "connect"); expect(s).toBe("connecting");
    s = transition(s, "connected"); expect(s).toBe("idle");
  });
  it("connecting → offline on error", () => {
    expect(transition("connecting", "error")).toBe("offline");
  });
  it("CO-2: offline recovers to idle on a successful sync, not only on reconnect", () => {
    expect(transition("offline", "syncDone")).toBe("idle");   // a successful poll proves we're online
    expect(transition("offline", "connected")).toBe("idle");  // a full reconnect still recovers
    expect(transition("offline", "error")).toBe("offline");   // a genuine failure stays offline
  });
  it("idle → syncing → idle around a reconcile", () => {
    expect(transition("idle", "syncStart")).toBe("syncing");
    expect(transition("syncing", "syncDone")).toBe("idle");
  });
  it("any active phase → offline on error (this is the stale-green bug guard)", () => {
    for (const s of ["connecting", "idle", "syncing"] as Phase[]) {
      expect(transition(s, "error")).toBe("offline");
    }
  });
  it("offline recovers to idle on connected, else stays offline", () => {
    expect(transition("offline", "connected")).toBe("idle");
    expect(transition("offline", "syncStart")).toBe("offline");
  });
  it("connect from any phase restarts connecting; unload always → off", () => {
    for (const s of ["off", "connecting", "idle", "syncing", "offline"] as Phase[]) {
      expect(transition(s, "connect")).toBe("connecting");
      expect(transition(s, "unload")).toBe("off");
    }
  });
});

describe("light is a pure function of phase", () => {
  it("green only when idle (up to date)", () => {
    expect(light("idle").color).toBe("var(--color-green)");
    for (const s of ["off", "connecting", "syncing", "offline"] as Phase[]) {
      expect(light(s).color).not.toBe("var(--color-green)");
    }
  });
  it("offline is red", () => expect(light("offline").color).toBe("var(--color-red)"));
});

describe("SyncMachine fires onChange only on real transitions", () => {
  it("dedups no-op events", () => {
    const seen: Phase[] = [];
    const m = new SyncMachine((p) => seen.push(p));
    m.dispatch("connect");   // off -> connecting
    m.dispatch("syncStart"); // connecting -> connecting (no-op, no fire)
    m.dispatch("connected"); // connecting -> idle
    m.dispatch("syncDone");  // idle -> idle (no-op)
    expect(seen).toEqual(["connecting", "idle"]);
  });
});

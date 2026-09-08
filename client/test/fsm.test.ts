import { describe, it, expect } from "vitest";
import { defineMachine, identity, tableCoverage } from "../src/fsm";
import { resolveMachine, RESOLVE_STATES, type ResolveState, type ResolveEvent } from "../src/resolvefsm";
import { mountMachine, MOUNT_STATES, MOUNT_EVENTS } from "../src/mountfsm";
import { transportMachine, TRANSPORT_STATES, TRANSPORT_EVENTS } from "../src/transportstate";
import { linkMachine, LinkKind, LinkEventKind, FailureKind, type LinkState, type LinkEvent } from "../src/connstate";
import { engineMachine, ENGINE_STATES, type EngineStateEvent } from "../src/syncengine";

// The shared primitive every hazard-bearing state machine is built on (fsm.ts). These pin its contract —
// pure, total, conservative, terminal-aware — and then drive every REAL machine through every (state, event)
// pair, so the table of each is proven total (nothing throws, nothing invents a state).
describe("fsm primitive", () => {
  type S = "a" | "b" | "end";
  type E = "go" | "finish" | "reset" | "noise";
  const m = defineMachine<S, E, { beep?: boolean }>({
    name: "pmTest", states: ["a", "b", "end"], events: ["go", "finish", "reset", "noise"],
    kindOf: identity, eventKindOf: identity,
    terminal: { states: ["end"], exits: ["reset"] },
    transition(s, e) {
      if (e === "reset") return "a";
      if (s === "a" && e === "go") return { state: "b", effects: { beep: true } };
      if (s === "b" && e === "finish") return "end";
      return undefined;
    },
  });

  it("applies rules, carries effects as data, and reports whether the state changed", () => {
    expect(m.step("a", "go")).toEqual({ state: "b", effects: { beep: true }, changed: true });
    expect(m.next("b", "finish")).toBe("end");
  });
  it("an event with no rule is a no-op (total + conservative), never a throw", () => {
    expect(m.step("a", "noise")).toEqual({ state: "a", effects: undefined, changed: false });
    expect(m.step("a", "finish")).toEqual({ state: "a", effects: undefined, changed: false });
  });
  it("a terminal state is left only by its declared exits", () => {
    expect(m.isTerminal("end")).toBe(true);
    expect(m.step("end", "go").changed).toBe(false);
    expect(m.next("end", "reset")).toBe("a");
  });
  it("tableCoverage visits every pair and reports outcomes", () => {
    const cov = tableCoverage(m, { states: ["a", "b", "end"], events: ["go", "finish", "reset", "noise"] });
    expect(cov).toHaveLength(12);
    expect(cov.find((r) => r.from === "end" && r.on === "go")).toMatchObject({ to: "end", changed: false });
  });
});

describe("every real machine has a TOTAL table (no throw on any (state, event) pair)", () => {
  it("resolveMachine", () => {
    const states: ResolveState[] = [{ kind: "idle" }, { kind: "local", step: "writing" }, { kind: "uploading", sawBusy: false }, { kind: "done" }, { kind: "stale" }, { kind: "failed", message: "m" }];
    const events: ResolveEvent[] = [{ kind: "start" }, { kind: "step", step: "reading" }, { kind: "localDone" }, { kind: "stale" }, { kind: "error", message: "e" }, { kind: "engineBusy" }, { kind: "engineIdle" }, { kind: "graceElapsed" }, { kind: "capElapsed" }, { kind: "reset" }];
    const cov = tableCoverage(resolveMachine, { states, events });
    expect(cov).toHaveLength(states.length * events.length);
    expect(new Set(cov.map((r) => r.to)).size).toBeLessThanOrEqual(RESOLVE_STATES.length); // never a state outside the declared set
    for (const r of cov.filter((r) => ["done", "stale", "failed"].includes(r.from) && r.on !== "reset")) expect(r.changed).toBe(false);
  });
  it("mountMachine", () => {
    const cov = tableCoverage(mountMachine, { states: MOUNT_STATES, events: MOUNT_EVENTS });
    expect(cov).toHaveLength(MOUNT_STATES.length * MOUNT_EVENTS.length);
    for (const r of cov) expect(MOUNT_STATES).toContain(r.to);
  });
  it("transportMachine", () => {
    const cov = tableCoverage(transportMachine, { states: TRANSPORT_STATES, events: TRANSPORT_EVENTS });
    expect(cov).toHaveLength(TRANSPORT_STATES.length * TRANSPORT_EVENTS.length);
    for (const r of cov) expect(TRANSPORT_STATES).toContain(r.to);
  });
  it("engineMachine — and `unloading` is terminal: an effect resolving after teardown cannot revive the engine (UCA-26)", () => {
    const events: EngineStateEvent[] = [
      { kind: "unload" }, { kind: "disconnect" }, { kind: "connectStart", linkRetrying: false }, { kind: "connectStart", linkRetrying: true },
      { kind: "connected", queued: false }, { kind: "connected", queued: true }, { kind: "failed" }, { kind: "work" }, { kind: "drained" },
    ];
    const cov = tableCoverage(engineMachine, { states: ENGINE_STATES, events });
    expect(cov).toHaveLength(ENGINE_STATES.length * events.length);
    for (const r of cov) expect(ENGINE_STATES).toContain(r.to);
    for (const r of cov.filter((r) => r.from === "unloading")) expect(r.changed).toBe(false); // nothing leaves unloading
    expect(engineMachine.next("idle", { kind: "work" })).toBe("reconciling");
    expect(engineMachine.next("off", { kind: "work" })).toBe("off");          // no rule: unchanged
    expect(engineMachine.next("reconciling", { kind: "drained" })).toBe("idle");
    expect(engineMachine.next("connecting", { kind: "drained" })).toBe("connecting");
  });
  it("linkMachine", () => {
    const states: LinkState[] = [
      { kind: LinkKind.Ok },
      { kind: LinkKind.Retrying, recovery: { kind: "retryBackoff" } as never, attempt: 1 },
      { kind: LinkKind.Blocked, reason: FailureKind.AuthRejected as never, recovery: { kind: "awaitUser" } as never },
    ];
    const events: LinkEvent[] = [
      { kind: LinkEventKind.Connected },
      { kind: LinkEventKind.Failed, cls: { kind: FailureKind.Transient } as never },
    ];
    const cov = tableCoverage(linkMachine, { states, events });
    expect(cov).toHaveLength(6);
    for (const r of cov) expect([LinkKind.Ok, LinkKind.Retrying, LinkKind.Blocked]).toContain(r.to);
  });
});

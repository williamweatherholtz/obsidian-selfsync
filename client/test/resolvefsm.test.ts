import { describe, it, expect } from "vitest";
import { resolveNext, resolveLabel, resolveInFlight, type ResolveState, type ResolveEvent } from "../src/resolvefsm";

// The resolution FSM is PURE: every transition is a table row here. The modal only feeds it events and paints
// resolveLabel(state) — so the whole "what does the button say while resolving" contract is this file.
const run = (events: ResolveEvent[], from: ResolveState = { kind: "idle" }) => events.reduce(resolveNext, from);

describe("resolvefsm: transitions", () => {
  it("happy path mine: idle → checking → reading → writing → removingCopy → uploading → busy → idle → done", () => {
    const steps: ResolveEvent[] = [
      { kind: "start" }, { kind: "step", step: "reading" }, { kind: "step", step: "writing" }, { kind: "step", step: "removingCopy" },
      { kind: "localDone" }, { kind: "engineBusy" }, { kind: "engineIdle" },
    ];
    const seen = steps.map((_, i) => run(steps.slice(0, i + 1)));
    expect(seen.map((s) => s.kind)).toEqual(["local", "local", "local", "local", "uploading", "uploading", "done"]);
    expect((seen[0] as { step: string }).step).toBe("checking"); // start lands on the first real step
    expect((seen[5] as { sawBusy: boolean }).sawBusy).toBe(true);
  });

  it("uploading with the engine NEVER seen busy completes on the grace, not before", () => {
    const up = run([{ kind: "start" }, { kind: "localDone" }]);
    expect(resolveNext(up, { kind: "engineIdle" })).toEqual(up);          // idle without ever busy proves nothing yet
    expect(resolveNext(up, { kind: "graceElapsed" })).toEqual({ kind: "done" });
  });

  it("uploading with the engine busy ignores the grace and waits for idle; the cap always completes", () => {
    const busy = run([{ kind: "start" }, { kind: "localDone" }, { kind: "engineBusy" }]);
    expect(resolveNext(busy, { kind: "graceElapsed" })).toEqual(busy);
    expect(resolveNext(busy, { kind: "engineIdle" })).toEqual({ kind: "done" });
    expect(resolveNext(busy, { kind: "capElapsed" })).toEqual({ kind: "done" });
  });

  it("stale and error are terminal from local and uploading; reset returns to idle from anywhere", () => {
    expect(run([{ kind: "start" }, { kind: "stale" }])).toEqual({ kind: "stale" });
    expect(run([{ kind: "start" }, { kind: "localDone" }, { kind: "error", message: "disk" }])).toEqual({ kind: "failed", message: "disk" });
    expect(resolveNext({ kind: "stale" }, { kind: "start" })).toEqual({ kind: "stale" });   // terminal until reset
    expect(resolveNext({ kind: "failed", message: "x" }, { kind: "reset" })).toEqual({ kind: "idle" });
    expect(resolveNext({ kind: "done" }, { kind: "reset" })).toEqual({ kind: "idle" });
  });

  it("events that do not apply leave the state unchanged", () => {
    expect(resolveNext({ kind: "idle" }, { kind: "engineBusy" })).toEqual({ kind: "idle" });
    expect(resolveNext({ kind: "idle" }, { kind: "localDone" })).toEqual({ kind: "idle" });
    const local: ResolveState = { kind: "local", step: "writing" };
    expect(resolveNext(local, { kind: "engineBusy" })).toEqual(local);
  });
});

describe("resolvefsm: projection", () => {
  it("labels: each local step, uploading, done; idle/stale/failed show the button's own label", () => {
    expect(resolveLabel({ kind: "idle" }, "Keep + this device's")).toBe("Keep + this device's");
    expect(resolveLabel({ kind: "local", step: "checking" }, "x")).toBe("Checking the other version…");
    expect(resolveLabel({ kind: "local", step: "reading" }, "x")).toBe("Reading this device's version…");
    expect(resolveLabel({ kind: "local", step: "writing" }, "x")).toBe("Writing this device's version…");
    expect(resolveLabel({ kind: "local", step: "keepingBoth" }, "x")).toBe("Keeping both versions…");
    expect(resolveLabel({ kind: "local", step: "removingCopy" }, "x")).toBe("Removing the conflict copy…");
    expect(resolveLabel({ kind: "uploading", sawBusy: false }, "x")).toBe("Updating the server…");
    expect(resolveLabel({ kind: "done" }, "x")).toBe("Done");
    expect(resolveLabel({ kind: "stale" }, "Keep both")).toBe("Keep both");
    expect(resolveLabel({ kind: "failed", message: "m" }, "Keep both")).toBe("Keep both");
  });
  it("inFlight is exactly local + uploading", () => {
    expect(resolveInFlight({ kind: "idle" })).toBe(false);
    expect(resolveInFlight({ kind: "local", step: "checking" })).toBe(true);
    expect(resolveInFlight({ kind: "uploading", sawBusy: true })).toBe(true);
    expect(resolveInFlight({ kind: "done" })).toBe(false);
    expect(resolveInFlight({ kind: "stale" })).toBe(false);
  });
});

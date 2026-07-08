import { describe, it, expect } from "vitest";
import { SyncEngine, EngineEffects, engineStateToPhase } from "../src/syncengine";

const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve!: () => void; let reject!: (e?: unknown) => void;
  const p = new Promise<void>((res, rej) => { resolve = () => res(); reject = (e) => rej(e); });
  return { p, resolve, reject };
}

// A harness whose effects resolve immediately by default; a test can `block(name)` to hold an
// effect in-flight (returns the deferred to resolve/reject later) to probe serialization + ordering.
function harness() {
  const calls: string[] = [];
  const phases: string[] = [];
  const errors: string[] = [];
  let reconnects = 0;
  const blocks: Record<string, ReturnType<typeof deferred>[]> = {};
  const run = (name: string): Promise<void> => {
    calls.push(name);
    const q = blocks[name];
    if (q && q.length) return q.shift()!.p; // held by a test
    return Promise.resolve();
  };
  const fx: EngineEffects = {
    connect: () => run("connect"),
    reconcileAll: () => run("reconcileAll"),
    reconcilePath: (p) => run("path:" + p),
    rews: () => run("rews"),
    teardown: () => { calls.push("teardown"); },
    onPhase: (p) => phases.push(p),
    onError: (w) => errors.push(w),
    scheduleReconnect: () => { reconnects++; },
  };
  const block = (name: string) => { const d = deferred(); (blocks[name] ??= []).push(d); return d; };
  const e = new SyncEngine(fx);
  return { e, calls, phases, errors, block, get reconnects() { return reconnects; } };
}

describe("SyncEngine — serial run-to-completion", () => {
  it("connect settles to idle, then a remote poke reconciles and returns to idle", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" });
    await tick();
    expect(h.e.getState()).toBe("idle");
    h.e.enqueue({ kind: "remote" });
    await tick();
    expect(h.calls).toEqual(["connect", "reconcileAll"]);
    expect(h.e.getState()).toBe("idle");
  });

  it("shows Syncing (not Connecting) once the connection is established during the initial reconcile", async () => {
    const h = harness();
    const g = h.block("connect");                 // hold connect in-flight (models the long initial reconcile inside it)
    h.e.enqueue({ kind: "connect" });
    await tick();
    expect(engineStateToPhase(h.e.getState())).toBe("connecting"); // before the connection is established
    h.e.markReconciling();                        // connect effect signals: connected, now reconciling
    expect(engineStateToPhase(h.e.getState())).toBe("syncing");    // the initial sync shows Syncing, not Connecting
    g.resolve(); await tick();
    expect(h.e.getState()).toBe("idle");          // settles once connect returns
  });

  it("markReconciling is a no-op unless connecting", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick(); // now idle
    h.e.markReconciling();
    expect(h.e.getState()).toBe("idle");            // not upgraded from a non-connecting state
  });

  it("runs exactly one effect at a time — a poke during a reconcile waits, never overlaps (CONC-R3#3)", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick();
    const g = h.block("reconcileAll");              // hold the first reconcile in-flight
    h.e.enqueue({ kind: "remote" }); await tick();
    expect(h.calls.filter((c) => c === "reconcileAll").length).toBe(1); // in-flight
    expect(h.e.getState()).toBe("reconciling");
    // Two more pokes arrive mid-reconcile: coalesced to ONE queued follow-up.
    h.e.enqueue({ kind: "remote" });
    h.e.enqueue({ kind: "remote" });
    expect(h.e.pending()).toEqual(["remote"]);
    g.resolve(); await tick();
    expect(h.calls.filter((c) => c === "reconcileAll").length).toBe(2); // the queued follow-up ran
    expect(h.e.getState()).toBe("idle");            // no poke dropped, no overlap
  });

  it("dedups QUEUED path events by path but keeps distinct paths", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick();
    const g = h.block("path:a.md");
    h.e.enqueue({ kind: "path", path: "a.md", size: 1 }); await tick(); // a.md in-flight
    h.e.enqueue({ kind: "path", path: "b.md", size: 1 });               // b.md queued
    h.e.enqueue({ kind: "path", path: "b.md", size: 2 });               // dup of QUEUED b.md → dropped
    h.e.enqueue({ kind: "path", path: "c.md", size: 1 });               // distinct → queued
    expect(h.e.pending()).toEqual(["path", "path"]);                    // b.md, c.md
    g.resolve(); await tick();
    expect(h.calls).toEqual(["connect", "path:a.md", "path:b.md", "path:c.md"]);
  });

  it("a re-edit of a path already IN-FLIGHT enqueues a fresh reconcile (new content)", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick();
    const g = h.block("path:a.md");
    h.e.enqueue({ kind: "path", path: "a.md", size: 1 }); await tick(); // a.md in-flight
    h.e.enqueue({ kind: "path", path: "a.md", size: 2 });               // changed AGAIN → must re-reconcile
    expect(h.e.pending()).toEqual(["path"]);
    g.resolve(); await tick();
    expect(h.calls).toEqual(["connect", "path:a.md", "path:a.md"]);
  });
});

describe("SyncEngine — gating on connection", () => {
  it("ignores local/remote events until connected (connect's reconcile subsumes them)", async () => {
    const h = harness();
    h.e.enqueue({ kind: "path", path: "a.md", size: 1 });
    h.e.enqueue({ kind: "remote" });
    await tick();
    expect(h.calls).toEqual([]);            // nothing ran — not connected
    expect(h.e.getState()).toBe("off");
  });
});

describe("SyncEngine — failure funnels to offline + reconnect", () => {
  it("a failed reconcile goes offline, schedules a reconnect, and drops pending work", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick();
    const g = h.block("reconcileAll");
    h.e.enqueue({ kind: "remote" }); await tick();
    h.e.enqueue({ kind: "path", path: "a.md", size: 1 }); // queued behind the failing reconcile
    g.reject(new Error("server down")); await tick();
    expect(h.e.getState()).toBe("offline");
    expect(h.reconnects).toBe(1);
    expect(h.e.pending()).toEqual([]);       // pending path dropped — the reconnect's reconcileAll covers it
    expect(h.errors).toContain("remote");
  });

  it("a failed connect goes offline + reconnect and stays disconnected", async () => {
    const h = harness();
    const g = h.block("connect");
    h.e.enqueue({ kind: "connect" }); await tick();
    expect(h.e.getState()).toBe("connecting");
    g.reject(new Error("no token")); await tick();
    expect(h.e.getState()).toBe("offline");
    expect(h.reconnects).toBe(1);
    // While disconnected, a local edit is ignored (recovered by the next connect's reconcile).
    h.e.enqueue({ kind: "path", path: "a.md", size: 1 }); await tick();
    expect(h.calls.some((c) => c.startsWith("path:"))).toBe(false);
  });
});

describe("SyncEngine — WS re-dial folds into the one queue (no parallel recovery race)", () => {
  it("rews re-dials the socket; if it can't open, it escalates to a full connect", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick();
    const g = h.block("rews");
    h.e.enqueue({ kind: "rews" }); await tick();
    g.reject(new Error("upgrade rejected")); await tick();
    expect(h.calls).toEqual(["connect", "rews", "connect"]); // escalated, serially
  });
});

describe("SyncEngine — terminal transitions", () => {
  it("unload tears down, projects off, and swallows further events", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick();
    h.e.enqueue({ kind: "unload" });
    expect(h.calls).toContain("teardown");
    expect(h.e.getState()).toBe("unloading");
    h.e.enqueue({ kind: "remote" }); await tick();
    expect(h.calls.filter((c) => c === "reconcileAll").length).toBe(0);
  });

  it("disconnect stops everything and returns to off (stays re-connectable)", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick();
    h.e.enqueue({ kind: "disconnect" }); await tick();
    expect(h.e.getState()).toBe("off");
    expect(h.calls).toContain("teardown");
  });
});

describe("SyncEngine — Round-6 CONC fixes", () => {
  it("failToOffline drops `connected`, so a WS redial/poke in the offline window is IGNORED (one recovery path)", async () => {
    const h = harness();
    h.e.enqueue({ kind: "connect" }); await tick();
    const g = h.block("reconcileAll");
    h.e.enqueue({ kind: "remote" }); await tick();
    g.reject(new Error("blip")); await tick();
    expect(h.e.getState()).toBe("offline");
    // A WS `close` in the offline→reconnect window enqueues {rews}; it must be ignored now that
    // connected=false, and a stray poll {remote} too — ONLY the scheduled backoff reconnect recovers.
    h.e.enqueue({ kind: "rews" }); await tick();
    h.e.enqueue({ kind: "remote" }); await tick();
    expect(h.calls.filter((c) => c === "rews").length).toBe(0);         // redial did not run
    expect(h.calls.filter((c) => c === "reconcileAll").length).toBe(1); // stray poke ignored
    expect(h.reconnects).toBe(1);                                       // exactly one recovery path
  });

  it("coalescing a queued path keeps the LARGER size (stale small size can't bypass the RAM/size gate)", async () => {
    const sizes: number[] = [];
    const fx: EngineEffects = {
      connect: () => Promise.resolve(),
      reconcileAll: () => Promise.resolve(),
      reconcilePath: (_p, s) => { sizes.push(s); return Promise.resolve(); },
      rews: () => Promise.resolve(), teardown: () => {}, onPhase: () => {}, onError: () => {}, scheduleReconnect: () => {},
    };
    const e = new SyncEngine(fx);
    e.enqueue({ kind: "connect" });                       // in-flight; the paths below queue behind it
    e.enqueue({ kind: "path", path: "big.md", size: 100 });
    e.enqueue({ kind: "path", path: "big.md", size: 900_000_000 }); // grew past the gate
    e.enqueue({ kind: "path", path: "big.md", size: 500 });          // smaller → must NOT lower it
    await tick();
    expect(sizes).toEqual([900_000_000]);                 // ran once, with the MAX size observed
  });
});

describe("engineStateToPhase — light projection", () => {
  it("maps operational state to the display phase", () => {
    expect(engineStateToPhase("connecting")).toBe("connecting");
    expect(engineStateToPhase("reconciling")).toBe("syncing");
    expect(engineStateToPhase("idle")).toBe("idle");
    expect(engineStateToPhase("offline")).toBe("offline");
    expect(engineStateToPhase("off")).toBe("off");
    expect(engineStateToPhase("unloading")).toBe("off");
  });
});

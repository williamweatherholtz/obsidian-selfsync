// The AUTHORITATIVE operational state machine for the sync lifecycle.
//
// Before this, the client's real control state lived in a pile of imperative booleans
// (`applying`, `connecting`, `remoteDirty`, `pendingLocal`, `persisting`) and every async entry
// point (local edit / delete / rename, remote poke, poll tick, reconnect) re-implemented the same
// check-set-dispatch-work-drain dance by hand — six copies, each a place to forget a step. That
// hand-rolled event loop was the source of a whole family of races (leaked `applying` guard,
// dropped mid-reconcile remote poke, stranded drain, WS-redial-vs-reconnect). syncstate.ts's FSM
// only ever drove the status LIGHT; nothing branched on it.
//
// This engine makes the operational state the ONE authoritative machine: a single serial event
// queue with run-to-completion semantics. Exactly one effect runs at a time; events that arrive
// during an effect are enqueued (coalesced) and processed when it settles. That makes the old race
// class structurally impossible — a remote poke mid-reconcile is just a queued event; there is one
// drain site, not six; recovery has one path. Effects (connect / reconcile / re-dial WS / teardown)
// are INJECTED, so the whole thing is unit-testable without Obsidian. The status light is a pure
// PROJECTION of this machine's state (see phase()).

import { Phase } from "./syncstate";

// The operational state. Projected to a display Phase for the light.
export type EngineState = "off" | "connecting" | "reconciling" | "idle" | "offline" | "unloading";

export type EngineEvent =
  | { kind: "connect" }                             // (re)establish: token, health, initial reconcile, WS+poll
  | { kind: "remote" }                              // a remote change (WS poke or poll tick) → reconcile all
  | { kind: "path"; path: string; size: number }    // a local file change → reconcile just that path
  | { kind: "rews" }                                // re-establish ONLY the WS socket (no reconcile)
  | { kind: "disconnect" }                          // user disconnect → off, stop timers (stays signed in)
  | { kind: "unload" };                             // plugin teardown

// Injected side-effects. All async ones REJECT on failure; the engine turns that into `offline`
// + a scheduled reconnect. None of them manage state or re-entrancy — the engine owns that.
export interface EngineEffects {
  connect(): Promise<void>;                    // acquire token, health-check, initial reconcileAll, spin up WS + poll
  reconcileAll(): Promise<void>;               // full reconcile (remote poke / poll)
  reconcilePath(path: string, size: number): Promise<void>; // single-path reconcile (local event)
  rews(): Promise<void>;                       // re-dial the WS socket only; rejects if it can't open
  teardown(): void;                            // stop timers + close WS (disconnect/unload)
  onPhase(p: Phase): void;                     // projection sink for the status light
  onError(where: string, e: unknown): void;    // logging
  scheduleReconnect(): void;                   // arm the backoff timer that will later enqueue {connect}
}

export function engineStateToPhase(s: EngineState): Phase {
  switch (s) {
    case "connecting": return "connecting";
    case "reconciling": return "syncing";
    case "idle": return "idle";
    case "offline": return "offline";
    case "off":
    case "unloading": return "off";
  }
}

export class SyncEngine {
  private queue: EngineEvent[] = [];
  private running = false;                 // is the processor loop active? (replaces `applying`)
  private state: EngineState = "off";
  private connected = false;               // has a connect() completed? gates path/remote/rews
  private retrying = false;                // in a backoff-reconnect cycle after a failure — so doomed
                                           // retry attempts keep showing "offline", not flashing "connecting"

  constructor(private fx: EngineEffects) {}

  getState(): EngineState { return this.state; }
  phase(): Phase { return engineStateToPhase(this.state); }

  // Called by the connect EFFECT once the connection is established (token + health OK) but BEFORE the
  // initial reconcile, so the initial sync shows "Syncing…" not "Connecting…" (the connect effect does
  // the full initial reconcile, which is the bulk of the time). Only upgrades the `connecting` phase;
  // never overrides offline/unloading/idle.
  // Called by connect() AFTER the health check passes — so the connection is confirmed reachable.
  // Upgrades from either "connecting" (fresh connect) or "offline" (a backoff retry that just
  // succeeded in reaching the server) to "reconciling", so recovery shows "Syncing…", not a stale
  // "offline"/"connecting".
  markReconciling(): void { if (this.state === "connecting" || this.state === "offline") this.setState("reconciling"); }
  /** Test/introspection helper: pending event kinds in order. */
  pending(): string[] { return this.queue.map((e) => e.kind); }

  // Enqueue an event and kick the processor. Coalescing keeps the queue bounded and idempotent:
  // one pending `remote` reconciles everything, one `connect`/`rews` is enough, and a path dedups
  // by path. Terminal states swallow further input.
  enqueue(ev: EngineEvent): void {
    if (this.state === "unloading") return;
    if (ev.kind === "unload") { this.state = "unloading"; this.queue = []; this.fx.teardown(); this.fx.onPhase(this.phase()); return; }
    // A repeat {path} for a path already queued coalesces — but keep the LARGER size, so a save
    // that grew the file past the RAM/size gate between the two events isn't judged on the stale
    // smaller size (which would bypass the pre-read skip). (Round-6 CONC)
    if (ev.kind === "path") {
      const q = this.queue.find((x) => x.kind === "path" && x.path === ev.path) as { kind: "path"; path: string; size: number } | undefined;
      if (q) { if (ev.size > q.size) q.size = ev.size; return; }
    }
    const dup =
      (ev.kind === "remote" && this.queue.some((q) => q.kind === "remote")) ||
      (ev.kind === "connect" && this.queue.some((q) => q.kind === "connect")) ||
      (ev.kind === "rews" && this.queue.some((q) => q.kind === "rews"));
    if (dup) return;
    this.queue.push(ev);
    void this.pump();
  }

  private setState(s: EngineState): void {
    if (s !== this.state) { this.state = s; this.fx.onPhase(this.phase()); }
  }

  // On any effect failure: go offline, log, arm the backoff reconnect, and DROP pending
  // path/remote/rews work — the reconnect's connect() does a full reconcileAll that subsumes all of
  // it (local edits are recovered via base comparison, remote via changes(0)). No tight retry loop,
  // no lost data. disconnect/unload events are preserved.
  private failToOffline(where: string, e: unknown): void {
    this.setState("offline");
    this.retrying = true; // we're now in a backoff loop; further connect attempts stay "offline"
    // Drop `connected` so the path/remote/rews guards short-circuit during the offline→reconnect
    // window. Without this, a WS `close` firing after the failure would enqueue {rews}, pass the
    // `if (!connected) return` guard (connected was still true), and re-dial a socket while the
    // backoff reconnect is ALSO pending — two live recovery paths (Round-6 CONC). Only the
    // backoff {connect} recovers now; it sets connected=true again on success.
    this.connected = false;
    this.fx.onError(where, e);
    this.queue = this.queue.filter((q) => q.kind === "disconnect" || q.kind === "unload");
    this.fx.scheduleReconnect();
  }

  private async pump(): Promise<void> {
    if (this.running) return;              // exactly one processor at a time (run-to-completion)
    this.running = true;
    try {
      while (this.queue.length && this.state !== "unloading") {
        const ev = this.queue.shift()!;
        await this.handle(ev);
      }
      // Settle to idle only if we're connected and nothing failed us into offline.
      if (this.connected && this.state === "reconciling" && this.queue.length === 0) this.setState("idle");
    } finally {
      this.running = false;
    }
  }

  private async handle(ev: EngineEvent): Promise<void> {
    switch (ev.kind) {
      case "unload":
        this.setState("unloading"); this.queue = []; this.fx.teardown(); return;
      case "disconnect":
        this.connected = false; this.retrying = false; this.queue = []; this.fx.teardown(); this.setState("off"); return;
      case "connect": {
        // A fresh connect shows "Connecting…"; a backoff RETRY (server was down) keeps showing
        // "Offline — retrying" so the light doesn't flash connecting↔offline every attempt.
        this.setState(this.retrying ? "offline" : "connecting");
        try { await this.fx.connect(); this.connected = true; this.retrying = false; this.setState(this.queue.length ? "reconciling" : "idle"); }
        catch (e) { this.connected = false; this.failToOffline("connect", e); }
        return;
      }
      case "rews":
        if (!this.connected) return;
        try { await this.fx.rews(); } catch (e) { this.fx.onError("rews", e); this.enqueue({ kind: "connect" }); }
        return;
      case "remote":
        if (!this.connected) return;       // ignored until connected; connect() reconciles anyway
        this.setState("reconciling");
        try { await this.fx.reconcileAll(); } catch (e) { this.failToOffline("remote", e); }
        return;
      case "path":
        if (!this.connected) return;       // a local edit while disconnected is caught by connect()'s reconcileAll
        this.setState("reconciling");
        try { await this.fx.reconcilePath(ev.path, ev.size); } catch (e) { this.failToOffline("path", e); }
        return;
    }
  }
}

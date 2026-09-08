// The RESOLUTION state machine for the Resolve-conflicts modal (owner, 2026-09-08: "'step by step status' is a
// FSM. do proper state tracking"). Pure: a state type, an event type, one transition function, one label
// projection. The modal holds the state, feeds it events (the plugin's real steps, the engine's busy/idle, the
// clock), and paints the pressed button from the projection - it never composes status strings itself.
//
//   idle --start--> local(checking) --step--> local(step)... --localDone--> uploading --engineBusy--> uploading*
//   uploading* --engineIdle--> done          uploading (never busy) --graceElapsed--> done   any --capElapsed--> done
//   local|uploading --stale--> stale         local|uploading --error--> failed          any --reset--> idle
//
// "uploading" is real, not decorative: resolving enqueues a sync of the written path, so the modal waits for the
// engine to pick it up (busy) and settle (idle). If busy never appears within the grace (nothing to upload, or
// offline - the upload happens later) or the cap passes, the machine completes anyway: it never blocks on the network.

export type ResolveStep = "checking" | "reading" | "writing" | "keepingBoth" | "removingCopy";

export type ResolveState =
  | { kind: "idle" }
  | { kind: "local"; step: ResolveStep }        // the plugin is performing a local step
  | { kind: "uploading"; sawBusy: boolean }     // local steps done; waiting for the engine to pick up + settle
  | { kind: "done" }
  | { kind: "stale" }                           // the other version changed since it was previewed; nothing applied
  | { kind: "failed"; message: string };

export type ResolveEvent =
  | { kind: "start" }
  | { kind: "step"; step: ResolveStep }
  | { kind: "localDone" }
  | { kind: "stale" }
  | { kind: "error"; message: string }
  | { kind: "engineBusy" }
  | { kind: "engineIdle" }
  | { kind: "graceElapsed" }
  | { kind: "capElapsed" }
  | { kind: "reset" };

export function resolveNext(s: ResolveState, e: ResolveEvent): ResolveState {
  if (e.kind === "reset") return { kind: "idle" };
  switch (s.kind) {
    case "idle":
      return e.kind === "start" ? { kind: "local", step: "checking" } : s;
    case "local":
      if (e.kind === "step") return { kind: "local", step: e.step };
      if (e.kind === "localDone") return { kind: "uploading", sawBusy: false };
      if (e.kind === "stale") return { kind: "stale" };
      if (e.kind === "error") return { kind: "failed", message: e.message };
      return s;
    case "uploading":
      if (e.kind === "engineBusy") return { kind: "uploading", sawBusy: true };
      if (e.kind === "engineIdle") return s.sawBusy ? { kind: "done" } : s;
      if (e.kind === "graceElapsed") return s.sawBusy ? s : { kind: "done" };
      if (e.kind === "capElapsed") return { kind: "done" };
      if (e.kind === "stale") return { kind: "stale" };
      if (e.kind === "error") return { kind: "failed", message: e.message };
      return s;
    default:
      return s; // done / stale / failed are terminal until reset
  }
}

/** Is a resolution in flight (buttons must not accept another)? */
export function resolveInFlight(s: ResolveState): boolean { return s.kind === "local" || s.kind === "uploading"; }

const STEP_LABEL: Record<ResolveStep, string> = {
  checking: "Checking the other version…",
  reading: "Reading this device's version…",
  writing: "Writing this device's version…",
  keepingBoth: "Keeping both versions…",
  removingCopy: "Removing the conflict copy…",
};

/** What the pressed button reads in this state; `own` is its normal label. */
export function resolveLabel(s: ResolveState, own: string): string {
  switch (s.kind) {
    case "local": return STEP_LABEL[s.step];
    case "uploading": return "Updating the server…";
    case "done": return "Done";
    default: return own; // idle / stale / failed: the button is itself again (the notice carries the why)
  }
}

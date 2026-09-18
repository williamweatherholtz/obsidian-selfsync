// The main-thread stall VERDICT, as a pure function.
//
// A 1s heartbeat compares wall clock against the tick it expected, and a late tick can mean two very
// different things. A blocked main thread is the one worth a warning. A HIDDEN window is merely throttled:
// the host clamps timers to roughly once a minute when it is minimised or in the background, which says
// nothing about the thread. Conflating them produced 963 identical "STALLED 59.0s" warnings in one owner
// log (2026-09-18) and buried the real signal in its own noise.
//
// Pure so the distinction is unit-tested rather than argued about.

export type StallVerdict = "none" | "throttled" | "stalled";

export function stallVerdict(lateMs: number, windowHidden: boolean, warnMs: number): StallVerdict {
  if (lateMs < warnMs) return "none";          // ordinary jitter — a timer is never exact
  return windowHidden ? "throttled" : "stalled";
}

import { describe, it, expect } from "vitest";
import { stallVerdict } from "../src/stall";

// The detector's whole value is telling a BLOCKED main thread from a THROTTLED timer. It failed that in the
// field: a hidden window's clamped interval produced 963 identical "STALLED 59.0s" warnings in one owner log
// (2026-09-18), drowning the real ones. These pin the distinction.

const WARN = 2_000;

describe("stallVerdict", () => {
  it("ordinary jitter is not a stall", () => {
    expect(stallVerdict(0, false, WARN)).toBe("none");
    expect(stallVerdict(1_999, false, WARN)).toBe("none");
    expect(stallVerdict(1_999, true, WARN)).toBe("none"); // hidden or not, under the threshold is nothing
  });

  it("a late tick with the window VISIBLE is a stall — the thread really was blocked", () => {
    expect(stallVerdict(2_000, false, WARN)).toBe("stalled");
    expect(stallVerdict(59_000, false, WARN)).toBe("stalled");
  });

  // THE FIELD FALSE POSITIVE: the host clamps timers to ~1/minute in a hidden window.
  it("the same lateness while HIDDEN is throttling, never a stall", () => {
    expect(stallVerdict(59_000, true, WARN)).toBe("throttled");
    expect(stallVerdict(600_000, true, WARN)).toBe("throttled"); // ten minutes backgrounded is still not a stall
  });

  it("the threshold is a parameter, not a constant baked into the verdict", () => {
    expect(stallVerdict(3_000, false, 5_000)).toBe("none");
    expect(stallVerdict(6_000, false, 5_000)).toBe("stalled");
  });
});

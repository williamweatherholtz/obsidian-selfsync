import { describe, it, expect } from "vitest";
import { light, isWsStale, Phase } from "../src/syncstate";

describe("light is a pure function of phase", () => {
  it("green only when idle (up to date)", () => {
    expect(light("idle").color).toBe("var(--color-green)");
    for (const s of ["off", "connecting", "syncing", "offline"] as Phase[]) {
      expect(light(s).color).not.toBe("var(--color-green)");
    }
  });
  it("offline is red", () => expect(light("offline").color).toBe("var(--color-red)"));

  it("syncing tip includes the progress detail when given ('Syncing… 12/174')", () => {
    expect(light("syncing", "12/174").tip).toBe("Syncing… 12/174");
    expect(light("syncing").tip).toBe("Syncing…"); // no detail → plain
  });

  // P4 (status/transport dual-truth guard): when idle but the realtime WS is DOWN, the light must not
  // claim full green "Fully synced" — it reflects the polling-fallback truth instead.
  it("idle with realtime DOWN is not green and says it's polling", () => {
    const up = light("idle", "v5", true);
    expect(up.color).toBe("var(--color-green)");
    expect(up.tip).toContain("Fully synced");
    const down = light("idle", "v5", false);
    expect(down.color).not.toBe("var(--color-green)");
    expect(down.tip.toLowerCase()).toContain("polling");
  });
  it("realtime defaults to up (prior behavior) when the flag is omitted", () => {
    expect(light("idle").color).toBe("var(--color-green)");
  });
  it("the realtime flag only affects idle (syncing/offline are unchanged)", () => {
    expect(light("syncing", "", false).color).toBe(light("syncing", "", true).color);
    expect(light("offline", "", false).color).toBe("var(--color-red)");
  });
});

describe("isWsStale (crit-round: WS half-open liveness)", () => {
  it("is stale only once activity is older than the deadline", () => {
    expect(isWsStale(1000, 1000 + 74_000, 75_000)).toBe(false); // within the window → alive
    expect(isWsStale(1000, 1000 + 75_000, 75_000)).toBe(false); // exactly at the deadline → not yet
    expect(isWsStale(1000, 1000 + 76_000, 75_000)).toBe(true);  // past the deadline → half-open
  });
});

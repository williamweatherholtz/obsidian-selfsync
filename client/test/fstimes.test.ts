import { describe, it, expect, vi } from "vitest";
import { driveFsTimes, FsTimeApi } from "../src/fstimes";

function api(platform: FsTimeApi["platform"], withBirth: boolean): FsTimeApi & { m: any; b: any } {
  const m = vi.fn().mockResolvedValue(undefined);
  const b = vi.fn().mockResolvedValue(undefined);
  return { platform, setMtime: m, ...(withBirth ? { setBirthtime: b } : {}), m, b } as any;
}

describe("driveFsTimes", () => {
  it("sets mtime from updated on every desktop platform", async () => {
    const a = api("linux", false);
    await driveFsTimes(a, "n.md", 111, 222);
    expect(a.m).toHaveBeenCalledWith("n.md", 111);
  });
  it("sets birthtime from created only when the API provides it (win/mac)", async () => {
    const a = api("win", true);
    await driveFsTimes(a, "n.md", 111, 222);
    expect(a.b).toHaveBeenCalledWith("n.md", 222);
  });
  it("skips birthtime on linux (no setBirthtime)", async () => {
    const a = api("linux", false);
    await driveFsTimes(a, "n.md", 111, 222);
    expect(a.b).not.toHaveBeenCalled();
  });
  it("degrades silently when setMtime throws", async () => {
    const a = api("win", true); a.m.mockRejectedValue(new Error("EPERM"));
    await expect(driveFsTimes(a, "n.md", 111, 222)).resolves.toBeUndefined();
  });
  it("no-ops when updated is undefined", async () => {
    const a = api("mac", true);
    await driveFsTimes(a, "n.md", undefined, 222);
    expect(a.m).not.toHaveBeenCalled();
  });
});

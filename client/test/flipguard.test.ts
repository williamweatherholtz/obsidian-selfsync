import { describe, it, expect } from "vitest";
import { FlipGuard } from "../src/flipguard";

// SR-47 / C-50: a file whose content RETURNS to an earlier value is a two-writer loop; past the limit the push
// is held, and the hold lifts on a genuinely new value, on window expiry, or on an explicit release.
describe("FlipGuard — rewrite-loop breaker", () => {
  const MIN = 60_000;
  it("ordinary editing (always-new content) never holds", () => {
    const g = new FlipGuard(4, 10 * MIN);
    for (let i = 0; i < 20; i++) expect(g.record("n.md", `h${i}`, i * MIN).hold).toBe(false);
    expect(g.held(20 * MIN)).toEqual([]);
  });
  it("re-evaluating the SAME content across passes is not a flip (a held push is re-asked every pass)", () => {
    const g = new FlipGuard(2, 10 * MIN);
    for (let i = 0; i < 10; i++) expect(g.record("n.md", "same", i * 1000).flips).toBe(0);
  });
  it("A→B→A→B… counts a flip each time content returns, and holds at the limit", () => {
    const g = new FlipGuard(4, 10 * MIN);
    const seq = ["A", "B", "A", "B", "A", "B", "A"];
    const verdicts = seq.map((h, i) => g.record("n.md", h, i * 1000));
    expect(verdicts.map((v) => v.flips)).toEqual([0, 0, 1, 2, 3, 4, 5]);
    expect(verdicts.map((v) => v.hold)).toEqual([false, false, false, false, false, true, true]);
    expect(g.held(7_000)).toEqual(["n.md"]);
  });
  it("a genuinely NEW value after flipping ends the loop: the hold lifts and the count resets", () => {
    const g = new FlipGuard(2, 10 * MIN);
    for (const [i, h] of ["A", "B", "A", "B"].entries()) g.record("n.md", h, i * 1000);
    expect(g.record("n.md", "B", 4_000).hold).toBe(true);   // still bouncing
    expect(g.record("n.md", "C", 5_000).hold).toBe(false);  // real edit → released
    expect(g.record("n.md", "C", 6_000).flips).toBe(0);
    expect(g.held(6_000)).toEqual([]);
  });
  it("flips age out of the window", () => {
    const g = new FlipGuard(2, 5 * MIN);
    g.record("n.md", "A", 0); g.record("n.md", "B", 1000); g.record("n.md", "A", 2000); g.record("n.md", "B", 3000);
    expect(g.record("n.md", "B", 4000).hold).toBe(true);
    expect(g.record("n.md", "B", 6 * MIN).hold).toBe(false); // the flips happened > window ago
  });
  it("release() lets the current content through until a real edit clears the override; forget() drops history", () => {
    const g = new FlipGuard(2, 10 * MIN);
    for (const [i, h] of ["A", "B", "A", "B"].entries()) g.record("n.md", h, i * 1000);
    expect(g.held(4000)).toEqual(["n.md"]);
    g.release("n.md");
    expect(g.record("n.md", "B", 5000).hold).toBe(false);
    expect(g.record("n.md", "A", 6000).hold).toBe(false); // override persists while the loop continues (user chose it)
    expect(g.held(6000)).toEqual([]);
    g.forget("n.md");
    expect(g.record("n.md", "A", 7000).flips).toBe(0);
  });
  it("paths are independent", () => {
    const g = new FlipGuard(2, 10 * MIN);
    for (const [i, h] of ["A", "B", "A", "B"].entries()) g.record("x.md", h, i * 1000);
    expect(g.record("y.md", "A", 5000).hold).toBe(false);
    expect(g.held(5000)).toEqual(["x.md"]);
  });
});

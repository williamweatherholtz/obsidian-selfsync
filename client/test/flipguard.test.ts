import { describe, it, expect } from "vitest";
import { FlipGuard, shapeOf } from "../src/flipguard";

// SR-47 / C-50: a file whose content RETURNS to an earlier value is a two-writer loop; past the limit the push
// is held, and the hold lifts on a genuinely new value, on window expiry, or (one-shot) on an explicit release.
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
  it("the default limit tolerates a person toggling a checkbox back and forth five times", () => {
    const g = new FlipGuard(); // defaults: 6 flips / 10 min
    const seq = ["A", "B", "A", "B", "A", "B", "A"]; // 5 returns
    expect(seq.map((h, i) => g.record("n.md", h, i * 20_000).hold)).toEqual(seq.map(() => false));
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
  it("release() is ONE-SHOT: exactly the current content passes; the next flip re-arms the hold", () => {
    const g = new FlipGuard(2, 10 * MIN);
    for (const [i, h] of ["A", "B", "A", "B"].entries()) g.record("n.md", h, i * 1000);
    expect(g.held(4000)).toEqual(["n.md"]);
    g.release("n.md");
    expect(g.held(4000)).toEqual([]);                        // the row disappears — this content is allowed
    expect(g.record("n.md", "B", 5000).hold).toBe(false);    // the released content is pushed
    expect(g.record("n.md", "A", 6000).hold).toBe(true);     // the loop continues → held again (no standing exemption)
    expect(g.held(6000)).toEqual(["n.md"]);
    expect(g.record("n.md", "C", 7000).hold).toBe(false);    // a real edit still ends it
  });
  it("a release outlived by the window is forgotten with the flips", () => {
    const g = new FlipGuard(2, 5 * MIN);
    for (const [i, h] of ["A", "B", "A", "B"].entries()) g.record("n.md", h, i * 1000);
    g.release("n.md");
    g.record("n.md", "B", 6 * MIN);                          // flips aged out → nothing held, override cleared
    for (const [i, h] of ["A", "B", "A", "B"].entries()) g.record("n.md", h, 6 * MIN + (i + 1) * 1000);
    expect(g.record("n.md", "B", 6 * MIN + 5000).hold).toBe(true); // a fresh loop is held again
  });
  it("paths are independent", () => {
    const g = new FlipGuard(2, 10 * MIN);
    for (const [i, h] of ["A", "B", "A", "B"].entries()) g.record("x.md", h, i * 1000);
    expect(g.record("y.md", "A", 5000).hold).toBe(false);
    expect(g.held(5000)).toEqual(["x.md"]);
  });
});

// monotonicRewriteDetection (panel ID3 residual): a stamper writes a NEVER-SEEN value each round — no exact return — but
// the content's SHAPE (timestamps masked) returns every time. Passing the shape beside the hash makes that a flip.
describe("FlipGuard — timestamp-shape returns (monotonic stampers)", () => {
  it("shapeOf masks ISO dates/date-times, epoch numbers and clock times; leaves prose alone", () => {
    expect(shapeOf("updated: 2026-09-12T10:15:30Z\nx")).toBe("updated: ⟨ts⟩\nx");
    expect(shapeOf("updated: 2026-09-12 10:15:30+02:00")).toBe("updated: ⟨ts⟩");
    expect(shapeOf("at 1757671530 and 1757671530123")).toBe("at ⟨ts⟩ and ⟨ts⟩");
    expect(shapeOf("meeting 9:05 then 14:30:00")).toBe("meeting ⟨ts⟩ then ⟨ts⟩");
    expect(shapeOf("version 42 of chapter 3\r\n")).toBe("version 42 of chapter 3\n");
  });
  it("a stamper's rounds (new timestamp each time, same shape) are held at the limit; a real edit releases", () => {
    const g = new FlipGuard(3, 10 * 60_000);
    const round = (i: number) => `---\nlast-modified: 2026-09-12T10:${String(i).padStart(2, "0")}:00Z\n---\nbody\n`;
    const verdicts = [0, 1, 2, 3, 4].map((i) => g.record("n.md", `h${i}`, i * 1000, shapeOf(round(i))));
    expect(verdicts.map((v) => v.hold)).toEqual([false, false, false, true, true]); // round 1..3 return the shape → 3 flips
    expect(g.held(5000)).toEqual(["n.md"]);
    expect(g.record("n.md", "hX", 6000, shapeOf("---\nlast-modified: 2026-09-12T10:06:00Z\n---\nbody with a real edit\n")).hold).toBe(false);
  });
  it("without a shape (binary / oversize) only exact returns count — a monotonic writer is not held", () => {
    const g = new FlipGuard(3, 10 * 60_000);
    for (let i = 0; i < 8; i++) expect(g.record("a.bin", `h${i}`, i * 1000).hold).toBe(false);
  });
});

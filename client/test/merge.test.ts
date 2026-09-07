import { describe, it, expect } from "vitest";
import { merge3, isMergeable } from "../src/merge";

const enc = (s: string) => new TextEncoder().encode(s);

describe("isMergeable", () => {
  it("true for .md/.txt valid utf8, false for binary ext and invalid utf8", () => {
    expect(isMergeable("a.md", enc("hello"))).toBe(true);
    expect(isMergeable("a.txt", enc("hello"))).toBe(true);
    expect(isMergeable("a.png", enc("hello"))).toBe(false);
    expect(isMergeable("a.md", new Uint8Array([0xff, 0xfe, 0x00]))).toBe(false);
  });
});

describe("merge3", () => {
  it("clean-merges non-overlapping edits on both sides", () => {
    const r = merge3("line1\nline2\nline3\n", "LINE1\nline2\nline3\n", "line1\nline2\nLINE3\n");
    expect(r.clean).toBe(true);
    expect(r.merged).toContain("LINE1");
    expect(r.merged).toContain("LINE3");
  });
  it("flags a conflict when both edit the same region", () => {
    const r = merge3("hello world\n", "hello LOCAL\n", "hello REMOTE\n");
    expect(r.clean).toBe(false);
  });
  it("identical local and remote merge cleanly to that content", () => {
    const r = merge3("a\n", "b\n", "b\n");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("b\n");
  });
});

import { unifiedLineDiff } from "../src/noteconflict";
describe("unifiedLineDiff (conflict diff view)", () => {
  it("marks shared lines as context, other-only as '-', this-device-only as '+'", () => {
    const d = unifiedLineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(d.find((l) => l.text === "a")!.sign).toBe(" "); // shared
    expect(d.find((l) => l.sign === "-" && l.text === "b")).toBeTruthy(); // removed (the other's line)
    expect(d.find((l) => l.sign === "+" && l.text === "B")).toBeTruthy(); // this device's line
    expect(d.find((l) => l.sign === "+" && l.text === "d")).toBeTruthy(); // added on this device
  });
  it("EOL-only difference produces zero changed lines", () => {
    const d = unifiedLineDiff("a\r\nb\r\n", "a\nb");
    expect(d.filter((l) => l.sign !== " ").length).toBe(0);
  });

  // ---- PERF GUARDS (issueConflictDiffQuadratic) ----
  // lcsPairs is an O(n*m) DP over a NESTED number matrix, and unifiedLineDiff called it on whole
  // notes with NO size bound (merge3 has MAX_MERGE_LINES; the diff view had nothing). Measured on a
  // fast desktop, for notes differing by ONE line: 4k lines 447ms, 8k 1.96s, 12k 4.5s — on the UI
  // thread, on modal open AND after every resolve, and several times worse on mobile. These guards
  // pin the fix (common prefix/suffix trimming + a cell budget) so the class cannot come back.
  const bigNote = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag} line ${i} some ordinary note prose here`).join("\n");

  it("a one-line change in a 12k-line note diffs in well under a second", () => {
    const a = bigNote(12_000, "x");
    const lines = a.split("\n");
    const originalMiddle = lines[6_000];
    lines[6_000] = "CHANGED on this device";
    const b = lines.join("\n");
    const t0 = performance.now();
    const d = unifiedLineDiff(a, b);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(250); // was ~4500ms
    // still a CORRECT diff, not a bail-out
    expect(d.filter((l) => l.sign === "-").map((l) => l.text)).toEqual([originalMiddle]);
    expect(d.filter((l) => l.sign === "+").map((l) => l.text)).toEqual(["CHANGED on this device"]);
    expect(d.length).toBe(12_001); // 11,999 context + one '-' + one '+'
  });

  it("two large notes sharing NOTHING stay bounded instead of allocating an n*m matrix", () => {
    const a = bigNote(5_000, "aaa");
    const b = bigNote(5_000, "bbb");
    const t0 = performance.now();
    const d = unifiedLineDiff(a, b);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(250);
    // every line differs, so the whole region is reported changed — coarse but honest AND bounded
    expect(d.filter((l) => l.sign === "-").length).toBe(5_000);
    expect(d.filter((l) => l.sign === "+").length).toBe(5_000);
  });

  it("trimming does not change the diff for a middle-of-note edit", () => {
    const a = "h1\nh2\nA\nB\nC\nt1\nt2";
    const b = "h1\nh2\nA\nX\nC\nt1\nt2";
    const d = unifiedLineDiff(a, b);
    expect(d.map((l) => l.sign + l.text)).toEqual([
      " h1", " h2", " A", "-B", "+X", " C", " t1", " t2",
    ]);
  });
});

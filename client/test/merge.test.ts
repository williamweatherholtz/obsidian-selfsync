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
});

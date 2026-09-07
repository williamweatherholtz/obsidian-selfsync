// issueConflictDiffInvisibleChars — the conflict diff showed two VISUALLY IDENTICAL lines as a
// "- tagNames:" / "+ tagNames:" pair, leaving nothing to choose between (owner field report).
//
// Line endings were never the cause: unifiedLineDiff already normalises CRLF, lone CR and trailing
// blank lines away, and the first test here pins that. The real causes are characters you cannot
// see — a trailing space or tab, a non-breaking space, a zero-width character.
//
// Those are deliberately NOT ignored. In Markdown two trailing spaces are a HARD LINE BREAK, a tab
// is not four spaces inside a code block, and U+00A0 is not U+0020 — folding them together would
// hide a real edit and could silently discard the user's version. So the diff REVEALS them.
//
// Every invisible character in this file is written as an escape ( , ​, \t) on purpose:
// pasted literals are indistinguishable from ordinary spaces in a source file and silently rot.
import { describe, it, expect } from "vitest";
import { unifiedLineDiff, revealInvisible, invisibleOnlyDifference } from "../src/noteconflict";

const changed = (a: string, b: string) => unifiedLineDiff(a, b).filter((l) => l.sign !== " ");
const invisibleOnly = (a: string, b: string) => invisibleOnlyDifference(unifiedLineDiff(a, b));

describe("conflict diff: line endings are agnostic, invisible characters are revealed", () => {
  it("line endings are ALREADY agnostic — CRLF, lone CR and trailing blank lines are never changes", () => {
    expect(changed("tagNames:\r\nx", "tagNames:\nx")).toEqual([]);
    expect(changed("tagNames:\rx", "tagNames:\nx")).toEqual([]);
    expect(changed("a\r\nb\r\n\r\n", "a\nb")).toEqual([]);
  });

  it("a trailing space IS a real difference (a Markdown hard break) and must still be reported", () => {
    const d = changed("tagNames: \nx", "tagNames:\nx");
    expect(d.length).toBe(2); // one '-', one '+' — not silently folded away
  });

  it("revealInvisible marks trailing spaces, tabs, NBSP and zero-width characters", () => {
    expect(revealInvisible("tagNames: ")).toBe("tagNames:·");
    expect(revealInvisible("tagNames:   ")).toBe("tagNames:···");
    expect(revealInvisible("\ttagNames:")).toBe("→tagNames:");
    expect(revealInvisible("a b")).toBe("a⍽b"); // NBSP renders exactly like a space
    expect(revealInvisible("a​b")).toBe("a∅b"); // zero-width space
  });

  it("revealInvisible leaves ordinary text alone — interior spaces are not noise-marked", () => {
    expect(revealInvisible("tag names: a b")).toBe("tag names: a b");
    expect(revealInvisible("")).toBe("");
    expect(revealInvisible("- [ ] a task")).toBe("- [ ] a task");
  });

  it("invisibleOnlyDifference recognises a pair that differs ONLY invisibly", () => {
    expect(invisibleOnly("tagNames: \nx", "tagNames:\nx")).toBe(true);          // trailing space
    expect(invisibleOnly("tagNames: a\nx", "tagNames: a\nx")).toBe(true);  // NBSP vs space
    expect(invisibleOnly("tag​Names:\nx", "tagNames:\nx")).toBe(true);     // zero-width
  });

  it("invisibleOnlyDifference is false for a real edit, and for no edit at all", () => {
    expect(invisibleOnly("tagNames: a\nx", "tagNames: b\nx")).toBe(false); // a genuine change
    expect(invisibleOnly("same\nx", "same\nx")).toBe(false);               // nothing changed
    // Tab-vs-spaces INDENT is deliberately NOT "invisible only": it changes indent WIDTH, which is
    // semantic in Markdown (list nesting, code blocks). The arrow marker explains it; claiming the
    // two versions are indistinguishable would be false.
    expect(invisibleOnly("\ttagNames:\nx", "    tagNames:\nx")).toBe(false);
  });

  it("NFC/NFD text that renders identically is folded by invisibleOnlyDifference", () => {
    // "café" precomposed vs decomposed (e + combining acute). Byte-different, visually identical —
    // the classic macOS-vs-Windows sync trap. Content identity does NOT normalise Unicode
    // (issueContentIdentityNotUnicodeNormalised), so this still reaches the diff; at minimum the
    // user must be TOLD the versions are visually the same rather than left guessing.
    expect(invisibleOnly("tag: café\nx", "tag: café\nx")).toBe(true);
  });
});

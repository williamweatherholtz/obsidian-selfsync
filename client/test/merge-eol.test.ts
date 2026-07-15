// Unit tests for the line-level three-way merge (src/merge.ts): CRLF/LF handling, conflict-region
// output, and the isMergeable gate + large-input fallback. These are pure functions — no DOM.
import { describe, it, expect } from "vitest";
import { merge3, isMergeable } from "../src/merge";

describe("merge3 — line-ending handling", () => {
  // REGRESSION (issueMergeCrlf): merge3 used to split on raw "\n" with no CRLF normalization, so every
  // CRLF line carried a trailing "\r". A side that re-saved with LF (a pure line-ending change) failed
  // to align against a CRLF base — the LCS found no common anchors and the whole file became ONE
  // conflict region even when the real content edits didn't overlap. Cross-platform vaults (Windows
  // CRLF ↔ mac/Linux/mobile LF) hit this on nearly every merge. Fixed by normalizing CRLF→LF before
  // the LCS (merge3). This asserts the correct behavior; it was authored `it.fails` and flipped on fix.
  it("a pure line-ending difference does not explode into an all-lines conflict", () => {
    const base = "a\r\nb\r\nc"; // CRLF
    const local = "a\nb\nc"; // identical content, LF only (a pure EOL rewrite)
    const remote = "a\r\nb\r\nC"; // CRLF, one genuine edit: c -> C
    const { merged, clean } = merge3(base, local, remote);
    // Only remote changed a line's content; the EOL-normalized diff3 merges cleanly to that edit.
    expect(clean).toBe(true);
    expect(merged).toBe("a\nb\nC");
  });

  it("both sides changing the SAME line yields a non-clean merge that keeps the local side", () => {
    const { merged, clean } = merge3("a\nb\nc", "a\nX\nc", "a\nY\nc");
    expect(clean).toBe(false); // overlapping edit is flagged as a conflict, never silently mangled
    expect(merged).toBe("a\nX\nc"); // conflict region emits the local side into `merged`
  });

  it("a non-overlapping edit on each side merges cleanly (LF baseline, no EOL confusion)", () => {
    // Sanity anchor: with consistent LF endings the same shape of edit merges clean.
    const { merged, clean } = merge3("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nD");
    expect(clean).toBe(true);
    expect(merged).toBe("A\nb\nc\nD");
  });
});

describe("isMergeable", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("true for a text extension holding valid utf-8", () => {
    expect(isMergeable("notes/a.md", enc("# hello"))).toBe(true);
    expect(isMergeable("board.canvas", enc("{}"))).toBe(true);
    expect(isMergeable("READ.TXT", enc("caps ext still text"))).toBe(true); // case-insensitive
  });

  it("false for a non-text extension", () => {
    expect(isMergeable("image.png", enc("not really an image"))).toBe(false);
  });

  it("false for a text extension holding invalid utf-8 (binary-in-disguise)", () => {
    // 0xff is never a valid utf-8 lead byte; the fatal decoder throws -> not mergeable.
    expect(isMergeable("a.md", new Uint8Array([0xff, 0xfe, 0x00]))).toBe(false);
  });
});

describe("merge3 — large-input fallback (> MAX_MERGE_LINES)", () => {
  it("falls back to a conflict-copy (clean:false, merged=local) above the line cap", () => {
    const n = 5001; // MAX_MERGE_LINES is 5000
    const base = Array.from({ length: n }, (_, i) => `line${i}`).join("\n");
    const local = "LOCAL0\n" + Array.from({ length: n - 1 }, (_, i) => `line${i + 1}`).join("\n");
    const remote = Array.from({ length: n - 1 }, (_, i) => `line${i}`).join("\n") + "\nREMOTEEND";
    // All three differ, so no early-return short-circuit fires — the size guard is what triggers.
    const { merged, clean } = merge3(base, local, remote);
    expect(clean).toBe(false);
    expect(merged).toBe(local);
  });
});

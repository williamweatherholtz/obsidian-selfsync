// issueConflictDiffHidesIgnoredLineLoss — from a real conflict the owner pasted back.
//
// The diff fed normalizedContent() into unifiedLineDiff. normalizedContent DROPS an ignored
// timestamp line outright, which is correct for a content-identity HASH (a plugin adding `updated:`
// must never cause a conflict) but wrong for a DIFF: when only ONE side has the line, dropping it
// from both makes it invisible. The owner's note had two lines — `created:` and `updated:` — present
// only on the Windows copy, and the rendered diff did not show them at all. So "Keep the other
// device's" would have silently deleted them, with nothing on screen saying so, on an IRREVERSIBLE
// either-side choice.
//
// maskedForDisplay masks the VALUE instead of removing the line: equal timestamps still compare
// equal (the whole point of the ignore setting) while a line present on one side only still shows.
import { describe, it, expect } from "vitest";
import { maskedForDisplay, normalizedContent, IGNORED_TS_PLACEHOLDER } from "../src/frontmatter";
import { unifiedLineDiff } from "../src/noteconflict";

const KEYS = ["created", "updated", "modified"];

// The owner's actual conflict, reduced to the frontmatter that matters.
const THEIRS = [
  "---",
  "icon: package",
  "tagNames: ", // trailing space — the other device's YAML writer emits one for an empty value
  "savedViews: []",
  "---",
].join("\n");
const MINE = [
  "---",
  "icon: package",
  "tagNames:", // no trailing space
  "savedViews: []",
  "created: 2026-04-01T14:54",  // present ONLY on this device
  "updated: 2026-06-08T09:40",  // present ONLY on this device
  "---",
].join("\n");

describe("ignored timestamp lines in the conflict diff", () => {
  it("normalizedContent DROPS the lines — correct for a hash, and why the diff hid them", () => {
    expect(normalizedContent(MINE, KEYS)).not.toContain("created:");
    expect(normalizedContent(MINE, KEYS)).not.toContain("updated:");
    // both sides hash the same apart from the trailing space, which is the established policy
    expect(normalizedContent(MINE, KEYS)).not.toContain("2026-04-01");
  });

  it("maskedForDisplay KEEPS the lines and masks only the value", () => {
    const m = maskedForDisplay(MINE, KEYS);
    expect(m).toContain(`created: ${IGNORED_TS_PLACEHOLDER}`);
    expect(m).toContain(`updated: ${IGNORED_TS_PLACEHOLDER}`);
    expect(m).not.toContain("2026-04-01T14:54"); // the noisy value is gone
    expect(m).not.toContain("2026-06-08T09:40");
  });

  it("the diff now SHOWS that keeping the other version deletes created: and updated:", () => {
    const d = unifiedLineDiff(maskedForDisplay(THEIRS, KEYS), maskedForDisplay(MINE, KEYS));
    const added = d.filter((l) => l.sign === "+").map((l) => l.text);
    expect(added).toContain(`created: ${IGNORED_TS_PLACEHOLDER}`);
    expect(added).toContain(`updated: ${IGNORED_TS_PLACEHOLDER}`);
  });

  it("the OLD transform hid exactly that — the bug this test locks out", () => {
    const d = unifiedLineDiff(normalizedContent(THEIRS, KEYS), normalizedContent(MINE, KEYS));
    expect(d.some((l) => l.text.includes("created"))).toBe(false); // invisible, as reported
  });

  it("a timestamp that merely CHANGED on both sides is still not a change", () => {
    const a = "---\nupdated: 2026-01-01T00:00\n---\nbody";
    const b = "---\nupdated: 2026-09-07T12:34\n---\nbody";
    const d = unifiedLineDiff(maskedForDisplay(a, KEYS), maskedForDisplay(b, KEYS));
    expect(d.filter((l) => l.sign !== " ")).toEqual([]); // the ignore setting still works
  });

  it("a NON-timestamp value under an ignored key is left alone (value-shape gate)", () => {
    const a = "---\nupdated: not-a-date\n---\nbody";
    expect(maskedForDisplay(a, KEYS)).toContain("updated: not-a-date");
  });

  it("with no ignore patterns configured, nothing is masked at all", () => {
    expect(maskedForDisplay(MINE, [])).toContain("created: 2026-04-01T14:54");
  });

  it("body text is never touched — only lines inside the frontmatter fences", () => {
    const withBody = "---\nupdated: 2026-01-01T00:00\n---\nupdated: 2026-01-01T00:00\n";
    const out = maskedForDisplay(withBody, KEYS);
    expect(out.split("\n")[1]).toBe(`updated: ${IGNORED_TS_PLACEHOLDER}`); // in frontmatter → masked
    expect(out.split("\n")[3]).toBe("updated: 2026-01-01T00:00");          // in body → untouched
  });
});

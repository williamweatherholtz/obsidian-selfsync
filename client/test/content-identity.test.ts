// Content-identity normalisation: the two ROOT CAUSES of recurring phantom conflicts.
//
// (1) issueFrontmatterTrailingSpaceConflictLoop — two devices whose plugin versions serialise an
//     empty YAML value differently (`tagNames: ` vs `tagNames:`) produced semantically identical
//     files that identity called divergent, regenerating the same conflict on every rewrite.
// (2) issueContentIdentityNotUnicodeNormalised — NFC vs NFD text that renders identically counted as
//     a divergence, the classic macOS-vs-Windows trap.
//
// The CRITICAL boundary: trailing whitespace is stripped ONLY inside the frontmatter fences. In
// Markdown body text two trailing spaces are a HARD LINE BREAK — real content that must survive.
//
// NO HASH MIGRATION IS NEEDED, and the last test here is what pins that: nothing in the client ever
// computes or stores BaseEntry.normHash (setBase writes { hash, text? } only), so the base side of
// every comparison is recomputed from the stored base TEXT at comparison time. Both sides therefore
// move together when this function changes. If someone ever starts PERSISTING normHash, that test
// fails and a migration becomes real.
import { describe, it, expect } from "vitest";
import { normalizedContent, normalizedHash } from "../src/frontmatter";
import { BaseStore } from "../src/base";

const KEYS = ["created", "updated"];
const enc = (s: string) => new TextEncoder().encode(s);
const sameIdentity = async (a: string, b: string, keys: readonly string[] = []) =>
  (await normalizedHash(enc(a), keys)) === (await normalizedHash(enc(b), keys));

describe("content identity: frontmatter trailing whitespace", () => {
  it("treats `key: ` and `key:` inside frontmatter as the SAME (both are null in YAML)", () => {
    const withSpace = "---\ntagNames: \nexcludes: \n---\nbody";
    const without = "---\ntagNames:\nexcludes:\n---\nbody";
    expect(normalizedContent(withSpace)).toBe(normalizedContent(without));
  });

  it("the owner's real conflict becomes identity-equal, so it would never be generated", async () => {
    // Reduced from the pasted conflict: six empty keys, trailing space on one device only.
    const theirs = [
      "---", "icon: package",
      "tagNames: ", "filesPaths: ", "bookmarksGroups: ", "excludes: ", "extends: ",
      "savedViews: []", "favoriteView: ",
      "---", "",
    ].join("\n");
    const mine = [
      "---", "icon: package",
      "tagNames:", "filesPaths:", "bookmarksGroups:", "excludes:", "extends:",
      "savedViews: []", "favoriteView:",
      "---", "",
    ].join("\n");
    expect(await sameIdentity(theirs, mine)).toBe(true);
  });

  it("a trailing space in the BODY is preserved — it is a Markdown hard line break", async () => {
    const hardBreak = "---\na: 1\n---\nline one  \nline two";
    const noBreak = "---\na: 1\n---\nline one\nline two";
    expect(normalizedContent(hardBreak)).not.toBe(normalizedContent(noBreak));
    expect(await sameIdentity(hardBreak, noBreak)).toBe(false);
  });

  it("a real VALUE difference in frontmatter is still a difference", async () => {
    expect(await sameIdentity("---\nicon: package\n---\nb", "---\nicon: box\n---\nb")).toBe(false);
  });

  it("a note with no frontmatter is unaffected, including its body trailing spaces", () => {
    expect(normalizedContent("line  \nnext")).toBe("line  \nnext");
  });

  it("still masks ignored timestamp keys, and still respects the value-shape gate", async () => {
    expect(await sameIdentity(
      "---\nupdated: 2026-01-01T00:00\n---\nb", "---\nupdated: 2026-09-07T12:34\n---\nb", KEYS,
    )).toBe(true);
    expect(await sameIdentity(
      "---\nupdated: not-a-date\n---\nb", "---\nupdated: other-text\n---\nb", KEYS,
    )).toBe(false); // not timestamp-VALUED → a real difference
  });
});

describe("content identity: Unicode normalisation", () => {
  it("NFC and NFD forms of the same text are the SAME identity", async () => {
    const nfc = "---\ntag: café\n---\ncafé body";          // é precomposed
    const nfd = "---\ntag: café\n---\ncafé body";        // e + combining acute
    expect(nfc).not.toBe(nfd);                                        // genuinely different bytes
    expect(normalizedContent(nfc)).toBe(normalizedContent(nfd));
    expect(await sameIdentity(nfc, nfd)).toBe(true);
  });

  it("genuinely different accented text is still different", async () => {
    expect(await sameIdentity("---\na: 1\n---\ncafé", "---\na: 1\n---\ncafe")).toBe(false);
  });
});

describe("why no hash migration is required", () => {
  it("setBase persists NO normHash, so the base side is always recomputed from stored text", () => {
    // If this ever fails, normHash has started being persisted and a stale-hash migration becomes
    // real: a value stored under an older normalisation would no longer match a fresh computation.
    const store = new BaseStore();
    store.set("n.md", { hash: "abc", text: "---\nk: \n---\nb" });
    const persisted = store.toJSON()["n.md"];
    expect(persisted.normHash).toBeUndefined();
    expect(persisted.text).toBeDefined(); // the text IS kept — that is what gets re-hashed
  });
});

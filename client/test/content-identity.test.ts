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
// NO HASH RESTAMP MIGRATION IS NEEDED — but not for the reason first stated. HEAD never writes a
// cached identity hash (setBase stores { hash, text? }), so the base side of every comparison is
// recomputed from stored TEXT and both sides move together when normalisation changes. However 1.8.x
// DID persist a `normHash`, and reconcile used to TRUST a stored one over recomputation — so legacy
// data.json files carry stale values. The correct fix is not to restamp them but to have no cached
// field at all: the last describe pins that legacy values are stripped on load and never re-saved.
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

describe("no cached identity hash: legacy normHash is dropped, never trusted", () => {
  // HISTORY, because it matters: 1.8.x DID persist a `normHash` (computed under that era's masking).
  // 1.9.0 removed every writer but left the field, toJSON, a load guard, and a read in
  // reconcile.baseNormHash that TRUSTED the stored value over recomputation. So a vault that ran 1.8.x
  // carries stale hashes in data.json today, and after the 1.30.6 normalisation change they are
  // guaranteed to disagree with a fresh computation. (Stale ⇒ mismatch ⇒ a spurious conflict copy: the
  // safe direction, never a wrong delete — equality would need a SHA-256 collision. But it is exactly
  // the phantom-conflict class being eliminated.) The fix is to have NO cached field at all.
  it("a legacy persisted normHash is stripped on load and never re-persisted", () => {
    const legacy = { "n.md": { hash: "abc", text: "---\nk: \n---\nb", normHash: "STALE-1.8.x" } };
    const store = new BaseStore(legacy as any);
    const e = store.get("n.md") as any;
    expect(e.normHash).toBeUndefined();          // gone in memory
    expect(store.toJSON()["n.md"]).not.toHaveProperty("normHash"); // gone on the next save
    expect(store.toJSON()["n.md"].text).toBe("---\nk: \n---\nb"); // the text IS kept — it is re-hashed
  });

  it("the entry type has no cached hash field, so nothing can be read from one", () => {
    const store = new BaseStore();
    store.set("n.md", { hash: "abc", text: "x" });
    expect(Object.keys(store.toJSON()["n.md"]).sort()).toEqual(["hash", "text"]);
  });
});

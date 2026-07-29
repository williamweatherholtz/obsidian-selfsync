import { describe, it, expect } from "vitest";
import { timestampPolicySignature, planBackfillItem } from "../src/timestampBackfill";
import { noteCompliant } from "../src/frontmatter";

const K = ["created", "updated"];

describe("timestampBackfill (pure)", () => {
  it("policy signature changes on keys/excluded, ignores excluded order + is stable", () => {
    expect(timestampPolicySignature(K, ["b", "a"])).toBe(timestampPolicySignature(K, ["a", "b"]));
    expect(timestampPolicySignature(K, ["a"])).not.toBe(timestampPolicySignature(K, ["a", "c"]));
    expect(timestampPolicySignature(["created", "modified"], [])).not.toBe(timestampPolicySignature(K, []));
  });

  it("a compliant note → nothing to do", () => {
    const t = "---\ncreated: 2020-01-01T00:00:00+00:00\nupdated: 2021-01-01T00:00:00+00:00\n---\nb\n";
    expect(planBackfillItem(t, K, 0, 0, 0, 0)).toEqual({ conformed: null, needsCopy: false });
  });

  it("a clean additive stamp → conform seeded from OS metadata, no copy needed", () => {
    const p = planBackfillItem("---\ntitle: T\n---\nb\n", K, Date.UTC(2020, 0, 1), Date.UTC(2021, 0, 1), 0, 0);
    expect(p.conformed).toContain("created: 2020-01-01T00:00:00+00:00");
    expect(p.conformed).toContain("updated: 2021-01-01T00:00:00+00:00");
    expect(p.conformed).toContain("title: T");
    expect(p.needsCopy).toBe(false);
  });

  it("normalizing our own quoted/Z values is a clean conform (fixed point, no copy)", () => {
    const p = planBackfillItem('---\ncreated: "2020-01-01T00:00:00Z"\nupdated: 2021-01-01T00:00:00Z\n---\nb\n', K, 0, 0, 0, 0);
    expect(noteCompliant(p.conformed!, K)).toBe(true);
    expect(p.needsCopy).toBe(false);
  });

  it("a malformed/unterminated note → conform is not provably clean → flagged for a reversible copy", () => {
    const p = planBackfillItem("---\nnot terminated frontmatter\nsome body\n", K, 0, 0, 0, 0);
    expect(p.conformed).not.toBeNull();
    expect(noteCompliant(p.conformed!, K)).toBe(true); // still reaches compliance
    expect(p.needsCopy).toBe(true);                    // but preserve the original — not provably lossless
  });
});

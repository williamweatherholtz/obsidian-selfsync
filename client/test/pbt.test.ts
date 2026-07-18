import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decide, sameIgnoringEol, Presence } from "../src/reconcile";
import { merge3 } from "../src/merge";
import { chunk, sha256hex } from "../src/chunker";
import { mergeEnabledPluginsJson } from "../src/configsync";

// PROPERTY-BASED TESTS (D0030, Anthropic Claude-PBT method). Each property is CURATED against a real
// invariant mined from the code's own WHY-comments — not the implementation restated. Failures were run
// through the reflection loop (genuine bug vs too-strong property). These are permanent regressions over
// the pure, high-criticality (dataLoss/correctness) cores: decide / merge3 / chunker / sameIgnoringEol /
// mergeEnabledPluginsJson. fast-check shrinks any failure to a minimal counterexample.

const enc = (s: string) => new TextEncoder().encode(s);
const crlf = (s: string) => s.replace(/\n/g, "\r\n");
// \r-free multi-line text, so injecting CRLF ourselves is the ONLY EOL variation (clean CRLF-invariance).
const text = fc.array(fc.constantFrom("foo", "bar", "baz", "", "qux one", "  x"), { maxLength: 6 }).map((ls) => ls.join("\n"));
// a small hash alphabet + absent, so L/B/R equality combinations actually collide (exercise every decide branch).
const presence: fc.Arbitrary<Presence> = fc.option(fc.constantFrom("a", "b", "c").map((h) => ({ hash: h })), { nil: null });

describe("PBT: decide() — the reconcile truth table (correctness)", () => {
  it("is total + deterministic (never throws; same inputs → same action)", () => {
    fc.assert(fc.property(presence, presence, presence, (l, b, r) => {
      const a1 = decide(l, b, r); const a2 = decide(l, b, r);
      expect(a1).toBe(a2);
    }));
  });
  it("SAFETY: never returns a destructive delete unless exactly one side is ABSENT", () => {
    fc.assert(fc.property(presence, presence, presence, (l, b, r) => {
      const a = decide(l, b, r);
      if (l !== null && r !== null) expect(a === "delete-local" || a === "delete-remote").toBe(false);
    }));
  });
  it("NO SILENT CLOBBER: both present + diverged + NO common base ⇒ conflict-copy (never pull/push)", () => {
    fc.assert(fc.property(fc.constantFrom("a", "b", "c"), fc.constantFrom("a", "b", "c"), (lh, rh) => {
      fc.pre(lh !== rh);
      expect(decide({ hash: lh }, null, { hash: rh })).toBe("conflict-copy");
    }));
  });
  it("agreement ⇒ in-sync (both equal-present, or both absent)", () => {
    fc.assert(fc.property(fc.constantFrom("a", "b", "c"), (h) => {
      expect(decide({ hash: h }, null, { hash: h })).toBe("in-sync");
    }));
    expect(decide(null, null, null)).toBe("in-sync");
    expect(decide(null, { hash: "a" }, null)).toBe("in-sync"); // both gone, stale base cleared elsewhere
  });
  it("one-sided change routes correctly (base==local ⇒ pull; base==remote ⇒ push)", () => {
    fc.assert(fc.property(fc.constantFrom("a", "b", "c"), fc.constantFrom("a", "b", "c"), (lh, rh) => {
      fc.pre(lh !== rh);
      expect(decide({ hash: lh }, { hash: lh }, { hash: rh })).toBe("pull");   // only remote moved
      expect(decide({ hash: lh }, { hash: rh }, { hash: rh })).toBe("push");   // only local moved
    }));
  });
});

describe("PBT: merge3() — three-way merge (correctness; CRLF class)", () => {
  it("identical edits on both sides ⇒ clean, merged == that content", () => {
    fc.assert(fc.property(text, text, (base, x) => {
      const { merged, clean } = merge3(base, x, x);
      expect(clean).toBe(true);
      expect(merged).toBe(x);
    }));
  });
  it("one-sided change ⇒ clean, adopts the changed side", () => {
    fc.assert(fc.property(text, text, (base, other) => {
      expect(merge3(base, other, base)).toMatchObject({ clean: true, merged: other }); // only local moved
      expect(merge3(base, base, other)).toMatchObject({ clean: true, merged: other }); // only remote moved
    }));
  });
  it("CRLF-INVARIANCE: the merge verdict + LF-normalized content ignore \\n vs \\r\\n (the regression class)", () => {
    fc.assert(fc.property(text, text, text, (base, a, b) => {
      const lf = merge3(base, a, b);
      const cr = merge3(crlf(base), crlf(a), crlf(b));
      expect(cr.clean).toBe(lf.clean);
      expect(cr.merged.replace(/\r\n/g, "\n")).toBe(lf.merged.replace(/\r\n/g, "\n"));
    }));
  });
});

describe("PBT: chunker (integrity)", () => {
  it("ROUND-TRIP: concat(chunk(x)) === x (lossless reassembly)", async () => {
    // Larger inputs + more runs to stress the gear-hash boundary logic (MIN/AVG/MAX chunk sizes).
    await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 40000 }), async (bytes) => {
      const parts = await chunk(bytes);
      const total = parts.reduce((n, p) => n + p.bytes.length, 0);
      const out = new Uint8Array(total);
      let o = 0; for (const p of parts) { out.set(p.bytes, o); o += p.bytes.length; }
      expect(out).toEqual(bytes);
    }), { numRuns: 300 });
  });
  it("is DETERMINISTIC + each chunk hash matches its bytes", async () => {
    await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 5000 }), async (bytes) => {
      const a = await chunk(bytes); const b = await chunk(bytes);
      expect(a.map((c) => c.hash)).toEqual(b.map((c) => c.hash));
      for (const c of a) expect(await sha256hex(c.bytes)).toBe(c.hash);
    }));
  });
});

describe("PBT: sameIgnoringEol (correctness; false-conflict class)", () => {
  it("reflexive + invariant to CRLF and trailing newlines", () => {
    fc.assert(fc.property(text, (x) => {
      expect(sameIgnoringEol(enc(x), enc(x))).toBe(true);
      expect(sameIgnoringEol(enc(x), enc(crlf(x)))).toBe(true);
      expect(sameIgnoringEol(enc(x), enc(x + "\n\n"))).toBe(true);
    }));
  });
});

describe("PBT: mergeEnabledPluginsJson (dataLoss; the disable-vanish class)", () => {
  const ids = fc.uniqueArray(fc.constantFrom("a", "b", "c", "selfsync", "brat", "dataview"), { maxLength: 6 });
  it("GROW-ONLY UNION: result ⊇ local ∪ remote (a sync can never DROP a locally-enabled id), sorted+unique", () => {
    fc.assert(fc.property(ids, ids, (l, r) => {
      const res = mergeEnabledPluginsJson(JSON.stringify(l), JSON.stringify(r));
      expect(res).not.toBeNull();
      const got = JSON.parse(res as string) as string[];
      for (const id of [...l, ...r]) expect(got).toContain(id);          // nothing dropped
      expect(got).toEqual([...new Set(got)].sort());                     // unique + sorted
    }));
  });
  it("idempotent + null on a non-string[] body", () => {
    fc.assert(fc.property(ids, ids, (l, r) => {
      const once = mergeEnabledPluginsJson(JSON.stringify(l), JSON.stringify(r)) as string;
      expect(mergeEnabledPluginsJson(once, once)).toBe(once);
    }));
    expect(mergeEnabledPluginsJson("[1,2,3]", "[]")).toBeNull();  // numbers, not strings
    expect(mergeEnabledPluginsJson("{}", "[]")).toBeNull();       // object, not array
  });
});

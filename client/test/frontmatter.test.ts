import { describe, it, expect } from "vitest";
import {
  hasFrontmatter, getManagedValue, setManagedValue,
  normalizedContent, normalizedHash, formatIsoOffset, parseIso, seedValues, reconcileManagedFields,
  isCanonicalTimestamp, noteCompliant, conformTimestamps,
} from "../src/frontmatter";

const enc = (s: string) => new TextEncoder().encode(s);

describe("frontmatter parse + managed keys", () => {
  const withFm = "---\ntitle: Hi\nupdated: 2026-01-01T00:00:00-06:00\n---\nbody\n";
  it("detects a leading frontmatter block", () => {
    expect(hasFrontmatter(withFm)).toBe(true);
    expect(hasFrontmatter("no fm here\n")).toBe(false);
    expect(hasFrontmatter("text\n---\nnot leading\n")).toBe(false);
  });
  it("reads a managed key value", () => {
    expect(getManagedValue(withFm, "updated")).toBe("2026-01-01T00:00:00-06:00");
    expect(getManagedValue(withFm, "created")).toBeUndefined();
  });
  it("replaces an existing managed key in place, preserving other lines + body", () => {
    const out = setManagedValue(withFm, "updated", "2026-02-02T02:02:02-06:00");
    expect(out).toContain("title: Hi");
    expect(getManagedValue(out, "updated")).toBe("2026-02-02T02:02:02-06:00");
    expect(out.endsWith("body\n")).toBe(true);
  });
  it("inserts a managed key into an existing block at the top", () => {
    const out = setManagedValue(withFm, "created", "2025-12-31T00:00:00-06:00");
    expect(getManagedValue(out, "created")).toBe("2025-12-31T00:00:00-06:00");
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00-06:00");
  });
  it("creates a frontmatter block when none exists, keeping the body", () => {
    const out = setManagedValue("just body\n", "updated", "2026-01-01T00:00:00-06:00");
    expect(hasFrontmatter(out)).toBe(true);
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00-06:00");
    expect(out).toContain("just body");
  });
});

describe("normalized content/hash", () => {
  const a = "---\ntitle: Hi\nupdated: 2026-01-01T00:00:00-06:00\n---\nbody\n";
  const b = "---\ntitle: Hi\nupdated: 2026-09-09T09:09:09-06:00\n---\nbody\n"; // differs ONLY in updated
  it("masks managed keys so timestamp-only diffs normalize equal", () => {
    expect(normalizedContent(a, ["updated"])).toBe(normalizedContent(b, ["updated"]));
  });
  it("a real body change normalizes different", () => {
    const c = a.replace("body", "BODY");
    expect(normalizedContent(a, ["updated"])).not.toBe(normalizedContent(c, ["updated"]));
  });
  it("normalizes CRLF to LF", () => {
    const crlf = a.replace(/\n/g, "\r\n");
    expect(normalizedContent(crlf, ["updated"])).toBe(normalizedContent(a, ["updated"]));
  });
  it("normalizedHash equal for timestamp-only diff", async () => {
    expect(await normalizedHash(enc(a), ["updated"])).toBe(await normalizedHash(enc(b), ["updated"]));
  });
  it("non-frontmatter text passes through unchanged", () => {
    expect(normalizedContent("plain body\n", ["updated"])).toBe("plain body\n");
  });
});

describe("iso offset + seeding", () => {
  it("formats epoch + offset as ISO-8601 with offset", () => {
    // 2026-01-01T00:00:00Z at -06:00 => 2025-12-31T18:00:00-06:00
    expect(formatIsoOffset(Date.UTC(2026, 0, 1, 0, 0, 0), -360)).toBe("2025-12-31T18:00:00-06:00");
    expect(formatIsoOffset(Date.UTC(2026, 0, 1, 0, 0, 0), 0)).toBe("2026-01-01T00:00:00+00:00");
    expect(formatIsoOffset(Date.UTC(2026, 0, 1, 0, 0, 0), 330)).toBe("2026-01-01T05:30:00+05:30");
  });
  it("parseIso round-trips to the same instant", () => {
    const ms = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseIso(formatIsoOffset(ms, -360))).toBe(ms);
    expect(parseIso("not a date")).toBeUndefined();
  });
  it("seedValues uses OS ctime/mtime, not now, when available", () => {
    const ct = Date.UTC(2020, 0, 1), mt = Date.UTC(2021, 5, 15), now = Date.UTC(2026, 0, 1);
    const s = seedValues(ct, mt, now, 0);
    expect(parseIso(s.created)).toBe(ct);
    expect(parseIso(s.updated)).toBe(mt);
  });
  it("seedValues falls back to now when stat is missing", () => {
    const now = Date.UTC(2026, 0, 1);
    const s = seedValues(undefined, undefined, now, 0);
    expect(parseIso(s.created)).toBe(now);
    expect(parseIso(s.updated)).toBe(now);
  });
});

describe("reconcileManagedFields", () => {
  const local = "---\ncreated: 2020-01-01T00:00:00+00:00\nupdated: 2026-01-01T00:00:00+00:00\n---\nbody\n";
  const remote = "---\ncreated: 2019-01-01T00:00:00+00:00\nupdated: 2026-09-09T00:00:00+00:00\n---\nbody\n";
  it("keeps earliest created and older updated", () => {
    const out = reconcileManagedFields(local, remote, ["created", "updated"]);
    expect(getManagedValue(out, "created")).toBe("2019-01-01T00:00:00+00:00"); // earliest
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00+00:00"); // older
  });
  it("takes the present value when one side lacks the key", () => {
    const r2 = "---\ncreated: 2019-01-01T00:00:00+00:00\n---\nbody\n";
    const out = reconcileManagedFields(local, r2, ["created", "updated"]);
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00+00:00"); // from local
  });
});

describe("1.8.0 instant-based compliance + normalizer + alias masking", () => {
  const K = ["created", "updated"];
  it("isCanonicalTimestamp: offset-agnostic; rejects quoted/Z/ms/date-only", () => {
    expect(isCanonicalTimestamp("2026-01-01T00:00:00-06:00")).toBe(true);
    expect(isCanonicalTimestamp("2026-01-01T00:00:00+05:30")).toBe(true);
    expect(isCanonicalTimestamp('"2026-01-01T00:00:00+00:00"')).toBe(false);
    expect(isCanonicalTimestamp("2026-01-01T00:00:00Z")).toBe(false);
    expect(isCanonicalTimestamp("2026-01-01T00:00:00.123+00:00")).toBe(false);
    expect(isCanonicalTimestamp("2026-01-01")).toBe(false);
  });
  it("noteCompliant requires both keys present + canonical", () => {
    expect(noteCompliant("---\ncreated: 2026-01-01T00:00:00+00:00\nupdated: 2026-01-01T00:00:00+00:00\n---\nb\n", K)).toBe(true);
    expect(noteCompliant("---\ncreated: 2026-01-01T00:00:00+00:00\n---\nb\n", K)).toBe(false);
    expect(noteCompliant('---\ncreated: "2026-01-01T00:00:00+00:00"\nupdated: 2026-01-01T00:00:00+00:00\n---\nb\n', K)).toBe(false);
    expect(noteCompliant("no frontmatter\n", K)).toBe(false);
  });
  it("conformTimestamps is a FIXED POINT — output is always compliant + idempotent", () => {
    const now = Date.UTC(2026, 6, 1), ct = Date.UTC(2020, 0, 1), mt = Date.UTC(2021, 0, 1);
    for (const input of [
      "no frontmatter body\n",
      "---\ntitle: T\n---\nbody\n",
      '---\ncreated: "2026-01-01T00:00:00+00:00"\nupdated: 2026-01-01T00:00:00Z\n---\nb\n',
      "---\ncreated: garbage\nupdated: 2026-01-01\n---\nb\n",
      "---\ncreated: 2020-01-01T00:00:00+00:00\nupdated: 2021-01-01T00:00:00+00:00\n---\nb\n",
    ]) {
      const out = conformTimestamps(input, K, ct, mt, now, 0);
      expect(noteCompliant(out, K)).toBe(true);
      expect(conformTimestamps(out, K, ct, mt, now, 0)).toBe(out);
    }
  });
  it("conform re-emits an existing valid instant canonically (Z -> +00:00, same instant), never bumps", () => {
    const out = conformTimestamps("---\nupdated: 2026-01-01T00:00:00Z\ncreated: 2019-01-01T00:00:00Z\n---\nb\n", K, undefined, undefined, 0, 0);
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00+00:00");
    expect(getManagedValue(out, "created")).toBe("2019-01-01T00:00:00+00:00");
  });
  it("conform seeds a missing key from OS metadata, not now", () => {
    const out = conformTimestamps("---\ntitle: T\n---\nb\n", K, Date.UTC(2020, 0, 1), Date.UTC(2021, 0, 1), Date.UTC(2026, 0, 1), 0);
    expect(getManagedValue(out, "created")).toBe("2020-01-01T00:00:00+00:00");
    expect(getManagedValue(out, "updated")).toBe("2021-01-01T00:00:00+00:00");
  });
  it("normalizedContent masks third-party alias keys (Linter-loop fix)", () => {
    const a = "---\ntitle: T\ndate modified: 2026-01-01T00:00:00\nupdated: 2026-01-01T00:00:00+00:00\n---\nb\n";
    const b = "---\ntitle: T\ndate modified: 2026-09-09T09:09:09\nupdated: 2026-05-05T00:00:00+00:00\n---\nb\n";
    expect(normalizedContent(a, K)).toBe(normalizedContent(b, K));
  });
});

describe("1.7.1 parser safety — block scalars / BOM / CRLF / order preservation", () => {
  it("does NOT false-close frontmatter on a --- inside a block scalar (Finding 1 — corruption)", () => {
    const note = "---\ndescription: |\n  intro\n  ---\n  more\ntitle: Real Title\ntags: [a, b]\n---\nbody\n";
    const out = setManagedValue(note, "updated", "2026-01-01T00:00:00-06:00");
    expect(getManagedValue(out, "title")).toBe("Real Title"); // still in frontmatter, not demoted to body
    expect(getManagedValue(out, "tags")).toBe("[a, b]");
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00-06:00");
    expect(out).toContain("  more"); // block-scalar content preserved
  });
  it("preserves a leading BOM (Finding 5)", () => {
    const note = "﻿---\ntitle: T\n---\nbody\n";
    const out = setManagedValue(note, "updated", "x");
    expect(out.charCodeAt(0)).toBe(0xFEFF);
    expect(getManagedValue(out, "updated")).toBe("x");
    expect(getManagedValue(out, "title")).toBe("T");
  });
  it("preserves CRLF line endings (Finding 5)", () => {
    const note = "---\r\ntitle: T\r\n---\r\nbody\r\n";
    const out = setManagedValue(note, "updated", "x");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n"); // every LF is part of a CRLF — none introduced bare
    expect(getManagedValue(out, "updated")).toBe("x");
    expect(getManagedValue(out, "title")).toBe("T");
  });
  it("preserves the user's existing key order (Finding 5)", () => {
    const note = "---\ntitle: T\nauthor: me\n---\nbody\n";
    const out = setManagedValue(note, "updated", "x");
    const fm = out.slice(0, out.indexOf("body"));
    expect(fm.indexOf("title")).toBeLessThan(fm.indexOf("author")); // user's order intact
    expect(getManagedValue(out, "updated")).toBe("x");
  });
  it("round-trips and is byte-stable on re-set (no drift / no churn)", () => {
    const note = "---\ntitle: T\n---\nbody line\nmore\n";
    const out = setManagedValue(note, "updated", "2026-01-01T00:00:00+00:00");
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00+00:00");
    expect(out).toContain("title: T");
    expect(out).toContain("body line\nmore");
    expect(setManagedValue(out, "updated", "2026-01-01T00:00:00+00:00")).toBe(out); // idempotent bytes
  });
});

describe("critique fixes — CRLF / quotes / duplicates / cross-device determinism", () => {
  it("reads and rewrites managed keys on CRLF notes without duplicating (F4)", () => {
    const crlf = "---\r\ntitle: Hi\r\nupdated: 2026-01-01T00:00:00-06:00\r\n---\r\nbody\r\n";
    expect(getManagedValue(crlf, "updated")).toBe("2026-01-01T00:00:00-06:00");
    const out = setManagedValue(crlf, "updated", "2026-02-02T00:00:00-06:00");
    expect(getManagedValue(out, "updated")).toBe("2026-02-02T00:00:00-06:00");
    expect((out.match(/updated:/g) || []).length).toBe(1); // no duplicate key
  });
  it("parseIso strips YAML quotes (F5)", () => {
    const ms = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseIso('"2026-01-01T00:00:00+00:00"')).toBe(ms);
    expect(parseIso("'2026-01-01T00:00:00+00:00'")).toBe(ms);
  });
  it("setManagedValue collapses pre-existing duplicate keys to one (F6)", () => {
    const dup = "---\nupdated: 2020-01-01T00:00:00+00:00\ntitle: T\nupdated: 2021-01-01T00:00:00+00:00\n---\nbody\n";
    const out = setManagedValue(dup, "updated", "2026-01-01T00:00:00+00:00");
    expect((out.match(/updated:/g) || []).length).toBe(1);
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00+00:00");
  });
  it("keyOf handles no-space-after-colon and rejects indented (nested) keys (F13)", () => {
    expect(getManagedValue("---\nupdated:2026-01-01T00:00:00+00:00\n---\nb\n", "updated")).toBe("2026-01-01T00:00:00+00:00");
    expect(getManagedValue("---\nmeta:\n  updated: 2026-01-01T00:00:00+00:00\n---\nb\n", "updated")).toBeUndefined();
  });
  it("reconcileManagedFields is deterministic across devices — no ping-pong (F2)", () => {
    const keys = ["updated"];
    const a = "---\nupdated: 2026-01-01T00:00:00+00:00\n---\nbody\n";
    const b = "---\nupdated: 2026-01-01T01:00:00+01:00\n---\nbody\n"; // SAME instant, different offset string
    const ab = getManagedValue(reconcileManagedFields(a, b, keys), "updated");
    const ba = getManagedValue(reconcileManagedFields(b, a, keys), "updated");
    expect(ab).toBe(ba); // both devices converge on the SAME value — no perpetual re-push
    const g = "---\nupdated: not-a-date\n---\nbody\n";
    expect(getManagedValue(reconcileManagedFields(a, g, keys), "updated")).toBe("2026-01-01T00:00:00+00:00");
    expect(getManagedValue(reconcileManagedFields(g, a, keys), "updated")).toBe("2026-01-01T00:00:00+00:00");
  });
});

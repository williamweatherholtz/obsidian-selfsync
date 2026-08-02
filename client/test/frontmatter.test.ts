import { describe, it, expect } from "vitest";
import {
  hasFrontmatter, getManagedValue,
  normalizedContent, normalizedHash,
  isCanonicalTimestamp, isTimestampValue,
  DEFAULT_IGNORED_TIMESTAMP_KEYS,
} from "../src/frontmatter";

const enc = (s: string) => new TextEncoder().encode(s);

describe("frontmatter parse + read", () => {
  const withFm = "---\ntitle: Hi\nupdated: 2026-01-01T00:00:00-06:00\n---\nbody\n";
  it("detects a leading frontmatter block", () => {
    expect(hasFrontmatter(withFm)).toBe(true);
    expect(hasFrontmatter("no fm here\n")).toBe(false);
    expect(hasFrontmatter("text\n---\nnot leading\n")).toBe(false);
  });
  it("reads a top-level scalar value", () => {
    expect(getManagedValue(withFm, "updated")).toBe("2026-01-01T00:00:00-06:00");
    expect(getManagedValue(withFm, "created")).toBeUndefined();
  });
  it("does NOT read an indented/nested key as top-level", () => {
    expect(getManagedValue("---\nmeta:\n  updated: 2026-01-01T00:00:00+00:00\n---\nb\n", "updated")).toBeUndefined();
  });
});

describe("content identity — always-on EOL/BOM normalization (the CRLF false-positive fix)", () => {
  it("a PLAIN note (no frontmatter) is EOL-normalized — the old short-circuit bug", async () => {
    const lf = "just a plain note\nsecond line\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(normalizedContent(crlf)).toBe(normalizedContent(lf));
    expect(await normalizedHash(enc(crlf))).toBe(await normalizedHash(enc(lf))); // used to differ (raw hash)
  });
  it("a plain note with a leading BOM identifies equal to one without", async () => {
    const plain = "body only\n";
    expect(await normalizedHash(enc("﻿" + plain))).toBe(await normalizedHash(enc(plain)));
  });
  it("multiple trailing newlines collapse (no spurious change)", () => {
    expect(normalizedContent("a\nb\n")).toBe(normalizedContent("a\nb\n\n\n"));
  });
  it("T4: a lone-CR (old Mac) and a final-newline TOGGLE are non-differences — consistent with merge3's sameIgnoringEol", () => {
    expect(normalizedContent("a\rb")).toBe(normalizedContent("a\nb"));   // lone CR normalized (was not)
    expect(normalizedContent("a\nb")).toBe(normalizedContent("a\nb\n")); // 0-vs-1 trailing newline now equal (was a difference)
  });
  it("a real body change still differs", async () => {
    expect(await normalizedHash(enc("hello\n"))).not.toBe(await normalizedHash(enc("HELLO\n")));
  });
  it("binary / non-UTF8 content falls back to the raw hash (still comparable, never throws)", async () => {
    const bin = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    expect(await normalizedHash(bin)).toBe(await normalizedHash(bin));
  });
});

describe("content identity — value-shape-gated timestamp masking", () => {
  const K = DEFAULT_IGNORED_TIMESTAMP_KEYS;
  const a = "---\ntitle: Hi\nupdated: 2026-01-01T00:00:00-06:00\n---\nbody\n";
  const b = "---\ntitle: Hi\nupdated: 2026-09-09T09:09:09-06:00\n---\nbody\n"; // differs ONLY in updated
  it("timestamp-only diff normalizes equal when the feature is on", () => {
    expect(normalizedContent(a, K)).toBe(normalizedContent(b, K));
  });
  it("with NO patterns (feature off), a timestamp diff is a real change", () => {
    expect(normalizedContent(a)).not.toBe(normalizedContent(b));
  });
  it("VALUE-SHAPE GATE: a non-date value on an ignored key is NOT masked (real edit survives)", () => {
    const x = "---\nupdated: reviewed by Alice\n---\nbody\n";
    const y = "---\nupdated: reviewed by Bob\n---\nbody\n";
    expect(normalizedContent(x, K)).not.toBe(normalizedContent(y, K)); // real content change, still synced
  });
  it("T1: a BARE-YEAR `created` edit is NOT masked — it still syncs (Date.parse used to eat it)", () => {
    const x = "---\ncreated: 2020\n---\nbody\n";
    const y = "---\ncreated: 2021\n---\nbody\n";
    expect(normalizedContent(x, K)).not.toBe(normalizedContent(y, K)); // bare year isn't a timestamp SHAPE → real edit syncs
  });
  it("masks a PER-DEVICE key via the `-*` wildcard (updated-asi-laptop)", () => {
    const p = "---\ntitle: T\nupdated-asi-laptop: 2026-01-01T00:00:00-06:00\n---\nb\n";
    const q = "---\ntitle: T\nupdated-asi-laptop: 2026-09-09T09:09:09-05:00\n---\nb\n";
    expect(normalizedContent(p, K)).toBe(normalizedContent(q, K));
  });
  it("masks Obsidian/Linter alias keys (date modified) when timestamp-valued", () => {
    const p = "---\ntitle: T\ndate modified: 2026-01-01T00:00:00\nupdated: 2026-01-01T00:00:00+00:00\n---\nb\n";
    const q = "---\ntitle: T\ndate modified: 2026-09-09T09:09:09\nupdated: 2026-05-05T00:00:00+00:00\n---\nb\n";
    expect(normalizedContent(p, K)).toBe(normalizedContent(q, K));
  });
  it("a body change is still detected even when timestamps also differ", () => {
    const c = b.replace("body", "BODY");
    expect(normalizedContent(a, K)).not.toBe(normalizedContent(c, K));
  });
  it("does NOT mask a multi-line/list value (it isn't a scalar timestamp) — no false-equal, no orphan lines", () => {
    const p = "---\nupdated:\n  - 2026-01-01\n  - 2026-02-02\n---\nb\n";
    const q = "---\nupdated:\n  - 2026-01-01\n  - 2099-12-31\n---\nb\n";
    expect(normalizedContent(p, K)).not.toBe(normalizedContent(q, K)); // list items differ → real change
  });
  it("normalizedHash agrees with normalizedContent for a timestamp-only diff", async () => {
    expect(await normalizedHash(enc(a), K)).toBe(await normalizedHash(enc(b), K));
  });
});

describe("block-scalar / order safety of the parser (still matters for masking)", () => {
  it("does NOT false-close on a --- inside a block scalar, so real keys aren't demoted+masked", () => {
    const note = "---\ndescription: |\n  intro\n  ---\n  more\nupdated: 2026-01-01T00:00:00-06:00\ntitle: Real\n---\nbody\n";
    // `title` and the block-scalar content must be preserved in the identity; only `updated` is masked.
    const masked = normalizedContent(note, ["updated"]);
    expect(masked).toContain("title: Real");
    expect(masked).toContain("  more");
    expect(masked).not.toContain("2026-01-01T00:00:00-06:00");
  });
});

describe("value-shape helpers", () => {
  it("isCanonicalTimestamp: offset-agnostic; rejects quoted/Z/ms/date-only", () => {
    expect(isCanonicalTimestamp("2026-01-01T00:00:00-06:00")).toBe(true);
    expect(isCanonicalTimestamp("2026-01-01T00:00:00+05:30")).toBe(true);
    expect(isCanonicalTimestamp('"2026-01-01T00:00:00+00:00"')).toBe(false);
    expect(isCanonicalTimestamp("2026-01-01T00:00:00Z")).toBe(false);
    expect(isCanonicalTimestamp("2026-01-01")).toBe(false);
  });
  it("isTimestampValue: ISO date/datetime SHAPES only — NOT bare years/integers (T1/T2, portable, no Date.parse)", () => {
    expect(isTimestampValue("2026-01-01")).toBe(true);
    expect(isTimestampValue("2026-01-01T00:00:00Z")).toBe(true);
    expect(isTimestampValue("2026-01-01T00:00:00-06:00")).toBe(true);
    expect(isTimestampValue("2026-01-01 12:00:00")).toBe(true);          // space separator
    expect(isTimestampValue("2026-01-01T00:00:00.000Z")).toBe(true);     // milliseconds
    expect(isTimestampValue('"2026-01-01"')).toBe(true);                 // quoted date
    expect(isTimestampValue("reviewed by Bob")).toBe(false);
    // The T1/T2 regression: Date.parse accepted these as dates → they were MASKED and stopped syncing.
    expect(isTimestampValue("2020")).toBe(false);                        // bare year (a curated publication year)
    expect(isTimestampValue("5")).toBe(false);                           // a counter
    expect(isTimestampValue("42")).toBe(false);
    expect(isTimestampValue("3.14")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  hasFrontmatter, getManagedValue, setManagedValue,
  normalizedContent, normalizedHash, formatIsoOffset, parseIso, seedValues, reconcileManagedFields,
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

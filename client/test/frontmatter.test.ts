import { describe, it, expect } from "vitest";
import { hasFrontmatter, getManagedValue, setManagedValue } from "../src/frontmatter";

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

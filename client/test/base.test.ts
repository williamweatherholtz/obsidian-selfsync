import { describe, it, expect } from "vitest";
import { BaseStore, conflictCopyName } from "../src/base";

describe("BaseStore", () => {
  it("round-trips entries and serializes", () => {
    const b = new BaseStore();
    b.set("a.md", { hash: "h1", text: "hello" });
    b.set("img.png", { hash: "h2" });
    expect(b.get("a.md")).toEqual({ hash: "h1", text: "hello" });
    expect(b.get("img.png")?.text).toBeUndefined();
    const b2 = new BaseStore(b.toJSON());
    expect(b2.get("a.md")?.hash).toBe("h1");
    b2.delete("a.md");
    expect(b2.get("a.md")).toBeUndefined();
  });

  it("R15 sync#3: the (size,mtime) scan-skip hint is NOT persisted by toJSON (session-only)", () => {
    const b = new BaseStore();
    b.set("a.md", { hash: "h1", text: "hi" });
    b.stampStat("a.md", 123, 456);
    // In-memory the hint is present (drives the in-session scan-skip)…
    expect(b.get("a.md")).toMatchObject({ size: 123, mtime: 456 });
    // …but toJSON (what persists to data.json) carries only hash + text, so a stale stamp can't
    // survive a restart and weaken the missed-event backstop.
    const j = b.toJSON()["a.md"] as Record<string, unknown>;
    expect(j).toEqual({ hash: "h1", text: "hi" });
    expect(j.size).toBeUndefined();
    expect(j.mtime).toBeUndefined();
  });
});

describe("conflictCopyName", () => {
  it("inserts a conflict marker (14-digit timestamp) before the extension", () => {
    const when = new Date(Date.UTC(2026, 10, 28, 14, 30, 5));
    expect(conflictCopyName("notes/meeting.md", "Laptop", when)).toMatch(/^notes\/meeting \(conflict Laptop \d{14}\)\.md$/);
  });
  it("handles a dotless filename", () => {
    expect(conflictCopyName("README", "Phone", new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toMatch(/^README \(conflict Phone \d{14}\)$/);
  });
  it("H4: two conflicts on the same path/device in the same minute get DISTINCT names (no overwrite)", () => {
    const when = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)); // same instant
    const a = conflictCopyName("n.md", "Dev", when, "aaaaaa");
    const b = conflictCopyName("n.md", "Dev", when, "bbbbbb");
    expect(a).not.toBe(b);                 // content tag disambiguates
    expect(a).toContain("-aaaaaa");
    expect(b).toContain("-bbbbbb");
  });
});

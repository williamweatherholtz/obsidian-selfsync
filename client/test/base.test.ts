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
});

describe("conflictCopyName", () => {
  it("inserts a conflict marker before the extension", () => {
    const when = new Date(Date.UTC(2026, 10, 28, 14, 30));
    expect(conflictCopyName("notes/meeting.md", "Laptop", when)).toMatch(/^notes\/meeting \(conflict Laptop \d{12}\)\.md$/);
  });
  it("handles a dotless filename", () => {
    expect(conflictCopyName("README", "Phone", new Date(Date.UTC(2026, 0, 1, 0, 0)))).toMatch(/^README \(conflict Phone \d{12}\)$/);
  });
});

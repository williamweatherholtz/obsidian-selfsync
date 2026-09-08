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

  // REVERSED (issueNormHashDeadPersistedField): this used to assert normHash round-trips through
  // toJSON/reload. 1.8.x wrote it; 1.9.0 removed every writer but left the field, and reconcile TRUSTED a
  // stored value over recomputation — a staleness trap, since the hash depends on both the user's
  // ignore keys and the normalisation algorithm (changed in 1.30.6). There is now no cached field: a
  // legacy value in a persisted blob is stripped on load and never saved again.
  it("DROPS a legacy 1.8.x normHash on load and never re-persists it", () => {
    const json = { "n.md": { hash: "raw1", text: "t", normHash: "stale-from-1.8" } };
    const s2 = new BaseStore(json as any);
    expect((s2.get("n.md") as any)?.normHash).toBeUndefined();
    expect(s2.toJSON()["n.md"]).not.toHaveProperty("normHash");
    expect(s2.get("n.md")?.hash).toBe("raw1"); // the real identity fields survive
    expect(s2.get("n.md")?.text).toBe("t");
  });

  it("PERSISTS the (size,mtime) scan-skip hint through toJSON/reload so a reload skips re-hashing (issueScanSkipHintNotPersisted)", () => {
    // Reverses R15 sync#3: dropping the hint made EVERY reload re-hash the whole vault (owner field report).
    // Now the hint is persisted (same rsync/Syncthing heuristic the in-session skip uses, spanning restarts).
    const b = new BaseStore();
    b.set("a.md", { hash: "h1", text: "hi" });
    b.stampStat("a.md", 123, 456);
    expect(b.get("a.md")).toMatchObject({ size: 123, mtime: 456 });
    const j = b.toJSON()["a.md"] as Record<string, unknown>;
    expect(j).toMatchObject({ hash: "h1", text: "hi", size: 123, mtime: 456 });
    // …and it survives a real serialize→reload round-trip (data.json shape).
    const reloaded = new BaseStore(JSON.parse(JSON.stringify(b.toJSON())));
    expect(reloaded.get("a.md")).toMatchObject({ hash: "h1", size: 123, mtime: 456 });
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

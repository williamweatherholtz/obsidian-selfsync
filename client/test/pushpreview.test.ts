import { describe, it, expect } from "vitest";
import { classifyPushPull, countChanges, touchedCount, lineDiff } from "../src/pushpreview";

// classifyPushPull must mirror resolveConfigConflict EXACTLY (reconcile.ts): the SOURCE side wins and the
// TARGET is overwritten. push => local is the source; pull => server is the source.
describe("classifyPushPull — what an authoritative overwrite does to each file", () => {
  const L = (hash?: string) => ({ present: true, hash });   // local present (with/without a known hash)
  const S = (hash?: string) => ({ present: true, hash });   // server present
  const absent = { present: false };
  const files = [
    { path: "same.json", local: L("h1"), server: S("h1") }, // equal both sides
    { path: "diff.json", local: L("hL"), server: S("hS") }, // differ
    { path: "localonly.json", local: L("hL"), server: absent },   // only local
    { path: "serveronly.json", local: absent, server: S("hS") },  // only server
  ];
  it("PUSH: local wins → server-absent=add, differ=overwrite, local-absent=remove, equal=unchanged", () => {
    const m = new Map(classifyPushPull(files, "push").map((c) => [c.path, c.op]));
    expect(m.get("same.json")).toBe("unchanged");
    expect(m.get("diff.json")).toBe("overwrite");
    expect(m.get("localonly.json")).toBe("create");  // local has it, server doesn't → created on server
    expect(m.get("serveronly.json")).toBe("delete"); // local lacks it → removed from server (matches resolveConfigConflict deleteFile)
  });
  it("PULL: server wins → local-absent=add, differ=overwrite, server-absent=remove, equal=unchanged", () => {
    const m = new Map(classifyPushPull(files, "pull").map((c) => [c.path, c.op]));
    expect(m.get("same.json")).toBe("unchanged");
    expect(m.get("diff.json")).toBe("overwrite");
    expect(m.get("serveronly.json")).toBe("create"); // server has it, local doesn't → created here
    expect(m.get("localonly.json")).toBe("delete");  // server lacks it → removed here (matches io.remove on null fileMeta)
  });
  it("a present-but-UNREAD (large) side is conservatively an overwrite, never a false 'unchanged'", () => {
    const both = [{ path: "big.json", local: { present: true }, server: S("hS") }]; // local present, hash unknown
    expect(classifyPushPull(both, "push")[0].op).toBe("overwrite");
    expect(classifyPushPull(both, "pull")[0].op).toBe("overwrite");
  });
  it("an unreadable local file on PULL is an overwrite (present target), not a false 'add' (crit finding 3)", () => {
    // The caller sets local.present=true for a pull target even when it couldn't hash it (applyPull overwrites).
    const f = [{ path: "x.json", local: { present: true }, server: S("hS") }];
    expect(classifyPushPull(f, "pull")[0].op).toBe("overwrite"); // NOT "create"
  });
  it("counts + touched: touched excludes unchanged; counts tally each op", () => {
    const ch = classifyPushPull(files, "push");
    expect(countChanges(ch)).toEqual({ overwrite: 1, create: 1, delete: 1, unchanged: 1 });
    expect(touchedCount(ch)).toBe(3);
  });
  it("an already-in-sync folder is all-unchanged → 0 touched (the disabled-confirm case)", () => {
    const ch = classifyPushPull([{ path: "a", local: L("x"), server: S("x") }], "push");
    expect(touchedCount(ch)).toBe(0);
  });
});

describe("lineDiff — target(old) → source(new)", () => {
  it("identical text → all context, no add/del", () => {
    const d = lineDiff("a\nb\nc", "a\nb\nc")!;
    expect(d.every((l) => l.type === "ctx")).toBe(true);
  });
  it("an added line is +, a removed line is -", () => {
    const d = lineDiff("a\nc", "a\nb\nc")!;
    expect(d).toEqual([{ type: "ctx", text: "a" }, { type: "add", text: "b" }, { type: "ctx", text: "c" }]);
    const d2 = lineDiff("a\nb\nc", "a\nc")!;
    expect(d2).toEqual([{ type: "ctx", text: "a" }, { type: "del", text: "b" }, { type: "ctx", text: "c" }]);
  });
  it("create (empty old) → all adds; delete (empty new) → all dels", () => {
    expect(lineDiff("", "x\ny")!).toEqual([{ type: "add", text: "x" }, { type: "add", text: "y" }]);
    expect(lineDiff("x\ny", "")!).toEqual([{ type: "del", text: "x" }, { type: "del", text: "y" }]);
  });
  it("a changed value shows as a paired del+add (the common data.json case)", () => {
    const d = lineDiff('{\n  "k": 1\n}', '{\n  "k": 2\n}')!;
    expect(d.some((l) => l.type === "del" && l.text.includes('"k": 1'))).toBe(true);
    expect(d.some((l) => l.type === "add" && l.text.includes('"k": 2'))).toBe(true);
  });
  it("returns null (→ caller shows 'too large') past the line cap", () => {
    const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join("\n");
    const big2 = Array.from({ length: 1500 }, (_, i) => `LINE ${i}`).join("\n");
    expect(lineDiff(big, big2)).toBeNull();
  });
});

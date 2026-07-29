import { describe, it, expect } from "vitest";
import { normalizeFolder, addExcluded, removeExcluded, isExcluded, matchFolders } from "../src/excludedFolders";

describe("excludedFolders (pure)", () => {
  it("normalizeFolder trims, strips slashes, collapses dup separators", () => {
    expect(normalizeFolder("  /Work/Archive/ ")).toBe("Work/Archive");
    expect(normalizeFolder("A//B")).toBe("A/B");
    expect(normalizeFolder("/")).toBe("");
  });
  it("add/remove are set-semantics + sorted, normalized", () => {
    expect(addExcluded([], "/Work/")).toEqual(["Work"]);
    expect(addExcluded(["Work"], "work")).toEqual(["Work", "work"]); // case-sensitive paths, distinct
    expect(addExcluded(["B", "A"], "A")).toEqual(["A", "B"]); // dedup + sort, no dup
    expect(removeExcluded(["A", "B"], "/A/")).toEqual(["B"]);
  });
  it("isExcluded matches a folder and everything under it, at boundaries only", () => {
    expect(isExcluded("Work/note.md", ["Work"])).toBe(true);
    expect(isExcluded("Work/Sub/n.md", ["Work"])).toBe(true);
    expect(isExcluded("Work", ["Work"])).toBe(true);
    expect(isExcluded("Workshop/n.md", ["Work"])).toBe(false); // prefix but not a folder boundary
    expect(isExcluded("Other/n.md", ["Work"])).toBe(false);
    expect(isExcluded("a/b.md", [])).toBe(false);
  });
  it("isExcluded is case-insensitive (F7 — Windows/macOS filesystems)", () => {
    expect(isExcluded("work/note.md", ["Work"])).toBe(true);
    expect(isExcluded("WORK/Sub/n.md", ["work"])).toBe(true);
    expect(isExcluded("Other/n.md", ["Work"])).toBe(false);
  });
  it("matchFolders ranks case-insensitively, prefix before substring", () => {
    const all = ["Archive", "Work", "Work/Archive", "Notes/Work"];
    expect(matchFolders("work", all)).toEqual(["Work", "Work/Archive", "Notes/Work"]);
    expect(matchFolders("", all)).toEqual(all);
  });
});

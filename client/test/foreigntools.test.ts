import { describe, it, expect } from "vitest";
import { foreignArtefact, isForeignArtefact, summarizeForeign, describeForeign } from "../src/foreigntools";

// SR-47 / UCA-52: another sync tool's bookkeeping is recognised (and only the UNAMBIGUOUS shapes are), so it is
// never synced as content and never read as a deletion. Pure + total.
describe("foreigntools — classifier", () => {
  it("recognises Syncthing conflict copies, its folder marker, ignore file and version tree", () => {
    expect(foreignArtefact("Notes/plan.sync-conflict-20260907-101500-ABCDEFG.md")).toEqual({ tool: "Syncthing", kind: "conflictCopy" });
    expect(foreignArtefact("plan.sync-conflict-20260907-101500-A1B2C3D")).toEqual({ tool: "Syncthing", kind: "conflictCopy" }); // no extension
    expect(foreignArtefact(".stfolder")).toEqual({ tool: "Syncthing", kind: "marker" });
    expect(foreignArtefact(".stfolder/syncthing-folder-marker")).toEqual({ tool: "Syncthing", kind: "marker" });
    expect(foreignArtefact(".stignore")).toEqual({ tool: "Syncthing", kind: "marker" });
    expect(foreignArtefact(".stversions/Notes/plan~20260907-101500.md")).toEqual({ tool: "Syncthing", kind: "versions" });
  });
  it("recognises Dropbox / Nextcloud conflicted copies and Dropbox's cache, Resilio's marker, iCloud placeholders, Office locks", () => {
    expect(foreignArtefact("a/b (conflicted copy 2026-09-07).md")).toEqual({ tool: "Dropbox", kind: "conflictCopy" });
    expect(foreignArtefact("a/b (Alice's conflicted copy 2026-09-07).md")).toEqual({ tool: "Dropbox", kind: "conflictCopy" });
    expect(foreignArtefact("a/b (conflicted copy 2026-09-07 101500).md")).toEqual({ tool: "Nextcloud", kind: "conflictCopy" });
    expect(foreignArtefact(".dropbox.cache/x")).toEqual({ tool: "Dropbox", kind: "versions" });
    expect(foreignArtefact(".dropbox")).toEqual({ tool: "Dropbox", kind: "marker" });
    expect(foreignArtefact(".sync/Archive/plan.md")).toEqual({ tool: "Resilio Sync", kind: "marker" });
    expect(foreignArtefact("Attachments/.photo.jpg.icloud")).toEqual({ tool: "iCloud Drive", kind: "placeholder" });
    expect(foreignArtefact("docs/~$budget.docx")).toEqual({ tool: "Office", kind: "lock" });
    expect(foreignArtefact("docs/.~lock.budget.odt#")).toEqual({ tool: "Office", kind: "lock" });
  });
  it("does NOT classify ordinary notes, SelfSync's own conflict copies, or ambiguous shapes (a false positive would un-sync a real note)", () => {
    for (const p of [
      "plan.md", "Notes/2026-09-07 meeting.md", "sync-conflict.md", "plan (1).md", "plan-DESKTOP-ABC123.md", "plan 2.md",
      "plan (conflict 2026-09-07 Laptop).md",         // SelfSync's own copy naming — that IS content we manage
      "plan (this device's version 2026-09-07).md",  // Keep-both output — ours
      "stfolder/x.md", "my.dropbox.notes.md", "icloud.md", "~notes.md", "conflicted copy.md",
      "plan.sync-conflict-2026-09-07.md",             // wrong Syncthing shape
    ]) expect(foreignArtefact(p), p).toBeNull();
    expect(isForeignArtefact("")).toBe(false);
  });
});

describe("foreigntools — summary for the settings row", () => {
  it("counts per tool and names them; empty when nothing is foreign", () => {
    const s = summarizeForeign(["a.md", ".stfolder", "b.sync-conflict-20260907-101500-ABCDEFG.md", "c (conflicted copy 2026-09-07).md"]);
    expect(s.skipped).toBe(3);
    expect(s.tools).toEqual(["Dropbox", "Syncthing"]);
    expect(s.byTool).toEqual({ Syncthing: 2, Dropbox: 1 });
    expect(describeForeign(s)).toBe("Dropbox (1 file), Syncthing (2 files) detected — their files are left to that tool and not synced");
    expect(describeForeign(summarizeForeign(["a.md"]))).toBe("");
    expect(describeForeign(summarizeForeign([".stfolder"]))).toContain("its file is left to that tool");
  });
});

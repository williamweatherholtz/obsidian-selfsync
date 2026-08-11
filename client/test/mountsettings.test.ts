import { describe, it, expect } from "vitest";
import { sourceOptions, mountRowLabel, mountStateLabel, validateMountDraft, foldersWithContent, sourcePathNote } from "../src/mountsettings";
import { Mount } from "../src/mounts";
import { SharedVaultRef } from "../src/transport";

describe("foldersWithContent — the source subfolder picker's real options (composedMountPathUx)", () => {
  it("derives distinct ancestor folders from file paths, excluding .obsidian + root files", () => {
    expect(foldersWithContent([
      "A/note1.md", "A/note1 1.md", "A/sub/deep.md",
      "Welcome.md", "note.md",                              // root files → no folder
      ".obsidian/app.json", ".obsidian/plugins/x/main.js",  // config tree → not mountable
      "Projects/Shared/y.md",
    ])).toEqual(["A", "A/sub", "Projects", "Projects/Shared"]);
  });
  it("an EMPTY folder never appears — it has no files, so it is never offered (the signal the owner needed)", () => {
    expect(foldersWithContent(["A/note.md", "Welcome.md"])).toEqual(["A"]); // B is empty → absent
  });
});

describe("sourcePathNote — non-blocking warning for an empty/nonexistent subfolder", () => {
  const folders = ["A", "Projects", "Projects/Shared"];
  it("no note for the whole vault (blank) or a folder that has content (case-insensitive)", () => {
    expect(sourcePathNote("", folders)).toBeNull();
    expect(sourcePathNote("A", folders)).toBeNull();
    expect(sourcePathNote("projects/shared", folders)).toBeNull();
  });
  it("warns for an empty/nonexistent folder (the silent-empty-mount trap the owner hit with B)", () => {
    expect(sourcePathNote("B", folders)).toMatch(/No notes under .B./);
    expect(sourcePathNote("B/", folders)).toMatch(/No notes under .B./); // normalized before the compare
  });
});

const mk = (mountPoint: string, vaultId = "asi", sourcePath = "", owner = "", direction: "pull" | "sync" = "pull"): Mount =>
  ({ source: { owner, vaultId, sourcePath }, mountPoint, direction });

describe("sourceOptions — candidate source vaults", () => {
  it("lists my own vaults + shared-to-me vaults, EXCLUDING the primary, marking write permission", () => {
    const mine = ["personal", "asi", "archive"];
    const shared: SharedVaultRef[] = [
      { owner: "alice", vault: "team", perm: "readWrite" },
      { owner: "bob", vault: "readonly", perm: "read" },
    ];
    const opts = sourceOptions(mine, shared, { owner: "", vaultId: "personal" }); // primary = my own "personal"
    expect(opts).toEqual([
      { owner: "", vaultId: "asi", label: "asi", canWrite: true },
      { owner: "", vaultId: "archive", label: "archive", canWrite: true },
      { owner: "alice", vaultId: "team", label: "alice/team", canWrite: true },   // readWrite → sync allowed
      { owner: "bob", vaultId: "readonly", label: "bob/readonly", canWrite: false }, // read → pull only
    ]);
  });
  it("excludes a SHARED primary vault by owner+id (not just id)", () => {
    const opts = sourceOptions(["asi"], [{ owner: "alice", vault: "team", perm: "readWrite" }], { owner: "alice", vaultId: "team" });
    expect(opts.map((o) => o.label)).toEqual(["asi"]); // the shared primary alice/team excluded; a same-named own vault would NOT be
  });
});

describe("mountRowLabel", () => {
  it("renders own-vault subfolder and shared whole-vault forms", () => {
    expect(mountRowLabel(mk("Work/ASI", "asi", "Projects"))).toBe("asi/Projects  →  Work/ASI");
    expect(mountRowLabel(mk("Refs", "team", "", "alice"))).toBe("alice/team (whole vault)  →  Refs");
  });
});

describe("mountStateLabel", () => {
  it("maps each FSM state to human text", () => {
    expect(mountStateLabel("live")).toBe("In sync");
    expect(mountStateLabel("offline")).toMatch(/Offline/);
    expect(mountStateLabel("failed")).toMatch(/Failed/);
    expect(mountStateLabel("detached")).toBe("Not started");
  });
});

describe("validateMountDraft — why Save stays disabled", () => {
  const others = [mk("Existing", "asi", "A")];
  it("requires a source vault and a non-root local folder", () => {
    expect(validateMountDraft({ source: { owner: "", vaultId: "", sourcePath: "" }, mountPoint: "X", direction: "pull" }, [])).toMatch(/source vault/);
    expect(validateMountDraft(mk("", "asi"), [])).toMatch(/local folder/);
    expect(validateMountDraft(mk("/", "asi"), [])).toMatch(/local folder/);
  });
  it("rejects overlap/nesting/duplication with the existing set", () => {
    expect(validateMountDraft(mk("Existing", "asi", "B"), others)).toMatch(/mount point|nested/); // duplicate mount point
    expect(validateMountDraft(mk("Existing/Deeper", "asi", "B"), others)).toMatch(/nested/);
  });
  it("accepts a valid, non-overlapping draft", () => {
    expect(validateMountDraft(mk("Fresh/Folder", "asi", "B"), others)).toBeNull();
  });
});

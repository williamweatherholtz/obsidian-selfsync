import { describe, it, expect } from "vitest";
import { sourceOptions, mountRowLabel, mountStateLabel, validateMountDraft } from "../src/mountsettings";
import { Mount } from "../src/mounts";
import { SharedVaultRef } from "../src/transport";

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

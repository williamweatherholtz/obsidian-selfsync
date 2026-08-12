import { describe, it, expect } from "vitest";
import { Mount, normFolder, normMountFolder, claimsLocal, primaryExcludes, mountRelFromLocal, mountRelFromSource, localFromMountRel, sourceFromMountRel, validateMounts, parseMounts, nudgeTarget } from "../src/mounts";

const mk = (mountPoint: string, sourcePath = "", direction: "pull" | "sync" = "pull"): Mount =>
  ({ source: { owner: "will", vaultId: "asi", sourcePath }, mountPoint, direction });

describe("normFolder", () => {
  it("strips leading/trailing/duplicate slashes + '.' segments", () => {
    expect(normFolder("/Work/ASI/")).toBe("Work/ASI");
    expect(normFolder("Work//ASI")).toBe("Work/ASI");
    expect(normFolder("./Work/./ASI")).toBe("Work/ASI");
    expect(normFolder("")).toBe("");
    expect(normFolder("/")).toBe("");
  });
  it("ROUND-TRIPS a filename with legitimate leading/trailing whitespace (never trims a segment interior)", () => {
    expect(normFolder("Work/ note .md")).toBe("Work/ note .md"); // the leaf's spaces are real filename bytes — must survive
    expect(normFolder("/ leading/trailing /x")).toBe(" leading/trailing /x");
  });
});

describe("R3 boundary adversarial — case / unicode / dots / .obsidian / dedupe", () => {
  it("normFolder drops '..' segments (defense-in-depth against a source path escape)", () => {
    expect(normFolder("a/../b")).toBe("a/b");          // '..' dropped (not resolved) — no escape reaches the sink
    expect(normFolder("../.obsidian/x")).toBe(".obsidian/x");
  });
  it("normMountFolder sanitizes user config — trims spaces, strips trailing dots, splits backslashes, drops ..", () => {
    expect(normMountFolder("Work\\ASI ")).toBe("Work/ASI");
    expect(normMountFolder(" Work / ASI. ")).toBe("Work/ASI");
    expect(normMountFolder("a/../b")).toBe("a/b");
    expect(normMountFolder("/")).toBe("");
  });
  it("H1: boundary is case-insensitive so a case-drifted folder can't split-brain between mount and primary", () => {
    const m = mk("Work/ASI");
    expect(claimsLocal(m, "work/asi/note.md")).toBe(true);       // same physical folder, different case → still claimed
    expect(mountRelFromLocal(m, "work/asi/note.md")).toBe("note.md"); // rel keeps the REAL case of the remainder
  });
  it("M4: boundary is Unicode-normalized (NFC vs NFD café)", () => {
    const nfc = "Café", nfd = "Café"; // é as one vs two code points
    expect(claimsLocal(mk(nfc), `${nfd}/x.md`)).toBe(true);
  });
  it("M5: validateMounts rejects two mounts over the same physical folder differing only by case", () => {
    expect(validateMounts([mk("Work/ASI"), mk("work/asi", "B")])[0]).toMatch(/share the mount point/);
  });
  it("H2: validateMounts rejects a mount point OR source inside .obsidian (data-only keystone)", () => {
    expect(validateMounts([mk(".obsidian/plugins/x")])[0]).toMatch(/\.obsidian/);
    expect(validateMounts([{ source: { owner: "", vaultId: "asi", sourcePath: ".obsidian/plugins/y" }, mountPoint: "Work", direction: "pull" }])[0]).toMatch(/\.obsidian/);
  });
});

describe("boundary — claimsLocal / primaryExcludes (the load-bearing invariant)", () => {
  const m = mk("Work/ASI");
  it("claims the mount point itself and anything under it", () => {
    expect(claimsLocal(m, "Work/ASI")).toBe(true);
    expect(claimsLocal(m, "Work/ASI/notes/a.md")).toBe(true);
    expect(claimsLocal(m, "/Work/ASI/x")).toBe(true); // normalized
  });
  it("does NOT claim a sibling that merely shares a name prefix", () => {
    expect(claimsLocal(m, "Work/ASIx/a.md")).toBe(false); // segment boundary respected
    expect(claimsLocal(m, "Work")).toBe(false);
    expect(claimsLocal(m, "Personal/a.md")).toBe(false);
  });
  it("primaryExcludes = claimed by ANY mount", () => {
    const mounts = [mk("Work/ASI"), mk("Refs")];
    expect(primaryExcludes(mounts, "Refs/x.md")).toBe(true);
    expect(primaryExcludes(mounts, "Work/ASI/y.md")).toBe(true);
    expect(primaryExcludes(mounts, "notes/z.md")).toBe(false); // primary keeps this
  });
});

describe("two-sided path translation", () => {
  it("local ↔ mount-relative", () => {
    const m = mk("Work/ASI");
    expect(mountRelFromLocal(m, "Work/ASI/notes/a.md")).toBe("notes/a.md");
    expect(mountRelFromLocal(m, "Work/ASI")).toBe("");            // the folder itself
    expect(mountRelFromLocal(m, "Personal/a.md")).toBeNull();     // not under this mount
    expect(localFromMountRel(m, "notes/a.md")).toBe("Work/ASI/notes/a.md");
  });
  it("source ↔ mount-relative for a SUBFOLDER of the source", () => {
    const m = mk("Work/ASI", "Projects");
    expect(mountRelFromSource(m, "Projects/notes/a.md")).toBe("notes/a.md");
    expect(mountRelFromSource(m, "Reference/a.md")).toBeNull();   // outside this mount's source subtree
    expect(sourceFromMountRel(m, "notes/a.md")).toBe("Projects/notes/a.md");
  });
  it("whole-source mount (sourcePath '') maps everything", () => {
    const m = mk("Work/ASI", "");
    expect(mountRelFromSource(m, "notes/a.md")).toBe("notes/a.md");
    expect(sourceFromMountRel(m, "notes/a.md")).toBe("notes/a.md");
  });
  it("round-trips: local → mount-rel → source → mount-rel → local", () => {
    const m = mk("Work/ASI", "Projects");
    const rel = mountRelFromLocal(m, "Work/ASI/notes/a.md")!;
    const s = sourceFromMountRel(m, rel);
    expect(s).toBe("Projects/notes/a.md");
    expect(mountRelFromSource(m, s)).toBe(rel);
    expect(localFromMountRel(m, rel)).toBe("Work/ASI/notes/a.md");
  });
});

describe("validateMounts", () => {
  it("accepts distinct, non-nested mount points", () => {
    expect(validateMounts([mk("Work/ASI"), mk("Refs"), mk("Work/Other")])).toEqual([]);
  });
  it("rejects an empty / root mount point", () => {
    expect(validateMounts([mk("")])[0]).toMatch(/can't be empty or the vault root/);
    expect(validateMounts([mk("/")])[0]).toMatch(/can't be empty or the vault root/);
  });
  it("rejects duplicate mount points", () => {
    expect(validateMounts([mk("Work/ASI"), mk("Work/ASI", "Other")])[0]).toMatch(/share the mount point/);
  });
  it("rejects nested mount points (either nesting direction), but allows name-prefix siblings", () => {
    expect(validateMounts([mk("Work"), mk("Work/ASI")])[0]).toMatch(/nested inside/);
    expect(validateMounts([mk("Work/ASI"), mk("Work")])[0]).toMatch(/nested inside/);
    expect(validateMounts([mk("Work/ASI"), mk("Work/ASIx")])).toEqual([]); // NOT nested (segment boundary)
  });
});

describe("parseMounts — persistence boundary (parse-don't-validate)", () => {
  it("normalizes paths + defaults an unknown direction to pull", () => {
    const m = parseMounts([{ source: { owner: "will", vaultId: "asi", sourcePath: "/Projects/" }, mountPoint: "/Work/ASI/", direction: "weird" }]);
    expect(m).toEqual([{ source: { owner: "will", vaultId: "asi", sourcePath: "Projects" }, mountPoint: "Work/ASI", direction: "pull" }]);
  });
  it("keeps a valid sync mount + drops malformed entries (no vault, empty/root mount point, non-object)", () => {
    const m = parseMounts([
      { source: { owner: "will", vaultId: "asi", sourcePath: "" }, mountPoint: "Refs", direction: "sync" },
      { source: { owner: "will", sourcePath: "x" }, mountPoint: "NoVault" }, // no vaultId → dropped
      { source: { vaultId: "asi" }, mountPoint: "/" },                        // root mount point → dropped
      "garbage", null,
    ]);
    expect(m).toEqual([{ source: { owner: "will", vaultId: "asi", sourcePath: "" }, mountPoint: "Refs", direction: "sync" }]);
  });
  it("non-array → []", () => { expect(parseMounts(undefined)).toEqual([]); expect(parseMounts("x")).toEqual([]); });
});

describe("nudgeTarget — the local-file-event nudge decision (mountNudgeHardening F4)", () => {
  const never = () => false; // no path is a self-echo
  const sync = mk("Work/ASI", "", "sync");
  const pull = mk("Refs", "", "pull");
  const mounts = [sync, pull];

  it("returns the claiming mount for a user edit under a SYNC mount (force a push-scanning pass)", () => {
    expect(nudgeTarget(mounts, "Work/ASI/note.md", never)).toBe(sync);
    expect(nudgeTarget(mounts, "Work/ASI", never)).toBe(sync); // the mount point itself
  });

  it("also nudges a PULL mount (a local edit surfaces promptly as a read-only conflict; the io still can't write the source)", () => {
    expect(nudgeTarget(mounts, "Refs/a/b.md", never)).toBe(pull);
  });

  it("returns null for a path outside every mount (the primary scope owns it)", () => {
    expect(nudgeTarget(mounts, "Inbox/x.md", never)).toBeNull();
    expect(nudgeTarget(mounts, "Work/ASIx/y.md", never)).toBeNull(); // sibling by name-prefix, NOT under the mount
    expect(nudgeTarget([], "Work/ASI/note.md", never)).toBeNull();
  });

  it("returns null when the event is the echo of the mount's OWN pull-write (not a user edit)", () => {
    const echo = (p: string) => p === "Work/ASI/pulled.md";
    expect(nudgeTarget(mounts, "Work/ASI/pulled.md", echo)).toBeNull(); // our write coming back → ignore
    expect(nudgeTarget(mounts, "Work/ASI/typed.md", echo)).toBe(sync);  // a different file → a real edit → nudge
  });
});

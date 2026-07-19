import { describe, it, expect } from "vitest";
import { groupConfigConflicts, configFileLabel, configSurfaceOf, configAutoResolveChoice, adjudicateConfigConflict } from "../src/configsync";

describe("configSurfaceOf — path → the per-category toggle that governs it", () => {
  it("maps each recognized config file/dir to its surface", () => {
    expect(configSurfaceOf(".obsidian/app.json")).toBe("core");
    expect(configSurfaceOf(".obsidian/core-plugins.json")).toBe("core");
    expect(configSurfaceOf(".obsidian/hotkeys.json")).toBe("hotkeys");
    expect(configSurfaceOf(".obsidian/appearance.json")).toBe("appearance");
    expect(configSurfaceOf(".obsidian/themes/Minimal/theme.css")).toBe("appearance");
    expect(configSurfaceOf(".obsidian/snippets/mine.css")).toBe("snippets");
    expect(configSurfaceOf(".obsidian/community-plugins.json")).toBe("community");
    expect(configSurfaceOf(".obsidian/plugins/dataview/main.js")).toBe("community");
  });
  it("returns null for a note/attachment or an unrecognized .obsidian file", () => {
    expect(configSurfaceOf("notes/todo.md")).toBeNull();
    expect(configSurfaceOf(".obsidian/workspace.json")).toBeNull(); // device-local, no surface
  });
});

describe("configAutoResolveChoice — first-contact direction, else prompt", () => {
  it("auto-resolves ONLY a no-base (conflict-copy) divergence when a direction is set", () => {
    expect(configAutoResolveChoice("conflict-copy", "appearance", "download")).toBe("remote"); // adopt synced
    expect(configAutoResolveChoice("conflict-copy", "appearance", "upload")).toBe("local");    // keep this device's
  });
  it("falls through to a prompt when it's a LATER edit (has a base), not first contact", () => {
    expect(configAutoResolveChoice("merge", "appearance", "download")).toBeNull();
    expect(configAutoResolveChoice("edit-wins-pull", "core", "upload")).toBeNull();
    expect(configAutoResolveChoice("edit-wins-keep-local", "core", "download")).toBeNull();
  });
  it("falls through when no direction is pending, or the path has no surface", () => {
    expect(configAutoResolveChoice("conflict-copy", "appearance", undefined)).toBeNull();
    expect(configAutoResolveChoice("conflict-copy", null, "download")).toBeNull();
  });
});

describe("adjudicateConfigConflict — the explicit auto-vs-manual state (D3)", () => {
  it("an auto-resolvable first-contact divergence → {auto, choice}", () => {
    expect(adjudicateConfigConflict("conflict-copy", "appearance", "download")).toEqual({ kind: "auto", choice: "remote" });
    expect(adjudicateConfigConflict("conflict-copy", "appearance", "upload")).toEqual({ kind: "auto", choice: "local" });
  });
  it("anything the choice helper declines (later edit, no direction, no surface) → {manual}", () => {
    expect(adjudicateConfigConflict("merge", "appearance", "download")).toEqual({ kind: "manual" });
    expect(adjudicateConfigConflict("edit-wins-pull", "core", "upload")).toEqual({ kind: "manual" });
    expect(adjudicateConfigConflict("conflict-copy", "appearance", undefined)).toEqual({ kind: "manual" });
    expect(adjudicateConfigConflict("conflict-copy", null, "download")).toEqual({ kind: "manual" });
  });
  it("is a faithful lift of configAutoResolveChoice — never disagrees with the underlying choice", () => {
    for (const reason of ["conflict-copy", "merge", "edit-wins-pull", "edit-wins-keep-local"])
      for (const surface of ["appearance", "core", null] as const)
        for (const dir of ["download", "upload", undefined] as const) {
          const choice = configAutoResolveChoice(reason, surface, dir);
          const adj = adjudicateConfigConflict(reason, surface, dir);
          if (choice) expect(adj).toEqual({ kind: "auto", choice });
          else expect(adj).toEqual({ kind: "manual" });
        }
  });
});

describe("groupConfigConflicts — one entry per plugin, labelled by purpose", () => {
  it("collapses all of a plugin's files into ONE entry", () => {
    const groups = groupConfigConflicts([
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/plugins/dataview/data.json",
      ".obsidian/plugins/dataview/styles.css",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Plugin: dataview");
    expect(groups[0].paths).toHaveLength(3);
  });

  it("keeps distinct plugins separate and labels non-plugin files by purpose", () => {
    const groups = groupConfigConflicts([
      ".obsidian/plugins/tasks/data.json",
      ".obsidian/plugins/dataview/data.json",
      ".obsidian/community-plugins.json",
      ".obsidian/appearance.json",
    ]);
    const labels = groups.map((g) => g.label);
    expect(labels).toContain("Plugin: tasks");
    expect(labels).toContain("Plugin: dataview");
    expect(labels).toContain("Enabled community plugins");   // not "community-plugins.json changed"
    expect(labels).toContain("Appearance & theme");
    expect(groups).toHaveLength(4);
  });

  it("empty in, empty out", () => expect(groupConfigConflicts([])).toEqual([]));
});

describe("configFileLabel — describes the setting, not the filename", () => {
  it("maps known config files to their purpose", () => {
    expect(configFileLabel(".obsidian/community-plugins.json")).toBe("Enabled community plugins");
    expect(configFileLabel(".obsidian/hotkeys.json")).toBe("Hotkeys");
    expect(configFileLabel(".obsidian/app.json")).toBe("App settings");
  });
  it("names themes and snippets by their file", () => {
    expect(configFileLabel(".obsidian/themes/Minimal/theme.css")).toBe("Theme: Minimal");
    expect(configFileLabel(".obsidian/snippets/custom.css")).toBe("CSS snippet: custom.css");
  });
});

import { describe, it, expect } from "vitest";
import { groupConfigConflicts, configFileLabel } from "../src/configsync";

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

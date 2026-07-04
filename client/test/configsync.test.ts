import { describe, it, expect } from "vitest";
import { shouldSync, pluginIdOf, DEFAULT_CONFIG_SYNC, ConfigSyncSelection } from "../src/configsync";

const SELF = "obsidian-selfsync";
const on = (over: Partial<ConfigSyncSelection> = {}): ConfigSyncSelection =>
  ({ ...DEFAULT_CONFIG_SYNC, enabled: true, ...over });

describe("shouldSync — notes always sync", () => {
  it("ordinary notes/attachments sync regardless of config selection", () => {
    for (const sel of [DEFAULT_CONFIG_SYNC, on()]) {
      expect(shouldSync("Note.md", sel, SELF)).toBe(true);
      expect(shouldSync("folder/deep/img.png", sel, SELF)).toBe(true);
    }
  });
});

describe("shouldSync — master switch", () => {
  it("config sync OFF means nothing under .obsidian syncs", () => {
    expect(shouldSync(".obsidian/app.json", DEFAULT_CONFIG_SYNC, SELF)).toBe(false);
    expect(shouldSync(".obsidian/community-plugins.json", DEFAULT_CONFIG_SYNC, SELF)).toBe(false);
  });
});

describe("shouldSync — SelfSync self-exclusion is absolute", () => {
  it("never syncs SelfSync's own plugin folder, even with everything enabled", () => {
    const sel = on({ community: true });
    expect(shouldSync(`.obsidian/plugins/${SELF}/data.json`, sel, SELF)).toBe(false);
    expect(shouldSync(`.obsidian/plugins/${SELF}/main.js`, sel, SELF)).toBe(false);
    expect(shouldSync(`.obsidian/plugins/${SELF}`, sel, SELF)).toBe(false);
  });
  it("does not accidentally exclude a plugin whose id is a prefix of SelfSync's", () => {
    // ".../obsidian-sync/..." must still sync — only the exact SelfSync id is barred.
    expect(shouldSync(`.obsidian/plugins/obsidian-sync/data.json`, on(), SELF)).toBe(true);
  });
});

describe("shouldSync — category defaults", () => {
  it("core settings + hotkeys + community sync by default (when enabled)", () => {
    const sel = on();
    expect(shouldSync(".obsidian/app.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/core-plugins.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/hotkeys.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/community-plugins.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/plugins/dataview/data.json", sel, SELF)).toBe(true);
  });
  it("appearance + themes + snippets are OFF by default (opt-in)", () => {
    const sel = on();
    expect(shouldSync(".obsidian/appearance.json", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/themes/Foo/theme.css", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/snippets/x.css", sel, SELF)).toBe(false);
  });
  it("opting in enables appearance/themes/snippets", () => {
    expect(shouldSync(".obsidian/appearance.json", on({ appearance: true }), SELF)).toBe(true);
    expect(shouldSync(".obsidian/themes/Foo/theme.css", on({ appearance: true }), SELF)).toBe(true);
    expect(shouldSync(".obsidian/snippets/x.css", on({ snippets: true }), SELF)).toBe(true);
  });
});

describe("shouldSync — per-plugin deny + community toggle", () => {
  it("a denied plugin id is excluded but others still sync", () => {
    const sel = on({ pluginDeny: ["dataview"] });
    expect(shouldSync(".obsidian/plugins/dataview/data.json", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/plugins/templater/data.json", sel, SELF)).toBe(true);
  });
  it("turning community off excludes all plugin folders and the manifest", () => {
    const sel = on({ community: false });
    expect(shouldSync(".obsidian/community-plugins.json", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/plugins/dataview/data.json", sel, SELF)).toBe(false);
  });
});

describe("shouldSync — unrecognized config files are device-local", () => {
  it("workspace/graph/etc are never synced", () => {
    const sel = on();
    expect(shouldSync(".obsidian/workspace.json", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/workspace-mobile.json", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/graph.json", sel, SELF)).toBe(false);
  });
});

describe("pluginIdOf", () => {
  it("extracts the plugin id from a plugins path, else null", () => {
    expect(pluginIdOf(".obsidian/plugins/dataview/data.json")).toBe("dataview");
    expect(pluginIdOf(".obsidian/plugins/dataview")).toBe("dataview");
    expect(pluginIdOf(".obsidian/app.json")).toBeNull();
    expect(pluginIdOf("Note.md")).toBeNull();
  });
});

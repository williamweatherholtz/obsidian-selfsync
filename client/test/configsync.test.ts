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
  // Allowlist the self ids in these tests, so the ONLY reason a self path is excluded is the
  // self-exclusion rule — proving it OVERRIDES the allowlist (not just an empty-allowlist artifact).
  it("never syncs SelfSync's own plugin folder, even when enabled AND allowlisted", () => {
    const sel = on({ community: true, pluginAllow: [SELF, "new-livesync"] });
    expect(shouldSync(`.obsidian/plugins/${SELF}/data.json`, sel, SELF)).toBe(false);
    expect(shouldSync(`.obsidian/plugins/${SELF}/main.js`, sel, SELF)).toBe(false);
    expect(shouldSync(`.obsidian/plugins/${SELF}`, sel, SELF)).toBe(false);
  });
  it("also excludes a leftover FORMER self-folder (new-livesync) so old creds can't sync", () => {
    const sel = on({ community: true, pluginAllow: [SELF, "new-livesync"] });
    expect(shouldSync(".obsidian/plugins/new-livesync/data.json", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/plugins/new-livesync/main.js", sel, SELF)).toBe(false);
  });
  it("does not accidentally exclude a plugin whose id is a prefix of SelfSync's", () => {
    // ".../obsidian-sync/..." must still sync when allowlisted — only the exact SelfSync id is barred.
    expect(shouldSync(`.obsidian/plugins/obsidian-sync/data.json`, on({ community: true, pluginAllow: ["obsidian-sync"] }), SELF)).toBe(true);
  });
  it("excludes the self-folder CASE-INSENSITIVELY (SEC-R2#1 — no cred-hijack via an uppercased path)", () => {
    const sel = on({ community: true, pluginAllow: [SELF, "new-livesync"] });
    // On a case-insensitive FS these resolve to the SAME folder as new-livesync/SELF, so they
    // must NOT sync — else a shared vault could overwrite the victim's stored server URL + creds.
    expect(shouldSync(".obsidian/plugins/NEW-LIVESYNC/data.json", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/plugins/New-LiveSync/main.js", sel, SELF)).toBe(false);
    expect(shouldSync(`.obsidian/plugins/${SELF.toUpperCase()}/data.json`, sel, SELF)).toBe(false);
  });
});

describe("shouldSync — category defaults", () => {
  it("core + hotkeys + appearance + themes + snippets sync by default (match official)", () => {
    const sel = on();
    expect(shouldSync(".obsidian/app.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/core-plugins.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/hotkeys.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/appearance.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/themes/Foo/theme.css", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/snippets/x.css", sel, SELF)).toBe(true);
  });
  it("community-plugin code is OFF by default (opt-in — pushing plugin code is riskier)", () => {
    const sel = on();
    expect(shouldSync(".obsidian/community-plugins.json", sel, SELF)).toBe(false);
    expect(shouldSync(".obsidian/plugins/dataview/data.json", sel, SELF)).toBe(false);
  });
  it("community ON syncs the enabled-list, but a plugin's CODE syncs only when allowlisted", () => {
    // Turning community on lets the manifest (enabled list) sync; a plugin FOLDER still needs an
    // explicit per-plugin opt-in — so a newly-installed plugin is NOT auto-shared.
    expect(shouldSync(".obsidian/community-plugins.json", on({ community: true }), SELF)).toBe(true);
    expect(shouldSync(".obsidian/plugins/dataview/data.json", on({ community: true }), SELF)).toBe(false); // not allowlisted
    expect(shouldSync(".obsidian/plugins/dataview/data.json", on({ community: true, pluginAllow: ["dataview"] }), SELF)).toBe(true);
  });
});

describe("shouldSync — per-plugin ALLOWLIST + community toggle", () => {
  it("only allowlisted plugins sync; a new (non-allowlisted) plugin does NOT", () => {
    const sel = on({ community: true, pluginAllow: ["templater"] });
    expect(shouldSync(".obsidian/plugins/templater/data.json", sel, SELF)).toBe(true);
    expect(shouldSync(".obsidian/plugins/dataview/data.json", sel, SELF)).toBe(false); // newly installed → not shared
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

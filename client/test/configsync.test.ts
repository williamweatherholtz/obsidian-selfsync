import { describe, it, expect } from "vitest";
import { shouldSync, isJunkFile, pluginIdOf, pluginFilePaths, isSelfPluginId, DEFAULT_CONFIG_SYNC, ConfigSyncSelection, isEnabledListConfig, mergeEnabledPluginsJson, shouldNotifyConfigChange, changeSourceLabel } from "../src/configsync";

// Source-of-change notification rule (D-provenance): notify only when SOMEONE ELSE made the change —
// NEVER based on whether the vault is shared. "user" mode = another PERSON; "userDevice" = another device too.
describe("shouldNotifyConfigChange — the source-driven notify rule", () => {
  const self = { user: "will", deviceId: "dev-A" };
  it("stays silent for YOUR OWN change (same user) in user mode — the whole point", () => {
    expect(shouldNotifyConfigChange({ author: "will", deviceId: "dev-A" }, self, "user")).toBe(false);
    expect(shouldNotifyConfigChange({ author: "will", deviceId: "dev-B" }, self, "user")).toBe(false); // your other device is still "you"
  });
  it("notifies when ANOTHER PERSON changed it, in either mode", () => {
    expect(shouldNotifyConfigChange({ author: "alice", deviceId: "dev-Z" }, self, "user")).toBe(true);
    expect(shouldNotifyConfigChange({ author: "alice", deviceId: "dev-A" }, self, "userDevice")).toBe(true); // even if the device id happens to collide
  });
  it("matches the account CASE-INSENSITIVELY — a your-own change stamped as-typed by an older server isn't flagged as another person (issueUsernameNotCanonicalized)", () => {
    // self.user is now canonically lowercase ("will"); an older server may have stamped the author "Will".
    expect(shouldNotifyConfigChange({ author: "Will", deviceId: "dev-A" }, self, "user")).toBe(false); // still YOU → silent
    expect(shouldNotifyConfigChange({ author: "WILL", deviceId: "dev-B" }, self, "user")).toBe(false);
    expect(shouldNotifyConfigChange({ author: "Alice", deviceId: "dev-Z" }, self, "user")).toBe(true);  // a real other person still notifies
    expect(changeSourceLabel({ author: "Will", deviceName: "Laptop" }, self)).toBe("Laptop");           // not labeled "Will (Laptop)" — it's you
  });

  it("in userDevice mode, also notifies for YOUR OWN account from a DIFFERENT device", () => {
    expect(shouldNotifyConfigChange({ author: "will", deviceId: "dev-B" }, self, "userDevice")).toBe(true);
    expect(shouldNotifyConfigChange({ author: "will", deviceId: "dev-A" }, self, "userDevice")).toBe(false); // this very device → silent
  });
  it("treats an UNKNOWN author (pre-provenance change) as notify — conservative", () => {
    expect(shouldNotifyConfigChange({}, self, "user")).toBe(true);
    expect(shouldNotifyConfigChange({ deviceId: "dev-B" }, self, "user")).toBe(true); // device but no author → still unknown who
  });
  it("in userDevice mode, YOUR change from an UNKNOWN device notifies (can't confirm it's this one)", () => {
    expect(shouldNotifyConfigChange({ author: "will" }, self, "userDevice")).toBe(true);
  });
  it("SPOOF-RESISTANCE: a peer renaming their device can't dodge notification — identity is the account, then the UUID, never the name", () => {
    // A peer (alice) whose device is *named* like yours still notifies: author differs.
    expect(shouldNotifyConfigChange({ author: "alice", deviceName: "Will's Desktop", deviceId: "dev-Z" }, self, "user")).toBe(true);
    // In userDevice mode, a same-account change from a device with a spoofed NAME but different UUID still notifies.
    expect(shouldNotifyConfigChange({ author: "will", deviceName: "dev-A pretender", deviceId: "dev-B" }, self, "userDevice")).toBe(true);
  });
});

describe("changeSourceLabel — human 'who' for the notice, never a raw UUID", () => {
  const self = { user: "will", deviceId: "dev-A" };
  it("prefers the friendly device name", () => {
    expect(changeSourceLabel({ author: "will", deviceName: "Laptop", deviceId: "dev-B" }, self)).toBe("Laptop");
  });
  it("names the other PERSON, with their device in parens when present", () => {
    expect(changeSourceLabel({ author: "alice", deviceName: "Alice-PC" }, self)).toBe("alice (Alice-PC)");
    expect(changeSourceLabel({ author: "alice" }, self)).toBe("alice");
  });
  it("falls back to a generic label (never exposes the UUID) when nothing is known", () => {
    const label = changeSourceLabel({ deviceId: "6f1e-secret-uuid" }, self);
    expect(label).toBe("another device");
    expect(label).not.toContain("uuid");
  });
});

describe("isSelfPluginId — the self-folder exclusion Push/Pull must honor (case-insensitive + legacy)", () => {
  it("matches the current self id case-INSENSITIVELY (a case-variant folder is the same on a CI filesystem)", () => {
    expect(isSelfPluginId("selfsync", "selfsync")).toBe(true);
    expect(isSelfPluginId("SelfSync", "selfsync")).toBe(true);      // case-variant → still self (credential-safety)
    expect(isSelfPluginId("SELFSYNC", "selfsync")).toBe(true);
    expect(isSelfPluginId("dataview", "selfsync")).toBe(false);
  });
  it("matches LEGACY self ids (a leftover old-id folder still holds old credentials)", () => {
    expect(isSelfPluginId("new-livesync", "selfsync")).toBe(true);
    expect(isSelfPluginId("New-LiveSync", "selfsync")).toBe(true);  // legacy, case-insensitive
  });
});

describe("pluginFilePaths — the file set a Push/Pull acts on (union of local+server under the plugin folder)", () => {
  it("unions both sides, scoped to the plugin folder, junk excluded, sorted", () => {
    const local = [".obsidian/plugins/dataview/main.js", ".obsidian/plugins/dataview/data.json", ".obsidian/plugins/other/main.js", "Note.md"];
    const server = [".obsidian/plugins/dataview/main.js", ".obsidian/plugins/dataview/styles.css", ".obsidian/plugins/dataview/.DS_Store"];
    // dataview files from BOTH sides (so a Push removes a server-only file, a Pull removes a local-only
    // file); other-plugin + note excluded; junk excluded; sorted.
    expect(pluginFilePaths(local, server, "dataview")).toEqual([
      ".obsidian/plugins/dataview/data.json",   // local-only → a Pull removes it locally
      ".obsidian/plugins/dataview/main.js",     // both
      ".obsidian/plugins/dataview/styles.css",  // server-only → a Push removes it on the server
    ]);
  });
  it("never reaches outside the exact plugin folder (no id-prefix bleed)", () => {
    // "dataview" must not match "dataview-extra": exact folder segment only.
    const paths = [".obsidian/plugins/dataview/main.js", ".obsidian/plugins/dataview-extra/main.js"];
    expect(pluginFilePaths(paths, [], "dataview")).toEqual([".obsidian/plugins/dataview/main.js"]);
  });
  it("empty when neither side has the plugin", () => {
    expect(pluginFilePaths(["Note.md"], [".obsidian/plugins/x/main.js"], "dataview")).toEqual([]);
  });
});

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

describe("isJunkFile / shouldSync — OS junk the server rejects is skipped client-side", () => {
  it("skips Thumbs.db / .DS_Store / desktop.ini / .git anywhere in the path", () => {
    for (const p of [
      "Thumbs.db", "a/b/Thumbs.db", ".DS_Store", "sub/.DS_Store",
      "desktop.ini", "x/desktop.ini", ".git", "repo/.git/config",
    ]) {
      expect(isJunkFile(p)).toBe(true);
      expect(shouldSync(p, on(), SELF)).toBe(false); // never synced, config on or off
      expect(shouldSync(p, DEFAULT_CONFIG_SYNC, SELF)).toBe(false);
    }
  });
  it("does NOT skip legitimate files that merely resemble junk", () => {
    for (const p of ["thumbs.db.md", "notes/Thumbsdb.md", "my.git.notes.md", "git/readme.md"]) {
      expect(isJunkFile(p)).toBe(false);
      expect(shouldSync(p, on(), SELF)).toBe(true);
    }
  });
});

describe("shouldSync — crash-orphan atomic-write temps never sync (R21)", () => {
  it("rejects a leftover .selfsync-part partial download, as a note or under .obsidian", () => {
    for (const sel of [DEFAULT_CONFIG_SYNC, on({ community: true })]) {
      expect(shouldSync("notes/big.md.selfsync-part", sel, SELF)).toBe(false);
      expect(shouldSync("attachment.pdf.selfsync-part", sel, SELF)).toBe(false);
      expect(shouldSync(".obsidian/plugins/x/main.js.selfsync-part", sel, SELF)).toBe(false);
      // the server's mirror temp suffix too, for symmetry
      expect(shouldSync("notes/big.md.selfsync-tmp", sel, SELF)).toBe(false);
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

describe("community-plugins.json set-merge (never disable a locally-enabled plugin)", () => {
  it("isEnabledListConfig matches ONLY community-plugins.json", () => {
    expect(isEnabledListConfig(".obsidian/community-plugins.json")).toBe(true);
    expect(isEnabledListConfig(".obsidian/core-plugins.json")).toBe(false);
    expect(isEnabledListConfig(".obsidian/app.json")).toBe(false);
    expect(isEnabledListConfig(".obsidian/plugins/tasks/main.js")).toBe(false);
  });
  it("unions the enabled ids (sorted) — keeps ids from BOTH sides", () => {
    expect(JSON.parse(mergeEnabledPluginsJson('["a","c"]', '["a","b"]')!)).toEqual(["a", "b", "c"]);
    expect(JSON.parse(mergeEnabledPluginsJson('["z","a"]', '["a"]')!)).toEqual(["a", "z"]);
  });
  it("treats an empty/whitespace body as the empty set", () => {
    expect(JSON.parse(mergeEnabledPluginsJson("", '["x"]')!)).toEqual(["x"]);
    expect(JSON.parse(mergeEnabledPluginsJson('["x"]', "   ")!)).toEqual(["x"]);
  });
  it("returns null on a non-string[] body so the caller falls back (never merges garbage)", () => {
    expect(mergeEnabledPluginsJson('{"a":true}', '["b"]')).toBeNull(); // an object (core-plugins.json shape)
    expect(mergeEnabledPluginsJson("not json", '["b"]')).toBeNull();
    expect(mergeEnabledPluginsJson("[1,2]", '["b"]')).toBeNull();      // numbers, not ids
  });
});

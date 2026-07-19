import { describe, it, expect } from "vitest";
import { parseSettings, DEFAULT_SETTINGS } from "../src/settings";
import { DEFAULT_CONFIG_SYNC } from "../src/configsync";

// parseSettings is the parse-don't-validate boundary for the untrusted persisted `settings` object
// (issuePatternUntaggedShouldAdopt). It must default every field, harden the wrong-typed ones, and hand
// back FRESH nested collections so a loaded vault can never alias — and thus mutate — a module constant.

describe("parseSettings — harden + freshen the persisted settings object", () => {
  it("returns full defaults for empty / non-object / hostile input", () => {
    for (const bad of [undefined, null, {}, 42, "nope", []]) {
      const s = parseSettings(bad);
      expect(s.vaultId).toBe(DEFAULT_SETTINGS.vaultId);
      expect(s.maxSyncMB).toBe(DEFAULT_SETTINGS.maxSyncMB);
      expect(s.storePassword).toBe(DEFAULT_SETTINGS.storePassword);
      expect(s.configConflicts).toEqual([]);
      expect(s.configSync.enabled).toBe(DEFAULT_CONFIG_SYNC.enabled);
    }
  });

  it("merges provided fields over the defaults", () => {
    const s = parseSettings({ serverUrl: "https://s.example.com", username: "will", maxSyncMB: 10 });
    expect(s.serverUrl).toBe("https://s.example.com");
    expect(s.username).toBe("will");
    expect(s.maxSyncMB).toBe(10);
    expect(s.vaultId).toBe(DEFAULT_SETTINGS.vaultId); // untouched fields keep defaults
  });

  it("coerces a non-array configConflicts to an empty array (a corrupt data.json can't crash the queue)", () => {
    expect(parseSettings({ configConflicts: "oops" }).configConflicts).toEqual([]);
    expect(parseSettings({ configConflicts: null }).configConflicts).toEqual([]);
    expect(parseSettings({ configConflicts: ["a.json", "b.json"] }).configConflicts).toEqual(["a.json", "b.json"]);
  });

  it("never aliases the module constants — nested collections are fresh per parse", () => {
    const a = parseSettings({});
    const b = parseSettings({});
    expect(a.configSync).not.toBe(DEFAULT_CONFIG_SYNC);      // not the module constant
    expect(a.configSync).not.toBe(b.configSync);             // and not shared between parses
    expect(a.configConflicts).not.toBe(b.configConflicts);
    expect(a.configSync.pluginAllow).not.toBe(DEFAULT_CONFIG_SYNC.pluginAllow);
    // mutating one result must not leak into the constant or a fresh parse
    a.configConflicts.push("x.json");
    a.configSync.pluginAllow.push("dataview");
    expect(parseSettings({}).configConflicts).toEqual([]);
    expect(DEFAULT_CONFIG_SYNC.pluginAllow).not.toContain("dataview");
  });

  it("backfills configSync sub-fields while preserving provided ones", () => {
    const s = parseSettings({ configSync: { enabled: true, pluginAllow: ["excalidraw"] } });
    expect(s.configSync.enabled).toBe(true);
    expect(s.configSync.pluginAllow).toEqual(["excalidraw"]);
    expect(s.configSync.pluginDir).toEqual({}); // absent sub-field → fresh default
  });
});

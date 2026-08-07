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

  it("defaults + hardens the timestamp-ignore settings, and migrates the retired embed-timestamp fields", () => {
    const d = parseSettings({});
    expect(d.ignoreTimestampChanges).toBe(true); // default ON — identity-only, never writes notes
    expect(d.ignoredTimestampKeys).toContain("updated");
    expect(d.ignoredTimestampKeys).toContain("updated-*"); // per-device pattern in the defaults
    expect(d.excludedFolders).toEqual([]);
    // Retired fields are dropped, not carried forward.
    expect((d as unknown as Record<string, unknown>).embeddedTimestamps).toBeUndefined();
    expect((d as unknown as Record<string, unknown>).driveFsTimes).toBeUndefined();
    // A legacy vault that had the old feature on → migrates to masking on, seeding its custom keys ∪ defaults.
    const migrated = parseSettings({ embeddedTimestamps: true, timestampCreatedKey: "made", timestampUpdatedKey: "changed" });
    expect(migrated.ignoreTimestampChanges).toBe(true);
    expect(migrated.ignoredTimestampKeys).toContain("made");
    expect(migrated.ignoredTimestampKeys).toContain("changed");
    expect(migrated.ignoredTimestampKeys).toContain("updated"); // ∪ defaults
    // An explicit new-field value is honored.
    expect(parseSettings({ ignoreTimestampChanges: false }).ignoreTimestampChanges).toBe(false);
    expect(parseSettings({ excludedFolders: ["Work"] }).excludedFolders).toEqual(["Work"]);
    expect(parseSettings({ excludedFolders: "oops" }).excludedFolders).toEqual([]); // non-array → empty
    // fresh array per parse (no alias)
    const input = { excludedFolders: ["X"] };
    const out = parseSettings(input);
    input.excludedFolders.push("Y");
    expect(out.excludedFolders).toEqual(["X"]);
  });

  it("hardens the provenance fields: notify mode defaults to 'user', deviceId kept only if a real string", () => {
    // Notify mode: default, honored value, and anything unexpected → the safe "user" default.
    expect(parseSettings({}).configChangeNotify).toBe("user");
    expect(parseSettings({ configChangeNotify: "userDevice" }).configChangeNotify).toBe("userDevice");
    expect(parseSettings({ configChangeNotify: "everything" }).configChangeNotify).toBe("user"); // unknown → default
    expect(parseSettings({ configChangeNotify: 7 as unknown as string }).configChangeNotify).toBe("user"); // wrong type → default
    // deviceId: a real string survives; empty/non-string → undefined (re-minted lazily), never a bogus "".
    expect(parseSettings({ deviceId: "abc-123" }).deviceId).toBe("abc-123");
    expect(parseSettings({ deviceId: "" }).deviceId).toBeUndefined();
    expect(parseSettings({ deviceId: 5 as unknown as string }).deviceId).toBeUndefined();
    expect(parseSettings({}).deviceId).toBeUndefined();
  });

  it("autoSyncNewPlugins is opt-in — default off, and only a literal true persists", () => {
    expect(parseSettings({}).autoSyncNewPlugins).toBe(false);
    expect(parseSettings({ autoSyncNewPlugins: true }).autoSyncNewPlugins).toBe(true);
    expect(parseSettings({ autoSyncNewPlugins: "yes" as unknown as boolean }).autoSyncNewPlugins).toBe(false); // wrong type → off
    expect(parseSettings({ autoSyncNewPlugins: 1 as unknown as boolean }).autoSyncNewPlugins).toBe(false);
  });
});

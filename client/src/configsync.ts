// Decides which paths sync. Notes/attachments always sync; the `.obsidian/` config
// surface is opt-in per category. This is the SECURITY core of selective sync:
//
//   1. SelfSync's OWN plugin folder is NEVER synced, under any setting. Its data.json
//      holds this device's server URL / credentials / vaultId — syncing it would let
//      one device overwrite another's connection config ("the IP may differ").
//   2. Defaults mirror official Obsidian Sync: core settings, hotkeys, appearance and
//      themes/snippets are ON; community-plugin CODE is OFF by default (opt-in).
//   3. Anything under `.obsidian/` we don't explicitly recognize (workspace.json,
//      graph.json, …) is device-local and NOT synced.
//
// Pure and total: no Obsidian API, so it's exhaustively unit-testable.

export interface ConfigSyncSelection {
  enabled: boolean;      // master switch: sync the .obsidian/ surface at all
  core: boolean;         // app.json, core-plugins.json
  community: boolean;    // community-plugins.json + other plugins' folders
  appearance: boolean;   // appearance.json, themes/**  (default OFF)
  snippets: boolean;     // snippets/**                 (default OFF)
  hotkeys: boolean;      // hotkeys.json
  pluginDeny: string[];  // community plugin ids to exclude individually
}

// Category defaults mirror official Obsidian Sync's "Vault configuration sync": core
// settings, hotkeys, appearance, and themes/snippets ON; community-plugin *code* OFF
// (opt-in, since pushing plugin code across devices — incl. desktop-only plugins onto
// mobile — is the riskier default). `enabled` is still off overall: config sync is
// opt-in as a whole; notes always sync regardless.
export const DEFAULT_CONFIG_SYNC: ConfigSyncSelection = {
  enabled: false,
  core: true,
  hotkeys: true,
  appearance: true,
  snippets: true,
  community: false,
  pluginDeny: [],
};

const CONFIG_PREFIX = ".obsidian/";

// Former plugin-folder ids that must ALSO never sync — a leftover folder from a prior
// install (before the id rename) still holds this device's old credentials, and the
// current plugin wouldn't otherwise recognize it as "self". Keep this list forever.
const LEGACY_SELF_IDS = ["new-livesync"];

// The plugin id of a given community-plugin path under `.obsidian/plugins/`, or null.
export function pluginIdOf(path: string): string | null {
  if (!path.startsWith(CONFIG_PREFIX)) return null;
  const rest = path.slice(CONFIG_PREFIX.length);
  if (!rest.startsWith("plugins/")) return null;
  const id = rest.slice("plugins/".length).split("/")[0];
  return id || null;
}

// True if `path` should participate in sync given the selection and this device's own
// SelfSync plugin id (the folder that must never sync).
export function shouldSync(path: string, sel: ConfigSyncSelection, selfPluginId: string): boolean {
  if (!path.startsWith(CONFIG_PREFIX)) return true; // ordinary note/attachment
  if (!sel.enabled) return false;                   // config sync switched off entirely

  const p = path.slice(CONFIG_PREFIX.length);

  // (1) HARD, non-optional exclusion: SelfSync's own plugin folder — plus any FORMER
  // self-folder id, so a leftover pre-rename folder's credentials can never sync.
  for (const self of [selfPluginId, ...LEGACY_SELF_IDS]) {
    if (self && (p === `plugins/${self}` || p.startsWith(`plugins/${self}/`))) return false;
  }

  // (2) recognized categories
  if (p === "app.json" || p === "core-plugins.json") return sel.core;
  if (p === "hotkeys.json") return sel.hotkeys;
  if (p === "appearance.json" || p.startsWith("themes/")) return sel.appearance;
  if (p.startsWith("snippets/")) return sel.snippets;
  if (p === "community-plugins.json") return sel.community;
  if (p.startsWith("plugins/")) {
    if (!sel.community) return false;
    const id = p.slice("plugins/".length).split("/")[0];
    if (!id) return false;
    if (sel.pluginDeny.includes(id)) return false;
    return true;
  }

  // (3) unrecognized .obsidian/ file → device-local, never synced
  return false;
}

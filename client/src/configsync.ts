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

// A group of divergent config paths the user resolves as one unit — at most one per plugin,
// one per other config file — with a human label describing WHAT it is (not a raw filename).
export interface ConflictGroup { key: string; label: string; paths: string[] }

// Human label for a config file, by purpose rather than filename.
export function configFileLabel(path: string): string {
  const rel = path.replace(/^\.obsidian\//, "");
  const known: Record<string, string> = {
    "community-plugins.json": "Enabled community plugins",
    "core-plugins.json": "Enabled core plugins",
    "app.json": "App settings",
    "appearance.json": "Appearance & theme",
    "hotkeys.json": "Hotkeys",
    "graph.json": "Graph settings",
    "canvas.json": "Canvas settings",
  };
  if (known[rel]) return known[rel];
  if (rel.startsWith("themes/")) return `Theme: ${rel.slice("themes/".length).split("/")[0]}`;
  if (rel.startsWith("snippets/")) return `CSS snippet: ${rel.slice("snippets/".length)}`;
  return rel;
}

// Collapse divergent config paths into at most one entry per plugin (all of a plugin's files —
// main.js, data.json, styles.css — become one "Plugin: <id>" the user resolves in one click) and
// one entry per other config file (labelled by purpose). Sorted by label for a stable UI.
export function groupConfigConflicts(paths: string[]): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>();
  for (const p of paths) {
    const id = pluginIdOf(p);
    const key = id ? `plugin:${id}` : `file:${p}`;
    const label = id ? `Plugin: ${id}` : configFileLabel(p);
    const g = groups.get(key) ?? { key, label, paths: [] };
    g.paths.push(p);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

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

  // (1) HARD, non-optional exclusion: SelfSync's own plugin folder — plus any FORMER self-folder
  // id. CASE-INSENSITIVE (SEC-R2#1): on a case-insensitive filesystem a differently-cased path
  // (plugins/NEW-LIVESYNC/) resolves to the SAME folder, so a case-sensitive check let a shared
  // vault smuggle attacker-controlled server/creds into the victim's data.json via an uppercased
  // path — a connection hijack. Match the plugin-id folder segment case-insensitively.
  const pl = p.toLowerCase();
  if (pl.startsWith("plugins/")) {
    const idLc = pl.slice("plugins/".length).split("/")[0];
    const selfIds = [selfPluginId, ...LEGACY_SELF_IDS].filter(Boolean).map((s) => s.toLowerCase());
    if (selfIds.includes(idLc)) return false;
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

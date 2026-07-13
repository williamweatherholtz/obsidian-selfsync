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
  // Community plugin ids to INCLUDE (allowlist). A plugin's code+settings sync ONLY if its id is
  // here — so a NEWLY-installed plugin is NOT shared until the user opts it in (or bulk-adds all).
  // Default-OFF, opt-in: installing a plugin on one device never auto-pushes it (and its files
  // overwriting the other devices) before the user decides to share it. (was pluginDeny: default-share)
  pluginAllow: string[];
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
  pluginAllow: [], // no community plugins shared until the user opts them in (or bulk-adds all)
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

// The config SURFACE a path belongs to (the per-category toggle that governs it), or null for a
// non-config / unrecognized path. Mirrors shouldSync's category checks — kept in lockstep with it.
// Used to look up the per-surface first-contact direction when auto-resolving an initial divergence.
export type ConfigSurface = "core" | "hotkeys" | "appearance" | "snippets" | "community";
export function configSurfaceOf(path: string): ConfigSurface | null {
  if (!path.startsWith(CONFIG_PREFIX)) return null;
  const p = path.slice(CONFIG_PREFIX.length);
  if (p === "app.json" || p === "core-plugins.json") return "core";
  if (p === "hotkeys.json") return "hotkeys";
  if (p === "appearance.json" || p.startsWith("themes/")) return "appearance";
  if (p.startsWith("snippets/")) return "snippets";
  if (p === "community-plugins.json" || p.startsWith("plugins/")) return "community";
  return null;
}

// First-contact direction for config sync, chosen per surface when it's turned on (parallel to the
// vault-switch download/upload — MERGE is intentionally absent: config files are opaque blobs, so a
// line-merge could yield invalid/nonsense settings; the only sane first-contact resolution is to take
// one whole side). download = adopt the synced copy; upload = make this device's copy canonical.
export type ConfigDirection = "download" | "upload";

// Decide whether an incoming config divergence should be AUTO-resolved by the surface's chosen
// first-contact direction, and to which side. Returns "local" (keep this device's) / "remote" (take
// the synced) for resolveConfigConflict, or null to fall through to the normal per-file human prompt.
// ONLY a first-contact divergence (no common base → decide() returned "conflict-copy") is auto-resolved;
// a LATER concurrent edit (both sides changed from a shared base → "merge"/"edit-wins-*") always prompts
// — that genuinely needs a human. Pure + total for unit testing.
export function configAutoResolveChoice(reason: string, surface: ConfigSurface | null, dir: ConfigDirection | undefined): "local" | "remote" | null {
  if (reason !== "conflict-copy" || !surface || !dir) return null;
  return dir === "download" ? "remote" : "local";
}

// The plugin id of a given community-plugin path under `.obsidian/plugins/`, or null.
export function pluginIdOf(path: string): string | null {
  if (!path.startsWith(CONFIG_PREFIX)) return null;
  const rest = path.slice(CONFIG_PREFIX.length);
  if (!rest.startsWith("plugins/")) return null;
  const id = rest.slice("plugins/".length).split("/")[0];
  return id || null;
}

// OS/tool junk the server refuses on commit (its is_junk): trying to sync these just produces noisy
// HTTP 400s per file, so skip them client-side too. EXACT mirror of the server list (basename match on
// any path segment — a `.git` dir anywhere, or the OS thumbnail/metadata files) plus the crash-orphaned
// atomic-write temps. Kept an exact mirror so the client skips PRECISELY what the server rejects.
export function isJunkFile(path: string): boolean {
  if (path.endsWith(".selfsync-part") || path.endsWith(".selfsync-tmp")) return true;
  for (const seg of path.split("/")) {
    if (seg === ".DS_Store" || seg === "Thumbs.db" || seg === "desktop.ini" || seg === ".git") return true;
  }
  return false;
}

// True if `path` should participate in sync given the selection and this device's own
// SelfSync plugin id (the folder that must never sync).
export function shouldSync(path: string, sel: ConfigSyncSelection, selfPluginId: string): boolean {
  // (0) Never sync OS/tool junk (Thumbs.db, .DS_Store, desktop.ini, .git) or a crash-orphaned
  // atomic-write temp (`<name>.selfsync-part`/`.selfsync-tmp`). The server 400s all of these on
  // commit, so attempting them only spams the log — skip them here (defense in depth + quiet).
  if (isJunkFile(path)) return false;
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
    // ALLOWLIST: a plugin syncs only if the user explicitly opted it in. A new plugin's folder is
    // NOT in pluginAllow, so it stays device-local until the user adds it (per-plugin or bulk).
    return sel.pluginAllow.includes(id);
  }

  // (3) unrecognized .obsidian/ file → device-local, never synced
  return false;
}

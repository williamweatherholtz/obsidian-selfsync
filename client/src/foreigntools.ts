// Coexistence with OTHER sync tools operating on the same directory (STPA UCA-52 / SR-47, c14OtherSyncTools).
// The plugin cannot command Syncthing, Dropbox, Nextcloud, Resilio or iCloud — it can only recognise their
// footprints and stay out of their way. Two footprints matter:
//   (1) ARTEFACTS the other tool writes that are NOT the user's content — its conflict copies, version
//       folders, markers, placeholders, lock files. Syncing them would propagate one tool's bookkeeping to
//       every device as notes, and deleting them (because a device without that tool lacks them) would
//       fight the tool that owns them. Such paths are skipped ENTIRELY (never pushed, never pulled, never a
//       base, never read as a deletion) — the same "not in scope" semantics as a declined config path.
//   (2) MARKERS that prove a tool is present (`.stfolder`, `.dropbox`, `.sync`), so the settings tab can
//       NAME what was detected instead of the user guessing why files are skipped.
// Pure + total (no Obsidian API), exhaustively unit-tested (foreigntools.test.ts). Only UNAMBIGUOUS shapes
// are matched: OneDrive's `name-DEVICE.md` and Google Drive's `name (1).md` collide with ordinary user
// naming and are deliberately NOT classified — a false positive here would silently un-sync a real note.
export type ForeignTool = "Syncthing" | "Dropbox" | "Nextcloud" | "Resilio Sync" | "iCloud Drive" | "Office";
export type ArtefactKind = "conflictCopy" | "marker" | "versions" | "placeholder" | "lock";
export interface ForeignArtefact { tool: ForeignTool; kind: ArtefactKind }

// Syncthing: `name.sync-conflict-20260907-101500-ABCDEFG.md` (date-time-deviceIdPrefix).
const SYNCTHING_CONFLICT = /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(\.|$)/;
// Dropbox: `name (conflicted copy 2026-09-07).md` / `name (Alice's conflicted copy 2026-09-07).md`;
// Nextcloud: `name (conflicted copy 2026-09-07 101500).md`.
const CONFLICTED_COPY = / \((?:[^()]* )?conflicted copy(?: \d{4}-\d{2}-\d{2}(?: \d{6})?)?\)/;
// Resilio Sync: `name.Conflict.md` style ("<name>.Conflict<ext>") is only classified with the `.sync` marker
// present elsewhere — too generic alone — so it is NOT matched here; its folder marker is.
const ICLOUD_PLACEHOLDER = /^\..+\.icloud$/;

export function foreignArtefact(path: string): ForeignArtefact | null {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return null;
  for (const seg of segs) {
    // Directory / marker segments — anywhere in the path (a `.stversions/` tree, a `.dropbox.cache/` tree).
    switch (seg) {
      case ".stfolder": return { tool: "Syncthing", kind: "marker" };
      case ".stignore": return { tool: "Syncthing", kind: "marker" };
      case ".stversions": return { tool: "Syncthing", kind: "versions" };
      case ".dropbox": return { tool: "Dropbox", kind: "marker" };
      case ".dropbox.cache": return { tool: "Dropbox", kind: "versions" };
      case ".sync": return { tool: "Resilio Sync", kind: "marker" };
    }
  }
  const base = segs[segs.length - 1];
  if (SYNCTHING_CONFLICT.test(base)) return { tool: "Syncthing", kind: "conflictCopy" };
  if (CONFLICTED_COPY.test(base)) {
    // Nextcloud appends a 6-digit time; Dropbox does not. Both are conflict copies; the tool name is a hint.
    return { tool: / \d{6}\)/.test(base) ? "Nextcloud" : "Dropbox", kind: "conflictCopy" };
  }
  if (ICLOUD_PLACEHOLDER.test(base)) return { tool: "iCloud Drive", kind: "placeholder" };
  if (base.startsWith("~$") || /^\.~lock\..+#$/.test(base)) return { tool: "Office", kind: "lock" };
  return null;
}

export function isForeignArtefact(path: string): boolean { return foreignArtefact(path) !== null; }

// Vault-root MARKERS a tool leaves even when it has produced no conflict copy. Obsidian's file index never lists
// dot-prefixed paths, so these must be probed with the adapter (ObsidianVaultIo.list does, once per listing) —
// without that the settings row could only ever name a tool after it had already caused a conflict.
export const FOREIGN_ROOT_MARKERS: readonly string[] = [".stfolder", ".stignore", ".stversions", ".dropbox", ".dropbox.cache", ".sync"];

// Summarise a listing: which tools are evidenced (any artefact of theirs) and how many paths each accounts
// for. Feeds the settings row ("Syncthing detected — 12 of its files not synced") and a once-per-change log.
export interface ForeignSummary { tools: ForeignTool[]; skipped: number; byTool: Record<string, number> }
export function summarizeForeign(paths: Iterable<string>): ForeignSummary {
  const byTool: Record<string, number> = {};
  let skipped = 0;
  for (const p of paths) {
    const a = foreignArtefact(p);
    if (!a) continue;
    skipped++;
    byTool[a.tool] = (byTool[a.tool] ?? 0) + 1;
  }
  return { tools: Object.keys(byTool).sort() as ForeignTool[], skipped, byTool };
}

export function describeForeign(s: ForeignSummary): string {
  if (s.tools.length === 0) return "";
  const parts = s.tools.map((t) => `${t} (${s.byTool[t]} file${s.byTool[t] === 1 ? "" : "s"})`);
  return `${parts.join(", ")} detected — ${s.skipped === 1 ? "its file is" : "their files are"} left to that tool and not synced`;
}

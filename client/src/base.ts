export interface BaseEntry { hash: string; text?: string }

// The per-file "base" = the last-synced state (common ancestor for merges).
// Persisted across restart via the plugin's saveData; `text` is kept only for
// mergeable (UTF-8 text) files so three-way merge has an ancestor to work from.
export class BaseStore {
  private m: Map<string, BaseEntry>;
  constructor(initial: Record<string, BaseEntry> = {}) {
    this.m = new Map(Object.entries(initial));
  }
  get(path: string): BaseEntry | undefined { return this.m.get(path); }
  set(path: string, entry: BaseEntry): void { this.m.set(path, entry); }
  delete(path: string): void { this.m.delete(path); }
  paths(): string[] { return [...this.m.keys()]; }
  toJSON(): Record<string, BaseEntry> { return Object.fromEntries(this.m); }
}

function pad(n: number, w = 2): string { return n.toString().padStart(w, "0"); }

export function conflictCopyName(path: string, device: string, when: Date, tag = ""): string {
  // Timestamp to the SECOND plus a short content tag (e.g. the local hash prefix), so
  // two conflicts on the same path/device close in time produce DIFFERENT names and the
  // second copy can never overwrite (and destroy) the first.
  const ts = `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}`
    + `${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}`;
  const suffix = tag ? `-${tag}` : "";
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${stem} (conflict ${device} ${ts}${suffix})${ext}`;
}

// Inverse of conflictCopyName: given a path, return the ORIGINAL path it's a conflict copy of, or
// null if it isn't one. Matches the exact "<orig> (conflict <device> <14-digit ts>[-tag])" shape
// (the 14-digit timestamp keeps a user's own "(conflict …)"-named file from false-matching). Used to
// DERIVE the set of unresolved conflicts from the vault, so it can never go stale.
export function originalOfConflictCopy(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const m = stem.match(/^(.*) \(conflict .+ \d{14}(?:-[0-9a-z]+)?\)$/i);
  return m ? `${dir}${m[1]}${ext}` : null;
}
export function isConflictCopy(path: string): boolean { return originalOfConflictCopy(path) !== null; }

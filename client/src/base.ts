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

export function conflictCopyName(path: string, device: string, when: Date): string {
  const ts = `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}`;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${stem} (conflict ${device} ${ts})${ext}`;
}

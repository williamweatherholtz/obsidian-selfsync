// `size`/`mtime` are an OPTIONAL scan-skip hint (perf, Finding 2): the file's on-disk
// (size, mtime) at the last time we confirmed it equals this base. A whole-vault reconcile
// can then skip the read+SHA-256 for a file whose (size, mtime) are unchanged — the standard
// rsync/Syncthing scan optimization. They're a hint only: absent/stale ⇒ fall back to hashing,
// so correctness never depends on them, and a real local edit is caught by the event path
// (reconcilePath always reads) regardless.
export interface BaseEntry { hash: string; text?: string; size?: number; mtime?: number }

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
  // Record the on-disk (size, mtime) of a file we've just confirmed equals its base, so the next
  // whole-vault pass can skip re-hashing it. In-memory only (no persist) — an optimization hint.
  stampStat(path: string, size: number, mtime: number): void {
    const e = this.m.get(path);
    if (e) { e.size = size; e.mtime = mtime; }
  }
  // Persist hash + text only — NOT the (size, mtime) scan-skip hint (R15 sync#3). The hint is a
  // session-only optimization: dropping it here means a fresh start re-hashes every file once (the
  // connect reconcile does that anyway) and re-stamps in memory, so the missed-event backstop is
  // fully restored on restart rather than weakened by a stale persisted stamp — while the recurring
  // in-session 15-min re-hash (the actual perf win) is still eliminated.
  toJSON(): Record<string, { hash: string; text?: string }> {
    return Object.fromEntries([...this.m].map(([p, e]) => [p, e.text !== undefined ? { hash: e.hash, text: e.text } : { hash: e.hash }]));
  }
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

// DERIVE the set of unresolved note conflicts purely from the vault's file list — a conflict IS an
// owned conflict-copy file (recognized by the strict scheme above), so the list/count/modal are a
// pure projection of the vault and can NEVER go stale or disagree with a cached array. Idempotent +
// total; the single source of truth for note conflicts (D-conflict-model). Pure → unit-testable.
export function deriveNoteConflicts(paths: readonly string[]): { copy: string; original: string }[] {
  const out: { copy: string; original: string }[] = [];
  for (const p of paths) { const original = originalOfConflictCopy(p); if (original) out.push({ copy: p, original }); }
  return out;
}

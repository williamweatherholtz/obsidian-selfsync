// `size`/`mtime` are an OPTIONAL scan-skip hint (perf, Finding 2): the file's on-disk
// (size, mtime) at the last time we confirmed it equals this base. A whole-vault reconcile
// can then skip the read+SHA-256 for a file whose (size, mtime) are unchanged — the standard
// rsync/Syncthing scan optimization. They're a hint only: absent/stale ⇒ fall back to hashing,
// so correctness never depends on them, and a real local edit is caught by the event path
// (reconcilePath always reads) regardless. Persisted across restart (toJSON,
// issueScanSkipHintNotPersisted) so a reload doesn't re-hash the whole vault.
// `normHash` = the NORMALIZED content hash (managed timestamp keys masked) at the last sync. Unlike the
// (size, mtime) perf hint, it is identity-meaningful — it lets a copy/re-stamp (raw hash differs, normHash
// equal) be recognized as "no genuine change", so it IS persisted (see toJSON).
export interface BaseEntry { hash: string; text?: string; size?: number; mtime?: number; normHash?: string }

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
  // whole-vault pass can skip re-hashing it. Persisted (see toJSON) so the skip survives a reload
  // (issueScanSkipHintNotPersisted) — still a hint: absent/stale ⇒ fall back to hashing.
  stampStat(path: string, size: number, mtime: number): void {
    const e = this.m.get(path);
    if (e) { e.size = size; e.mtime = mtime; }
  }
  // Persist hash + text + normHash AND the (size, mtime) scan-skip hint (issueScanSkipHintNotPersisted,
  // 2026-08-02 — REVERSES the earlier drop-on-persist). Dropping the stamp meant EVERY plugin reload re-read
  // + re-hashed the WHOLE vault on the first connect (owner: "reconciling ~1100 files, changed nothing") —
  // the field cost that motivated this. Persisting it makes a reload trust the same (size,mtime) heuristic
  // the in-session skip already uses, so an unchanged vault reconnects cheaply. TRADEOFF (the exact
  // rsync/Syncthing residual the in-session skip ALREADY accepts, now spanning restarts): a file changed OUT
  // of Obsidian while the plugin was off, preserving BOTH size AND mtime, isn't re-hashed on reload — a
  // DELAY (caught on the next edit event / any size|mtime change), never data loss, and never hides a REMOTE
  // change (those are detected via the server manifest, independent of the local scan-skip). The stamp is
  // internally consistent: stampStat only sets size/mtime on an entry right after confirming content == its
  // hash. (Owner-directed; ships as a recorded delivery design choice + spec/critique/TDD.)
  toJSON(): Record<string, { hash: string; text?: string; normHash?: string; size?: number; mtime?: number }> {
    return Object.fromEntries([...this.m].map(([p, e]) => {
      const o: { hash: string; text?: string; normHash?: string; size?: number; mtime?: number } = { hash: e.hash };
      if (e.text !== undefined) o.text = e.text;
      if (e.normHash !== undefined) o.normHash = e.normHash;
      if (e.size !== undefined) o.size = e.size;
      if (e.mtime !== undefined) o.mtime = e.mtime;
      return [p, o];
    }));
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
// @audit r2 2026-07-18 — EXEMPLARY, no change: pure, total, single-source-of-truth derivation of note
// conflicts from the vault file list (no cached array to go stale); the 14-digit-timestamp anchor avoids
// false-matching a user's own "(conflict …)" file, and it round-trips dotted/extensionless stems.
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

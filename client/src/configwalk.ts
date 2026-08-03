// A bounded PARALLEL walk of the hidden `.obsidian/` config tree. The original enumeration was fully
// SEQUENTIAL — one awaited `adapter.list(dir)` / `adapter.stat(file)` at a time, depth-first — so on a
// latency-bound adapter (mobile: each fs call round-trips a bridge) a plugin-heavy `.obsidian` tree cost
// many seconds (owner field report: ~18s of a connect). This walks the same tree but runs the adapter
// calls concurrently under a GLOBAL cap, collapsing the wall-clock from (call COUNT × latency) toward
// (tree DEPTH × latency). Read-only + pure: no plugin/Obsidian coupling, so it is unit-testable, and it
// finds exactly the same file set as the sequential walk (order-independent — keyed by path).
//
// issueConfigWalkSlow.

// The minimal adapter surface the walk needs — matches Obsidian's DataAdapter.list/stat.
export interface WalkAdapter {
  list(dir: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ mtime?: number; size?: number; ctime?: number } | null>;
}
export interface WalkStats { dirs: number; files: number } // folders listed + files statted (diagnostic)
export type WalkEntry = { mtime: number; size: number; ctime?: number };

// A tiny counting semaphore: `run` acquires a slot, runs `fn`, and releases (handing the slot directly to
// the next waiter so the in-flight count can never exceed `limit`). Bounds TOTAL concurrent adapter calls
// across the whole recursive walk — a per-call mapPool can't, because recursion would multiply its cap.
class Semaphore {
  private avail: number;
  private q: (() => void)[] = [];
  constructor(n: number) { this.avail = Math.max(1, n); }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.avail <= 0) await new Promise<void>((r) => this.q.push(r)); // wait for a freed slot…
    else this.avail--;                                                   // …or take one now
    try { return await fn(); }
    finally { const w = this.q.shift(); if (w) w(); else this.avail++; } // pass the slot on, or return it
  }
}

// Walk `root` and every subfolder, returning the (path → {mtime,size,ctime}) map for files that `passes`,
// plus counts. `onListError(dir, e)` is called for a directory that can't be listed (a cloud placeholder /
// lock) — that subtree is skipped, NOT treated as empty (the caller must not infer deletions from it), and
// the rest of the walk continues. `limit` = max concurrent adapter calls.
export async function walkConfigTree(
  root: string,
  adapter: WalkAdapter,
  passes: (path: string) => boolean,
  limit: number,
  onListError: (dir: string, e: unknown) => void,
): Promise<{ entries: Map<string, WalkEntry>; stats: WalkStats }> {
  const entries = new Map<string, WalkEntry>();
  const stats: WalkStats = { dirs: 0, files: 0 };
  const sem = new Semaphore(limit);
  async function walk(dir: string): Promise<void> {
    stats.dirs++;
    let listing: { files: string[]; folders: string[] };
    try { listing = await sem.run(() => adapter.list(dir)); }
    catch (e) { onListError(dir, e); return; } // skip this subtree; caller must NOT read absence from it
    await Promise.all([
      // stat the passing files in this dir concurrently (each takes a slot)…
      ...listing.files.filter(passes).map((file) => (async () => {
        stats.files++;
        try {
          const st = await sem.run(() => adapter.stat(file));
          entries.set(file, { mtime: st?.mtime ?? 0, size: st?.size ?? 0, ctime: st?.ctime });
        } catch { /* skip an unreadable file — same as the sequential walk */ }
      })()),
      // …and recurse into subfolders concurrently (the semaphore caps the TOTAL in-flight calls).
      ...listing.folders.map((f) => walk(f)),
    ]);
  }
  await walk(root);
  return { entries, stats };
}

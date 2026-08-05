// Pure logic behind the Push/Pull PREVIEW (nPushPullPreview): classify what an authoritative overwrite
// will do to each file of a plugin's folder, and produce a compact line diff for the changed text ones.
// No Obsidian API + total, so it's exhaustively unit-testable and can't drift from the real push/pull.
import { lcsPairs } from "./merge";

// What Push/Pull will do to ONE file — mirrors resolveConfigConflict exactly (reconcile.ts):
//   push (local->server): local absent => delete on server; else overwrite/create on server.
//   pull (server->local): server absent => delete here;     else overwrite/create here.
export type PushPullOp = "overwrite" | "create" | "delete" | "unchanged";
export interface FileChange { path: string; op: PushPullOp }
export type PushDirection = "push" | "pull";

// A change row enriched with the SERVER copy's provenance (nChangeAttribution): WHO last committed the
// server's version and WHEN. Shown so a Push tells you whose settings you're overwriting, and a Pull tells
// you whose settings you're adopting. Present only where a server copy is involved (overwrite/create/delete
// that touches the server side); absent for a local-only file. `author` is the server-authenticated user.
export interface FileChangeView extends FileChange { author?: string; deviceName?: string; mtime?: number }

// The human "who" for a server copy's provenance line: "user · Device" when both are known, else whichever
// is known, else null (a pre-provenance file has no author — the caller then shows just the timestamp).
export function serverProvenanceWho(author?: string, deviceName?: string): string | null {
  if (author && deviceName) return `${author} · ${deviceName}`;
  return author ?? deviceName ?? null;
}

// One side's state for a path: whether it's PRESENT there and (when known) its content HASH. `present` with
// `hash === undefined` means "present but content not compared" — a large file we deliberately didn't read
// to bound memory — which is treated as possibly-different (never provably unchanged). The two notions are
// separate precisely so an unreadable-but-existing local file classifies correctly: the caller sets local
// `present` to match what the REAL action sees (readOrNull for a push source; on-disk existence for a pull
// target — see reconcile.resolveConfigConflict), so the preview never disagrees with the overwrite.
export interface SideState { present: boolean; hash?: string }

// Classify each union path. Direction picks the SOURCE (winner) vs the TARGET (overwritten): push => local
// is source; pull => server is source. Mirrors resolveConfigConflict exactly: source-present + target-absent
// = create; source-absent + target-present = delete; both present = overwrite unless PROVABLY equal.
export function classifyPushPull(
  files: readonly { path: string; local: SideState; server: SideState }[],
  direction: PushDirection,
): FileChange[] {
  return files.map(({ path, local, server }) => {
    const [src, tgt] = direction === "push" ? [local, server] : [server, local];
    let op: PushPullOp;
    if (src.present && !tgt.present) op = "create";
    else if (!src.present && tgt.present) op = "delete";
    else if (src.present && tgt.present) {
      // Only "unchanged" when we can PROVE equality (both hashes known + equal); an unread (large) side is
      // conservatively an overwrite. The real push/pull re-writes it anyway (the server short-circuits an
      // identical re-commit), so over-reporting is safe — under-reporting a real change would not be.
      op = src.hash !== undefined && tgt.hash !== undefined && src.hash === tgt.hash ? "unchanged" : "overwrite";
    } else op = "unchanged"; // absent on both sides → nothing to do
    return { path, op };
  });
}

export interface ChangeCounts { overwrite: number; create: number; delete: number; unchanged: number }
export function countChanges(changes: readonly FileChange[]): ChangeCounts {
  const c: ChangeCounts = { overwrite: 0, create: 0, delete: 0, unchanged: 0 };
  for (const ch of changes) c[ch.op]++;
  return c;
}
// The count of files this overwrite actually touches (everything but unchanged) — the headline number.
export function touchedCount(changes: readonly FileChange[]): number {
  return changes.reduce((n, ch) => n + (ch.op === "unchanged" ? 0 : 1), 0);
}

// Instant, network-free convergence check behind the Push/Pull GREY-OUT (nPushPullPreview): is a plugin
// folder already in sync (local == the last-synced base)? Compares the base's persisted (size, mtime) stamps
// to a fresh scoped local walk — NO hashing, NO server fetch. Converged ⟺ the SAME set of syncable files AND
// every base file's stamp matches local. Conservative: a missing stamp, a set mismatch, or a missing file →
// NOT converged, so the buttons stay live rather than falsely greying an action that would do something.
export function stampsConverged(
  base: readonly { path: string; size?: number; mtime?: number }[],
  local: ReadonlyMap<string, { size: number; mtime: number }>,
): boolean {
  if (base.length !== local.size) return false; // a local-only file (would push) or a base file gone locally (would delete)
  for (const b of base) {
    const l = local.get(b.path);
    if (!l) return false;                                        // base file missing locally → diverged
    if (b.size === undefined || b.mtime === undefined) return false; // no cheap stamp → can't confirm → assume actionable
    if (l.size !== b.size || l.mtime !== b.mtime) return false;  // local (size,mtime) changed since base → diverged
  }
  return true; // same set + every stamp matches → converged → Push and Pull are both no-ops
}

export type DiffLine = { type: "add" | "del" | "ctx"; text: string };

// The full preview the modal renders: the direction, plugin name, human endpoint labels (from -> to), the
// per-file classification, and a LAZY per-file diff loader (fetches/decodes on demand so the modal opens
// instantly and only downloads a file's content when its diff is expanded). loadDiff resolves to the line
// diff, or a marker for a non-text ("binary") or oversized ("too-large") file.
export interface PluginPushPreview {
  direction: PushDirection;
  name: string;
  fromLabel: string;
  toLabel: string;
  changes: FileChangeView[];
  loadDiff: (path: string) => Promise<DiffLine[] | "binary" | "too-large">;
}
// Above this combined line count the LCS DP (O(n·m)) is too heavy for a modal — return null ("too large
// to diff") and let the caller fall back to a plain "content changed" row.
const MAX_DIFF_LINES = 2000;

// A unified line diff from `oldText` (the TARGET being overwritten) to `newText` (the SOURCE winning): del
// lines leave the target, add lines arrive from the source, ctx lines are unchanged. Reuses the tested LCS
// anchors from merge.ts so it can never disagree with the merge engine on what "the same line" means.
export function lineDiff(oldText: string, newText: string): DiffLine[] | null {
  const A = oldText.length ? oldText.split("\n") : [];
  const B = newText.length ? newText.split("\n") : [];
  if (A.length + B.length > MAX_DIFF_LINES) return null;
  const out: DiffLine[] = [];
  let ai = 0, bi = 0;
  for (const [a, b] of lcsPairs(A, B)) {
    while (ai < a) out.push({ type: "del", text: A[ai++] }); // target-only lines before this anchor → removed
    while (bi < b) out.push({ type: "add", text: B[bi++] }); // source-only lines before this anchor → added
    out.push({ type: "ctx", text: A[a] }); ai = a + 1; bi = b + 1;
  }
  while (ai < A.length) out.push({ type: "del", text: A[ai++] });
  while (bi < B.length) out.push({ type: "add", text: B[bi++] });
  return out;
}

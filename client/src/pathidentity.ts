// PATH IDENTITY — the one place that decides whether two path strings name the same on-disk file here.
//
// Why this module exists: path identity was decided ad hoc, by a bare `.toLowerCase()` in three places
// (BaseStore.foldSibling, reconcile's foldIndex and caseRenamedTombstones), while every other key-space
// (unsyncedEdits, rejectedPushes, the flip guard) keyed on whatever string its caller happened to hold.
// Two spellings of one file then drifted into different keys, and the drift surfaced much later as
// something unrelated-looking: a status light latched on "Syncing…" (issue005), a phantom delete on a
// folding peer (issueCaseRenamePairDeletesOnFoldingPeer), unpushable folders (issueCasePathDivergence).
// About ten recorded issues belong to this one class (owner direction st004, 2026-09-29).
//
// Two rules follow:
//  1. Any comparison or map key that means "the same file" goes through identityKey(), never a raw string.
//  2. A state that should be impossible is REPORTED here (pathViolation), never skipped silently. The
//     default handler THROWS, so a test or an unconfigured caller fails at the site. The plugin installs a
//     handler that logs an ERROR and surfaces it to the user; the caller decides whether the path is also
//     held (a destructive write on an ambiguous path is refused — owner choice, 2026-09-29).

/** The identity rules of the filesystem the vault lives on. */
export interface PathFs {
  /** Two spellings differing only in letter case are one file (Windows, macOS, iOS). */
  caseInsensitive: boolean;
  /**
   * Two spellings differing only in Unicode normalisation (NFC vs NFD) are one file (macOS/iOS: APFS
   * and HFS+). NOT Windows: NTFS stores both forms as distinct names, so folding them there would alias
   * two real files.
   */
  normInsensitive: boolean;
}

export const EXACT_FS: PathFs = { caseInsensitive: false, normInsensitive: false };

/**
 * The identity key of `path` on `fs`: two paths are the same file here iff their keys are equal.
 * NFC before lower-casing, so a decomposed accent folds the same way as a composed one.
 */
export function identityKey(path: string, fs: PathFs): string {
  const n = fs.normInsensitive ? path.normalize("NFC") : path;
  return fs.caseInsensitive ? n.toLowerCase() : n;
}

export function sameFile(a: string, b: string, fs: PathFs): boolean {
  return a === b || identityKey(a, fs) === identityKey(b, fs);
}

/** identity key → the FIRST spelling seen for it. Later spellings of the same file are ignored here. */
export function identityIndex(keys: Iterable<string>, fs: PathFs): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of keys) { const f = identityKey(k, fs); if (!m.has(f)) m.set(f, k); }
  return m;
}

/**
 * Groups of two or more DISTINCT spellings in `keys` that are one file on `fs`. Empty when every key is
 * its own file. Used where the input should never hold such a group (a server manifest, the base).
 */
export function identityGroups(keys: Iterable<string>, fs: PathFs): string[][] {
  if (!fs.caseInsensitive && !fs.normInsensitive) return [];
  const by = new Map<string, string[]>();
  for (const k of keys) {
    const f = identityKey(k, fs);
    const g = by.get(f);
    if (g) { if (!g.includes(k)) g.push(k); } else by.set(f, [k]);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

// ---- Violations: fail early, fail loud ----------------------------------------------------------------

export type PathViolationKind =
  | "duplicate-identity"   // one collection holds two spellings of one file
  | "alias-crossed-files"  // an alias mapped a path onto a DIFFERENT file (never legitimate)
  | "listing-two-spellings"; // the local listing reports two spellings of one file on a filesystem that cannot hold both

export interface PathViolation {
  kind: PathViolationKind;
  /** The function that detected it, e.g. "reconcileAll/remote-manifest". */
  site: string;
  /** Every spelling involved, exactly as held. */
  paths: string[];
  detail?: string;
}

export class PathIdentityError extends Error {
  constructor(readonly violation: PathViolation) {
    super(describePathViolation(violation));
    this.name = "PathIdentityError";
  }
}

export function describePathViolation(v: PathViolation): string {
  const paths = v.paths.map((p) => `'${p}'`).join(", ");
  return `path identity violation (${v.kind}) at ${v.site}: ${paths}${v.detail ? ` - ${v.detail}` : ""}`;
}

type Handler = (v: PathViolation) => void;
const THROW: Handler = (v) => { throw new PathIdentityError(v); };
let handler: Handler = THROW;

/**
 * Install the handler for violations and return the previous one. The plugin installs a logging handler
 * at load; a test that deliberately provokes a violation installs a collecting one and restores after.
 */
export function setPathViolationHandler(h: Handler | null): Handler {
  const prev = handler;
  handler = h ?? THROW;
  return prev;
}

/** Report a violated path-identity invariant. Throws under the default handler. */
export function pathViolation(v: PathViolation): void {
  handler(v);
}

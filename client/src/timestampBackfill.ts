// Pure planning for the embedded-timestamp backfill (1.8.0). No Obsidian/IO — the impure walk, push,
// marker persistence, and pacing live in main.ts; this module decides WHAT to do with one note and how to
// version the policy, so both are exhaustively unit-testable (mirrors configsync.ts / statuslight.ts).
import { noteCompliant, conformTimestamps, normalizedContent } from "./frontmatter";

// A change to the managed keys or the excluded set invalidates convergence (re-walk). `driveFsTimes` and the
// (fixed, single) format do NOT change note bytes, so they are deliberately excluded — flipping them must not
// re-stamp the vault. Order-insensitive so a reordered excluded list isn't a spurious policy change.
export function timestampPolicySignature(managedKeys: string[], excludedFolders: string[]): string {
  return JSON.stringify({ keys: managedKeys, excluded: [...excludedFolders].sort() });
}

export interface BackfillPlan {
  conformed: string | null; // null = nothing to do (already compliant)
  needsCopy: boolean;       // the conform changed MORE than our managed keys → preserve original as a copy
}

// Decide what to do with one in-scope note. `needsCopy` drives the reversible first pass: it is true only
// when the conformed bytes differ from the original in something OTHER than our managed keys (i.e. the edit
// wasn't a provably-clean additive/normalizing stamp — e.g. malformed/unterminated frontmatter). With the
// block-scalar-safe surgical writer, a well-formed note is always a clean conform (needsCopy = false).
export function planBackfillItem(text: string, keys: string[], ctime: number | undefined, mtime: number | undefined, now: number, tzOffsetMin: number): BackfillPlan {
  if (noteCompliant(text, keys)) return { conformed: null, needsCopy: false };
  const conformed = conformTimestamps(text, keys, ctime, mtime, now, tzOffsetMin);
  const needsCopy = normalizedContent(text, keys) !== normalizedContent(conformed, keys);
  return { conformed, needsCopy };
}

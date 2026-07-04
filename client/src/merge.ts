const TEXT_EXT = [".md", ".markdown", ".txt", ".canvas"];

export function isMergeable(path: string, bytes: Uint8Array): boolean {
  const lower = path.toLowerCase();
  if (!TEXT_EXT.some((e) => lower.endsWith(e))) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function splitLines(s: string): string[] {
  return s.length === 0 ? [] : s.split("\n");
}

// LCS alignment: increasing (baseIndex, otherIndex) pairs where lines are equal.
function lcsPairs(base: string[], other: string[]): Array<[number, number]> {
  const n = base.length, m = other.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = base[i] === other[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (base[i] === other[j]) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return out;
}

// Line-level three-way merge (diff3). `clean` is false when both sides changed the
// same region differently. Predictable and conflict-detecting — unlike a fuzzy
// character patch, an overlapping edit is a conflict, never silently mangled.
export function merge3(base: string, local: string, remote: string): { merged: string; clean: boolean } {
  if (local === remote) return { merged: local, clean: true };
  if (base === local) return { merged: remote, clean: true };
  if (base === remote) return { merged: local, clean: true };

  const B = splitLines(base), L = splitLines(local), R = splitLines(remote);
  const lb = new Map(lcsPairs(B, L)); // baseIdx -> localIdx (anchors vs local)
  const rb = new Map(lcsPairs(B, R)); // baseIdx -> remoteIdx (anchors vs remote)
  // Anchors = base lines stable in BOTH local and remote (present + aligned).
  const anchors: Array<[number, number, number]> = [];
  for (let bi = 0; bi < B.length; bi++) {
    if (lb.has(bi) && rb.has(bi)) anchors.push([bi, lb.get(bi)!, rb.get(bi)!]);
  }

  const out: string[] = [];
  let clean = true;
  let pb = -1, pl = -1, pr = -1;
  const resolveGap = (bs: string[], ls: string[], rs: string[]) => {
    const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (eq(ls, bs)) out.push(...rs);          // only remote changed this region
    else if (eq(rs, bs)) out.push(...ls);     // only local changed this region
    else if (eq(ls, rs)) out.push(...ls);     // both made the same change
    else { clean = false; out.push(...ls); }  // both changed differently -> conflict
  };
  for (const [bi, li, ri] of anchors) {
    resolveGap(B.slice(pb + 1, bi), L.slice(pl + 1, li), R.slice(pr + 1, ri));
    out.push(B[bi]); // the stable anchor line
    pb = bi; pl = li; pr = ri;
  }
  // tail after the last anchor
  resolveGap(B.slice(pb + 1), L.slice(pl + 1), R.slice(pr + 1));

  return { merged: out.join("\n"), clean };
}

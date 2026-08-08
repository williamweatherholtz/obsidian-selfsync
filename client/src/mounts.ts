// Pure logic for composed-vault MOUNTS (D0039, nComposedVaults). A Mount maps a subfolder of a SOURCE
// server-vault (`sourcePath` within S) to a LOCAL subfolder (`mountPoint`), data-only + directional. This
// module is the two-sided PATH MATH + the boundary/overlap RULES — no Obsidian API, no engine — so the
// path translation AND the load-bearing "the primary scope excludes every mount point" invariant are
// exhaustively unit-testable and can never drift from the reconcile that consumes them.

export type MountDirection = "pull" | "sync"; // pull = S→local (read-only); sync = bidirectional
export interface MountSource { owner: string; vaultId: string; sourcePath: string } // sourcePath "" = whole source vault
export interface Mount { source: MountSource; mountPoint: string; direction: MountDirection }

// Normalize a folder path to bare segments joined by "/": no leading/trailing/duplicate slashes, no ""/"."/
// ".." segments. The single source of truth for how a mount/source path is compared + built. It must
// ROUND-TRIP real file paths EXACTLY, so it never trims a segment's interior/whitespace — a filename with a
// legitimate leading/trailing space (" note .md") must survive local↔source translation intact. `..` is
// dropped (a real vault path never contains it; a malicious source path using it to escape a scope is
// neutralized here as defense-in-depth, on top of the asSafeVaultPath sink guard).
export function normFolder(p: string): string {
  return p.split("/").filter((s) => s !== "" && s !== "." && s !== "..").join("/");
}

// Sanitize a USER-CONFIGURED mount/source folder (mountPoint / sourcePath) — NOT a real file path. Splits on
// both `/` and `\` (a Windows-style backslash mount point would otherwise be one inert segment), trims each
// segment's whitespace and strips trailing dots (which Windows silently drops on the FS, so "Work/ASI " or
// "Work/ASI." must not diverge from the real "Work/ASI" folder and leak to the primary), and drops empty/
// "."/".." segments. Distinct from normFolder, which must NOT mutate real file-path segments.
export function normMountFolder(p: string): string {
  return p.split(/[/\\]/).map((s) => s.trim().replace(/\.+$/, "")).filter((s) => s !== "" && s !== "." && s !== "..").join("/");
}

// Segments of a folder (real case preserved, for building I/O paths). The canonical form of ONE segment for
// IDENTITY comparison: NFC + case-folded, so a mount point matches the same folder reached in a different
// case (Windows/macOS are case-insensitive) or Unicode form (macOS stores NFD). This mirrors the codebase's
// existing convention (isDataPath / shouldSync self-exclusion case-fold regardless of platform); the cost is
// a benign over-claim on a genuinely case-sensitive FS (rare on Obsidian desktop), far preferable to the
// split-brain LEAK where case drift routes one physical folder to both the mount AND the primary scope.
function segsOf(folder: string): string[] { return normFolder(folder).split("/").filter(Boolean); }
function canonSeg(s: string): string { return s.normalize("NFC").toLowerCase(); }
// Is `pathSegs` equal to, or nested under, `prefixSegs` — compared segment-wise + canonically? An empty
// prefix ("whole vault") is under-or-equal to everything. Segment-wise so a name-prefix sibling ("Work/ASIx"
// vs "Work/ASI") is NOT a match.
function underOrEqual(pathSegs: readonly string[], prefixSegs: readonly string[]): boolean {
  if (prefixSegs.length === 0) return true;
  if (pathSegs.length < prefixSegs.length) return false;
  return prefixSegs.every((s, i) => canonSeg(pathSegs[i]) === canonSeg(s));
}
function segsEqual(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && underOrEqual(a, b); }

// Is `localPath` the mount point itself or under it? The primary reconcile scope must EXCLUDE exactly these,
// so a mounted file never double-syncs to the primary server vault (the load-bearing boundary invariant).
export function claimsLocal(mount: Mount, localPath: string): boolean {
  const mp = segsOf(mount.mountPoint);
  return mp.length > 0 && underOrEqual(segsOf(localPath), mp);
}
// Does ANY mount claim this local path?
export function primaryExcludes(mounts: readonly Mount[], localPath: string): boolean {
  return mounts.some((m) => claimsLocal(m, localPath));
}

// local `<mountPoint>/<rel>` → `<rel>` (the mount-relative middle the reconcile operates on), or null if the
// path is not under this mount. The returned rel keeps the REAL path's case/segments (the match is canonical,
// the slice is real), so the round-trip through localFromMountRel finds the real on-disk file.
export function mountRelFromLocal(mount: Mount, localPath: string): string | null {
  const mp = segsOf(mount.mountPoint);
  if (mp.length === 0) return null;   // a mount point is never the vault root
  const p = segsOf(localPath);
  return underOrEqual(p, mp) ? p.slice(mp.length).join("/") : null;
}
// source S-relative `<sourcePath>/<rel>` → `<rel>`, or null if not under this mount's source subtree.
export function mountRelFromSource(mount: Mount, sPath: string): string | null {
  const sp = segsOf(mount.source.sourcePath), p = segsOf(sPath);
  if (sp.length === 0) return p.join("/"); // whole-source mount: everything is under it
  return underOrEqual(p, sp) ? p.slice(sp.length).join("/") : null;
}
// mount-relative `<rel>` → local `<mountPoint>/<rel>` (built with the configured mount-point case).
export function localFromMountRel(mount: Mount, rel: string): string {
  const mp = normFolder(mount.mountPoint), r = normFolder(rel);
  return r === "" ? mp : mp === "" ? r : `${mp}/${r}`;
}
// mount-relative `<rel>` → source S-relative `<sourcePath>/<rel>`.
export function sourceFromMountRel(mount: Mount, rel: string): string {
  const sp = normFolder(mount.source.sourcePath), r = normFolder(rel);
  return sp === "" ? r : r === "" ? sp : `${sp}/${r}`;
}

// Parse an untrusted persisted mounts array into well-formed, NORMALIZED Mounts (parse-don't-validate at the
// persistence boundary). Drops malformed entries (missing source vault / empty mount point); SANITIZES both
// folders via normMountFolder (trims stray whitespace / trailing dots / backslashes so a hand-edited config
// can't silently mis-match the real FS); defaults an unknown direction to the safe "pull". Overlap/nesting/
// config-anchoring is a separate validateMounts() concern surfaced in the UI, not a parse-time drop.
export function parseMounts(raw: unknown): Mount[] {
  if (!Array.isArray(raw)) return [];
  const out: Mount[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const m = e as Record<string, unknown>;
    const src = (m.source && typeof m.source === "object" ? m.source : {}) as Record<string, unknown>;
    const vaultId = typeof src.vaultId === "string" ? src.vaultId : "";
    const mountPoint = normMountFolder(typeof m.mountPoint === "string" ? m.mountPoint : "");
    if (!vaultId || !mountPoint) continue; // a mount needs a source vault + a non-root local mount point
    out.push({
      source: { owner: typeof src.owner === "string" ? src.owner : "", vaultId, sourcePath: normMountFolder(typeof src.sourcePath === "string" ? src.sourcePath : "") },
      mountPoint,
      direction: m.direction === "sync" ? "sync" : "pull",
    });
  }
  return out;
}

// Validate a mount SET (v1 rules): a mount point must be non-empty (never the vault root); neither the mount
// point NOR the source subfolder may sit inside the `.obsidian` config tree (data-only keystone — that would
// let config/credentials cross a mount boundary); and mount points must not be equal or NESTED, compared
// CANONICALLY (case/Unicode-insensitive) so two mounts over the same physical folder on a case-insensitive FS
// are caught. Returns human-readable errors (empty = valid).
export function validateMounts(mounts: readonly Mount[]): string[] {
  const errs: string[] = [];
  const pts: (string[] | null)[] = [];
  mounts.forEach((m, i) => {
    const mp = segsOf(m.mountPoint);
    if (mp.length === 0) { errs.push(`mount #${i + 1}: the mount point can't be empty or the vault root`); pts.push(null); return; }
    if (mp.some((s) => canonSeg(s) === ".obsidian")) errs.push(`mount #${i + 1}: a mount point can't be inside the .obsidian config folder (mounts sync notes only)`);
    if (segsOf(m.source.sourcePath).some((s) => canonSeg(s) === ".obsidian")) errs.push(`mount #${i + 1}: a source subfolder can't be inside the .obsidian config folder (mounts sync notes only)`);
    pts.push(mp);
  });
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const x = pts[a], y = pts[b];
      if (!x || !y) continue;
      if (segsEqual(x, y)) errs.push(`two mounts share the mount point "${mounts[a].mountPoint}"`);
      else if (underOrEqual(x, y)) errs.push(`mount point "${mounts[a].mountPoint}" is nested inside "${mounts[b].mountPoint}" (nesting is not allowed)`);
      else if (underOrEqual(y, x)) errs.push(`mount point "${mounts[b].mountPoint}" is nested inside "${mounts[a].mountPoint}" (nesting is not allowed)`);
    }
  }
  return errs;
}

// The maximal VALID, non-overlapping subset of a mount set (order-preserving, greedy). Unlike validateMounts
// (which reports errors over the WHOLE set for the UI), this DROPS only the offending entries — so one bad
// hand-edited mount can't deactivate the good ones (which would silently re-absorb their folders into the
// primary scope and upload source-derived content there, R5-MED-3). A mount is dropped if its mount point is
// empty/root, its mount point or source sits inside .obsidian, or its mount point overlaps an accepted one.
export function validMounts(mounts: readonly Mount[]): Mount[] {
  const ok: Mount[] = [];
  for (const m of mounts) {
    const mp = segsOf(m.mountPoint);
    if (mp.length === 0) continue;
    if (mp.some((s) => canonSeg(s) === ".obsidian")) continue;
    if (segsOf(m.source.sourcePath).some((s) => canonSeg(s) === ".obsidian")) continue;
    if (ok.some((o) => { const op = segsOf(o.mountPoint); return underOrEqual(mp, op) || underOrEqual(op, mp); })) continue;
    ok.push(m);
  }
  return ok;
}

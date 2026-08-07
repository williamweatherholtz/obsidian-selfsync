// Pure logic for composed-vault MOUNTS (D0039, nComposedVaults). A Mount maps a subfolder of a SOURCE
// server-vault (`sourcePath` within S) to a LOCAL subfolder (`mountPoint`), data-only + directional. This
// module is the two-sided PATH MATH + the boundary/overlap RULES — no Obsidian API, no engine — so the
// path translation AND the load-bearing "the primary scope excludes every mount point" invariant are
// exhaustively unit-testable and can never drift from the reconcile that will consume them (Phase 2+).

export type MountDirection = "pull" | "sync"; // pull = S→local (read-only); sync = bidirectional
export interface MountSource { owner: string; vaultId: string; sourcePath: string } // sourcePath "" = whole source vault
export interface Mount { source: MountSource; mountPoint: string; direction: MountDirection }

// Normalize a folder path to bare segments joined by "/": no leading/trailing/duplicate slashes, no "."/""
// segments. The single source of truth for how a mount/source path is compared + built. It must ROUND-TRIP
// real file paths EXACTLY, so it never trims a segment's interior/whitespace — a filename with a legitimate
// leading/trailing space (" note .md") must survive local↔source translation intact (trimming it would read/
// write the WRONG on-disk path). Sanitizing accidental whitespace in a USER-typed mount point is a UI-input
// concern (Phase 4), not this primitive's job.
export function normFolder(p: string): string {
  return p.split("/").filter((s) => s !== "" && s !== ".").join("/");
}
// The prefix form "<folder>/" for boundary tests. Empty folder → "" so "everything is under it" (whole-vault).
function prefix(folder: string): string { return folder === "" ? "" : folder + "/"; }

// Is `localPath` the mount point itself or under it? The primary reconcile scope must EXCLUDE exactly these,
// so a mounted file never double-syncs to the primary server vault (the load-bearing boundary invariant).
export function claimsLocal(mount: Mount, localPath: string): boolean {
  const mp = normFolder(mount.mountPoint), p = normFolder(localPath);
  return mp !== "" && (p === mp || p.startsWith(prefix(mp)));
}
// Does ANY mount claim this local path?
export function primaryExcludes(mounts: readonly Mount[], localPath: string): boolean {
  return mounts.some((m) => claimsLocal(m, localPath));
}

// local `<mountPoint>/<rel>` → `<rel>` (the mount-relative middle the reconcile operates on), or null if the
// path is not under this mount.
export function mountRelFromLocal(mount: Mount, localPath: string): string | null {
  const mp = normFolder(mount.mountPoint), p = normFolder(localPath);
  if (mp === "") return null;   // a mount point is never the vault root
  if (p === mp) return "";
  const pre = prefix(mp);
  return p.startsWith(pre) ? p.slice(pre.length) : null;
}
// source S-relative `<sourcePath>/<rel>` → `<rel>`, or null if not under this mount's source subtree.
export function mountRelFromSource(mount: Mount, sPath: string): string | null {
  const sp = normFolder(mount.source.sourcePath), p = normFolder(sPath);
  if (sp === "") return p;      // whole-source mount: everything is under it
  if (p === sp) return "";
  const pre = prefix(sp);
  return p.startsWith(pre) ? p.slice(pre.length) : null;
}
// mount-relative `<rel>` → local `<mountPoint>/<rel>`.
export function localFromMountRel(mount: Mount, rel: string): string {
  const mp = normFolder(mount.mountPoint), r = normFolder(rel);
  return r === "" ? mp : `${mp}/${r}`;
}
// mount-relative `<rel>` → source S-relative `<sourcePath>/<rel>`.
export function sourceFromMountRel(mount: Mount, rel: string): string {
  const sp = normFolder(mount.source.sourcePath), r = normFolder(rel);
  return sp === "" ? r : r === "" ? sp : `${sp}/${r}`;
}

// Parse an untrusted persisted mounts array into well-formed, NORMALIZED Mounts (parse-don't-validate at the
// persistence boundary). Drops malformed entries (missing source vault / empty mount point); normalizes both
// paths; defaults an unknown direction to the safe "pull". Overlap/nesting is a separate validateMounts()
// concern surfaced in the UI, not a parse-time drop.
export function parseMounts(raw: unknown): Mount[] {
  if (!Array.isArray(raw)) return [];
  const out: Mount[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const m = e as Record<string, unknown>;
    const src = (m.source && typeof m.source === "object" ? m.source : {}) as Record<string, unknown>;
    const vaultId = typeof src.vaultId === "string" ? src.vaultId : "";
    const mountPoint = normFolder(typeof m.mountPoint === "string" ? m.mountPoint : "");
    if (!vaultId || !mountPoint) continue; // a mount needs a source vault + a non-root local mount point
    out.push({
      source: { owner: typeof src.owner === "string" ? src.owner : "", vaultId, sourcePath: normFolder(typeof src.sourcePath === "string" ? src.sourcePath : "") },
      mountPoint,
      direction: m.direction === "sync" ? "sync" : "pull",
    });
  }
  return out;
}

// Validate a mount SET (v1 rules): a mount point must be non-empty (never the vault root), and mount points
// must not be equal or NESTED (no overlapping/nested mounts). Returns human-readable errors (empty = valid).
export function validateMounts(mounts: readonly Mount[]): string[] {
  const errs: string[] = [];
  const pts = mounts.map((m) => normFolder(m.mountPoint));
  pts.forEach((mp, i) => { if (mp === "") errs.push(`mount #${i + 1}: the mount point can't be empty or the vault root`); });
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const x = pts[a], y = pts[b];
      if (!x || !y) continue;
      if (x === y) errs.push(`two mounts share the mount point "${x}"`);
      else if (x.startsWith(prefix(y))) errs.push(`mount point "${x}" is nested inside "${y}" (nesting is not allowed)`);
      else if (y.startsWith(prefix(x))) errs.push(`mount point "${y}" is nested inside "${x}" (nesting is not allowed)`);
    }
  }
  return errs;
}

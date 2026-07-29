// Pure + total: no Obsidian API, exhaustively unit-testable (mirrors configsync.ts / statuslight.ts).
// A note is "excluded from timestamp management" when its path is, or is under, a listed folder.
// Exclusion turns OFF timestamp management for those notes; it never affects content sync.
export function normalizeFolder(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function addExcluded(list: string[], raw: string): string[] {
  const f = normalizeFolder(raw);
  if (!f) return [...list].sort();
  return [...new Set([...list, f])].sort();
}

export function removeExcluded(list: string[], raw: string): string[] {
  const f = normalizeFolder(raw);
  return list.filter((x) => x !== f).sort();
}

export function isExcluded(path: string, list: string[]): boolean {
  const p = normalizeFolder(path);
  return list.some((raw) => {
    const f = normalizeFolder(raw);
    return f !== "" && (p === f || p.startsWith(f + "/"));
  });
}

export function matchFolders(query: string, all: string[]): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  const pre: string[] = [], sub: string[] = [];
  for (const f of all) {
    const lf = f.toLowerCase();
    if (lf.startsWith(q)) pre.push(f);
    else if (lf.includes(q)) sub.push(f);
  }
  return [...pre, ...sub];
}

// Pure: line-based YAML-frontmatter handling for SelfSync's own managed scalar keys (created/updated).
// No Obsidian import, no YAML dependency. Non-frontmatter / unparseable text is handled by callers via
// a raw-bytes fallback (see normalizedHash). We only ever read/write our own top-level scalar keys, and
// we insert them at a fixed position, so SelfSync never reorders a user's YAML.
const FENCE = "---";

interface Split { hasFm: boolean; fmLines: string[]; body: string; }

function split(text: string): Split {
  // Frontmatter must be the very first line `---`, terminated by a later `---`.
  const nl = text.indexOf("\n");
  if (nl === -1 || text.slice(0, nl).trim() !== FENCE) return { hasFm: false, fmLines: [], body: text };
  const rest = text.slice(nl + 1);
  const lines = rest.split("\n");
  let close = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === FENCE) { close = i; break; }
  if (close === -1) return { hasFm: false, fmLines: [], body: text }; // unterminated → treat as plain
  const fmLines = lines.slice(0, close);
  const body = lines.slice(close + 1).join("\n");
  return { hasFm: true, fmLines, body };
}

function keyOf(line: string): string | null {
  const m = /^([A-Za-z0-9_. -]+):(?:\s.*)?$/.exec(line);
  return m ? m[1] : null;
}

export function hasFrontmatter(text: string): boolean {
  return split(text).hasFm;
}

export function getManagedValue(text: string, key: string): string | undefined {
  const s = split(text);
  if (!s.hasFm) return undefined;
  for (const line of s.fmLines) {
    if (keyOf(line) === key) {
      const idx = line.indexOf(":");
      return line.slice(idx + 1).trim() || undefined;
    }
  }
  return undefined;
}

export function setManagedValue(text: string, key: string, value: string): string {
  const s = split(text);
  const kv = `${key}: ${value}`;
  if (!s.hasFm) {
    return `${FENCE}\n${kv}\n${FENCE}\n${text}`;
  }
  const out = [...s.fmLines];
  const at = out.findIndex((l) => keyOf(l) === key);
  if (at >= 0) out[at] = kv;
  else out.unshift(kv); // fixed position: top of block → never reorders on re-stamp
  return `${FENCE}\n${out.join("\n")}\n${FENCE}\n${s.body}`;
}

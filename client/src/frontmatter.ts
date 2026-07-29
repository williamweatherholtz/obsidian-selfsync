// Pure: line-based YAML-frontmatter handling for SelfSync's own managed scalar keys (created/updated).
// No Obsidian import, no YAML dependency. Non-frontmatter / unparseable text is handled by callers via
// a raw-bytes fallback (see normalizedHash). We only ever read/write our own top-level scalar keys, and
// we insert them at a fixed position, so SelfSync never reorders a user's YAML.
import { sha256hex } from "./chunker";

const FENCE = "---";

interface Split { hasFm: boolean; fmLines: string[]; body: string; }

function split(text: string): Split {
  // Frontmatter must be the very first line `---`, terminated by a later `---`.
  const nl = text.indexOf("\n");
  if (nl === -1 || text.slice(0, nl).trim() !== FENCE) return { hasFm: false, fmLines: [], body: text };
  const rest = text.slice(nl + 1);
  const lines = rest.split(/\r?\n/); // tolerate CRLF — strip the trailing \r so keyOf/fence match on Windows notes
  let close = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === FENCE) { close = i; break; }
  if (close === -1) return { hasFm: false, fmLines: [], body: text }; // unterminated → treat as plain
  const fmLines = lines.slice(0, close);
  const body = lines.slice(close + 1).join("\n");
  return { hasFm: true, fmLines, body };
}

function keyOf(line: string): string | null {
  // Top-level scalar key: must start with a non-space key char (so an INDENTED/nested line never matches),
  // may contain internal spaces (Linter uses `date modified`), optional space before the colon, any value
  // after (including `key:value` with no space, and values containing colons like a timestamp).
  const m = /^([A-Za-z0-9_.-][A-Za-z0-9_. -]*?)\s*:.*$/.exec(line);
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
  let seen = false;
  const out: string[] = [];
  for (const l of s.fmLines) {
    if (keyOf(l) === key) { if (!seen) { out.push(kv); seen = true; } /* drop any DUPLICATE managed-key lines */ }
    else out.push(l);
  }
  if (!seen) out.unshift(kv); // absent → add at the top (stable position; never reorders on re-stamp)
  return `${FENCE}\n${out.join("\n")}\n${FENCE}\n${s.body}`;
}

// The git-model identity primitive: strip the managed keys, normalize EOL + trailing newline, so two
// versions that differ ONLY in managed keys yield identical normalized content (and hash).
export function normalizedContent(text: string, managedKeys: string[]): string {
  const lf = text.replace(/\r\n/g, "\n");
  const s = split(lf);
  if (!s.hasFm) return trimTrailing(lf);
  const kept = s.fmLines.filter((l) => {
    const k = keyOf(l);
    return k === null || !managedKeys.includes(k);
  });
  const rebuilt = `${FENCE}\n${kept.join("\n")}\n${FENCE}\n${s.body}`;
  return trimTrailing(rebuilt);
}
function trimTrailing(s: string): string { return s.replace(/\n+$/, "\n"); }

// Non-text / non-frontmatter files fall back to the RAW hash so identity == raw (legacy behaviour).
export async function normalizedHash(bytes: Uint8Array, managedKeys: string[]): Promise<string> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return sha256hex(bytes); }
  if (!hasFrontmatter(text)) return sha256hex(bytes);
  return sha256hex(new TextEncoder().encode(normalizedContent(text, managedKeys)));
}

// Pure ISO-8601-with-offset formatting. tzOffsetMin is minutes AHEAD of UTC (e.g. -360 for -06:00),
// supplied by the impure caller as -(new Date().getTimezoneOffset()). Kept as a param so this is testable.
export function formatIsoOffset(epochMs: number, tzOffsetMin: number): string {
  const local = new Date(epochMs + tzOffsetMin * 60000);
  const p = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const date = `${p(local.getUTCFullYear(), 4)}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}`;
  const time = `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}`;
  const sign = tzOffsetMin < 0 ? "-" : "+";
  const off = `${sign}${p(Math.trunc(Math.abs(tzOffsetMin) / 60))}:${p(Math.abs(tzOffsetMin) % 60)}`;
  return `${date}T${time}${off}`;
}

export function parseIso(s: string): number | undefined {
  let t = s.trim();
  // Strip surrounding YAML quotes — Linter presets / Obsidian Properties often quote string-typed dates
  // (`updated: "2026-…"`), and Date.parse of a quoted string is NaN.
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) t = t.slice(1, -1).trim();
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}

// First-seed a note that has no managed fields: prefer the file's existing OS metadata (creation /
// modification time) over "now", so adopting a pre-existing vault preserves each note's real history.
export function seedValues(ctime: number | undefined, mtime: number | undefined, now: number, tzOffsetMin: number): { created: string; updated: string } {
  return {
    created: formatIsoOffset(ctime ?? now, tzOffsetMin),
    updated: formatIsoOffset(mtime ?? now, tzOffsetMin),
  };
}

// Two versions are content-identical except the managed keys. Adopt `remote` as the canonical text, then
// overwrite each managed key with the OLDER (earliest) of the two values — once content is known identical,
// the newer stamp is spurious, so the older instant is the truthful last-real-change / creation time.
export function reconcileManagedFields(local: string, remote: string, keys: string[]): string {
  let out = remote;
  for (const key of keys) {
    const pick = pickOlder(getManagedValue(local, key), getManagedValue(remote, key));
    if (pick !== undefined) out = setManagedValue(out, key, pick);
  }
  return out;
}

// Pick the OLDER of two managed values, DETERMINISTICALLY across devices: both sides must compute the same
// winner regardless of which copy is "local", or two devices ping-pong forever (equal-instant/different-
// offset is the multi-timezone case). Rule: older parsed instant wins; a parseable value beats an
// unparseable one; a true tie (equal instant, or both unparseable) breaks on the lexicographically-smaller
// string. NEVER "prefer local".
function pickOlder(lv: string | undefined, rv: string | undefined): string | undefined {
  if (lv === undefined) return rv;
  if (rv === undefined) return lv;
  const lms = parseIso(lv), rms = parseIso(rv);
  if (lms !== undefined && rms !== undefined) {
    if (lms < rms) return lv;
    if (rms < lms) return rv;
    return lv <= rv ? lv : rv; // same instant, different string → deterministic
  }
  if (lms !== undefined) return lv; // parseable beats unparseable
  if (rms !== undefined) return rv;
  return lv <= rv ? lv : rv; // both unparseable → deterministic
}

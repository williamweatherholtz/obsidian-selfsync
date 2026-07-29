// Pure: line-based YAML-frontmatter handling for SelfSync's own managed scalar keys (created/updated).
// No Obsidian import, no YAML dependency. Non-frontmatter / unparseable text is handled by callers via
// a raw-bytes fallback (see normalizedHash). We only ever read/write our own top-level scalar keys, and
// we insert them at a fixed position, so SelfSync never reorders a user's YAML.
import { sha256hex } from "./chunker";

const BOM = "﻿";
// A frontmatter fence is `---` at COLUMN 0 (optional trailing whitespace). Requiring col-0 is what stops an
// INDENTED `---` inside a YAML block scalar (description: | … `  ---`) from false-closing the block and
// demoting real keys into the body (the shipped-1.7.0 corruption, Finding 1).
const FENCE_RE = /^---[ \t]*$/;

// Well-known THIRD-PARTY volatile timestamp keys (Obsidian Linter etc.). We never WRITE these, but we MASK
// them in the normalized-identity hash so another plugin bumping them isn't seen as a content change — which
// would otherwise ignite a cross-plugin re-stamp/re-sync storm on a bulk enable (critique Finding 4).
const VOLATILE_ALIAS_KEYS = ["date modified", "date created", "modified"];

interface Parsed {
  bom: boolean;
  eol: "\r\n" | "\n";
  lines: string[];   // content lines (terminators stripped); a trailing "" element preserves a final newline
  hasFm: boolean;
  open: number;      // index of the opening fence (0) or -1
  close: number;     // index of the closing fence or -1
}

function detectEol(text: string): "\r\n" | "\n" {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

// Parse WITHOUT losing anything: split preserves every line; join with the detected EOL round-trips a
// consistent-EOL document byte-for-byte (the trailing "" carries a final newline). BOM detected + preserved.
function parse(raw: string): Parsed {
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(1) : raw;
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !FENCE_RE.test(lines[0])) return { bom, eol, lines, hasFm: false, open: -1, close: -1 };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (FENCE_RE.test(lines[i])) { close = i; break; }
  if (close === -1) return { bom, eol, lines, hasFm: false, open: -1, close: -1 };
  return { bom, eol, lines, hasFm: true, open: 0, close };
}

function keyOf(line: string): string | null {
  // Top-level scalar key: must start with a non-space key char (so an INDENTED/nested line — incl. block-
  // scalar content — never matches), may contain internal spaces (Linter's `date modified`), optional space
  // before the colon, any value after (incl. `key:value` with no space, and values containing colons).
  const m = /^([A-Za-z0-9_.-][A-Za-z0-9_. -]*?)[ \t]*:.*$/.exec(line);
  return m ? m[1] : null;
}

function reassemble(p: Parsed, lines: string[]): string {
  return (p.bom ? BOM : "") + lines.join(p.eol);
}

export function hasFrontmatter(text: string): boolean { return parse(text).hasFm; }

export function getManagedValue(text: string, key: string): string | undefined {
  const p = parse(text);
  if (!p.hasFm) return undefined;
  for (let i = p.open + 1; i < p.close; i++) {
    if (keyOf(p.lines[i]) === key) {
      const idx = p.lines[i].indexOf(":");
      return p.lines[i].slice(idx + 1).trim() || undefined;
    }
  }
  return undefined;
}

// SURGICAL + preservation-safe: replaces only our key's line (dropping duplicates) or inserts it just before
// the closing fence — preserving the user's other keys, their ORDER, the body, the EOL (CRLF/LF), and a BOM.
// Never re-serializes the user's YAML.
export function setManagedValue(text: string, key: string, value: string): string {
  const p = parse(text);
  const kv = `${key}: ${value}`;
  if (!p.hasFm) {
    // No parseable frontmatter → create a fresh block at the top; the rest of the doc is untouched.
    return reassemble(p, ["---", kv, "---", ...p.lines]);
  }
  let seen = false;
  let closePos = -1;
  const out: string[] = [];
  for (let i = 0; i < p.lines.length; i++) {
    if (i > p.open && i < p.close && keyOf(p.lines[i]) === key) {
      if (!seen) { out.push(kv); seen = true; } // replace in place; drop DUPLICATE managed-key lines
      continue;
    }
    if (i === p.close) closePos = out.length; // where the closing fence landed after any dup-drops
    out.push(p.lines[i]);
  }
  if (!seen) out.splice(closePos, 0, kv); // absent → append at the END of the block (before the closing fence)
  return reassemble(p, out);
}

// The git-model identity primitive: strip the managed keys, normalize EOL + trailing newline, so two
// versions that differ ONLY in managed keys yield identical normalized content (and hash).
export function normalizedContent(text: string, managedKeys: string[]): string {
  const lf = text.replace(/\r\n/g, "\n").replace(/^﻿/, ""); // identity is EOL- and BOM-agnostic
  const p = parse(lf);
  if (!p.hasFm) return trimTrailing(lf);
  const kept: string[] = [];
  for (let i = 0; i < p.lines.length; i++) {
    if (i > p.open && i < p.close) {
      const k = keyOf(p.lines[i]);
      if (k !== null && (managedKeys.includes(k) || VOLATILE_ALIAS_KEYS.includes(k))) continue; // mask our keys + third-party volatile timestamp keys
    }
    kept.push(p.lines[i]);
  }
  return trimTrailing(kept.join("\n"));
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

// ---- 1.8.0 backfill: instant-based compliance + the real normalizer ----

// Canonical timestamp value = an UNQUOTED ISO-8601 date-time with a numeric offset. OFFSET-AGNOSTIC on
// purpose: the SAME instant written with different device offsets (-06:00 vs -05:00) is equally canonical,
// so two devices never disagree on compliance and there is a global fixed point (critique F2).
const CANON_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
export function isCanonicalTimestamp(v: string): boolean { return CANON_TS_RE.test(v.trim()); }

// A note is COMPLIANT iff every managed key is present AND canonical-shaped.
export function noteCompliant(text: string, keys: string[]): boolean {
  for (const k of keys) { const v = getManagedValue(text, k); if (v === undefined || !isCanonicalTimestamp(v)) return false; }
  return true;
}

// Bring a note to compliance WITHOUT bumping (the backfill preserves real history — distinct from the
// per-edit stamp, which does bump `updated` to now). keys = [createdKey, updatedKey]. A missing key is
// seeded from OS metadata (ctime/mtime, never "now"); a present-but-non-canonical value is re-emitted at
// the SAME instant in canonical form (or, if unparseable, re-seeded from OS metadata); canonical values are
// left untouched. FIXED POINT by construction: the output is always noteCompliant().
export function conformTimestamps(text: string, keys: string[], ctime: number | undefined, mtime: number | undefined, now: number, tzOffsetMin: number): string {
  const createdKey = keys[0];
  const updatedKey = keys[1] ?? keys[0];
  const seed = seedValues(ctime, mtime, now, tzOffsetMin);
  let out = text;
  for (const [key, seedVal] of [[createdKey, seed.created], [updatedKey, seed.updated]] as const) {
    const v = getManagedValue(out, key);
    if (v === undefined) { out = setManagedValue(out, key, seedVal); continue; }
    if (isCanonicalTimestamp(v)) continue; // already canonical (any offset) — leave it
    const ms = parseIso(v);
    out = setManagedValue(out, key, ms !== undefined ? formatIsoOffset(ms, tzOffsetMin) : seedVal);
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

# Embedded Timestamp Metadata + Volatile-Field-Aware Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SelfSync own an embedded, portable `created`/`updated` timestamp in note frontmatter, treat timestamp-only differences as non-conflicts, and drive filesystem times from the embedded value — eliminating the "diff conflicts that are just time metadata" pain.

**Architecture:** Pure decision cores (`frontmatter.ts`, `excludedFolders.ts`) + a thin FS-time edge (`fstimes.ts`), spliced into the existing content-hash reconcile at the same seam as the `sameIgnoringEol` cosmetic short-circuit. Change-detection gains a *normalized* hash (managed timestamp keys masked) alongside the untouched raw hash, so identity is git-style content-addressed. The settings UI is pure-state + thin, focus-preserving render.

**Tech Stack:** TypeScript, esbuild, vitest (unit + happy-dom DOM), Playwright+Electron (`e2e-obsidian`), Obsidian plugin API. Server untouched.

## Global Constraints

- Pure modules (`frontmatter.ts`, `excludedFolders.ts`) MUST NOT import from `obsidian` or touch the DOM/filesystem — they take plain inputs and are unit-tested with zero mocks (mirror `configsync.ts` / `statuslight.ts`).
- The **raw** content hash (`sha256hex` over full bytes) stays the storage/CAS/wire identity — never change it. The normalized hash is an ADDITIONAL, decision-only value.
- Managed keys default to `created` / `updated`; configurable. Value format is full ISO 8601 with offset: `YYYY-MM-DDTHH:mm:ss±HH:MM`.
- The master feature toggle `embeddedTimestamps` defaults to **false** (opt-in) — writing into user notes must be a deliberate opt-in on a released plugin.
- Timestamp management is an OVERLAY: it must never throw into, block, or break content sync. Unparseable YAML / non-markdown → fall back to raw bytes; FS-time or native-addon failure → swallow and continue.
- Creation time (birthtime) is best-effort Windows/macOS only; POSIX `ctime` is never set; mobile FS-time driving is skipped.
- After any change touching shared server shape run full `cargo test --locked` + `clippy -D warnings`; the client gate is full `vitest` + `tsc`; then `keel reverify --all-drift` green. (CI runs neither clippy nor the full Rust suite — run them locally.)
- Commit footer ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01YEGMR6bnE914j8ySiqYc25`
- Work on `main` directly; push after each commit (post-commit hook is unreliable).

---

## File Structure

**Create:**
- `client/src/frontmatter.ts` — pure: parse/serialize frontmatter, get/set managed keys, normalized content + hash, ISO-offset format/parse, seed-from-stat, stamping decision.
- `client/src/excludedFolders.ts` — pure: `normalizeFolder`, `addExcluded`, `removeExcluded`, `isExcluded`, `matchFolders`.
- `client/src/fstimes.ts` — thin: `driveFsTimes(api, path, updatedMs, createdMs?)` over an injected `FsTimeApi`.
- `client/test/frontmatter.test.ts`, `client/test/excludedFolders.test.ts`, `client/test/fstimes.test.ts`
- `client/e2e-obsidian/excluded-folders.pwspec.ts`

**Modify:**
- `client/src/base.ts` — add `normHash?: string` to `BaseEntry` + persist in `toJSON`.
- `client/src/configsync.ts` — `shouldSync` gains an `excluded: string[]` param (exclusion gates management, not content sync — see Task 7).
- `client/src/reconcile.ts` — compute `normHash`; timestamp-only short-circuit in `reconcileMergeOrConflict`; stamp-on-genuine-change + revert-spurious-bump in `reconcileOne`; thread `managedKeys`/`excludedFolders` via `ReconcileDeps`.
- `client/src/settings.ts` — settings fields; `renderExcludedFolders`; `FolderSuggest` adapter.
- `client/src/main.ts` — settings defaults + `parseSettings` clone; `setExcludedFolders`; `getAllFolders` adapter; the `FsTimeApi` impl; wire stamping + fstimes into the write/push path.
- `client/test/obsidian-stub.ts` — add `AbstractInputSuggest`, `TFolder`, `vault.getAllFolders`.
- `client/test/reconcile.test.ts` — timestamp-only / copy-bump / excluded / no-regression cases.
- `client/test/settings-ui.dom.test.ts` + `client/test/ui-dom-harness.ts` — excluded-folders wiring.
- `manifest.json` / `versions.json` — MINOR bump (Task 12, via `scripts/bump-version.mjs`).

---

## Task 1: `excludedFolders.ts` — pure folder-exclusion algebra

**Files:**
- Create: `client/src/excludedFolders.ts`
- Test: `client/test/excludedFolders.test.ts`

**Interfaces:**
- Produces: `normalizeFolder(raw: string): string`, `addExcluded(list: string[], raw: string): string[]`, `removeExcluded(list: string[], raw: string): string[]`, `isExcluded(path: string, list: string[]): boolean`, `matchFolders(query: string, all: string[]): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/excludedFolders.test.ts
import { describe, it, expect } from "vitest";
import { normalizeFolder, addExcluded, removeExcluded, isExcluded, matchFolders } from "../src/excludedFolders";

describe("excludedFolders (pure)", () => {
  it("normalizeFolder trims, strips slashes, collapses dup separators", () => {
    expect(normalizeFolder("  /Work/Archive/ ")).toBe("Work/Archive");
    expect(normalizeFolder("A//B")).toBe("A/B");
    expect(normalizeFolder("/")).toBe("");
  });
  it("add/remove are set-semantics + sorted, normalized", () => {
    expect(addExcluded([], "/Work/")).toEqual(["Work"]);
    expect(addExcluded(["Work"], "work")).toEqual(["Work", "work"]); // case-sensitive paths, distinct
    expect(addExcluded(["B", "A"], "A")).toEqual(["A", "B"]); // dedup + sort, no dup
    expect(removeExcluded(["A", "B"], "/A/")).toEqual(["B"]);
  });
  it("isExcluded matches a folder and everything under it, at boundaries only", () => {
    expect(isExcluded("Work/note.md", ["Work"])).toBe(true);
    expect(isExcluded("Work/Sub/n.md", ["Work"])).toBe(true);
    expect(isExcluded("Work", ["Work"])).toBe(true);
    expect(isExcluded("Workshop/n.md", ["Work"])).toBe(false); // prefix but not a folder boundary
    expect(isExcluded("Other/n.md", ["Work"])).toBe(false);
    expect(isExcluded("a/b.md", [])).toBe(false);
  });
  it("matchFolders ranks case-insensitively, prefix before substring", () => {
    const all = ["Archive", "Work", "Work/Archive", "Notes/Work"];
    expect(matchFolders("work", all)).toEqual(["Work", "Work/Archive", "Notes/Work"]);
    expect(matchFolders("", all)).toEqual(all);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/excludedFolders.test.ts`
Expected: FAIL — cannot find module `../src/excludedFolders`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/excludedFolders.ts
// Pure + total: no Obsidian API, exhaustively unit-testable (mirrors configsync.ts).
// A note is "excluded from timestamp management" when its path is, or is under, a listed folder.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run test/excludedFolders.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add client/src/excludedFolders.ts client/test/excludedFolders.test.ts
git commit -F <msg>   # "feat(client): pure excludedFolders module (normalize/add/remove/isExcluded/matchFolders)"
git push origin main
```

---

## Task 2: `frontmatter.ts` — parse + get/set managed keys (line-based, no YAML dep)

**Files:**
- Create: `client/src/frontmatter.ts`
- Test: `client/test/frontmatter.test.ts`

**Interfaces:**
- Produces: `hasFrontmatter(text: string): boolean`, `getManagedValue(text: string, key: string): string | undefined`, `setManagedValue(text: string, key: string, value: string): string`
- Rationale for line-based (not a YAML lib): the module must stay pure and dependency-light; we only ever read/write our own top-level scalar keys, and SelfSync inserts them at a fixed position so it never reorders a user's YAML.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/frontmatter.test.ts
import { describe, it, expect } from "vitest";
import { hasFrontmatter, getManagedValue, setManagedValue } from "../src/frontmatter";

describe("frontmatter parse + managed keys", () => {
  const withFm = "---\ntitle: Hi\nupdated: 2026-01-01T00:00:00-06:00\n---\nbody\n";
  it("detects a leading frontmatter block", () => {
    expect(hasFrontmatter(withFm)).toBe(true);
    expect(hasFrontmatter("no fm here\n")).toBe(false);
    expect(hasFrontmatter("text\n---\nnot leading\n")).toBe(false);
  });
  it("reads a managed key value", () => {
    expect(getManagedValue(withFm, "updated")).toBe("2026-01-01T00:00:00-06:00");
    expect(getManagedValue(withFm, "created")).toBeUndefined();
  });
  it("replaces an existing managed key in place, preserving other lines + body", () => {
    const out = setManagedValue(withFm, "updated", "2026-02-02T02:02:02-06:00");
    expect(out).toContain("title: Hi");
    expect(getManagedValue(out, "updated")).toBe("2026-02-02T02:02:02-06:00");
    expect(out.endsWith("body\n")).toBe(true);
  });
  it("inserts a managed key into an existing block at the top", () => {
    const out = setManagedValue(withFm, "created", "2025-12-31T00:00:00-06:00");
    expect(getManagedValue(out, "created")).toBe("2025-12-31T00:00:00-06:00");
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00-06:00");
  });
  it("creates a frontmatter block when none exists, keeping the body", () => {
    const out = setManagedValue("just body\n", "updated", "2026-01-01T00:00:00-06:00");
    expect(hasFrontmatter(out)).toBe(true);
    expect(getManagedValue(out, "updated")).toBe("2026-01-01T00:00:00-06:00");
    expect(out).toContain("just body");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run test/frontmatter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/frontmatter.ts
// Pure: line-based YAML-frontmatter handling for SelfSync's own managed scalar keys.
// No Obsidian import, no YAML dependency. Unparseable / non-fm text is handled by callers via raw fallback.
const FENCE = "---";

interface Split { hasFm: boolean; fmLines: string[]; body: string; }

function split(text: string): Split {
  // Frontmatter must be the very first line `---` and a closing `---`.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run test/frontmatter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/frontmatter.ts client/test/frontmatter.test.ts
git commit -F <msg>   # "feat(client): frontmatter parse + get/set managed keys (line-based, pure)"
git push origin main
```

---

## Task 3: `frontmatter.ts` — normalized content + hash (mask managed keys)

**Files:**
- Modify: `client/src/frontmatter.ts`
- Test: `client/test/frontmatter.test.ts`

**Interfaces:**
- Consumes: `split` (internal), `sha256hex` from `./sync` (existing exported hash used elsewhere — verify the exact export name in `sync.ts`; if it's not exported, add `export`).
- Produces: `normalizedContent(text: string, managedKeys: string[]): string`, `normalizedHash(bytes: Uint8Array, managedKeys: string[]): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// append to client/test/frontmatter.test.ts
import { normalizedContent, normalizedHash } from "../src/frontmatter";
const enc = (s: string) => new TextEncoder().encode(s);

describe("normalized content/hash", () => {
  const a = "---\ntitle: Hi\nupdated: 2026-01-01T00:00:00-06:00\n---\nbody\n";
  const b = "---\ntitle: Hi\nupdated: 2026-09-09T09:09:09-06:00\n---\nbody\n"; // differs ONLY in updated
  it("masks managed keys so timestamp-only diffs normalize equal", () => {
    expect(normalizedContent(a, ["updated"])).toBe(normalizedContent(b, ["updated"]));
  });
  it("a real body change normalizes different", () => {
    const c = a.replace("body", "BODY");
    expect(normalizedContent(a, ["updated"])).not.toBe(normalizedContent(c, ["updated"]));
  });
  it("normalizes CRLF to LF", () => {
    const crlf = a.replace(/\n/g, "\r\n");
    expect(normalizedContent(crlf, ["updated"])).toBe(normalizedContent(a, ["updated"]));
  });
  it("normalizedHash equal for timestamp-only diff", async () => {
    expect(await normalizedHash(enc(a), ["updated"])).toBe(await normalizedHash(enc(b), ["updated"]));
  });
  it("non-frontmatter text passes through unchanged", () => {
    expect(normalizedContent("plain body\n", ["updated"])).toBe("plain body\n");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run test/frontmatter.test.ts`
Expected: FAIL — `normalizedContent` not exported.

- [ ] **Step 3: Implement**

First confirm the hash helper: in `client/src/sync.ts` there is a `sha256hex(bytes)` used by reconcile — ensure it is `export`ed (add `export` if needed). Then add to `frontmatter.ts`:

```ts
import { sha256hex } from "./sync"; // add `export` to sha256hex in sync.ts if not already

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

export async function normalizedHash(bytes: Uint8Array, managedKeys: string[]): Promise<string> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return sha256hex(bytes); } // non-text/binary → raw identity
  if (!hasFrontmatter(text)) return sha256hex(bytes); // no fm → raw identity (cheap + exact)
  return sha256hex(new TextEncoder().encode(normalizedContent(text, managedKeys)));
}
```

Note: if `sha256hex` is async in this codebase (WebCrypto), make `normalizedContent` sync but `normalizedHash` await it; match the existing signature exactly (check `reconcile.ts:942` usage).

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run test/frontmatter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/frontmatter.ts client/src/sync.ts client/test/frontmatter.test.ts
git commit -F <msg>   # "feat(client): normalized content hash masking managed keys (git-model identity)"
git push origin main
```

---

## Task 4: `frontmatter.ts` — ISO-offset format/parse + seed-from-stat + stamp decision

**Files:**
- Modify: `client/src/frontmatter.ts`
- Test: `client/test/frontmatter.test.ts`

**Interfaces:**
- Produces: `formatIsoOffset(epochMs: number, tzOffsetMin: number): string`, `parseIso(s: string): number | undefined`, `seedValues(statCtimeMs: number | undefined, statMtimeMs: number | undefined, nowMs: number, tzOffsetMin: number): { created: string; updated: string }`
- `tzOffsetMin` is `-(new Date().getTimezoneOffset())` supplied by the impure caller (JS returns minutes-behind-UTC negated). Kept as a parameter so the function is pure/testable.

- [ ] **Step 1: Write the failing test**

```ts
// append to client/test/frontmatter.test.ts
import { formatIsoOffset, parseIso, seedValues } from "../src/frontmatter";

describe("iso offset + seeding", () => {
  it("formats epoch + offset as ISO-8601 with offset", () => {
    // 2026-01-01T00:00:00Z at -06:00 => 2025-12-31T18:00:00-06:00
    expect(formatIsoOffset(Date.UTC(2026, 0, 1, 0, 0, 0), -360)).toBe("2025-12-31T18:00:00-06:00");
    expect(formatIsoOffset(Date.UTC(2026, 0, 1, 0, 0, 0), 0)).toBe("2026-01-01T00:00:00+00:00");
    expect(formatIsoOffset(Date.UTC(2026, 0, 1, 0, 0, 0), 330)).toBe("2026-01-01T05:30:00+05:30");
  });
  it("parseIso round-trips to the same instant", () => {
    const ms = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseIso(formatIsoOffset(ms, -360))).toBe(ms);
    expect(parseIso("not a date")).toBeUndefined();
  });
  it("seedValues uses OS ctime/mtime, not now, when available", () => {
    const ct = Date.UTC(2020, 0, 1), mt = Date.UTC(2021, 5, 15), now = Date.UTC(2026, 0, 1);
    const s = seedValues(ct, mt, now, 0);
    expect(parseIso(s.created)).toBe(ct);
    expect(parseIso(s.updated)).toBe(mt);
  });
  it("seedValues falls back to now when stat is missing", () => {
    const now = Date.UTC(2026, 0, 1);
    const s = seedValues(undefined, undefined, now, 0);
    expect(parseIso(s.created)).toBe(now);
    expect(parseIso(s.updated)).toBe(now);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run test/frontmatter.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
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
  const ms = Date.parse(s.trim());
  return Number.isNaN(ms) ? undefined : ms;
}
export function seedValues(ctime: number | undefined, mtime: number | undefined, now: number, tzOffsetMin: number) {
  return {
    created: formatIsoOffset(ctime ?? now, tzOffsetMin),
    updated: formatIsoOffset(mtime ?? now, tzOffsetMin),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run test/frontmatter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/frontmatter.ts client/test/frontmatter.test.ts
git commit -F <msg>   # "feat(client): ISO-offset format/parse + OS-metadata seeding"
git push origin main
```

---

## Task 5: `fstimes.ts` — thin FS-time driver over an injected API

**Files:**
- Create: `client/src/fstimes.ts`
- Test: `client/test/fstimes.test.ts`

**Interfaces:**
- Produces: `interface FsTimeApi { platform: "win" | "mac" | "linux" | "mobile"; setMtime(path: string, epochMs: number): Promise<void>; setBirthtime?: (path: string, epochMs: number) => Promise<void>; }`, `driveFsTimes(api: FsTimeApi, path: string, updatedMs?: number, createdMs?: number): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/fstimes.test.ts
import { describe, it, expect, vi } from "vitest";
import { driveFsTimes, FsTimeApi } from "../src/fstimes";

function api(platform: FsTimeApi["platform"], withBirth: boolean): FsTimeApi & { m: any; b: any } {
  const m = vi.fn().mockResolvedValue(undefined);
  const b = vi.fn().mockResolvedValue(undefined);
  return { platform, setMtime: m, ...(withBirth ? { setBirthtime: b } : {}), m, b } as any;
}

describe("driveFsTimes", () => {
  it("sets mtime from updated on every desktop platform", async () => {
    const a = api("linux", false);
    await driveFsTimes(a, "n.md", 111, 222);
    expect(a.m).toHaveBeenCalledWith("n.md", 111);
  });
  it("sets birthtime from created only when the API provides it (win/mac)", async () => {
    const a = api("win", true);
    await driveFsTimes(a, "n.md", 111, 222);
    expect(a.b).toHaveBeenCalledWith("n.md", 222);
  });
  it("skips birthtime on linux (no setBirthtime)", async () => {
    const a = api("linux", false);
    await driveFsTimes(a, "n.md", 111, 222);
    expect(a.b).not.toHaveBeenCalled();
  });
  it("degrades silently when setMtime throws", async () => {
    const a = api("win", true); a.m.mockRejectedValue(new Error("EPERM"));
    await expect(driveFsTimes(a, "n.md", 111, 222)).resolves.toBeUndefined();
  });
  it("no-ops when updated is undefined", async () => {
    const a = api("mac", true);
    await driveFsTimes(a, "n.md", undefined, 222);
    expect(a.m).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run test/fstimes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// client/src/fstimes.ts
// Thin edge: the embedded timestamp drives filesystem times. Best-effort — NEVER throws into sync.
export interface FsTimeApi {
  platform: "win" | "mac" | "linux" | "mobile";
  setMtime(path: string, epochMs: number): Promise<void>;
  setBirthtime?: (path: string, epochMs: number) => Promise<void>; // present only where settable (win/mac)
}
export async function driveFsTimes(api: FsTimeApi, path: string, updatedMs?: number, createdMs?: number): Promise<void> {
  try { if (updatedMs !== undefined) await api.setMtime(path, updatedMs); } catch { /* best-effort */ }
  try { if (createdMs !== undefined && api.setBirthtime) await api.setBirthtime(path, createdMs); } catch { /* best-effort */ }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run test/fstimes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/fstimes.ts client/test/fstimes.test.ts
git commit -F <msg>   # "feat(client): thin fstimes driver (mtime always, birthtime best-effort)"
git push origin main
```

---

## Task 6: `base.ts` — persist a normalized hash alongside the raw hash

**Files:**
- Modify: `client/src/base.ts` (interface `BaseEntry` ~line 7; `toJSON` ~line 35-37; `setBase`/`stampStat` region)
- Test: `client/test/base.test.ts`

**Interfaces:**
- Produces: `BaseEntry.normHash?: string` (persisted); `BaseStore.setBase` accepts/stores it.

- [ ] **Step 1: Write the failing test**

```ts
// append to client/test/base.test.ts
import { BaseStore } from "../src/base";
it("persists normHash through toJSON/reload", () => {
  const s = new BaseStore();
  s.setBase("n.md", { hash: "raw1", normHash: "norm1" });
  const json = JSON.parse(JSON.stringify(s.toJSON()));
  const s2 = BaseStore.fromJSON(json);        // use whatever the existing rehydrate entrypoint is
  expect(s2.get("n.md")?.normHash).toBe("norm1");
});
```
(Match the actual `setBase` signature + rehydrate method names in `base.ts` — adjust the test to them.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run test/base.test.ts`
Expected: FAIL — `normHash` missing after reload (dropped by `toJSON`).

- [ ] **Step 3: Implement**

In `base.ts`: add `normHash?: string;` to `BaseEntry`. In `toJSON` (currently serializes `{hash, text?}` and deliberately drops the perf-only `size`/`mtime`), ADD `normHash` to the serialized shape (it is identity-meaningful, unlike the stat hints). Ensure the rehydrate path reads it back. Keep `setBase` copying `normHash` from its entry arg.

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run test/base.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/base.ts client/test/base.test.ts
git commit -F <msg>   # "feat(client): persist normHash in the base store"
git push origin main
```

---

## Task 7: `configsync.ts` — thread exclusion through `shouldSync`'s consumers (management-only)

**Files:**
- Modify: `client/src/reconcile.ts` (`ReconcileDeps` type; where management decisions are made)
- Test: `client/test/reconcile.test.ts`

**Important semantic:** excluded folders still **sync content normally** — exclusion only turns OFF timestamp *management* (no stamp, no revert, no FS-time drive) for those paths. Do NOT gate `shouldSync` itself (that would stop content sync). Instead add a pure predicate `isManaged(path)` used only by the stamping/revert/fstimes steps.

**Interfaces:**
- Consumes: `isExcluded` (Task 1).
- Produces: `ReconcileDeps.managedKeys?: string[]`, `ReconcileDeps.excludedFolders?: string[]`, `ReconcileDeps.tzOffsetMin?: number`; a local helper `isManaged(d, path): boolean = !!d.managedKeys && !isExcluded(path, d.excludedFolders ?? [])`.

- [ ] **Step 1: Write the failing test** — deferred; `isManaged` is exercised by the Task 8/9 reconcile cases. This task only extends the `ReconcileDeps` type + helper (no behavior yet), so:

- [ ] **Step 2: Add the fields + helper**

In `reconcile.ts`, extend `ReconcileDeps` with the three optional fields above and add:
```ts
import { isExcluded } from "./excludedFolders";
function isManaged(d: ReconcileDeps, path: string): boolean {
  return !!d.managedKeys && d.managedKeys.length > 0 && !isExcluded(path, d.excludedFolders ?? []);
}
```
(Optional fields ⇒ existing tests/callers compile unchanged; management is inert until `managedKeys` is provided by `main.ts` in Task 10.)

- [ ] **Step 3: Verify the suite still green**

Run: `cd client && npx vitest run`
Expected: PASS (no behavior change).

- [ ] **Step 4: Commit**

```bash
git add client/src/reconcile.ts
git commit -F <msg>   # "feat(client): reconcile deps for timestamp management (managedKeys/excludedFolders/tz) + isManaged"
git push origin main
```

---

## Task 8: `reconcile.ts` — timestamp-only short-circuit + revert spurious bump

**Files:**
- Modify: `client/src/reconcile.ts` (`reconcileMergeOrConflict` ~810-872, at the `sameIgnoringEol` cosmetic check ~826; and `reconcileOne` push branch ~1009-1041)
- Test: `client/test/reconcile.test.ts`

**Interfaces:**
- Consumes: `normalizedHash` (Task 3), `getManagedValue`/`setManagedValue`/`parseIso`/`formatIsoOffset` (Tasks 2/4), `isManaged` (Task 7), `BaseEntry.normHash` (Task 6).
- Produces: two new resolution behaviors, both guarded by `isManaged`.

- [ ] **Step 1: Write the failing tests** (mirror the existing fake-IO/fake-server harness at the top of `reconcile.test.ts`)

```ts
// append to client/test/reconcile.test.ts, inside a new describe("embedded timestamp", ...)
// Uses the file's existing helpers: fakeIo(), fakeServer(), deps(), serverPutBytes(), text encoder.
// managedKeys:["updated","created"], no excluded folders.
it("timestamp-only cross-device diff resolves without a conflict copy, keeping the older updated", async () => {
  const io = fakeIo(), srv = fakeServer();
  const d = deps(io, srv, { managedKeys: ["updated", "created"], excludedFolders: [], tzOffsetMin: 0 });
  const older = "---\nupdated: 2026-01-01T00:00:00+00:00\n---\nbody\n";
  const newer = "---\nupdated: 2026-09-09T00:00:00+00:00\n---\nbody\n"; // same body
  io.write("n.md", enc(older));
  await serverPutBytes(srv, "n.md", enc(newer));
  // no common base (both "new") → decide()=conflict-copy path
  await reconcileAll(d);
  const names = io.list ? [...(await io.list()).keys()] : io.paths();
  expect(names.filter((p: string) => p.includes("conflict"))).toHaveLength(0); // NO conflict copy
  const got = new TextDecoder().decode(await io.read("n.md"));
  expect(got).toContain("2026-01-01T00:00:00+00:00"); // older updated kept
});

it("a spurious local timestamp bump on unchanged content is reverted and not pushed", async () => {
  const io = fakeIo(), srv = fakeServer();
  const base = "---\nupdated: 2026-01-01T00:00:00+00:00\n---\nbody\n";
  await serverPutBytes(srv, "n.md", enc(base));
  const d = deps(io, srv, { managedKeys: ["updated", "created"], excludedFolders: [], tzOffsetMin: 0 });
  await reconcileAll(d);                              // establishes base (raw + normHash)
  const bumped = base.replace("2026-01-01T00:00:00+00:00", "2026-05-05T00:00:00+00:00");
  io.write("n.md", enc(bumped));                      // copy-style bump, body identical
  const versionBefore = srv.versionOf("n.md");
  await reconcileAll(d);
  expect(srv.versionOf("n.md")).toBe(versionBefore);  // NOT pushed
  expect(new TextDecoder().decode(await io.read("n.md"))).toContain("2026-01-01T00:00:00+00:00"); // reverted
});

it("excluded folder is NOT managed: a timestamp-only diff there still routes normally", async () => {
  // With excludedFolders:["Gen"], a Gen/ note's timestamp-only diff is treated as a content diff (legacy behavior).
  // Assert isManaged is off — e.g. the spurious bump IS pushed for an excluded path.
  const io = fakeIo(), srv = fakeServer();
  const base = "---\nupdated: 2026-01-01T00:00:00+00:00\n---\nbody\n";
  await serverPutBytes(srv, "Gen/n.md", enc(base));
  const d = deps(io, srv, { managedKeys: ["updated", "created"], excludedFolders: ["Gen"], tzOffsetMin: 0 });
  await reconcileAll(d);
  io.write("Gen/n.md", enc(base.replace("2026-01-01", "2026-05-05")));
  const v = srv.versionOf("Gen/n.md");
  await reconcileAll(d);
  expect(srv.versionOf("Gen/n.md")).toBeGreaterThan(v); // managed OFF → pushed as a normal change
});

it("a genuine body conflict still produces a conflict copy (no regression)", async () => {
  const io = fakeIo(), srv = fakeServer();
  const d = deps(io, srv, { managedKeys: ["updated", "created"], excludedFolders: [], tzOffsetMin: 0 });
  io.write("n.md", enc("---\nupdated: 2026-01-01T00:00:00+00:00\n---\nLOCAL body\n"));
  await serverPutBytes(srv, "n.md", enc("---\nupdated: 2026-02-02T00:00:00+00:00\n---\nREMOTE body\n"));
  await reconcileAll(d);
  const names = io.list ? [...(await io.list()).keys()] : io.paths();
  expect(names.some((p: string) => p.includes("conflict"))).toBe(true);
});
```
(Adjust helper names — `io.paths()`/`io.list()`, `srv.versionOf`, `serverPutBytes`, `deps(...)` third arg — to the actual signatures at the top of `reconcile.test.ts`; the existing `deps()` builder must be extended to pass the three new `ReconcileDeps` fields through.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd client && npx vitest run test/reconcile.test.ts -t "embedded timestamp"`
Expected: FAIL — conflict copies created / bump pushed / older not kept.

- [ ] **Step 3: Implement**

**(a) Timestamp-only short-circuit** in `reconcileMergeOrConflict`, placed exactly like the `sameIgnoringEol` cosmetic check (~line 826), BEFORE the 3-way merge / conflict-copy logic. After the remote bytes are fetched (the function already fetches `remoteBytes` for merge):
```ts
if (isManaged(d, p)) {
  const keys = d.managedKeys!;
  const localNorm = await normalizedHash(localBytes, keys);
  const remoteNorm = await normalizedHash(remoteBytes, keys);
  if (localNorm === remoteNorm) {
    // Same logical version — reconcile fields, adopt, NO conflict copy.
    const merged = reconcileManagedFields(
      new TextDecoder().decode(localBytes),
      new TextDecoder().decode(remoteBytes),
      keys,
    );
    const bytes = new TextEncoder().encode(merged);
    await applyPull(d, p, bytes, /* recordBaseWith */ remote);   // write + base(raw+norm)
    return; // resolved
  }
}
```
Add the pure helper (put it in `frontmatter.ts`, unit-test it there):
```ts
// frontmatter.ts — created := min(parse), updated := older (min) since content is identical
export function reconcileManagedFields(local: string, remote: string, keys: string[]): string {
  let out = remote; // adopt remote body/frontmatter as the canonical text
  for (const key of keys) {
    const lv = getManagedValue(local, key), rv = getManagedValue(remote, key);
    const lms = lv ? parseIso(lv) : undefined, rms = rv ? parseIso(rv) : undefined;
    let pick: string | undefined;
    if (lms !== undefined && rms !== undefined) pick = lms <= rms ? (lv as string) : (rv as string); // older wins
    else pick = lv ?? rv;
    if (pick !== undefined) out = setManagedValue(out, key, pick);
  }
  return out;
}
```
Add its unit tests to `frontmatter.test.ts` (older `updated` wins; earliest `created`; missing-on-one-side takes the present one).

**(b) Revert spurious bump** in `reconcileOne`, in the branch where `decide()` says local changed vs base (about to push). Before pushing, when `isManaged(d,p)`:
```ts
const localNorm = await normalizedHash(localBytes, d.managedKeys!);
if (base?.normHash && localNorm === base.normHash) {
  // No genuine change — only managed fields moved (a copy / re-stamp). Restore base values, do not push.
  if (base.text !== undefined) { await d.io.write(p, new TextEncoder().encode(base.text)); }
  return; // no push; base unchanged
}
```
(When `base.text` is absent — non-mergeable/large — skip the rewrite but still `return` without pushing; the stamp is harmless and will not re-trigger because the next `normHash` still equals base.)

**(c) Record `normHash` in base** everywhere `setBase` is called after a write/push (compute `normalizedHash(bytes, d.managedKeys ?? [])` and pass it). When unmanaged, `normHash` = raw hash (so identity == raw, legacy behavior).

- [ ] **Step 4: Run to verify they pass**

Run: `cd client && npx vitest run test/reconcile.test.ts && npx vitest run test/frontmatter.test.ts`
Expected: PASS, and the full suite still green: `npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add client/src/reconcile.ts client/src/frontmatter.ts client/test/reconcile.test.ts client/test/frontmatter.test.ts
git commit -F <msg>   # "feat(client): timestamp-only auto-resolve + spurious-bump revert (normHash identity)"
git push origin main
```

---

## Task 9: `reconcile.ts` — stamp `updated` on a genuine local change (+ first-seed)

**Files:**
- Modify: `client/src/reconcile.ts` (`reconcileOne` push branch, before commit)
- Test: `client/test/reconcile.test.ts`

**Interfaces:**
- Consumes: `getManagedValue`/`setManagedValue`/`seedValues`/`formatIsoOffset` (Tasks 2/4), `isManaged`, `d.tzOffsetMin`, `d.now?: () => number` (inject a clock; default `Date.now` in `main.ts`, a fixed fn in tests).

- [ ] **Step 1: Write the failing tests**

```ts
it("stamps updated on a genuine local change and seeds created from OS ctime on first stamp", async () => {
  const io = fakeIo(), srv = fakeServer();
  const CT = Date.UTC(2020, 0, 1), MT = Date.UTC(2021, 0, 1), NOW = Date.UTC(2026, 0, 1);
  io.write("n.md", enc("no frontmatter body\n"), { ctime: CT, mtime: MT }); // fake stat
  const d = deps(io, srv, { managedKeys: ["updated", "created"], excludedFolders: [], tzOffsetMin: 0, now: () => NOW });
  await reconcileAll(d);
  const pushed = new TextDecoder().decode(srv.read("n.md"));
  expect(pushed).toContain("created: 2020-01-01T00:00:00+00:00"); // seeded from ctime, not now
  expect(pushed).toContain("updated:"); // present; updated seeds from mtime then bumps to now on the genuine push
});
it("stamping does not re-trigger a sync (normHash stable)", async () => {
  const io = fakeIo(), srv = fakeServer();
  const NOW = Date.UTC(2026, 0, 1);
  io.write("n.md", enc("---\ntitle: T\n---\nbody\n"), { ctime: NOW, mtime: NOW });
  const d = deps(io, srv, { managedKeys: ["updated", "created"], excludedFolders: [], tzOffsetMin: 0, now: () => NOW });
  await reconcileAll(d);
  const v = srv.versionOf("n.md");
  await reconcileAll(d); // second pass, no user edit
  expect(srv.versionOf("n.md")).toBe(v); // no re-push from the stamp
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd client && npx vitest run test/reconcile.test.ts -t "stamp"`
Expected: FAIL — no `created`/`updated` written.

- [ ] **Step 3: Implement**

In `reconcileOne`, in the genuine-change push branch (after the Task-8b revert check falls through, i.e. `localNorm !== base?.normHash`), when `isManaged(d,p)`:
```ts
let text = new TextDecoder().decode(localBytes);
const tz = d.tzOffsetMin ?? 0;
const now = (d.now ?? (() => Date.now()))();
// First-seed created/updated from OS metadata when absent (Task 4).
const stat = d.localStat; // { ctime?, mtime? } — the reconcileOne caller already has localStat
if (getManagedValue(text, "created") === undefined || getManagedValue(text, "updated") === undefined) {
  const seed = seedValues(stat?.ctime, stat?.mtime, now, tz);
  if (getManagedValue(text, "created") === undefined) text = setManagedValue(text, "created", seed.created);
  if (getManagedValue(text, "updated") === undefined) text = setManagedValue(text, "updated", seed.updated);
}
// A genuine content change → the change IS now; stamp updated = now.
text = setManagedValue(text, "updated", formatIsoOffset(now, tz));
localBytes = new TextEncoder().encode(text); // push these stamped bytes; base(normHash) computed from them
```
Confirm `reconcileOne` has `localStat` (size/mtime; extend to carry `ctime` from the caller — `main.ts` reads `TFile.stat.ctime`). Because the stamp changes only managed keys, `normalizedHash` is unchanged → the second reconcile in the test finds `localNorm === base.normHash` (Task 8b) → no re-push.

- [ ] **Step 4: Run to verify they pass**

Run: `cd client && npx vitest run test/reconcile.test.ts && npx vitest run`
Expected: PASS (whole suite).

- [ ] **Step 5: Commit**

```bash
git add client/src/reconcile.ts client/test/reconcile.test.ts
git commit -F <msg>   # "feat(client): stamp updated on genuine change; first-seed created/updated from OS stat"
git push origin main
```

---

## Task 10: `main.ts` — settings, adapters, and wiring it live

**Files:**
- Modify: `client/src/settings.ts` (`NewLiveSyncSettings` ~11-45; `DEFAULT_SETTINGS` ~46-70; `parseSettings` ~79-91), `client/src/main.ts` (`loadSettings` ~1627; `deps()` builder; write path ~186-209; `setExcludedFolders`; `getAllFolders`; `FsTimeApi` impl)
- Test: `client/test/parsesettings.test.ts`

**Interfaces:**
- Produces: `NewLiveSyncSettings.embeddedTimestamps: boolean`, `.timestampCreatedKey: string`, `.timestampUpdatedKey: string`, `.excludedFolders: string[]`, `.driveFsTimes: boolean`; `MyPlugin.setExcludedFolders(list: string[]): Promise<void>`; `MyPlugin.getAllFolders(): string[]`; `MyPlugin.managedKeys(): string[]` (`embeddedTimestamps ? [createdKey, updatedKey] : []`).

- [ ] **Step 1: Write the failing test**

```ts
// append to client/test/parsesettings.test.ts
it("defaults + hardens the new timestamp settings", () => {
  const d = parseSettings({});
  expect(d.embeddedTimestamps).toBe(false);
  expect(d.timestampCreatedKey).toBe("created");
  expect(d.timestampUpdatedKey).toBe("updated");
  expect(d.excludedFolders).toEqual([]);
  expect(d.driveFsTimes).toBe(true);
  const p = parseSettings({ excludedFolders: ["Work"], embeddedTimestamps: true });
  expect(p.excludedFolders).toEqual(["Work"]);
  // re-cloned off input (no alias)
  const input = { excludedFolders: ["X"] }; const out = parseSettings(input);
  input.excludedFolders.push("Y"); expect(out.excludedFolders).toEqual(["X"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run test/parsesettings.test.ts`
Expected: FAIL — fields undefined.

- [ ] **Step 3: Implement**

- `settings.ts`: add the 5 fields to `NewLiveSyncSettings`; add defaults to `DEFAULT_SETTINGS` (`embeddedTimestamps:false`, `timestampCreatedKey:"created"`, `timestampUpdatedKey:"updated"`, `excludedFolders:[]`, `driveFsTimes:true`); in `parseSettings` add fresh-array clone `out.excludedFolders = Array.isArray(raw.excludedFolders) ? [...raw.excludedFolders] : []` and scalar/bool coercion for the others (mirror the existing per-field hardening).
- `main.ts`: `managedKeys()` returns `this.settings.embeddedTimestamps ? [this.settings.timestampCreatedKey, this.settings.timestampUpdatedKey] : []`. In the `deps()` builder, pass `managedKeys: this.managedKeys()`, `excludedFolders: this.settings.excludedFolders`, `tzOffsetMin: -new Date().getTimezoneOffset()`, `now: () => Date.now()`, and extend `localStat` to include `ctime` (from `TFile.stat.ctime` / `adapter.stat`). Add `setExcludedFolders(list)` mirroring `setPluginSync` (`this.settings.excludedFolders = [...new Set(list)].sort(); await this.saveSettings(); this.settingsRefresh?.()`). Add `getAllFolders()` = `this.app.vault.getAllFolders().map(f => f.path)` (fallback: `getAllLoadedFiles().filter(f => f instanceof TFolder).map(f => f.path)`).
- `main.ts` write path (after `applyPull`/local stamp writes): if `this.settings.driveFsTimes && !Platform.isMobile`, call `driveFsTimes(this.fsTimeApi(), path, parseIso(updated), parseIso(created))`. Build `fsTimeApi()`: `platform` from `process.platform` (win32→"win", darwin→"mac", else "linux"; mobile→"mobile"); `setMtime` via `this.app.vault.adapter` write-with-`DataWriteOptions.mtime` or Node `fs.promises.utimes`; `setBirthtime` present only on win/mac, lazy-`require` the native `utimes` addon inside a try/catch so an absent addon just omits the capability.

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `cd client && npx vitest run test/parsesettings.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/settings.ts client/src/main.ts client/test/parsesettings.test.ts
git commit -F <msg>   # "feat(client): timestamp settings + deps/fstimes/getAllFolders wiring"
git push origin main
```

---

## Task 11: Settings UI — excluded-folders list + folder autocomplete (DOM-tested)

**Files:**
- Modify: `client/src/settings.ts` (`renderExcludedFolders` + `FolderSuggest`), `client/test/obsidian-stub.ts` (add `AbstractInputSuggest`, `TFolder`, `vault.getAllFolders`), `client/test/ui-dom-harness.ts` (add `setExcludedFolders`/`getAllFolders` to `fakePlugin`, an `inputByPlaceholder` helper if missing), `client/test/settings-ui.dom.test.ts`

**Interfaces:**
- Consumes: `matchFolders` (Task 1), `setExcludedFolders`/`getAllFolders` (Task 10).

- [ ] **Step 1: Write the failing DOM test**

```ts
// append to client/test/settings-ui.dom.test.ts
it("adds and removes an excluded folder via the UI", async () => {
  const { plugin, tab, container } = renderSettings({ excludedFolders: ["Work"], embeddedTimestamps: true });
  // one existing row rendered
  expect(container.querySelectorAll("[data-excluded-row]").length).toBe(1);
  // type a folder + Add
  typeInto(inputByPlaceholder(container, "Folder to exclude"), "Archive");
  buttonByText(container, "Add folder").click();
  expect(plugin.setExcludedFolders).toHaveBeenCalledWith(["Archive", "Work"]);
  // remove the first row
  (container.querySelector("[data-excluded-row] [data-remove]") as HTMLElement).click();
  expect(plugin.setExcludedFolders).toHaveBeenCalled();
});
```
(Use the harness's existing `renderSettings`/`buttonByText`/`typeInto`; add `inputByPlaceholder` + a `data-excluded-row`/`data-remove` marker convention.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run test/settings-ui.dom.test.ts`
Expected: FAIL — no such UI / stubs missing.

- [ ] **Step 3: Implement**

- `obsidian-stub.ts`: add a minimal `AbstractInputSuggest` class (constructor `(app, inputEl)`, `getSuggestions`/`renderSuggestion`/`selectSuggestion` no-ops), a `TFolder` class, and `vault.getAllFolders = () => []`.
- `settings.ts`: a `renderExcludedFolders(container)` method — for each `this.plugin.settings.excludedFolders` render a `new Setting(row)` with the folder text + a `data-excluded-row` marker + a `data-remove` × button calling `this.plugin.setExcludedFolders(removeExcluded(list, folder))` then re-rendering the list container only (the `fillStatus`/`listEl.empty()` in-place pattern — do NOT `this.display()`, to preserve focus). Below the rows: a text input (`placeholder="Folder to exclude"`) with a `FolderSuggest` attached and an "Add folder" button calling `this.plugin.setExcludedFolders(addExcluded(list, input.value))`. Gate the whole section behind `embeddedTimestamps`.
- `FolderSuggest extends AbstractInputSuggest<string>`: `getSuggestions(q) => matchFolders(q, this.plugin.getAllFolders())`, `renderSuggestion(v, el){ el.setText(v); }`, `selectSuggestion(v){ this.setValue(v); this.close(); }`.

- [ ] **Step 4: Run to verify it passes + typecheck + full suite**

Run: `cd client && npx vitest run test/settings-ui.dom.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/settings.ts client/test/obsidian-stub.ts client/test/ui-dom-harness.ts client/test/settings-ui.dom.test.ts
git commit -F <msg>   # "feat(client): excluded-folders settings UI + folder autocomplete (DOM-tested)"
git push origin main
```

---

## Task 12: E2E (real Obsidian) + full-suite green + MINOR release

**Files:**
- Create: `client/e2e-obsidian/excluded-folders.pwspec.ts`
- Modify: `client/e2e-obsidian/helpers/obsidian.ts` (add `openPluginSettings(page)`)
- Modify: `manifest.json`, `versions.json` (via `scripts/bump-version.mjs`)

- [ ] **Step 1: Write the e2e spec** (mirror `configsync.pwspec.ts` structure; `test.skip(!obsidianAvailable)`)

```ts
// client/e2e-obsidian/excluded-folders.pwspec.ts (sketch — fill against helpers/env.ts + obsidian.ts)
test("an excluded folder's note never reaches the server", async () => {
  const server = await startServer(dataRoot);
  await createVault(server.url, vault);
  const { vaultDir } = await stageVault(server.url, vault,
    { "Secret/n.md": "body\n", "Work/keep.md": "body\n" },
    { embeddedTimestamps: true, excludedFolders: [], driveFsTimes: false });
  const page = await launchObsidian(fakeAppData, vaultDir, cdpPort); await waitForVaultReady(page);
  await openPluginSettings(page);
  // add "Secret" to excluded via the UI
  await page.getByPlaceholder("Folder to exclude").fill("Secret");
  await page.getByRole("button", { name: "Add folder" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as any).app.plugins.plugins["selfsync"].settings.excludedFolders)).toContain("Secret");
  // Secret/ never syncs; Work/ does
  await expect.poll(() => serverHasFile(server.url, vault, "Work/keep.md")).toBe(true);
  await expect.poll(() => serverHasFile(server.url, vault, "Secret/n.md")).toBe(false);
});
```
Add `openPluginSettings(page)` to `obsidian.ts`: `page.evaluate(() => { const app=(window as any).app; app.setting.open(); app.setting.openTabById("selfsync"); })` (verify the tab id).

- [ ] **Step 2: Run e2e** (only where Obsidian is installed)

Run: `cd client && npx playwright test -c playwright.obsidian.config.ts excluded-folders`
Expected: PASS (or auto-skip where Obsidian is unavailable).

- [ ] **Step 3: Full gate**

Run: `cd client && npx vitest run && npx tsc --noEmit` — all green.
Run (repo root): `cargo test --locked` (server unchanged, must stay green) + `cargo clippy --all-targets -- -D warnings`.
Run: `keel.exe reverify --all-drift <root>` — green.

- [ ] **Step 4: MINOR release**

```bash
node scripts/bump-version.mjs minor    # new feature => MINOR (D0002)
```
Then append the sprint DoD result + close the sprint (see "Sprint closeout" below), commit, tag, push, and let the release workflow publish. Verify `scripts/check-release.mjs` + `scripts/check-release-currency.mjs` green.

- [ ] **Step 5: Commit + tag**

```bash
git add -A
git commit -F <msg>   # "release: <ver> — embedded timestamp metadata + volatile-field-aware sync"
git tag <ver> && git push origin main --tags
```

---

## Sprint closeout (engine discipline — after Task 12 green)

- Append the DoD result: `keel append-result --file .tracking/delivery/delivery.sysml --task embeddedTimestampMetadata --sha <HEAD> --verdict pass --judged-by claudeOpus --judged-at <date>` (only once the DoD in `delivery.sysml` is genuinely met — full suite + reverify green).
- Autonomous closeOut (inspect) + retro (analysis) per D0049; the single human gate is the per-sitting review (`method=confirmation`, `judgedBy=wweatherholtz`) + a `#Covers` edge to `embeddedTimestampMetadata`.
- `keel validate` + `keel guard` green before the release commit.

## Self-Review notes (spec coverage)

- srEmbeddedTimestamp → Tasks 2,4,9. srNormalizedIdentity → Task 3. srTimestampConflictResolve → Task 8. srDriveFsTimes → Tasks 5,10. srExcludedFolders → Tasks 1,7,10,11.
- Acceptance locations (`frontmatter/reconcile/fstimes/excludedFolders` + DOM/e2e) are all produced.
- Open verification items for the implementer: exact `sha256hex` sync-vs-async signature (Task 3); `base.ts` `setBase`/rehydrate names (Task 6); `reconcile.test.ts` helper signatures + `deps()` extension (Tasks 8–9); `TFile.stat.ctime` availability on the write path (Task 9/10); the plugin settings tab id for `openTabById` (Task 12).

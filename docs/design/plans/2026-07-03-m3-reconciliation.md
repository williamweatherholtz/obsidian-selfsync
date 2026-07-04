# M3 — Safe Reconciliation & Conflict Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace M1/M2's blunt "pull-overwrites-then-push" reconcile with a base-aware engine that **never silently loses or clobbers content**: upload local-only, download remote-only, three-way-merge divergent Markdown, and conflict-copy anything unmergeable — including the first connect of a pre-existing vault.

**Architecture:** Purely client-side (the server already stores/serves chunks, manifests, deletes). The client persists a **base** per file (last-synced state): a hash for every file, plus the base *text* for mergeable UTF-8 files. A pure `decide(local, base, remote)` function returns a typed action per path; a `reconcile` engine gathers local+remote+base for each path, runs `decide`, and executes (push / pull / merge / conflict-copy / delete), updating the base. Markdown three-way merge uses `diff-match-patch` (pure JS, same lib Obsidian Sync uses).

**Tech Stack:** TypeScript (client only). New dep: `diff-match-patch` + `@types/diff-match-patch`. No server changes. Vitest.

## Global Constraints

- Client only — **no `server/` changes** in M3. `keel` pre-commit guards run; never `--no-verify`.
- **Never lose data:** every reconcile branch either keeps both sides (conflict-copy) or is a provably-safe fast-forward. A file present on both sides with different content and **no common base is a conflict-copy, never an overwrite.**
- **Base = last-synced state**, persisted across restart via the plugin's `saveData`/`loadData` (a single JSON: `path → { hash, text? }`; `text` present only for mergeable files). Updated on every successful push/pull/merge.
- **Mergeable = UTF-8-decodable text** whose path ends in `.md`/`.markdown`/`.txt`/`.canvas` (canvas is JSON but line-mergeable enough; keep list configurable in code). Everything else (images, PDFs, binary) is **conflict-copy on divergence**, never merged.
- **Conflict-copy name:** `"<base> (conflict <device> <YYYYMMDDHHmm>)<.ext>"` (mirrors Obsidian Sync's pattern). The incoming/remote side stays at the canonical path; the local divergent side is written to the conflict-copy path and pushed. Surface a `Notice`.
- **Delete-vs-edit → edit wins** (content preserved), with a Notice — never lose an edit to a concurrent delete (carries M1's decision forward).
- **Conflict strategy setting** (per device, like Obsidian Sync ≥1.9.7): `"auto-merge"` (default — Markdown three-way-merges, others conflict-copy) vs `"conflict-file"` (always conflict-copy, never auto-merge). Add a `deviceName` setting used in conflict-copy names.
- **M3 non-goals:** multi-tenant/accounts/vault-UI (M4), mobile hardening (M5), Docker polish (M6), orphan-chunk GC / durability (backlog B5/B6), perf (B4). Base text is stored whole in `saveData` (fine for text vaults; a chunk-ref base is a later optimization — note in backlog).

---

## File structure

- `client/src/reconcile.ts` (new) — pure `decide()` + the `Action` type; the `reconcile()` engine over `SyncApi`/`VaultIo`/`BaseStore`.
- `client/src/base.ts` (new) — `BaseStore` (in-memory map + load/save via an injected persistence fn) and `conflictCopyName()`.
- `client/src/merge.ts` (new) — `merge3(base, local, remote) → { merged, clean }` (diff-match-patch); `isMergeable(path, bytes)`.
- `client/src/sync.ts` (modify) — keep `pull`/`pushFile` as low-level chunk primitives; reconcile builds on them.
- `client/src/main.ts` (modify) — wire reconcile into connect / WS-poll / local events; add base persistence; conflict/device settings.
- `client/src/settings.ts` (modify) — add `conflictStrategy` + `deviceName`.
- `client/test/reconcile.test.ts`, `client/test/merge.test.ts`, `client/test/base.test.ts` (new); `client/test/e2e.spec.ts` (extend).

---

## Task 1: `diff-match-patch` dep + three-way merge

**Files:** Modify `client/package.json`; Create `client/src/merge.ts`, `client/test/merge.test.ts`.
**Interfaces:** Produces
- `isMergeable(path: string, bytes: Uint8Array): boolean` — true iff extension is text-like AND bytes decode as valid UTF-8.
- `merge3(base: string, local: string, remote: string): { merged: string; clean: boolean }` — three-way merge; `clean=false` if any hunk conflicted.

- [ ] **Step 1: Add deps to `client/package.json` devDependencies**
```json
"diff-match-patch": "^1.0.5",
"@types/diff-match-patch": "^1.0.36",
```
Run `cd client && npm install`.

- [ ] **Step 2: Write failing test `client/test/merge.test.ts`**
```ts
import { describe, it, expect } from "vitest";
import { merge3, isMergeable } from "../src/merge";

const enc = (s: string) => new TextEncoder().encode(s);

describe("isMergeable", () => {
  it("true for .md valid utf8, false for binary and non-text ext", () => {
    expect(isMergeable("a.md", enc("hello"))).toBe(true);
    expect(isMergeable("a.txt", enc("hello"))).toBe(true);
    expect(isMergeable("a.png", enc("hello"))).toBe(false);
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x00]);
    expect(isMergeable("a.md", invalidUtf8)).toBe(false);
  });
});

describe("merge3", () => {
  it("clean-merges non-overlapping edits on both sides", () => {
    const base = "line1\nline2\nline3\n";
    const local = "LINE1\nline2\nline3\n";   // changed first line
    const remote = "line1\nline2\nLINE3\n";  // changed last line
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(true);
    expect(r.merged).toContain("LINE1");
    expect(r.merged).toContain("LINE3");
  });
  it("flags a conflict when both edit the same region", () => {
    const base = "hello world\n";
    const local = "hello LOCAL\n";
    const remote = "hello REMOTE\n";
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(false);
  });
  it("identical local and remote merge cleanly to that content", () => {
    const r = merge3("a\n", "b\n", "b\n");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("b\n");
  });
});
```

- [ ] **Step 3: Run → fails** `cd client && npx vitest run test/merge.test.ts` — FAIL (module missing).

- [ ] **Step 4: Implement `client/src/merge.ts`**
```ts
import DiffMatchPatch from "diff-match-patch";

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

// Three-way merge: apply the base→local patch onto remote (which already carries
// remote's own edits). `clean` is false if any hunk failed to apply (overlap).
export function merge3(base: string, local: string, remote: string): { merged: string; clean: boolean } {
  if (local === remote) return { merged: local, clean: true };
  const dmp = new DiffMatchPatch();
  const patches = dmp.patch_make(base, local);
  const [merged, results] = dmp.patch_apply(patches, remote);
  const clean = (results as boolean[]).every((ok) => ok);
  return { merged, clean };
}
```

- [ ] **Step 5: Run → passes** `cd client && npx vitest run test/merge.test.ts`.

- [ ] **Step 6: Commit** `git add client/package.json client/src/merge.ts client/test/merge.test.ts && git commit -m "feat(client): three-way merge (diff-match-patch) + mergeable detection"`

---

## Task 2: Base store + conflict-copy naming

**Files:** Create `client/src/base.ts`, `client/test/base.test.ts`.
**Interfaces:** Produces
- `interface BaseEntry { hash: string; text?: string }`
- `class BaseStore` with:
  - `constructor(initial?: Record<string, BaseEntry>)`
  - `get(path: string): BaseEntry | undefined`
  - `set(path: string, entry: BaseEntry): void`
  - `delete(path: string): void`
  - `toJSON(): Record<string, BaseEntry>` (for persistence)
- `conflictCopyName(path: string, device: string, when: Date): string`

- [ ] **Step 1: Write failing test `client/test/base.test.ts`**
```ts
import { describe, it, expect } from "vitest";
import { BaseStore, conflictCopyName } from "../src/base";

describe("BaseStore", () => {
  it("round-trips entries and serializes", () => {
    const b = new BaseStore();
    b.set("a.md", { hash: "h1", text: "hello" });
    b.set("img.png", { hash: "h2" });
    expect(b.get("a.md")).toEqual({ hash: "h1", text: "hello" });
    expect(b.get("img.png")?.text).toBeUndefined();
    const json = b.toJSON();
    const b2 = new BaseStore(json);
    expect(b2.get("a.md")?.hash).toBe("h1");
    b2.delete("a.md");
    expect(b2.get("a.md")).toBeUndefined();
  });
});

describe("conflictCopyName", () => {
  it("inserts a conflict marker before the extension", () => {
    const when = new Date(Date.UTC(2026, 10, 28, 14, 30)); // 2026-11-28 14:30 UTC
    const n = conflictCopyName("notes/meeting.md", "Laptop", when);
    expect(n).toMatch(/^notes\/meeting \(conflict Laptop \d{12}\)\.md$/);
  });
  it("handles a dotless filename", () => {
    const n = conflictCopyName("README", "Phone", new Date(Date.UTC(2026, 0, 1, 0, 0)));
    expect(n).toMatch(/^README \(conflict Phone \d{12}\)$/);
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement `client/src/base.ts`**
```ts
export interface BaseEntry { hash: string; text?: string }

export class BaseStore {
  private m: Map<string, BaseEntry>;
  constructor(initial: Record<string, BaseEntry> = {}) {
    this.m = new Map(Object.entries(initial));
  }
  get(path: string): BaseEntry | undefined { return this.m.get(path); }
  set(path: string, entry: BaseEntry): void { this.m.set(path, entry); }
  delete(path: string): void { this.m.delete(path); }
  paths(): string[] { return [...this.m.keys()]; }
  toJSON(): Record<string, BaseEntry> { return Object.fromEntries(this.m); }
}

function pad(n: number, w = 2): string { return n.toString().padStart(w, "0"); }

export function conflictCopyName(path: string, device: string, when: Date): string {
  const ts = `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}`;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${stem} (conflict ${device} ${ts})${ext}`;
}
```

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit** `git add client/src/base.ts client/test/base.test.ts && git commit -m "feat(client): base store + conflict-copy naming"`

---

## Task 3: Pure reconcile decision function

**Files:** Create `client/src/reconcile.ts` (decision only for this task), `client/test/reconcile.test.ts`.
**Interfaces:** Produces
- `type Presence = { hash: string } | null` (null = absent on that side).
- `type Action = "in-sync" | "push" | "pull" | "delete-local" | "delete-remote" | "merge" | "conflict-copy" | "edit-wins-keep-local" | "edit-wins-pull";`
- `function decide(local: Presence, base: { hash: string } | null, remote: Presence): Action`

Decision table (local L, base B, remote R by hash; null = absent):
| L | B | R | Action | Why |
|---|---|---|--------|-----|
| present, L==R | any | present | `in-sync` | already equal |
| present | null | null | `push` | local-only new |
| present, L==B | present | null | `delete-local` | remote deleted, local unchanged |
| present, L!=B | present | null | `edit-wins-keep-local` | remote deleted but local edited |
| null | null | present | `pull` | remote-only new |
| null | present, R==B | present | `delete-remote` | local deleted, remote unchanged |
| null | present, R!=B | present | `edit-wins-pull` | local deleted but remote edited |
| present, L!=R | null | present | `conflict-copy` | both exist, differ, no base (first connect) |
| present, L!=R, B==L | present | present | `pull` | only remote changed → fast-forward |
| present, L!=R, B==R | present | present | `push` | only local changed |
| present, L!=R, B!=L, B!=R | present | present | `merge` | both changed → try merge (caller falls back to conflict-copy) |
| null | any | null | `in-sync` | nothing anywhere |

- [ ] **Step 1: Write failing test `client/test/reconcile.test.ts`**
```ts
import { describe, it, expect } from "vitest";
import { decide } from "../src/reconcile";

const H = (h: string) => ({ hash: h });

describe("decide", () => {
  it("local-only new -> push", () => expect(decide(H("a"), null, null)).toBe("push"));
  it("remote-only new -> pull", () => expect(decide(null, null, H("b"))).toBe("pull"));
  it("equal both sides -> in-sync", () => expect(decide(H("x"), H("x"), H("x"))).toBe("in-sync"));
  it("pre-existing divergence, no base -> conflict-copy", () => expect(decide(H("a"), null, H("b"))).toBe("conflict-copy"));
  it("only remote changed -> pull", () => expect(decide(H("a"), H("a"), H("b"))).toBe("pull"));
  it("only local changed -> push", () => expect(decide(H("b"), H("a"), H("a"))).toBe("push"));
  it("both changed -> merge", () => expect(decide(H("b"), H("a"), H("c"))).toBe("merge"));
  it("remote deleted, local unchanged -> delete-local", () => expect(decide(H("a"), H("a"), null)).toBe("delete-local"));
  it("remote deleted, local edited -> edit-wins-keep-local", () => expect(decide(H("b"), H("a"), null)).toBe("edit-wins-keep-local"));
  it("local deleted, remote unchanged -> delete-remote", () => expect(decide(null, H("a"), H("a"))).toBe("delete-remote"));
  it("local deleted, remote edited -> edit-wins-pull", () => expect(decide(null, H("a"), H("b"))).toBe("edit-wins-pull"));
  it("nothing anywhere -> in-sync", () => expect(decide(null, null, null)).toBe("in-sync"));
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement `decide` in `client/src/reconcile.ts`**
```ts
export type Presence = { hash: string } | null;
export type Action =
  | "in-sync" | "push" | "pull" | "delete-local" | "delete-remote"
  | "merge" | "conflict-copy" | "edit-wins-keep-local" | "edit-wins-pull";

export function decide(local: Presence, base: { hash: string } | null, remote: Presence): Action {
  const L = local?.hash ?? null, B = base?.hash ?? null, R = remote?.hash ?? null;
  if (L === null && R === null) return "in-sync";
  if (L !== null && R !== null && L === R) return "in-sync";
  if (L !== null && R === null) {
    if (B === null) return "push";                 // local-only new
    return L === B ? "delete-local" : "edit-wins-keep-local";
  }
  if (L === null && R !== null) {
    if (B === null) return "pull";                 // remote-only new
    return R === B ? "delete-remote" : "edit-wins-pull";
  }
  // both present, L !== R
  if (B === null) return "conflict-copy";          // no common base -> never clobber
  if (B === L) return "pull";                       // only remote changed
  if (B === R) return "push";                       // only local changed
  return "merge";                                   // both changed
}
```

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit** `git add client/src/reconcile.ts client/test/reconcile.test.ts && git commit -m "feat(client): pure reconcile decision function"`

---

## Task 4: Reconcile engine (executes decisions)

**Files:** Modify `client/src/reconcile.ts` (add the engine); Modify `client/test/reconcile.test.ts` (add engine tests with fakes).
**Interfaces:** Consumes `SyncApi`, `VaultIo`, `ChunkCache`, `SyncState` from `sync.ts`; `pull`(rename risk — see note)/`pushFile` primitives; `BaseStore`, `conflictCopyName` from `base.ts`; `isMergeable`, `merge3` from `merge.ts`. Produces:
- `interface ReconcileDeps { api: SyncApi; io: VaultIo; base: BaseStore; cache: ChunkCache; state: SyncState; device: string; strategy: "auto-merge" | "conflict-file"; onConflict?: (path: string, copy: string) => void; onBaseChanged?: () => void; }`
- `async function reconcileAll(d: ReconcileDeps): Promise<void>` — reconcile every path across local ∪ remote.
- `async function reconcilePath(d: ReconcileDeps, path: string): Promise<void>` — reconcile one path.

Note: this task adds low-level helpers to `sync.ts` in Step 0 so the engine can read one file's bytes from the server by its chunk list, and hash local bytes.

- [ ] **Step 0: Add helpers to `client/src/sync.ts`** (exports used by the engine)
```ts
// (append to sync.ts)
import { sha256hex } from "./chunker"; // already imported at top; ensure present

// Fetch + reassemble a single file's bytes from its chunk list (cache-first).
export async function fetchFileBytes(api: SyncApi, cache: ChunkCache, chunks: string[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const h of chunks) {
    let b = cache.get(h);
    if (!b) { b = await api.getChunk(h); cachePut(cache, h, b); }
    parts.push(b);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// Push explicit bytes for a path (used to write a merged/conflict result). Returns file hash.
export async function pushBytes(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache, path: string, bytes: Uint8Array): Promise<string> {
  await io.write(path, bytes);
  return pushFile(api, io, state, cache, path);
}
```
(If `cachePut` isn't exported, export it from `sync.ts`. Keep `pull`/`pushFile`/`pushLocalNew` as-is; the engine supersedes `pull` for connect/notify but the primitives remain.)

- [ ] **Step 1: Write failing engine tests (append to `client/test/reconcile.test.ts`)**
```ts
import { reconcileAll, ReconcileDeps } from "../src/reconcile";
import { BaseStore } from "../src/base";
import { SyncApi, VaultIo, SyncState, ChunkCache, pushFile } from "../src/sync";
import { chunk, sha256hex } from "../src/chunker";
import { ChangesResponse, CommitRequest, FileMeta } from "../src/protocol";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function fakeServer() {
  const chunks = new Map<string, Uint8Array>(); const files = new Map<string, FileMeta>(); let version = 1;
  const api: SyncApi = {
    async changes(since) { return { version, upserts: [...files.values()].filter(f => f.version > since), deletes: [] } as ChangesResponse; },
    async missing(hs) { return hs.filter(h => !chunks.has(h)); },
    async getChunk(h) { return chunks.get(h)!; },
    async putChunk(h, b) { chunks.set(h, b); },
    async commit(r: CommitRequest) { const m: FileMeta = { ...r, version: ++version }; files.set(r.path, m); return m; },
    async deleteFile(p) { files.delete(p); },
  };
  return { api, chunks, files };
}
function fakeIo(seed: Record<string, string> = {}) {
  const m = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, enc(v)]));
  const io: VaultIo & { m: Map<string, Uint8Array> } = {
    m,
    async list() { const r = new Map<string, { mtime: number }>(); for (const k of m.keys()) r.set(k, { mtime: 0 }); return r; },
    async read(p) { return m.get(p)!; },
    async write(p, b) { m.set(p, b); },
    async remove(p) { m.delete(p); },
  };
  return io;
}
function deps(api: SyncApi, io: VaultIo, extra: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return { api, io, base: new BaseStore(), cache: new Map() as ChunkCache, state: { version: 0 } as SyncState, device: "Dev", strategy: "auto-merge", ...extra };
}
// helper: put a file on the server via the real push path from a throwaway client
async function serverPut(api: SyncApi, path: string, text: string) {
  const io = fakeIo({ [path]: text });
  await pushFile(api, io, { version: 0 } as SyncState, new Map() as ChunkCache, path);
}

describe("reconcileAll", () => {
  it("uploads local-only and downloads remote-only", async () => {
    const { api, files } = fakeServer();
    await serverPut(api, "remote.md", "from server");
    const io = fakeIo({ "local.md": "from client" });
    const d = deps(api, io);
    await reconcileAll(d);
    expect(files.has("local.md")).toBe(true);              // uploaded
    expect(dec((io as any).m.get("remote.md"))).toBe("from server"); // downloaded
  });

  it("pre-existing divergence with no base -> conflict-copy keeps BOTH (never clobbers)", async () => {
    const { api } = fakeServer();
    await serverPut(api, "note.md", "SERVER version");
    const io = fakeIo({ "note.md": "LOCAL version" });   // same path, different content, no base
    const d = deps(api, io);
    await reconcileAll(d);
    const m = (io as any).m as Map<string, Uint8Array>;
    // canonical path now holds the server version; local version preserved under a conflict copy
    expect(dec(m.get("note.md"))).toBe("SERVER version");
    const copies = [...m.keys()].filter(k => k.includes("(conflict"));
    expect(copies.length).toBe(1);
    expect(dec(m.get(copies[0]))).toBe("LOCAL version");  // nothing lost
  });

  it("both-changed mergeable -> three-way merge (auto-merge strategy)", async () => {
    const { api } = fakeServer();
    // establish a shared base on both sides
    await serverPut(api, "n.md", "l1\nl2\nl3\n");
    const io = fakeIo({ "n.md": "l1\nl2\nl3\n" });
    const base = new BaseStore(); base.set("n.md", { hash: await sha256hex(enc("l1\nl2\nl3\n")), text: "l1\nl2\nl3\n" });
    const d = deps(api, io, { base });
    // now diverge: local edits line1, remote edits line3
    (io as any).m.set("n.md", enc("L1\nl2\nl3\n"));
    await serverPut(api, "n.md", "l1\nl2\nL3\n");
    await reconcileAll(d);
    const merged = dec((io as any).m.get("n.md"));
    expect(merged).toContain("L1"); expect(merged).toContain("L3"); // both edits survive
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement the engine in `client/src/reconcile.ts`**
```ts
import { SyncApi, VaultIo, SyncState, ChunkCache, pushFile, pushBytes, fetchFileBytes } from "./sync";
import { sha256hex } from "./chunker";
import { BaseStore, conflictCopyName } from "./base";
import { isMergeable, merge3 } from "./merge";
import { FileMeta } from "./protocol";

export interface ReconcileDeps {
  api: SyncApi; io: VaultIo; base: BaseStore; cache: ChunkCache; state: SyncState;
  device: string; strategy: "auto-merge" | "conflict-file";
  onConflict?: (path: string, copy: string) => void;
  onBaseChanged?: () => void;
}

async function remoteManifest(api: SyncApi): Promise<Map<string, FileMeta>> {
  const resp = await api.changes(0);
  const m = new Map<string, FileMeta>();
  for (const f of resp.upserts) m.set(f.path, f);
  return m;
}

// Record a file's post-sync state as the new base (text kept only if mergeable).
async function setBase(d: ReconcileDeps, path: string, bytes: Uint8Array, hash: string) {
  d.base.set(path, isMergeable(path, bytes) ? { hash, text: new TextDecoder().decode(bytes) } : { hash });
  d.onBaseChanged?.();
}

export async function reconcileAll(d: ReconcileDeps): Promise<void> {
  const remote = await remoteManifest(d.api);
  const local = await d.io.list();
  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...d.base.paths()]);
  for (const p of paths) await reconcileOne(d, p, remote.get(p));
}

export async function reconcilePath(d: ReconcileDeps, path: string): Promise<void> {
  const remote = await remoteManifest(d.api);
  await reconcileOne(d, path, remote.get(path));
}

async function reconcileOne(d: ReconcileDeps, path: string, rmeta: FileMeta | undefined): Promise<void> {
  const localBytes = await readOrNull(d.io, path);
  const localHash = localBytes ? await sha256hex(localBytes) : null;
  const baseEntry = d.base.get(path) ?? null;
  const action = decide(
    localHash ? { hash: localHash } : null,
    baseEntry ? { hash: baseEntry.hash } : null,
    rmeta ? { hash: rmeta.hash } : null,
  );
  switch (action) {
    case "in-sync":
      if (localBytes && rmeta) await setBase(d, path, localBytes, rmeta.hash);
      return;
    case "push": {
      const h = await pushFile(d.api, d.io, d.state, d.cache, path);
      await setBase(d, path, localBytes!, h);
      return;
    }
    case "pull": {
      const bytes = await fetchFileBytes(d.api, d.cache, rmeta!.chunks);
      await d.io.write(path, bytes);
      await setBase(d, path, bytes, rmeta!.hash);
      return;
    }
    case "delete-local":
      await d.io.remove(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "delete-remote":
      await d.api.deleteFile(path); d.base.delete(path); d.onBaseChanged?.(); return;
    case "edit-wins-keep-local": {
      const h = await pushFile(d.api, d.io, d.state, d.cache, path); // re-create remotely
      await setBase(d, path, localBytes!, h); return;
    }
    case "edit-wins-pull": {
      const bytes = await fetchFileBytes(d.api, d.cache, rmeta!.chunks);
      await d.io.write(path, bytes); await setBase(d, path, bytes, rmeta!.hash); return;
    }
    case "merge":
    case "conflict-copy": {
      const remoteBytes = await fetchFileBytes(d.api, d.cache, rmeta!.chunks);
      const canMerge = action === "merge" && d.strategy === "auto-merge"
        && isMergeable(path, localBytes!) && isMergeable(path, remoteBytes) && baseEntry?.text !== undefined;
      if (canMerge) {
        const { merged, clean } = merge3(baseEntry!.text!, new TextDecoder().decode(localBytes!), new TextDecoder().decode(remoteBytes));
        if (clean) {
          const bytes = new TextEncoder().encode(merged);
          const h = await pushBytes(d.api, d.io, d.state, d.cache, path, bytes);
          await setBase(d, path, bytes, h);
          return;
        }
      }
      // Fallback / conflict-copy: remote becomes canonical; local kept as a copy.
      const copy = conflictCopyName(path, d.device, nowUtc());
      await d.io.write(copy, localBytes!);
      await d.io.write(path, remoteBytes);
      const ch = await pushFile(d.api, d.io, d.state, d.cache, copy);
      d.base.set(copy, isMergeable(copy, localBytes!) ? { hash: ch, text: new TextDecoder().decode(localBytes!) } : { hash: ch });
      await setBase(d, path, remoteBytes, rmeta!.hash);
      d.onConflict?.(path, copy);
      return;
    }
  }
}

async function readOrNull(io: VaultIo, path: string): Promise<Uint8Array | null> {
  try { return await io.read(path); } catch { return null; }
}
// `new Date()` with no args is disallowed in some harness contexts but fine in the plugin/tests.
function nowUtc(): Date { return new Date(); }
```
(Keep the `decide`/`Presence`/`Action` exports from Task 3 at the top of this file.)

- [ ] **Step 4: Run → passes** `cd client && npx vitest run test/reconcile.test.ts`.

- [ ] **Step 5: Commit** `git add client/src/reconcile.ts client/src/sync.ts client/test/reconcile.test.ts && git commit -m "feat(client): reconcile engine (merge, conflict-copy, safe deletes)"`

---

## Task 5: Settings — conflict strategy + device name

**Files:** Modify `client/src/settings.ts`.
**Interfaces:** Adds to `NewLiveSyncSettings`: `conflictStrategy: "auto-merge" | "conflict-file"` (default `"auto-merge"`), `deviceName: string` (default `""` → falls back to a generated name at use site).

- [ ] **Step 1: Extend the interface + defaults**
```ts
export interface NewLiveSyncSettings {
  serverUrl: string; username: string; password: string; verbose: boolean;
  conflictStrategy: "auto-merge" | "conflict-file";
  deviceName: string;
}
export const DEFAULT_SETTINGS: NewLiveSyncSettings = {
  serverUrl: "http://127.0.0.1:8789", username: "admin", password: "admin", verbose: false,
  conflictStrategy: "auto-merge", deviceName: "",
};
```

- [ ] **Step 2: Add the two controls in `display()`** (after the verbose toggle)
```ts
    new Setting(containerEl)
      .setName("Conflict handling")
      .setDesc("How to resolve a file edited on two devices before syncing.")
      .addDropdown((dd) => dd
        .addOption("auto-merge", "Auto-merge Markdown (recommended)")
        .addOption("conflict-file", "Always create a conflict copy")
        .setValue(s.conflictStrategy)
        .onChange(async (v) => { s.conflictStrategy = v as any; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown in conflict-copy filenames. Blank = auto.")
      .addText((t) => t.setValue(s.deviceName).onChange(async (v) => { s.deviceName = v.trim(); await this.plugin.saveSettings(); }));
```

- [ ] **Step 3: Build/typecheck** `cd client && npx tsc --noEmit` (main.ts may still reference old shape until Task 6 — commit together if so).

- [ ] **Step 4: Commit** `git add client/src/settings.ts && git commit -m "feat(client): conflict-strategy + device-name settings"`

---

## Task 6: Wire reconcile into the plugin

**Files:** Modify `client/src/main.ts`.
**Interfaces:** Consumes `reconcileAll`, `reconcilePath`, `ReconcileDeps` from `reconcile.ts`; `BaseStore` from `base.ts`.

- [ ] **Step 1: Add base persistence + reconcile deps to the plugin**
  - Add fields: `private base = new BaseStore();` and drop `lastHash`/`known`/`pushLocalNew` usage in favor of the base (keep `applying`, `cache`, `state`).
  - `loadSettings()`: also load persisted base: store both settings and base under one data blob — change `loadData`/`saveData` to `{ settings, base }`. Concretely:
```ts
async loadSettings() {
  const data = (await this.loadData()) ?? {};
  this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});
  this.base = new BaseStore(data.base ?? {});
}
async saveSettings() { await this.persist(); }
private async persist() { await this.saveData({ settings: this.settings, base: this.base.toJSON() }); }
```
  - Add `private deps(): ReconcileDeps` builder:
```ts
private deviceLabel(): string {
  return this.settings.deviceName || `${(navigator as any).platform ?? "device"}-${(this.app as any).appId?.slice?.(0,6) ?? "local"}`;
}
private deps(): ReconcileDeps {
  return {
    api: this.api!, io: this.io, base: this.base, cache: this.cache, state: this.state,
    device: this.deviceLabel(), strategy: this.settings.conflictStrategy,
    onConflict: (p, c) => this.log(`conflict on ${p} → kept your copy as ${c}`, true),
    onBaseChanged: () => { void this.persist(); },
  };
}
```
- [ ] **Step 2: Replace connect reconcile** — in `reconnect()`, replace the `pull(...) + changes(0) + pushLocalNew(...)` block with:
```ts
      this.applying = true;
      await reconcileAll(this.deps());
      this.applying = false;
      this.log(`reconciled → v${this.state.version}`);
```
- [ ] **Step 3: Replace remote-change handler** — `onRemoteChanged()` body becomes `await reconcileAll(this.deps())` (wrapped in the existing `applying`/try-finally + version-change log).
- [ ] **Step 4: Replace local-event handlers** — `onLocalChange`, `onLocalDelete`, `onLocalRename` each become base-aware via `reconcilePath`:
```ts
private async onLocalChange(f: TAbstractFile) {
  if (this.applying || !this.api || !(f instanceof TFile)) return;
  this.applying = true;
  try { await reconcilePath(this.deps(), f.path); this.setStatus("connected", `v${this.state.version}`); }
  catch (e: any) { this.log(`sync FAILED for ${f.path}: ${e?.message ?? e}`); }
  finally { this.applying = false; }
}
private async onLocalDelete(path: string) {
  if (this.applying || !this.api) return;
  this.applying = true;
  try { await reconcilePath(this.deps(), path); } catch (e: any) { this.log(`delete sync FAILED for ${path}: ${e?.message ?? e}`); }
  finally { this.applying = false; }
}
private async onLocalRename(file: TAbstractFile, oldPath: string) {
  if (this.applying || !this.api || !(file instanceof TFile)) return;
  this.applying = true;
  try { await reconcilePath(this.deps(), oldPath); await reconcilePath(this.deps(), file.path); }
  catch (e: any) { this.log(`rename sync FAILED: ${e?.message ?? e}`); }
  finally { this.applying = false; }
}
```
  Remove the now-unused `noteSyncedBytes`/`forgetSynced`/`lastHash`/`known` and `ObsidianVaultIo`'s `noteSynced` callback (the base store replaces the echo-guard: reconcile re-reads state each time and a no-op file is `in-sync`). Keep `ObsidianVaultIo` read/write/remove/list.
- [ ] **Step 5: Build + typecheck + unit tests** `cd client && npm run build && npx tsc --noEmit && npx vitest run test/reconcile.test.ts test/merge.test.ts test/base.test.ts test/chunker.test.ts test/sync.test.ts` — all green.
- [ ] **Step 6: Commit** `git add client/src/main.ts && git commit -m "feat(client): wire base-aware reconcile into the plugin"`

---

## Task 7: Headless E2E — divergence, merge, conflict-copy

**Files:** Modify `client/test/e2e.spec.ts`.
**Interfaces:** Uses `reconcileAll`/`reconcilePath` + `BaseStore` per client (each `Client` gets its own `base`).

- [ ] **Step 1: Give each E2E `Client` a `BaseStore` + a reconcile helper**, and rewrite `connect()` to `reconcileAll` instead of pull+pushLocalNew. Add scenarios (append to the existing test or add a second `it`):
```ts
  it("three-way merges divergent Markdown and conflict-copies divergent binary", async () => {
    const a = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-A-")));
    const b = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-B-")));

    // shared base
    await a.io.write("m.md", new TextEncoder().encode("l1\nl2\nl3\n"));
    await reconcileAll(aDeps(a)); await reconcileAll(bDeps(b));
    expect(new TextDecoder().decode(await b.io.read("m.md"))).toBe("l1\nl2\nl3\n");

    // diverge offline: A edits line1, B edits line3
    await a.io.write("m.md", new TextEncoder().encode("L1\nl2\nl3\n"));
    await b.io.write("m.md", new TextEncoder().encode("l1\nl2\nL3\n"));
    await reconcileAll(aDeps(a));         // A pushes its change
    await reconcileAll(bDeps(b));         // B merges A's change with its own
    await reconcileAll(aDeps(a));         // A pulls the merged result
    const am = new TextDecoder().decode(await a.io.read("m.md"));
    expect(am).toContain("L1"); expect(am).toContain("L3");  // both survive

    // binary divergence -> conflict copy (never clobber)
    const b1 = new Uint8Array(3000).map((_, i) => i & 0xff);
    const b2 = new Uint8Array(3000).map((_, i) => (i * 7) & 0xff);
    await a.io.write("x.bin", b1); await reconcileAll(aDeps(a)); await reconcileAll(bDeps(b));
    await a.io.write("x.bin", b1.map((v) => v ^ 1)); // A changes it
    await b.io.write("x.bin", b2);                    // B changes it differently
    await reconcileAll(aDeps(a)); await reconcileAll(bDeps(b));
    const bfiles = await bList(b);
    expect(bfiles.some((p) => p.includes("(conflict"))).toBe(true); // B kept both
  }, 30000);
```
  Provide small `aDeps(c)/bDeps(c)` builders in the test that construct `ReconcileDeps` with `device: "A"|"B"`, `strategy: "auto-merge"`, a per-client `BaseStore`, and the client's `api/io/cache/state`. Add a `bList` helper that returns the FS listing keys.
- [ ] **Step 2: Build server + run full client suite** `cd server && cargo build && cd ../client && npm run build && npx tsc --noEmit && npx vitest run` — all green (unit + E2E). If the merge/conflict scenario reveals an engine bug, fix `reconcile.ts` (not the test).
- [ ] **Step 3: Commit** `git add client/test/e2e.spec.ts && git commit -m "test(client): E2E for three-way merge + binary conflict-copy"`

---

## Task 8: Docs + full verification

**Files:** Modify `docs/design/e2e-process.md`, `docs/design/backlog.md`.

- [ ] **Step 1:** Full suite: `cd server && cargo test` (green, unchanged) + `cd client && npx tsc --noEmit && npx vitest run` (green).
- [ ] **Step 2:** Containerized E2E: `docker compose -f docker-compose.e2e.yml up --build --abort-on-container-exit --exit-code-from e2e` → exit 0.
- [ ] **Step 3:** `e2e-process.md`: update the M3 caveat — conflicts now **three-way-merge Markdown** and **conflict-copy** everything else (no more last-write-wins clobber); add manual scenarios S12 (edit same note offline on two devices → merged, no loss) and S13 (pre-existing vault first-connect with a same-named different file → both kept). `backlog.md`: resolve B3 (done in M3); add a note that base text is stored whole in `saveData` (optimize to chunk-refs later).
- [ ] **Step 4: Commit** `git add docs/design && git commit -m "docs(m3): reconciliation/merge/conflict-copy behavior + scenarios"`

---

## Self-review notes

- **Spec coverage (B3):** local-only→push, remote-only→pull, identical→in-sync, divergent-no-base→conflict-copy (the reported bug), divergent-with-base→three-way merge (Markdown) or conflict-copy (binary/unclean/conflict-file strategy), delete-vs-edit→edit-wins. All in `decide` (Task 3) + engine (Task 4), tested unit + E2E. ✅
- **Never-lose-data:** every divergence path writes the local side somewhere (canonical or conflict-copy) before overwriting; `decide` has no bare-overwrite branch when both sides changed. ✅
- **Design deviations noted:** base *text* persisted whole in `saveData` (simple; chunk-ref base is a later optimization → backlog). Base is per-device (correct — it's each device's last-agreed state). `new Date()` used for conflict timestamps (fine in plugin/vitest; not a workflow-script context).
- **Type consistency:** `Action`/`Presence`/`decide` (Task 3) reused by the engine (Task 4); `ReconcileDeps` shape identical across engine, main.ts wiring, and E2E; `BaseEntry`/`BaseStore` identical across base.ts, engine, main.ts. `fetchFileBytes`/`pushBytes`/`cachePut` added to `sync.ts` and consumed by the engine.
- **Server unchanged** — M3 is client-only; server stays 15/15.
- **Carry-over limits:** whole-`saveData` base rewrite per change (perf, backlog); no cross-device causal clock (a rare 3-way concurrent edit still resolves pairwise safely via conflict-copy); reconcile is O(files) per run (fine for M3; incremental reconcile is a later optimization).

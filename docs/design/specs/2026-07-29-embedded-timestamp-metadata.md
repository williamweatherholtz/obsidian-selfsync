# Embedded Timestamp Metadata + Volatile-Field-Aware Sync — Design Spec

- **Date:** 2026-07-29
- **Status:** Draft (refine phase; awaiting human review before implementation plan)
- **Author:** claudeOpus (design), wweatherholtz (direction)
- **Sprint:** `embeddedTimestampMetadata` (delivery)

## 1. Problem

Two related pains, one root cause.

1. **Filesystem timestamps lie.** `ctime`/`mtime` change spuriously — copying or moving a note between machines rewrites them even though the content is untouched. So "last modified" and "recently edited" views can't be trusted, and there is no durable, portable record of when a note *actually* changed.
2. **Timestamp-only diffs flood the user with false conflicts.** SelfSync hashes the **entire file, byte-for-byte, frontmatter included** (`sha256hex` over full content in `reconcile.ts`), and has **zero frontmatter awareness**. The moment any device changes a `updated:` field, the hash changes → SelfSync treats it as a real content change → two devices doing so independently produce a conflict or a merge. The timestamp field *is* content, as far as the engine is concerned.

The user's framing of the fix: *"if the file hasn't legitimately changed, this should be auto-resolved."* That is exactly git's model — content-addressed identity that ignores volatile metadata.

## 2. Goals / Non-goals

**Goals**
- An **authoritative, embedded** `updated`/`created` timestamp in note frontmatter, owned by SelfSync, that survives copy/move and reflects only *genuine* content changes.
- Sync **never raises a conflict** for a difference that is only in managed timestamp fields.
- The embedded timestamp **drives filesystem times** where the OS permits (so external tools and Dataview's `file.mtime` become accurate too).

**Non-goals**
- Managing arbitrary user frontmatter (only the two managed timestamp keys).
- Setting POSIX `ctime` (impossible on every OS — see §7).
- A general field-level frontmatter merge engine (we do the minimal timestamp reconciliation; a broader merge is a possible later generalization).
- Mobile filesystem-time fidelity (best-effort only; embedded value remains truth).

## 3. Key decisions (resolved forks)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **SelfSync owns the timestamp** (no external writer plugin). | SelfSync is the sync engine — it knows precisely when a *genuine* content change happens. Editor-event plugins (Linter, Update-time-on-edit) re-stamp on every device that touches a note, which is a primary *cause* of the conflict flood. One authority = consistency + no churn loop. |
| D2 | **Full ISO 8601 with offset** — `2026-07-29T14:30:00-06:00` — default keys `created` / `updated` (configurable; Linter preset `date created`/`date modified`). | Standard, human-readable in the author's local wall-clock, and **unambiguous** (offset pins the instant). The only cost is Obsidian's native datetime-*property* widget won't type an offset — irrelevant here because SelfSync owns the field, not the Properties panel. Format never affects correctness (see D4). |
| D3 | **Take the *older* `updated` / *earliest* `created`** when content is otherwise identical. | Once content is known identical-modulo-timestamp, the newer stamp is *definitionally spurious* (a copy, re-open, or re-stamp — not a real edit), so the older `updated` is the truthful last-real-change time. This is a deliberate inversion of Syncthing's "newer-wins" — justified because we *know* the content matches, which Syncthing doesn't. For a genuine merge (real content change on both sides), the merge produces new content, so `updated` = now. |
| D4 | **Identity = normalized content hash** that masks the managed keys (git model). | The single most robust primitive: strip managed keys → stable-serialize → normalize EOL → hash. Timestamp-only diffs hash equal → non-events. SelfSync stamping its own field can't cause a sync loop (stamp changes raw bytes, not the normalized hash). |
| D5 | **Write scope = all markdown notes, minus a user "Excluded folders" list.** | Comprehensive accuracy by default; a folder-path exclusion list (with autocomplete + add/remove) lets the user carve out folders SelfSync must leave completely alone. |
| D6 | **Drive `mtime` from `updated` (all desktop); drive creation time (birthtime) from `created` on Windows/macOS; degrade gracefully on Linux/mobile; never touch POSIX `ctime`.** | Hard OS limits, not preferences — see §7. "Creation time" (Explorer's *Date created* / birthtime) is settable on Windows & macOS; Linux exposes no API; POSIX `ctime` is unsettable everywhere by design (and isn't creation time anyway). |
| D7 | **First-seed `created`/`updated` from existing file metadata, not "now".** | Adopting a pre-existing vault must preserve each note's real history; initializing from `TFile.stat` (OS creation/modification time) is the best available signal — far better than stamping every old note as just-created. |

## 4. Architecture — four components + settings

Each is an independently testable unit; all *decision logic* is pure (no Obsidian/DOM), mirroring the repo's `statuslight.ts` / `syncstate.ts` / `configsync.ts` / `reconcile.ts::finalize` convention. The impure edges are thin adapters.

1. **`frontmatter.ts` (pure)** — parse/serialize YAML frontmatter; extract & set the managed keys; produce the **normalized content** (managed keys masked, stable key order, normalized EOL). Falls back to raw bytes for non-markdown / unparseable YAML (never throws).
2. **`excludedFolders.ts` (pure)** — `normalizeFolder`, `addExcluded`, `removeExcluded`, `isExcluded(path, list)`, `matchFolders(query, allFolders)` (autocomplete ranking). Set-semantics + sorted, extracted from the existing `setPluginSync` shape.
3. **Reconcile integration (pure decision, in `reconcile.ts`)** — a normalized-equality check at the existing `sameIgnoringEol` / `planMerge` seam; a new `timestampOnly` resolution branch (adopt + field-reconcile, no conflict copy). `isExcluded` is wired into the pure `shouldSync` so exclusion is covered by the existing sync test matrix.
4. **`fstimes.ts` (thin, impure)** — after any write, set `mtime` from `updated` (Obsidian `DataWriteOptions.mtime`, unix-ms) and, on Windows/macOS, birthtime from `created` via an optional native addon. Best-effort; failures degrade silently to mtime-only.

**Settings surface** — a master toggle, configurable key names, the "drive FS times" toggle, and the **Excluded folders** list: dynamic rows (folder-path input + `AbstractInputSuggest` autocomplete over `app.vault.getAllFolders()`), an "Add folder" button, per-row remove (×). The suggester is a thin adapter over the pure `matchFolders`. Persisted via a single `setExcludedFolders` plugin method (mirrors `setPluginSync`); the list container re-renders **in place** (the `fillStatus`/`listEl.empty()` pattern) so a text input mid-edit never loses focus.

## 5. The identity model (the crux)

Two hashes per file, both recorded in `BaseEntry` (`base.ts`):

- **Raw hash** — SHA-256 of full bytes. *Unchanged.* Continues to drive storage, CAS, and the wire protocol, so the server and versioning stay byte-exact.
- **Normalized hash** (`normHash`, persisted) — SHA-256 of content after: parse frontmatter → drop managed keys → stable-serialize → normalize EOL/trailing-newline (subsumes the existing `sameIgnoringEol` cosmetic check). Answers **"is this the same *logical* version?"**

`decide()` / `planMerge` gain a pre-check: **raw hashes differ but normalized hashes equal ⇒ `timestampOnly`** — not a conflict, not a content change. Edge cases: non-markdown, binary, or unparseable-YAML files → `normHash == rawHash` (behavior unchanged); malformed YAML is treated as opaque (never corrupted).

## 6. Resolution & data flow

**Stamping (local genuine change → push):** SelfSync detects a genuine change (local `normHash` ≠ base `normHash`) → stamps `updated = now` (ISO+offset) → pushes → records base (raw + norm + instant) → drives FS times. Stamping changes raw bytes but not `normHash`, so no loop and the stamp rides this same push.

**First-seed (note has no managed fields yet):** initialize `created`/`updated` from the file's *existing* metadata — `TFile.stat` ctime/mtime (OS creation/modification time) — **not** the current time, so adopting a pre-existing vault preserves each note's real history instead of marking every old note as just-created. Falls back to now only if stat is unavailable. `TFile.stat` is available on desktop and mobile, so seeding is portable.

**Copy / spurious bump (the churn-killer):** local raw hash ≠ base but `normHash` == base ⇒ no real change ⇒ SelfSync **restores the managed fields to base's (older) values and does not push.** This is what stops the conflict flood at its source.

**Pull:** remote vs local `normHash` equal ⇒ `timestampOnly` ⇒ reconcile fields (`created` = min, `updated` = older), adopt, **no conflict copy**. Otherwise the existing 3-way merge / conflict-copy path runs unchanged; a genuine merge produces new content so `updated` = now. Write → drive FS times.

## 7. Filesystem-time driving — per-OS reality

| OS | `mtime` from `updated` | creation time (birthtime) from `created` | POSIX `ctime` |
|----|----|----|----|
| Windows (desktop) | ✅ `DataWriteOptions.mtime` / `fs.utimes` | ✅ via native addon (`SetFileTime`) | ❌ never (unsettable) |
| macOS (desktop) | ✅ | ✅ via native addon | ❌ never |
| Linux (desktop) | ✅ | ❌ kernel exposes no API — skip | ❌ never |
| iOS / Android (Capacitor) | ⚠️ best-effort / skip | ❌ | ❌ never |

"Creation time" = Explorer's *Date created* / birthtime, and is a real feature we ship on Windows/macOS. POSIX `ctime` (inode-metadata-change time) is a *different* thing, unsettable everywhere by design, and not useful to embed-drive. The birthtime path is **strictly best-effort**: if the native addon can't load, everything else (including `mtime`) still works — mtime-only is a clean fallback that loses only the creation-time nicety.

## 8. Test architecture (BDD/TDD, architected before implementation)

Behavior specs are written **first** (failing), across three layers — matching the repo's existing harnesses:

**Layer 1 — pure unit (vitest, zero DOM):**
- `frontmatter.test.ts` — parse/serialize round-trip; normalized-hash masks managed keys; stable key order; EOL normalization; unparseable-YAML → raw fallback; non-markdown passthrough.
- `excludedFolders.test.ts` — add/remove set-semantics + sort; `normalizeFolder` hygiene; `isExcluded` prefix-matching (folder boundaries, root, nested); `matchFolders` ranking.
- Field-reconcile table — `created` = min, `updated` = older (identical content) vs now (genuine merge).

**Layer 2 — integration (`reconcile.test.ts`, fake IO + fake server):**
- timestamp-only diff → **no conflict copy**, fields reconciled (older/min).
- copy-bump (raw≠, norm=) → **reverted, not pushed**.
- genuine content conflict → still conflicts/merges as today (no regression).
- excluded folder → SelfSync never reads/writes its timestamps; `serverHasFile` stays false for excluded content.

**Layer 3 — DOM + e2e:**
- `settings-ui.dom.test.ts` (happy-dom harness `ui-dom-harness.ts`) — Add row, type a folder, ×-remove, assert `setExcludedFolders` wiring; requires new `AbstractInputSuggest` / `TFolder` / `getAllFolders` stubs in `obsidian-stub.ts`.
- `*.pwspec.ts` (real Obsidian, Playwright+Electron) — seed real vault folders via `stageVault(seedFiles)`, open settings, add/remove an excluded folder, assert `settings.excludedFolders` **and** the payoff: an excluded folder's file never reaches the server (`serverHasFile === false`). A small `openPluginSettings(page)` helper is added.

**FS-driver tests** mock `utimes`/`DataWriteOptions`: assert `mtime` set from `updated`; birthtime attempted on Win/mac, skipped on Linux, graceful on addon failure.

Per repo policy: after shared server-shape changes run full `cargo test` + `clippy -D warnings` (CI runs neither), and `keel reverify` to clear drift.

## 9. Tracked refine artifacts (engine)

Authored in `.tracking/` and validated by `keel`:

- **Needs** (`business/business.sysml`, → `goal3ConflictMerge`): `nTimestampFidelity` (accurate, portable, drives FS times), `nNoMetadataConflicts` (no timestamp-only conflicts).
- **Use cases** (`business/usecases.sysml`, → `selfHoster` + Need): `ucCopyPreservesTimestamp`, `ucTimestampOnlyNoConflict`, `ucExcludedFolderUntouched`.
- **System requirements** (`requirements/requirements.sysml`, EARS, `satisfy`→Need): `srEmbeddedTimestamp`, `srNormalizedIdentity`, `srTimestampConflictResolve`, `srDriveFsTimes`, `srExcludedFolders`.
- **Verification** (`verification/acceptance.sysml`, `method=test`, `#Verify`→SR): one acceptance Test per SR, `location` = the test files above.
- **Delivery** (`delivery/delivery.sysml`): `#Capability` Story `embeddedTimestampCapability` with `#DerivedFrom` + `#CharteredBy` → Need; sprint action `embeddedTimestampMetadata` + `…DoD`.

## 10. Risks

- **Native addon for birthtime** (e.g. `@baileyherbert/utimes`) — per-platform prebuilt binaries + a plugin build/distribution wrinkle. Mitigated by strict best-effort: absent/failing addon → mtime-only, sync unaffected. If distribution proves ugly, drop birthtime and keep mtime-only.
- **SelfSync now writes into user notes' frontmatter** — a new behavior (it never touched frontmatter before). Bounded by the excluded-folders list and the "only genuine change" gate; the normalized-hash guarantees no write loop.
- **YAML edge cases** — non-standard frontmatter, Windows line endings, notes with body-level `---`. Handled by parse-don't-validate with raw-bytes fallback; covered by Layer-1 tests.

## 11. Rollout

Runs as the `embeddedTimestampMetadata` sprint (refine → standup → implement → review → closeOut → retro → deploy), TDD throughout, shipping as a **MINOR** release (new feature). The per-sitting human review is the single human gate.

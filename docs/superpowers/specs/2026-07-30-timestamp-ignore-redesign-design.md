# Embedded-timestamp redesign: *ignore*, don't *own* — design (v2, critic-hardened)

**Date:** 2026-07-30
**Status:** REVISED after 3 independent antagonistic critiques (convergence / data-safety / design-fit)
**Supersedes the behavior of:** 1.7.0 / 1.7.1 / 1.8.0 "Embed created/updated timestamps"
**Author:** claudeOpus (with wweatherholtz)

---

## 0. Why we're here (the field failure)

The shipped feature had SelfSync **own** two frontmatter keys (`created`/`updated`): conform → canonical
ISO, backfill the whole vault on enable, seed missing values from OS metadata, stamp `updated` on push,
optionally drive filesystem mtime/creation-time. On a real *copied* multi-device vault this produced:

1. **Fabricated `created`.** Windows resets creation time on copy → `seedValues` read `ctime ≈ now` and
   stamped today's date. `detectRestoreSignature` (5 s bucket) missed a slow copy.
2. **Mass spurious conflict copies.** `planBackfillItem`'s `needsCopy` compares
   `normalizedContent(original)` vs `normalizedContent(conformed)`; a no-frontmatter note gains a
   `---…---` block on conform → always differ → a conflict copy per plain note.
3. **CRLF/BOM false positives (SEPARATE root cause).** Independent of timestamps — see §3.0.

**Root insight (unchanged):** the goal was never "author my timestamps." It was *"a difference that is
only a timestamp (or only line-endings) must not cause a sync conflict."* That is served by the
**identity** layer, not by writing notes. So: **delete the writing apparatus; fix identity.**

**What the critiques changed (this is v2):** the naive "make `decide()` use a masked hash" is
**unimplementable and unsafe** — the server manifest gives only a *raw* hash, the ignore-list is
client-local, and `merge3`/`decide()` are raw. Collapsing to a masked identity breaks pending-counts,
delete-detection, and CAS, and causes vault-wide push/pull oscillation. Removing the old destructive
"revert-local-to-base" hack *without* teaching `merge3` and the local-change predicate about the
ignored keys **resurrects deleted notes** and **reintroduces the conflict-copy flood**. So v2 keeps the
two-tier `{raw hash, normHash}` base and applies normalization as a *post-decide, client-side override*.

---

## 1. Goal

SelfSync **never writes** note content. Its **content-identity** layer normalizes line-endings/BOM
(always) and, when the feature is on, ignores *timestamp-valued* frontmatter keys — so two versions
that differ only in those respects are recognized as the same content: no push, no conflict, no copy,
no rewrite.

## 2. Non-goals

- No authoring/seeding/conforming/formatting of any frontmatter value.
- No driving of filesystem mtime / creation time.
- No vault-wide backfill on enable.
- No claim about the *truth* of any timestamp; values are carried verbatim and merely excluded from
  change-detection when timestamp-shaped.

---

## 3. Design

### 3.0 Always-on content identity (the real CRLF/BOM fix — NOT gated on the timestamp feature)

The base store already carries a raw `hash` **and** an optional `normHash` (base.ts). Generalize
`normHash` into a **content-identity hash** computed by `contentIdentity(bytes)`:

- **Text (UTF-8-decodable):** strip BOM, normalize CRLF→LF, normalize trailing newline, then hash.
  **No frontmatter short-circuit** — today `normalizedHash` returns the *raw* hash for a note without
  frontmatter (`frontmatter.ts:120`), which is exactly why CRLF false-positives survive on plain notes.
  Remove that short-circuit: every text file gets EOL/BOM/trailing normalization.
- **Binary / non-decodable:** raw hash (unchanged).

This is **always on**, independent of `ignoreTimestampChanges`. It is the fix for reported bug 3.

### 3.1 Two-tier identity — raw for the wire, normalized for "did content change" (Q2 resolved: keep both)

`decide()`, the pending-count, delete-remote detection, version/CAS, and the server manifest
comparison **stay on the raw `hash`** — the manifest only ever gives a raw hash, so `rmeta.hash ===
base.hash` must remain the cheap "remote unchanged" test. Do **not** collapse `base.hash` to a
normalized hash (it would make every normalized note read as pending/never-in-sync and break
delete-remote). Instead, `normHash = contentIdentity(bytes)` is used as an **override** on exactly the
client-local predicates:

- **local-unchanged** ("do I have a local edit vs base?"),
- **in-sync** ("is my local content the same as what I last synced?"),
- **delete-local vs edit-wins** (see §3.3 — the resurrection fix),
- **`merge3` inputs** (see §3.4 — the conflict-copy fix).

### 3.2 Timestamp masking, VALUE-SHAPE GATED (Q3 resolved) + pattern matching (F2)

When `ignoreTimestampChanges` is on and the path uses masked identity (§3.6), `contentIdentity` also
strips a frontmatter line **iff both**:

1. its key matches an ignored-key **pattern** — default set, matched by regex, not a fixed list:
   `^(created|updated|modified)(-.+)?$` and `^date (created|modified)$`. The `(-.+)?` covers per-device
   keys like `updated-asi-laptop` (58 such notes exist in the real vault — the fixed 5-key list missed
   them, F2). `ignoredFrontmatterKeys` becomes a list of patterns, defaulting to the above.
2. its **value parses as a timestamp/date** (`isCanonicalTimestamp` OR `parseIso` succeeds — these are
   **kept**, not deleted). This is the guard that stops masking from eating a *real* edit like
   `updated: reviewed by Bob` (Finding D) and naturally leaves list/multiline values alone (a block
   value doesn't parse as a scalar timestamp, so it stays in identity — resolves Finding 7).

Only single-line top-level scalar keys are maskable (matches `keyOf`); documented as such.

### 3.3 Delete-local must use normalized equality (Finding C — data-integrity, CRITICAL)

`decide()`'s delete branch returns `delete-local` when `local === base` and `edit-wins-keep-local`
otherwise — on **raw** hashes today. Under the redesign a drifted local timestamp makes `local ≠ base`
(raw), so a note a peer legitimately deleted would be **re-pushed (resurrected)**. Fix: the
"did local change vs base?" test that distinguishes delete-local from edit-wins **must compare
`contentIdentity(local)` vs `base.normHash`**, not raw. Remote-presence/tombstone stays raw.

### 3.4 `merge3` must be mask-aware (Finding B — conflict-copy flood, CRITICAL)

`merge3` is a line-level diff3 that treats an ignored `updated:` line as ordinary content. With the old
destructive revert gone, the next *real* remote edit three-way-merges local (drifted timestamp) against
a stale ancestor → no clean resolution → conflict copy — the exact flood we're killing, now
*guaranteed*. Fix: before diff3, **neutralize ignored+timestamp-shaped lines** in base/local/remote to
a constant (or strip them), run the merge on the neutralized text, then re-emit **local's** ignored
lines verbatim in the merged output. A note whose only local change is a masked timestamp then merges
cleanly against any remote body edit.

### 3.5 Convergence on a timestamp-only / EOL-only difference (Q1 resolved: hybrid, no rewrite)

When `contentIdentity(local) === contentIdentity(remote/base)` but raw bytes differ, and the **remote
is unchanged** (`rmeta.hash === base.hash`): **keep local bytes as-is, do not push, keep `base.hash` =
the raw hash of the last-synced server bytes, refresh `base.normHash`.** Next poll: `rmeta.hash ===
base.hash` → cheap skip; local raw still differs but the normHash override re-fires → still no push →
**stable, zero writes, tolerant of any auto-timestamp plugin** (a rewrite-to-converge would re-trigger
such a plugin → infinite write loop — rejected). A fresh device pulls the server's single raw copy, so
"canonical for new devices" = whatever the server holds; existing per-device byte differences are
harmless because they're invisible to identity. Also stamp `(size,mtime)` after the override so the
scan-skip fast path still fires (Finding H).

### 3.6 Path gate (Finding F)

`usesMaskedIdentity(path)` = feature on ∧ `path.endsWith(".md")` ∧ not under `.obsidian/`
(`CONFIG_PREFIX`) ∧ not in an excluded folder. Config files (`.json`/`.css`) and any `.md` under
`.obsidian/` **always** use raw identity — a `created:` inside a JSON config must never be masked.
(EOL/BOM normalization of §3.0 still applies to text config files — that is safe and desirable.)

---

## 4. Settings (UX pivot)

| Old | New |
|---|---|
| `embeddedTimestamps: boolean` (writes notes) | `ignoreTimestampChanges: boolean` (identity-only) |
| `timestampCreatedKey` / `timestampUpdatedKey` | `ignoredFrontmatterKeys: string[]` — **patterns**, default `["created","updated","modified","created-*","updated-*","modified-*","date created","date modified"]` |
| `driveFsTimes` | **removed** |
| `excludedFolders` | **kept**, re-documented: "folders where timestamp-only diffs are NOT ignored (they sync raw)." (EOL/BOM normalization still applies everywhere.) |
| `timestampBackfill` marker | **removed** |

- Enabling does **nothing** to files — no backfill, no conform, no counted-consent modal. It changes
  only how sync compares notes henceforth. Disabling reverts to raw+EOL identity.
- Group copy states plainly: *"SelfSync never edits these fields — it only stops a difference that is
  only in one of these date fields from causing a sync conflict. If another plugin rewrites these on
  every edit, SelfSync ignores that churn instead of fighting it."*
- **Default (Q4): ON.** Safe because it never writes and is value-shape gated; it fixes the
  timestamp-conflict complaint out of the box, incl. for users who never touched the old broken
  feature. Documented trade-off: a *manually-curated* timestamp-valued field stops propagating between
  devices while masked (rare; a user who wants it synced removes that key from the patterns).
- **Settings migration:** persisted `embeddedTimestamps === true` → `ignoreTimestampChanges = true`;
  `embeddedTimestamps === false`/absent → **on** (the new default). Seed `ignoredFrontmatterKeys` from
  old `timestampCreatedKey`/`timestampUpdatedKey` ∪ defaults. Drop `driveFsTimes`/`timestampBackfill`.
  Migration **never** touches note content (fabrications are handled only by the separate §6 cleanup).

---

## 5. Code impact

**Delete (writing apparatus + destructive revert):**
- `frontmatter.ts`: `seedValues`, `conformTimestamps`, `reconcileManagedFields`, `pickOlder`,
  `setManagedValue` (write path). `getManagedValue` **kept** (cleanup/diagnostics read values).
  `isCanonicalTimestamp`, `parseIso`, `formatIsoOffset` **kept** (value-shape gate / cleanup).
- `timestampBackfill.ts`: delete the module.
- `main.ts`: `runTimestampBackfill`, `detectRestoreSignature`, `countNonCompliantTimestamps`, backfill
  orchestration, `BACKFILL_DONE`, marker persistence, `noteStat` (seeding use). `driveFsTimes` writes.
- `reconcile.ts`: `backfillPush`, `stampBytes` + the stamp-on-push branch, the copy-bump **revert**
  branch (reconcile.ts:1037-1047), the `reconcileManagedFields` merge branch.

**Add / change (identity):**
- `frontmatter.ts`: `contentIdentity(bytes, opts)` — EOL/BOM/trailing normalize always; strip
  ignored+timestamp-shaped keys when `opts.ignoredPatterns` given. Remove the `!hasFrontmatter → raw`
  short-circuit. Pattern matcher for keys.
- `reconcile.ts`: `normHash` populated via `contentIdentity` for **all** text files (EOL fix) and with
  masking on `usesMaskedIdentity` paths; local-unchanged/in-sync/**delete-local** predicates use
  `normHash`; `merge3` inputs neutralized per §3.4; convergence override per §3.5.
- `merge.ts`: `merge3` gains ignored-line neutralization (or a masked wrapper).
- `settings.ts`: `renderEmbeddedTimestamps` → `renderIgnoreTimestamps` (toggle + patterns + excluded
  folders); remove FS-times + counted-consent.

**Base migration:** on first load after upgrade, existing `base.hash` are raw and `normHash` may be
absent. `baseNormHash` already lazily recomputes from `base.text`; for notes past the 1 MiB text cap,
persist `normHash` unconditionally for `.md` (Finding I) so the override still fires.

---

## 6. Cleanup of existing damage (SEPARATE, user-gated, delete-only)

Ground-truth from the real vault (measured): 33 live copies (23 `ASI Laptop 2026-07-29` + 10 `Win32
2026-07-08`), 32 timestamp-only + 1 real; 22 survivors at fabricated `created: 2026-07-08`, ≥3 at
today, 1 created-after-updated; 58 notes with `updated-asi-laptop:`; **no git, birth-time contaminated,
`.trash` noisy** → `created` is irrecoverable for a real subset.

**Cleanup ships delete-only, with `created` left untouched by default:**

1. **Enumerate** conflict copies with a recognizer that accepts **both** the 14-digit and the legacy
   **12-digit** (minute-precision) suffix — the current regex misses all 10 Win32 copies (F3).
2. **Delete predicate** — device/date-agnostic; keys ONLY on masked equality (F5):
   `deletable(C,S) := isConflictCopy(C) ∧ exists(S) ∧ contentIdentity(C, IGNORE) === contentIdentity(S, IGNORE)`
   where `IGNORE` masks the full timestamp family incl. per-device suffixes (**same code path** as sync
   identity, F2). Anything failing this (e.g. the 1 real conflict) → routed to the conflict modal,
   never auto-deleted.
3. **Delete to `.trash`/backup**, emit a per-file manifest `(copy → survivor, action)`, require a
   dry-run first, reconcile totals **including a `skipped_unmatched` bucket** (F3/F6).
4. **`created` recovery is OFF by default** (F1/F4/F7): there is no honest automated source for this
   vault. Optional, strictly opt-in, per-note, only adopting a value `v` that
   `isValidIso(v) ∧ v < FIRST_BACKFILL_INSTANT(≈2026-07-08) ∧ v ≤ S.updated ∧ v = min(valid candidates)`;
   else leave untouched and **report "created unrecoverable."** Never invent (Non-goal).
5. Also **scan all 380 notes** (not just conflict pairs) and **report** the fabricated-`created` set
   (22 at 07-08, the today set, the created>updated case) — report only; no automated rewrite (F1).

Mitigation (stop the harm) does not depend on cleanup: shipping the redesign removes the writing path,
so no further stamping/copying occurs the moment it lands.

---

## 7. Open questions — RESOLVED by the critiques

- **Q1 (convergence):** hybrid keep-local **without rewrite** (§3.5). Neither pure pole is safe.
- **Q2 (base identity):** keep raw `base.hash` + separate `normHash` (§3.1). Do not collapse.
- **Q3 (key hazards):** value-shape gate (§3.2) — mask only timestamp-valued keys.
- **Q4 (default):** ON, given value-shape gate + always-on EOL fix (§4).
- **Q5 (conflict view):** mask ignored keys in the conflict "what differs" view (cosmetic; deferred).
- **Q6 (cleanup created):** delete-only; `created` untouched by default; recovery opt-in + predicate
  (§6.4). The enable-cutoff is the *first* backfill (2026-07-08), not the 07-29 run.

## 8. Remaining decisions for the human

- **Cleanup scope & timing** (touches real vault data — needs explicit go-ahead): delete-only now vs
  after the code ships; whether to attempt the opt-in `created` recovery at all given how little is
  honestly recoverable.
- Everything else is resolved; the code redesign proceeds on the design above.

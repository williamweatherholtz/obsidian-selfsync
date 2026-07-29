# Embedded-timestamp backfill — safe convergence on enable

- **Date:** 2026-07-29 (refactored after a 3-lens independent critique)
- **Status:** Draft (design; ready for implementation after this refactor)
- **Author:** claudeOpus (design), wweatherholtz (direction)
- **Extends:** `2026-07-29-embedded-timestamp-metadata.md` (the 1.7.0 feature); redefines its enable-time behavior.

## 0. Design history — what the critique changed

The first draft proposed a **generic "Convergence Engine"** that unified embedded-timestamps and config-sync under one `status(path, bytes)` trichotomy. Three independent antagonistic critics **rejected it**, with proof:
- `status(path, bytes)` **cannot express config's decision** — config needs `(local, base, remote)` (what `decide()` consumes), so its `status` can't be pure and the trichotomy loses the `community-plugins.json` **union-merge** and the `edit-wins-*` **never-resurrect** guards. Unifying would either duplicate those guards (drift) or leave config in place (making the "engine" timestamp-specific anyway).
- **Verified shipped-1.7.0 bugs** the redesign must fix: the line-based parser **corrupts block-scalar frontmatter** (demotes real keys to body) and **rewrites BOM/EOL/key-order**.
- The backfill, even standalone, had a **termination flaw** (device-TZ-relative "canonical" → no global fixed point).

**Resolution:** a **timestamp-specific backfill**, config left untouched; a YAML-boundary-correct parser with surgical edits; **instant-based** compliance; a drift-aware marker; a reversible first pass via conflict-copies. No generic engine, no `status` trichotomy, no config retrofit.

## 1. Goal

Enabling Embedded Timestamps should **instantiate immediately, visibly, safely, and reversibly** — bring every in-scope note into compliance (seed/normalize `created`/`updated`) on enable, not lazily on next edit — without corrupting frontmatter, fabricating history, or churning across devices/plugins.

## 2. Scope

Timestamp domain only. Config-sync is out of scope and **unchanged**. In-scope = markdown notes (`.md`), minus excluded folders, minus a default-excluded `Templates/` (and Obsidian's configured template folder if readable — Finding 9).

## 3. Compliance — **instant-based**, not string-exact (fixes critic-2 F2)

A note is **compliant** iff `created` and `updated` are both present and each **parses to a valid ISO-8601 instant** (`parseIso` succeeds). It is **not** required to match this device's exact offset string. Consequences:
- Two devices in different timezones that hold the same instant in different offset strings are **both compliant** — no device rewrites the other's note, no cross-TZ churn, global fixed point exists.
- We only conform a value that is **missing, unparseable, or malformed** — never merely "a different valid offset."
- Human readability (local wall-clock + offset) is preserved; the instant is unambiguous via the offset.

## 4. The parser — YAML-boundary-correct + surgical edits (fixes Findings 1 & 5; is the 1.7.1 patch)

The line-based `split()` is replaced by a **block-scalar-aware boundary finder** so a `---` inside a `|`/`>` block scalar (or an indented line) never false-closes the frontmatter. Reads use a real YAML parse of the *correctly-bounded* block; **writes are surgical**:
- Replace **only** our managed key's line (or insert our keys) — never re-serialize the user's YAML.
- **Preserve** the original EOL (CRLF/LF), a leading BOM, key order, and all non-managed content byte-for-byte.
- **Round-trip guard:** if a note's frontmatter cannot be confidently parsed (ambiguous/malformed), the conform is **refused** and the note is routed to the reversible path (§7), never blindly rewritten.

`normalizedContent`/`normalizedHash` use the same corrected boundary. This parser fix ships as **1.7.1** independently (it closes the shipped corruption path even for the lazy per-edit stamping), and the backfill builds on it.

## 5. Conform / normalizer (fixes critic-2 F1)

`conform(note)` for a non-compliant in-scope note:
- **Missing** key → seed from OS metadata (`created`←ctime, `updated`←mtime), never "now".
- **Present but non-canonical** (quoted, `Z`, ms, space-separated, wrong shape) → re-serialize *that key's value* to canonical ISO form (surgical).
- **Fixed-point law (shipped test):** `compliant(conform(x))` must be true immediately, table-tested against quoted/`Z`/ms/space/CRLF/BOM/block-scalar inputs. This is a guard, not a wish.
- Touches **only our own keys** (D-CE-2); never reads/writes third-party keys (but see §9 for masking them in *identity*).

## 6. Backfill FSM + drift-aware marker (fixes critic-2 F3, F5)

Per **(device, vault)**, in `data.json` (never synced): `marker = { policyHash, cursor }`.
- **Trigger:** enable, `policyHash` change, or launch-when-`policyHash`-stale.
- **One-time pass:** walk in-scope notes in a stable sorted order; conform the non-compliant; advance a **persisted `cursor`** so an interrupted pass **resumes at the cursor** (O(remaining), not O(vault) — fixes F5). On reaching the end, record `marker.policyHash = current`.
- **Drift is handled at the write boundary, not by a re-walk (fixes F3):** the marker only means "the one-time walk finished." A note that arrives non-compliant via a **pull/merge-adopt** (e.g. an external tool stripped a key elsewhere) is conformed **as it is written** — so no note can sit non-compliant behind a "converged" marker. Steady state = per-edit stamping + per-pull/merge conform; the marker never suppresses that.
- **Derived progress:** "N of M notes to bring into compliance," computed from the compliance predicate; drives the status line and the pre-enable count (§8).

## 7. Reversible first pass — via conflict-copies (per direction)

The **initial** backfill is reversible. For each note it conforms:
- If the conform is a **provably-clean additive/surgical stamp** (round-trips; only our keys changed; EOL/BOM/order preserved) → apply in place (nothing to revert).
- If the conform would change **anything beyond inserting/normalizing our keys**, or the note **didn't confidently round-trip** → **preserve the original as a conflict-copy** (`<note> (conflict <device> <ts>).md`) before writing, and flag it in the existing conflict-review UI. The user reviews, then keeps or restores.

This concentrates reversibility exactly on the risky population (with the §4 parser, that's near-empty — malformed/ambiguous notes only), avoiding a 5000-copy flood while guaranteeing no silent loss. *(Open: widen to copy every conformed note if you prefer belt-and-suspenders over clutter — one policy flag.)*

## 8. Consent + restore detection (fixes Findings 3, 5, 6, 7)

**One informed confirm at enable**, now honest and scoped:
- Shows the **count**: "SelfSync will add/normalize `created`/`updated` on **N of M** notes."
- Correct wording: it adds our two fields (may coexist with Linter's), normalizes their format, and — states plainly — **may adjust line endings/order on notes it changes**; the reversible copies (§7) are mentioned.
- **Restore-signature detection:** if a large fraction of notes share one ctime/mtime within a few seconds (backup-restore / `git clone` / cloud-resync), warn that "dates read from your filesystem look reset by a backup/clone — seeding may not reflect real history," and offer to proceed / skip-seeding / cancel. (Never fabricate in spirit.)
- **Collision with a user's own `created`/`updated`:** if a scoped key already exists with a non-date value across many notes (a user using `updated` to mean "last reviewed"), **do not silently reformat** — surface it in the confirm and offer alternate key names.

## 9. Third-party-key masking in identity (fixes Finding 4 — Linter loop)

`normalizedHash` masks not only our keys but a small **allowlist of well-known volatile timestamp keys** (`date modified`, `date created`, `modified`) so a Linter/other-plugin bump of *those* keys is **not** seen as a content change → no cross-plugin re-stamp storm on enable or steady-state. We still never *write* them (D-CE-2); we only ignore their churn for identity.

## 10. Pacing / load (Finding 8)

The one-time pass is bounded pushes (safe under the delete guards). It **paces** via the existing `mapPool`/`FILE_CONCURRENCY`, backs off on server 429/5xx, and is **pausable/abortable** (leaves the cursor for resume). The status line shows progress; the burst is one-time per (device, vault, policy).

## 11. Multi-device convergence

Instant-based compliance (§3) + the shipped older-wins reconcile → devices converge at the byte level and **all agree on compliance** (any valid-instant offset string is compliant), so no device re-conforms another's note. No new coordination.

## 12. Decisions

- **D-CE-1 (REVISED):** No generic engine. Timestamp-specific backfill; config-sync untouched.
- **D-CE-2:** Conform touches only our own keys; identity *masks* a small third-party allowlist (§9) but never writes it.
- **D-CE-3:** Per-(device, vault) marker `{ policyHash, cursor }` in `data.json` (never synced); drift handled at the write boundary, not by re-walk.
- **D-CE-5:** Single ISO+offset format; compliance is instant-based; one honest, counted, restore-aware confirm.
- **D-CE-7 (NEW):** Parser is block-scalar-aware with surgical, preservation-safe writes; ships as the 1.7.1 corruption fix.
- **D-CE-8 (NEW):** Initial backfill is reversible via conflict-copies, scoped to non-provably-clean conforms.

## 13. Test architecture

- **Pure unit:** the parser (block-scalar boundary; BOM/CRLF/order preservation; malformed → refuse); compliance predicate (instant-based; quoted/`Z`/ms accepted); the **fixed-point law**; the normalizer table; `policyHash` sensitivity; restore-signature detector; the third-party mask.
- **Integration (fake IO/server):** enable → backfill a mixed vault (missing/quoted/compliant/excluded/non-md/template/block-scalar); interrupt → resume from cursor without re-touching done; drift via pull → conformed at write; policy change → re-walk; provably-unclean conform → conflict-copy + flag; marker skips walk when fresh.
- **Multi-device / multi-TZ:** two devices, different offsets → converge, no churn, both compliant.
- **DOM/e2e:** the counted restore-aware confirm; the passive progress line; the reversible copies surfaced in the conflict UI.

## 14. Sequencing

1. **1.7.1** — the parser corruption fix (§4) alone: block-scalar-safe boundary + BOM/EOL/order preservation + malformed-refuse, with the fixed-point/round-trip tests. Closes the shipped corruption path.
2. **1.8.0** — the backfill (§5–§10): FSM + drift-aware marker + reversible first pass + restore detection + honest counted confirm + third-party masking + Templates exclude.

## 15. Residual risks (accepted / documented)

- **Restore-then-enable** still seeds from filesystem dates *if the user proceeds past the warning* — by design (there's no better signal); the warning is the mitigation.
- **A note whose frontmatter is genuinely un-parseable** is skipped (not conformed) and flagged — it never gets managed timestamps until fixed; honest non-convergence, surfaced, never silent.
- **Reversible-copy clutter** on a vault full of malformed notes (rare); the confirm's count makes it visible before the user commits.

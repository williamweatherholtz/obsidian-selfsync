# Backlog — deferred product requirements

> Tracked future work surfaced during use. Each item names its target milestone (the process that will handle it) and the desired behavior, so nothing is lost. Convert to formal engine `Issue` items when the `keel` tooling is in the loop. Newest first.

## B6 — Server durability hardening (persist-failure rollback + startup consistency check)  ✅ DONE (2026-07-03)
**Resolved 2026-07-03:** `commit`/`delete` now snapshot the index, defer all physical
blob removal until AFTER `persist()` succeeds, and roll the in-memory index back to the
snapshot on persist failure — so a failed write never leaves the on-disk index ahead of
disk or dangling-referencing a removed chunk (no data loss). Chunk writes are atomic
(tmp+rename, no truncated blobs). Startup runs `verify_and_gc`: a referenced-but-missing
chunk marks the vault ERROR (→ operator reindex, reusing the M5 recovery path). Tests:
`commit_rolls_back_on_persist_failure_without_losing_blobs`,
`startup_marks_corrupt_on_dangling_reference`.
**Raised:** 2026-07-03 (M2 final review). **Target:** M4 (durability pass).
`Vault::commit`/`delete` mutate the in-memory index (and may `store.remove` a GC'd blob) *before* `persist()`; if `persist()` fails (disk full / IO error) the in-memory state is ahead of disk, and on restart the loaded index can dangle-reference a physically-removed chunk. Add: roll back in-memory state on persist failure, and a startup consistency check (index `chunk_refs` vs. blobs actually on disk). Pair with B4.

## B5 — Orphan-chunk garbage collection  ✅ DONE (2026-07-03)
**Resolved 2026-07-03:** `verify_and_gc` at startup sweeps the chunk store and removes
any blob with no `chunk_refs` entry (e.g. uploaded-but-never-committed before a crash).
Startup is the safe point — no in-flight uploads — so no time-based grace window is
needed; a mid-session client-drop leak is bounded and reclaimed at next restart. Test:
`startup_reclaims_orphan_chunks`.
**Raised:** 2026-07-03 (M2 final review). **Target:** M4.
`put_chunk` writes a blob without touching `chunk_refs`; only `commit` increments. A chunk uploaded but never committed (client drops between upload and commit) is never refcounted and never GC'd — a bounded disk-space leak (no data loss; a later commit referencing it "adopts" it). Add an orphan sweep: remove blobs with no `chunk_refs` entry older than N.

## B4 — Perf pass (deferred from M2)
**Raised:** 2026-07-03. **Target:** later perf milestone.
(a) `sha256_hex` allocates a String per byte — use `write!`/`hex` crate. (b) The Vault `Mutex` is held across all disk IO (reassembly reads, file write, JSON persist), serializing even reads/`missing`/`get_chunk` — fine for single-user M2, revisit for M4 multi-tenant. (c) Client chunker/hash is pure-TS + SHA-256; the design's FastCDC + blake3 (WASM) speed upgrade was deliberately deferred. (d) No automated coverage of the real Obsidian `requestUrl` binary transport (CI uses a parallel Node-fetch transport) — add a smoke test or document manual-only. (e) `main.ts` echo-guard/connect wiring is only covered by manual E2E.

## B3 — Intelligent reconciliation of pre-existing / untracked content on connect
**Raised:** 2026-07-03 (from live use of M1). **Target:** M3 (conflict/reconciliation).
**Problem:** When a vault with pre-existing content connects, the plugin doesn't handle that content intelligently. M1's initial reconcile is a blunt pull-then-push: a *local-only* file uploads, but a file present on **both sides with different content is clobbered by the server's copy**, and untracked content can appear "ignored." No merge, no conflict-copy, no "keep both."
**Desired behavior (never silently ignore or lose content):**
- Local-only file → **upload** it.
- Server-only file → **download** it.
- Same path, identical content → no-op.
- Same path, **divergent** content → **do not clobber**: for Markdown, three-way merge (M3 engine); for anything unmergeable/binary, write a **conflict copy** (`name (conflict <device> <ts>).ext`) and keep both. Surface the conflict to the user.
- On first connect of an existing vault, treat it as a reconcile of two populated sides, not a one-way overwrite.
**Note:** verify the local-only-upload path with a dedicated headless E2E scenario when M3 starts (distinguish a real bug from the divergent-content case).

## B2 — Vault selection / creation UI + multiple vaults per account  ✅ DONE (M4)
**Resolved 2026-07-03 in M4:** one account → many vaults; `POST/GET /api/vaults`;
the plugin's OnboardingModal lists/creates vaults and binds this Obsidian vault
to one (`vaultId` setting); server enforces per-`(user,vault)` isolation
(`DATA_ROOT/<user>/<vault>`), verified by unit + E2E isolation tests. The bigger
config-UX overhaul remains deferred (goal #1).
**Raised:** 2026-07-03. **Target:** M4 (multi-tenant) + onboarding UI.
**Problem:** The plugin hardwires a single server-side vault; there's no way to pick which server vault an Obsidian vault syncs to, or to create a new one.
**Desired behavior:** one account → many vaults; in the plugin, choose an existing server vault to sync the current Obsidian vault to, or create a new server vault; server enforces per-account vault isolation. Layout `/<data-root>/<user>/<vault>/…` (already in the design).

## B1 — Login / account creation UI (real onboarding)  ✅ DONE (M4)
**Resolved 2026-07-03 in M4:** real accounts with argon2id hashes (`.users.json`),
`REGISTRATION=open|invite|closed` + `/api/register`, tokens resolve to a user, and
the plugin OnboardingModal does login/register + vault pick/create. Status bar
now shows "SelfSync" + a green/amber/red light. Follow-ups: per-user invites
(currently a single shared `INVITE_CODE`); data migration from the pre-M4 single
vault layout (`DATA_ROOT/vault`) to `DATA_ROOT/<user>/<vault>` (test data re-syncs).
**Raised:** 2026-07-03. **Target:** M4 (multi-tenant) + onboarding UI.
**Problem:** The server has a single fixed `admin/admin` from config; there's no way to create users, and login is just URL/username/password fields + a Connect button — not a clear onboarding flow.
**Desired behavior:** server accounts with registration/creation (an admin/registration endpoint or CLI), and a plugin onboarding UI that logs in and (where allowed) creates an account. Clear connection state (the status-bar indicator + sync log added in M1 are the start).

---
*(These are the reason the milestone order is: M2 perf → **M3 reconciliation/conflict** → **M4 accounts/multi-vault + onboarding UI**. The full config-UX overhaul remains the deferred goal #1 at the end.)*

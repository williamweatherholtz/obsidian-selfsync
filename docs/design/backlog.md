# Backlog — deferred product requirements

> Tracked future work surfaced during use. Each item names its target milestone (the process that will handle it) and the desired behavior, so nothing is lost. Convert to formal engine `Issue` items when the `keel` tooling is in the loop. Newest first.

## B9 — Larger critique follow-ups (deliberately deferred from the 2026-07-04 critique fix pass)
**Raised:** 2026-07-04. **Target:** later, per-item. The critique's data-loss / credential / DoS
cluster and the bounded UX/perf items were fixed in that pass; these remain because each is a real
feature or architecture change, not a bounded fix — deferred with rationale rather than half-built:
- **Server index scaling** — `persist()` re-serializes the WHOLE index on every commit, `commit`/`delete`
  deep-clone the whole index for rollback, and deletion tombstones grow unbounded. Fine at current scale;
  needs an incremental/append store + tombstone compaction (bounded by clients' min-acked version) for
  large, churny, long-lived vaults.
- **`reconcilePath` fetches the whole manifest (`changes(0)`) per single-file event** — O(vault) network +
  parse per note save. Needs a single-path remote-meta endpoint or a WS-invalidated manifest cache.
- **Streaming large files** — `io.read` + `requestUrl` buffer whole files in RAM (mobile OOM on big
  attachments). Needs incremental chunk-from-disk + a size-gate/skip UI.
- **Full re-auth modal** — currently the status card *tells* the user to re-run setup when the token+password
  both fail; a dedicated "Session expired — re-enter password" inline prompt is nicer.
- **Mobile status indicator** — the status-bar light is invisible on Obsidian mobile; add a ribbon-icon (or
  Notice) fallback so mobile users see sync state.
- **Case-only / Windows-reserved path collisions** — `README.md` vs `readme.md` key two index entries to
  one file on a case-insensitive server FS; normalize/detect at commit.
- **CORS is `Any`** — restrict to configured origins (pairs with B7 auth hardening).
- **Config changes sync on reconnect, not live** — `.obsidian/` edits fire no vault events; optionally poll
  the config surface on the sync timer (today it's honest: the copy no longer implies live).

## B8 — BRAT-installable distribution (release pipeline)  ✅ DONE (2026-07-04)
**Resolved 2026-07-04:** the plugin now installs via BRAT from `williamweatherholtz/obsidian-selfsync`.
Set up: a root-level `manifest.json` (canonical; `id` new-livesync, name "SelfSync", version 0.1.0) +
`versions.json` for BRAT to read the version; a `.github/workflows/release.yml` that builds `client/`
and publishes a GitHub release (assets `main.js` + `manifest.json` + `versions.json`) on a version-tag
push; and an initial `0.1.0` release. The 385 leftover vrtmrz-fork tags (up to 0.25.79, no releases)
were nuked so the version namespace is clean. `client/manifest.json` was removed (root is the single
source); the e2e staging scripts copy the root manifest. Future release = bump `manifest.json`/
`versions.json` + push a matching tag. (Community-store submission is a later, separate step.)
**Raised:** 2026-07-04 (goal-#1 brainstorming, then made real). **Target:** distribution.

## B7 — Auth hardening (expiring/revocable tokens + public-exposure security)
**Raised:** 2026-07-04 (during goal-#1 config-UX brainstorming). **Target:** a dedicated auth/security milestone (NOT goal #1).
Today the server issues a non-expiring, in-memory UUID token on `POST /api/login` (lost on restart; the client re-logins with a stored password each reconnect). For publicly-exposed self-hosted instances this needs: expiring/refresh tokens with server-side **revocation**; an option for the client to persist **only a token** (never the password); documented **TLS/public-exposure guidance** (the shipped Caddy reverse-proxy example is the vehicle); and — deferred 2026-07-04 during goal-#1 brainstorming — optional **client-side E2E encryption** (a separate encryption password à la official Obsidian Sync). Our current model is trusted-server + TLS-in-transit, NOT content E2EE; adding E2EE would insert an encryption-password step into the setup wizard, so the wizard is designed to leave room for it. Explicitly scoped OUT of goal #1 — that overhaul builds on today's login→token flow and its connection string carries server+username only (never the password), leaving clean seams for this work. Full token lifecycle in the UI overhaul would be cart-before-horse.

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

## B4 — Perf pass (deferred from M2) — (a),(b) DONE 2026-07-03/04; (c),(d),(e) still open
**Raised:** 2026-07-03. **Target:** later perf milestone.
(a) ✅ DONE 2026-07-03 — `sha256_hex` now uses an allocation-free nibble→hex lookup (was a `format!`-per-byte String alloc). (b) ✅ DONE 2026-07-04 — the per-vault lock is now a `RwLock` (was `Mutex`): reads (changes/missing/get_chunk/status) and chunk uploads take a shared read lock and run concurrently; only commit/delete/reindex take the exclusive write lock, so one client's large pull no longer serializes another's reads of the same vault. Chunk `put` uses a unique temp name (AtomicU64) so concurrent same-hash uploads under the read lock can't collide; a concurrent-reads regression test guards against deadlock/poison. (c) ADDRESSED 2026-07-04 (pure-TS path) — the client chunker now separates the CPU-bound boundary scan from async hashing (native `crypto.subtle.digest` calls run concurrently via `Promise.all`, order-preserving so output is identical) and uses a byte→hex lookup table instead of `toString(16)`+`padStart` per byte. The blake3 + FastCDC **WASM** upgrade stays deferred BY DECISION: WebCrypto SHA-256 is already native/hardware-accelerated, and WASM adds bundle size + a CSP surface + mobile risk for an unproven gain — revisit only if profiling shows chunking/hashing is a real bottleneck. (d) MANUAL BY NATURE — the real Obsidian `requestUrl` binary transport can't run headlessly; it's covered by the desktop/mobile E2E "Test connection" + sync scenarios (D1/M2…), and the Node-fetch transport mirrors the same contract in CI. (e) COVERED — the decision logic is extracted into unit-tested pure modules (`reconcile.decide`, `syncstate` FSM, `connstr`, `wizardsteps`, `configsync`) + the headless two-client E2E; the residual in `main.ts` is thin Obsidian timer/event glue, verified in the manual desktop/mobile pass. **B4 closed.**

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

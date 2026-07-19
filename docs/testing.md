# Testing the SelfSync deliverable

This is the concrete, codebase-specific standard. The durable *rules* (fail-first, test the real path,
cover the failure classes, no tautologies) live in the `test-authoring` skill; the *why* is D0026.
Coverage and pass-state are **computed, gated facts — never prose attestations** (D0026).

## The gate (what must be green + floored)

| Layer | Command | Floor (constraint) |
|---|---|---|
| Server tests + coverage | `cd server && cargo llvm-cov --locked --fail-under-lines 89 --summary-only` | lines ≥ **89%** |
| Server lint | `cd server && cargo clippy --all-targets -- -D warnings` | warnings = 0 |
| Client tests + coverage | `cd client && npm run test:cov` | lines/stmts ≥ **75**, branches ≥ **83**, functions ≥ **66** |

CI (`.github/workflows/ci.yml`) runs all of the above. The client job **builds the server binary first**
so the real-server integration + sharing specs actually run (`SELFSYNC_REQUIRE_E2E=1` turns a missing
binary into a hard failure, not a silent skip). `keel reverify` re-runs the reverify contract at HEAD
on source drift and stamps a fresh `TestResult` on `deliverableTestGate`.

## Coverage (after Phases 1–2, 2026-07-14)

- **Client:** lines/statements **75.96%**, branches **84.15%**, functions **66.49%** — 388 tests
  (CI/Node-22 measurement; up from the 901368e baseline of 67.49/56.33/83.48 after the transport +
  4 UI-module + merge suites and the real `main.ts` action-body tests). Floors ratcheted to match.
- **Server:** lines **90.02%** total (up from 86.41%); `ws.rs` **76%** (was 13.5% — the new WebSocket
  suite), `main.rs` 0% (boot). Floors are a hair below measured to absorb run-to-run variance.

## Ratchet policy

Floors move **up only**. When you add tests that raise the measured number, raise the floor in
`client/vitest.config.ts` (thresholds) and the CI `--fail-under-lines` to the new value. Never lower a
floor to make a red run pass; never fabricate or back-date a coverage `Measurement`. Coverage *trend* is
the `clientLineCoverage` / `serverLineCoverage` Indicators (`keel indicators`) — record a new datapoint
with `keel record-measurement` after a meaningful change.

## Local coverage setup

- **Client:** `@vitest/coverage-v8` is a dev-dep; just `npm run test:cov`. v8 instrumentation slows
  CPU-heavy tests ~10×, so the config raises `testTimeout` to 30 s (these are correctness tests, not
  perf assertions — those are in `vitest.perf.config.ts`).
- **Server:** needs `rustup component add llvm-tools-preview` + `cargo install cargo-llvm-cov` once,
  then `cargo llvm-cov --summary-only`.

## Harnesses

- **Client unit** — vitest with `obsidian` aliased to `test/obsidian-stub.ts` (dual-mode: Node no-op /
  happy-dom real elements). Drive real logic over injected fakes.
- **Client DOM** — `test/ui-dom-harness.ts` `fakePlugin()` renders real controls; use it to exercise
  modal/settings *rendering + wiring*. **Do not** assert only that a button called a `vi.fn()` that
  stands in for the code under test — drive the real action body over in-memory io/api (`plugin-wiring`
  boots the real plugin with `spyApi` + `memIo`).
- **Client integration** — `test/e2e-helpers.ts`: `startServer()` spawns the real Rust binary;
  `NodeTransport` (real HTTP) + `FsVaultIo` drive the real `reconcileAll`/`reconcileDelta` engine. Specs
  gate on `canRun`; under `SELFSYNC_REQUIRE_E2E=1` a missing binary throws.
- **Server unit + integration** — inline `#[cfg(test)]` + `tests/*.rs` against the real axum app via
  `serve()` + `AppState::for_test`. WebSocket tests use `tokio-tungstenite` (a dev-dep) — connect to
  `/api/ws`, assert 101 vs 401/404, cap → 503, and that the connection counter returns to 0 on drop.
- **Playwright (server admin only)** — `client/e2e-admin/*.pwspec.ts` drives the `/admin` page in
  Chromium (`npm run test:admin-e2e`). Not the Obsidian plugin.
- **Real-Obsidian e2e (Playwright + CDP)** — BUILT (Phase 3). `client/e2e-obsidian/` + `npm run
  test:obsidian-e2e` (config `playwright.obsidian.config.ts`). `helpers/obsidian.ts` launches an
  ISOLATED Obsidian instance — it pre-seeds the temp `--user-data-dir`'s `obsidian.json` vault registry
  and uses a fixed `--remote-debugging-port` + `chromium.connectOverCDP()`, deliberately NOT the
  `obsidian://` URI (which the OS routes to a running Obsidian and would hijack the user's session).
  `helpers/env.ts` spawns a real server + stages a temp vault with the built plugin (settings nested
  under `data.settings` so it auto-connects). `smoke.pwspec.ts` asserts the plugin loads AND a seeded
  note syncs to the server end-to-end. `convergence.pwspec.ts` goes further: TWO isolated Obsidian
  instances (distinct CDP ports/user-data-dirs) syncing one vault, asserting a note made on device A
  converges to device B AND a change on B flows back to A (bidirectional), plus a healthy-status check.
  Needs Obsidian installed (`OBSIDIAN_PATH` to override the auto-detected path) → **local/nightly gate,
  self-skips when absent, NOT wired into per-PR CI**. Not covered here (flaky through live GUIs, and
  covered headlessly instead): forced divergent-edit conflicts.

## Resolved: local coverage on Node 24

Previously, `vitest 2.1.9` predated Node 24 and its v8 coverage provider crashed nondeterministically
under `fileParallelism: false` (exit 127, no summary). Fixed by bumping to **vitest 3** (+
`@vitest/coverage-v8` 3), which supports Node 24 — `npm run test:cov` now runs cleanly locally (388
tests, EXIT 0). All prior floors held across the major bump (no test-API breakage). CI already ran fine
on its pinned Node 22; it's now aligned to the same major.

## Property-based testing (D0030, `property-based-testing` skill)

Beyond example tests, the pure cores carry **property tests** (`client/test/pbt.test.ts`, fast-check) that
assert INVARIANTS over generated inputs (with shrinking to a minimal counterexample). Properties are curated
against the code's real invariants — not the implementation restated — and target the classes behind past
bugs: `decide` (totality, no-destructive-without-absence, no-silent-clobber, one-sided routing), `merge3`
(identical/one-sided merges + **CRLF-invariance**, the class of the CRLF merge bug), the chunker (lossless
reassembly round-trip + determinism + hash-correctness), `sameIgnoringEol` (EOL/trailing-newline invariance),
and `mergeEnabledPluginsJson` (**grow-only union** — a sync can never drop a locally-enabled plugin). Run with
`npx vitest run test/pbt.test.ts`. Method: Anthropic's Claude-PBT (investigate → properties → tests →
reflection loop → record). First pass (2026-07-18): 13 properties, **0 counterexamples** — the invariants
hold; the tests are permanent generative regressions.

## Mutation testing (D0030, `mutation-testing` skill)

Coverage proves lines *ran*; a **mutation score** proves the suite would *fail* on a real fault. Tooling:
`cargo-mutants` (server) + Stryker (client, planned), scoped by `keel arch criticality`; each surviving mutant is
a concrete test-gap → a fail-first killing test (or a justified accept), with the score recorded as the
`serverMutationScore` monitored Indicator (`keel indicators`; floorable in CI once a defensible baseline across
modules exists — D0088, no arbitrary threshold).

**First pass — `shares.rs` (authz keystone), 2026-07-18** (`mutationTestingSharesPass`). `cargo mutants --file
src/shares.rs --timeout 300`: 53 mutants → 4 real survivors exposed a systemic test-gap class (the code was
correct; the *tests* were blind): (1) the retain-then-`if len != before { save() }` deletion methods
(`revoke`/`purge_vault`/`purge_user`) were asserted only in-memory, so a mutant skipping the durable `save()`
survived (a dropped grant would reload after a restart); (2) the exact-match predicates in `revoke` and
`grants_for` had no *selectivity* test (single-grant fixtures made `&&`→`||` invisible). Killed with 7 fail-first
tests — reopen-from-disk persistence checks + non-`NotFound`/corrupt-file `open()` checks + multi-grant
selectivity checks. Confirming re-run: **49 caught / 0 missed / 4 unviable = 100%** over viable mutants (`serverMutationScore` M1).

**Second pass — durability core `index_store` + `chunkstore`, 2026-07-18** (`mutationTestingIndexChunkstore`).
89 mutants → 7 survivors. `index_store` (SQLite index authority) was already solid (41/42 = 97.6%; the one
survivor was the latent R12-CC1 `schema_version` stamp a single-version schema never exercises); `chunkstore`
(content-addressed blob store) had 6 in untested error/validation/recovery paths — crash-leftover `.tmp`
sweep, the `is_valid_hash` format gate, `get()` swallowing non-`NotFound` errors as "absent", and the R16
`touch()` orphan-clock reset. Killed with 5 tests. Confirming re-run: **80 caught / 0 missed / 9 unviable =
100%** (`serverMutationScore` M2 index_store, M3 chunkstore).

**Third pass — `vault.rs` (largest module: commit/reindex/GC/path-safety), 2026-07-18** (`mutationTestingVault`).
138 mutants → 33 survivors = 74.2%, the least-covered module. 8 were on the live **request path** and were killed
with 5 tests: `safe_rel_path` empty/absolute rejection, the strict `> MAX_FILE_BYTES` size gate, right-size/
**wrong-hash** integrity rejection, idempotency-requires-chunks-match, and commit+delete version bump. Confirming
re-run: **102 caught / 26 missed = 79.7%** (`serverMutationScore` M4). The 26 residual are **triaged, not ignored**
(the skill's rule — kill or *justify*): 21 documented equivalent/impractical accepts (the 4 GiB `MAX_FILE_BYTES`
constant whose *comparison* is now tested; log-only counters; the 300 s-interval best-effort orphan sweep whose
core reclaim is already 100 % in `chunkstore`; a guard that's redundant on Windows) + 5 real reindex
corrupt-rebuild gaps tracked as an open follow-on (`issueVaultReindexRebuildTestGaps` → `mutationTestingVaultReindex`).
Effective non-accepted coverage ≈ 95 %.

Across the four modules mutation-tested, 19 fail-first killing tests were added and 3 test-gap Issues recorded.

Reproduce: `cargo install cargo-mutants && cd server && cargo mutants --file src/shares.rs --timeout 300`
(use `--timeout` ≥ ~3× the baseline test time so `-j` contention can't cause false timeouts).

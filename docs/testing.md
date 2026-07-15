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
  note syncs to the server end-to-end. Needs Obsidian installed (`OBSIDIAN_PATH` to override the
  auto-detected path) → **local/nightly gate, self-skips when absent, NOT wired into per-PR CI**.
  Follow-ups on this harness: two-device convergence, conflict resolution, status-UI assertions.

## Known local caveat: Node 24 + vitest 2.1.9 coverage

This machine runs Node 24, but vitest 2.1.9 predates it; under `fileParallelism: false` the v8 coverage
provider can crash nondeterministically (exit 127, no summary) on the full `--coverage` run. **CI is
unaffected** — it pins Node 22 (`setup-node@v5`), which vitest 2.1.9 supports. Locally, if a coverage
run dies, either use Node 22, or cap parallelism: `npx vitest run --coverage --fileParallelism
--poolOptions.forks.maxForks=3` (bounds each worker's native state). Plain `npm test` (no coverage) is
unaffected. A proper fix (bump vitest / pin Node) is a separate tooling CHANGE, not yet made.

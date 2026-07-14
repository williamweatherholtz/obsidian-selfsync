# Testing the SelfSync deliverable

This is the concrete, codebase-specific standard. The durable *rules* (fail-first, test the real path,
cover the failure classes, no tautologies) live in the `test-authoring` skill; the *why* is D0026.
Coverage and pass-state are **computed, gated facts — never prose attestations** (D0026).

## The gate (what must be green + floored)

| Layer | Command | Floor (constraint) |
|---|---|---|
| Server tests + coverage | `cd server && cargo llvm-cov --locked --fail-under-lines 85 --summary-only` | lines ≥ **85%** |
| Server lint | `cd server && cargo clippy --all-targets -- -D warnings` | warnings = 0 |
| Client tests + coverage | `cd client && npm run test:cov` | lines/stmts ≥ **67**, branches ≥ **83**, functions ≥ **56** |

CI (`.github/workflows/ci.yml`) runs all of the above. The client job **builds the server binary first**
so the real-server integration + sharing specs actually run (`SELFSYNC_REQUIRE_E2E=1` turns a missing
binary into a hard failure, not a silent skip). `keel reverify` re-runs the reverify contract at HEAD
on source drift and stamps a fresh `TestResult` on `deliverableTestGate`.

## Baseline (901368e, 2026-07-14)

- **Client:** lines/statements 67.49%, branches 83.48%, functions 56.33% (functions low — the untested
  UI modules + spied-away `main.ts` action bodies; Phase 1 target).
- **Server:** lines 86.41% total; `ws.rs` **13.5%** (no WebSocket test — Phase 2 target), `main.rs` 0%
  (boot). Floors are set a hair below measured to absorb run-to-run branch-execution variance.

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
- **Real-Obsidian e2e (Playwright + CDP)** — DEFERRED (D0026). When built, port the CDP launcher from
  the `test_real_obsidian` branch (`chromium.connectOverCDP()` against `--remote-debugging-port`), and
  test only what the headless layers can't: `requestUrl`, the real vault adapter, file-event
  propagation, and the status UI. Needs Obsidian installed → a local/nightly gate, not per-PR.

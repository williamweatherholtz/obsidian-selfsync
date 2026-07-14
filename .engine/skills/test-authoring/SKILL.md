---
name: test-authoring
description: |
  Encodes the standard for WRITING deliverable tests (not modeling them — that's test-design) so the
  test suite actually catches defects instead of leaving them for critique passes (D0026/D0047). Use
  whenever writing, expanding, or reviewing unit / integration / e2e tests for the SelfSync deliverable
  (Rust server + TS plugin), and whenever shipping a fix (every fix ships a FAIL-FIRST regression test).
  Enforces: test the real code path (never assert on a mock that replaces the code under test), cover
  the failure/negative/edge classes, no tautological assertions, and keep coverage a COMPUTED, floored
  fact. Codebase specifics (harnesses, floors, commands) live in docs/testing.md.
metadata:
  version: 0.1.0
  domain: [testing, coverage, TDD, regression, vitest, cargo-test, D0026, D0047]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# test-authoring

The craft skill for making the deliverable's tests a real gate. Its reason to exist: three independent
critique passes kept finding MEDIUM+ defects that tests *should* have caught — because the suite was
pointed away from where bugs live (imperative edges, concurrency, error mapping) and toward pure
primitives, with no coverage measured and the strongest suites silently skipping in CI. This skill is
the D0047 correction cemented so it recurs. Codebase-specific detail (harness APIs, exact floors, run
commands) is in **docs/testing.md** — read it before writing tests; this skill is the durable *why* and
the non-negotiable rules.

## The rules (non-negotiable)

1. **Every fix ships a fail-first regression test.** Write the test, watch it FAIL against the unfixed
   code (proves it exercises the bug), then fix. A fix with no failing-first test is not done.
2. **Test the real code path, never a mock that replaces it.** Asserting `expect(spy).toHaveBeenCalledWith(x)`
   where `spy` stands in for the function under test verifies wiring, not behavior. Drive the REAL
   implementation over in-memory fakes of its *dependencies* (io, transport, server), not over a stub of
   itself.
3. **Cover the failure classes, not just the happy path.** For every behavior ask which of these apply
   and test the ones that do: empty/missing input · binary / invalid-UTF-8 · EOL (CRLF vs LF) ·
   connection/DNS error · read-only vault · concurrent / delta / racing path · deletion & tombstone ·
   CAS / version conflict (409) · oversized / DoS bound · expired / revoked / replayed token ·
   degraded / corrupt storage. The audit found bugs hide in exactly these.
4. **No tautological assertions.** Banned patterns: an assertion only inside a `.catch()` that never runs
   if the call resolves; `assert_ne!(status, 403)` / `expect(x).not.toBe(...)` that accepts a wrong
   outcome (a 400 passing a "write allowed" test); asserting a value equals itself; a test with no
   observable that could fail. Assert the SPECIFIC expected outcome.
5. **Coverage is computed and floored, never attested (D0026).** Run `--coverage`; the ratcheting FLOOR
   is a CI/vitest/llvm-cov constraint. When you close a gap, RAISE the floor to the new measured value
   — never lower a floor to make a red run pass, never write prose claiming coverage is "good."
6. **Concurrency and resource bounds get real tests.** A CAS/lock/semaphore/cap that exists only to stop
   a race must be tested UNDER that race (two parallel requests, N+1 connections, oversized body), not
   just single-threaded. A Drop/teardown counter is tested by asserting it returns to zero.

## Layers (see docs/testing.md for the harnesses)

- **Unit** — pure logic over injected fakes (reconcile, chunker, protocol, transport error mapping).
- **Integration** — real server binary via the vitest e2e-helpers, or the real axum app via the Rust
  `serve()`/`for_test` harness. These MUST run in CI (SELFSYNC_REQUIRE_E2E=1 makes a missing binary a
  hard failure, not a skip).
- **e2e (real Obsidian, Playwright+CDP)** — DEFERRED (D0026); when built, covers only what the headless
  layers structurally cannot (requestUrl transport, real vault adapter, file-event propagation, status UI).

## Anti-Pattern Watchlist

1. **Reactive regression graveyard** — only ever adding one test per past finding, at the unit level.
   Also test the orchestration/edge layer proactively.
2. **Mock-through** — mocking so much that the test passes even if the real code is deleted.
3. **Silent skip** — an integration spec that `skipIf(!available)` in CI. Make the gap loud.
4. **Green-by-timeout** — raising a timeout to hide a real perf regression (only raise for known
   instrumentation overhead on correctness tests; perf assertions live in the perf config).
5. **Prose coverage** — "well covered" in a DoD/commit instead of a measured number behind a floor.

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Alias the bare "obsidian" import (no resolvable package in the test env) to a lightweight stub,
// so modules that import it — transport.ts, main.ts, settings.ts, … — load in vitest and the
// plugin's orchestration wiring can be exercised. Production builds are unaffected (esbuild keeps
// "obsidian" external; see esbuild.config.mjs).
export default defineConfig({
  test: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url)),
    },
    // Run spec FILES one at a time. Several specs (e2e, config-permutations) spawn the real server
    // binary; with the default file-level parallelism, multiple files spawn a burst of server
    // processes at once and — on a loaded machine (esp. Windows) — some lose the listen-timeout race,
    // producing intermittent "lots of failed e2e" runs that pass in isolation. Serial files remove
    // the spawn storm; tests within a file still run in order, so at most one server starts at a time.
    // (Unit tests are milliseconds, so the wall-clock cost is negligible.)
    fileParallelism: false,
    // v8 coverage instrumentation slows CPU-heavy tests (large-download streaming, big-file
    // integration) by up to ~10×, which trips the 5000 ms default. These are correctness tests, not
    // perf assertions (those live in vitest.perf.config.ts), so give them generous headroom — unit
    // tests still finish in milliseconds, so the wall-clock cost is nil.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Coverage is a COMPUTED fact (D0026), never an authored/attested one: this config makes the
    // `--coverage` run recompute line/branch/function coverage from the real source at HEAD. The
    // thresholds below are the ratcheting FLOOR — a CONSTRAINT (a CI-enforced predicate), distinct
    // from the measured value. Raise a floor only after the measured number clears it; never lower
    // one to make a red run pass. `keel reverify` re-runs this gate to keep the recorded state honest.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Pure type/re-export or Obsidian-only-glue modules with no testable logic are excluded so the
      // floor tracks real behavioral coverage, not denominator padding.
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // FLOORS = the measured baseline at 901368e (lines/stmts 67.49%, branches 83.48%, funcs 56.33%),
      // each set a hair below measured to absorb run-to-run branch-execution variance. Ratchet UPWARD as
      // Phase 1 closes gaps (transport.ts, the 4 untested UI modules, real main.ts action bodies); the
      // low functions floor reflects exactly those untested surfaces. A drop below any floor fails the
      // run — the guard against silent coverage erosion. See docs/testing.md.
      thresholds: {
        lines: 67,
        functions: 56,
        branches: 83,
        statements: 67,
      },
    },
  },
});

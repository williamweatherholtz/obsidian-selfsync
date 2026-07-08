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
    // (Unit tests are milliseconds, so the wall-clock cost is negligible; CI doesn't run tests.)
    fileParallelism: false,
  },
});

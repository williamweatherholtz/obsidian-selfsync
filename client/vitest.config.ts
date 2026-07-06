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
  },
});

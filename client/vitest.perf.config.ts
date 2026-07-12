import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Separate config for the PERFORMANCE harness (perf/*.perf.ts) so it never runs in the normal
// `npm test`. Run on demand: `npm run test:perf`. Spawns the real server binary + headless clients.
export default defineConfig({
  test: {
    include: ["perf/**/*.perf.ts"],
    alias: { obsidian: fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url)) },
    fileParallelism: false, // one server + heavy IO at a time
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});

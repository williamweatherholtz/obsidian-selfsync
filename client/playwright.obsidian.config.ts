import { defineConfig } from "@playwright/test";

// Real-Obsidian e2e (D0026, Phase 3): drives the actual Obsidian Electron app via CDP. Separate from
// playwright.config.ts (which drives the server's admin web page in Chromium). This suite is a
// LOCAL/NIGHTLY gate — it needs Obsidian installed on the machine, so it is NOT wired into the per-PR
// CI (the runner has no Obsidian); specs self-skip when no install is found. One worker, serial, long
// timeouts (launching Obsidian + first-open + first sync is slow).
export default defineConfig({
  testDir: "./e2e-obsidian",
  testMatch: "**/*.pwspec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [["list"]],
});

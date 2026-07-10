import { defineConfig } from "@playwright/test";

// Real-browser (Chromium) functional tests for the server's admin web page (server/src/admin_ui.html,
// served at GET /admin). These drive the page's actual click-handlers against a real running server —
// the coverage vitest can't give (the page is inline vanilla JS with no module boundary). Specs live in
// ./e2e-admin and are named *.pwspec.ts so vitest (which matches *.{test,spec}.ts) never picks them up.
export default defineConfig({
  testDir: "./e2e-admin",
  testMatch: "**/*.pwspec.ts",
  workers: 1,          // each test spawns its own server binary — keep it serial (no spawn storm)
  fullyParallel: false,
  timeout: 60_000,
  reporter: "list",
  use: { headless: true },
});

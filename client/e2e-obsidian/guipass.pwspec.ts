import { test, expect, type Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import {
  launchObsidian, getMainWindow, waitForVaultReady, obsidianAvailable, obsidianBelowMinAppVersion, OBSIDIAN_EXECUTABLE,
  pluginStatus,
} from "./helpers/obsidianDriver";
import { isPluginLoaded } from "./helpers/rendererFunctions";
import { startServer, createVault, stageVault, serverHasFile, cleanup, ADMIN, type RunningServer, type StagedVault } from "./helpers/env";

// The L3 GUI pass (l3GuiPass, Sprint 9) as a real-Obsidian demonstration. The 2026-09-07 attempt stopped
// because the machine's Obsidian was below minAppVersion; this spec skips loudly in that case and otherwise
// drives the four surfaces the DoD names, through the UI the owner sees:
//   1. the setup wizard (command selfsync:setup) from a vault with NO connection settings, to a synced vault;
//   2. the settings tab: the Status / Connection / What syncs / Conflicts groups, Advanced collapsed;
//   3. exactly one status-bar indicator;
//   4. the switch-vault modal: Sync this vault to -> Switch -> Merge / Download / Upload, Merge converges.
// Run with: npm run test:obsidian-e2e -- guipass (after npm run build).
test.skip(!obsidianAvailable, `Obsidian not installed (set OBSIDIAN_PATH). Looked for: ${OBSIDIAN_EXECUTABLE ?? "none"}`);

const healthy = /^(idle|syncing|connecting)$/;
let server: RunningServer | undefined;
let staged: StagedVault | undefined;

test.afterEach(() => {
  if (staged) cleanup(staged.root);
  if (server) server.close();
  staged = undefined;
  server = undefined;
});

function runCommand(page: Page, id: string): Promise<boolean> {
  return page.evaluate((cmd) => (globalThis as unknown as { app: { commands: { executeCommandById(id: string): boolean } } }).app.commands.executeCommandById(cmd), id);
}

function openSettingsTab(page: Page): Promise<void> {
  return page.evaluate(() => {
    const app = (globalThis as unknown as { app: { setting: { open(): void; openTabById(id: string): void } } }).app;
    app.setting.open();
    app.setting.openTabById("selfsync");
  });
}

test("the L3 GUI pass: setup wizard, settings groups, one indicator, and the switch-vault modal through real Obsidian", async () => {
  test.setTimeout(300_000);
  server = await startServer(path.join(os.tmpdir(), `selfsync-e2e-guipass-${Date.now()}`));
  await createVault(server.url, "target");
  // A vault with NO connection: the wizard is the only way in. stageVault always writes a connection, so
  // the override empties it; main.ts opens the wizard on load when any of the three is missing.
  staged = stageVault(server.url, "unused", { "welcome.md": "# welcome\n" }, { serverUrl: "", username: "", password: "", vaultId: "", storePassword: false });

  const app = await launchObsidian(staged.appDataDir, staged.vaultDir);
  try {
    const page = await getMainWindow(app);
    await waitForVaultReady(page); // closes the auto-opened wizard; the command below reopens it as the DoD asks
    test.skip(!!(await obsidianBelowMinAppVersion(page)), (await obsidianBelowMinAppVersion(page)) || "");
    await expect.poll(() => page.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);

    // 1. The setup wizard, driven as the owner drives it.
    expect(await runCommand(page, "selfsync:setup"), "the selfsync:setup command exists").toBe(true);
    const wizard = page.locator(".modal-container", { hasText: "Set up SelfSync" });
    await expect(wizard).toBeVisible({ timeout: 10_000 });
    await wizard.locator(".setting-item", { hasText: "Server URL" }).locator("input").fill(server.url);
    await wizard.locator(".setting-item", { hasText: "Username" }).locator("input").fill(ADMIN.username);
    await wizard.locator(".setting-item", { hasText: "Password" }).locator("input[type=password]").fill(ADMIN.password);
    await wizard.getByRole("button", { name: "Log in", exact: true }).click();
    const newVault = wizard.locator(".setting-item", { hasText: "Or create a new vault" }).locator("input");
    await expect(newVault).toBeVisible({ timeout: 15_000 });
    await newVault.fill("wizard");
    await wizard.getByRole("button", { name: "Start syncing" }).click();
    await expect(wizard).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => pluginStatus(page), { timeout: 60_000 }).toMatch(healthy);
    await expect.poll(() => serverHasFile(server!.url, "wizard", "welcome.md"), { timeout: 60_000, intervals: [1_000] }).toBe(true);

    // 3. Exactly one status-bar indicator carries the plugin's label.
    const indicators = page.locator(".status-bar [aria-label^='SelfSync']");
    await expect(indicators).toHaveCount(1);

    // 2. The settings tab groups, Advanced collapsed until its chevron is used.
    await openSettingsTab(page);
    const tab = page.locator(".vertical-tab-content");
    for (const heading of ["Status", "Connection", "What syncs"]) {
      await expect(tab.getByText(heading, { exact: true }).first(), `settings group '${heading}'`).toBeVisible({ timeout: 10_000 });
    }
    // Conflicts is rendered ONLY while a manual choice is pending (settings.ts renderConflicts); a healthy
    // vault with nothing to resolve shows no such group. The 0.6.0 DoD predates that rule, so the honest
    // assertion here is the absence.
    await expect(tab.getByText("Conflicts", { exact: true }), "no Conflicts group while nothing is pending").toHaveCount(0);
    const advanced = tab.locator(".selfsync-collapse-group", { hasText: "Advanced" });
    await expect(advanced).toBeVisible();
    const storePassword = advanced.getByText("Store password on this device");
    await expect(storePassword, "Advanced starts collapsed").toBeHidden();
    await advanced.locator(".clickable-icon, .extra-setting-button").first().click();
    await expect(storePassword, "Advanced expands on its chevron").toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");

    // 4. The switch-vault modal: pick the second vault, Switch, then the three modes; Merge converges.
    expect(await runCommand(page, "selfsync:switch-vault"), "the selfsync:switch-vault command exists").toBe(true);
    const switcher = page.locator(".modal-container", { hasText: "Switch remote vault" });
    await expect(switcher).toBeVisible({ timeout: 10_000 });
    const pick = switcher.locator(".setting-item", { hasText: "Sync this vault to" }).locator("select");
    await expect(pick).toBeVisible({ timeout: 15_000 });
    await pick.selectOption("target");
    await switcher.getByRole("button", { name: "Switch", exact: true }).click();
    const resolve = page.locator(".modal-container", { hasText: "This vault already has content" });
    await expect(resolve).toBeVisible({ timeout: 10_000 });
    for (const mode of ["Merge", "Download", "Upload"]) {
      await expect(resolve.getByRole("button", { name: mode, exact: true }), `mode '${mode}' offered`).toBeVisible();
    }
    await resolve.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(resolve).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => pluginStatus(page), { timeout: 60_000 }).toMatch(healthy);
    await expect.poll(() => serverHasFile(server!.url, "target", "welcome.md"), { timeout: 60_000, intervals: [1_000] }).toBe(true);
  } finally {
    await app.close();
  }
});

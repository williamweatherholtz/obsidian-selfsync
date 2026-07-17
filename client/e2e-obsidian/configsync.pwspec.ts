import { test, expect } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { launchObsidian, getMainWindow, waitForVaultReady, obsidianAvailable, OBSIDIAN_EXECUTABLE, type ObsidianHandle } from "./helpers/obsidian";
import { startServer, createVault, stageVault, cleanup, type RunningServer, type StagedVault } from "./helpers/env";

// Two-device CONFIG sync through real Obsidian: with the community surface on, a community plugin
// installed+enabled on device A must propagate to device B (folder + enabled-list) — AND B's own
// enabled plugin must NOT be disabled by A's shorter list (the union-merge, end to end). This is the
// feature the field report made critical; the headless suite covers the reconcile logic, this proves
// it through the real ObsidianVaultIo + .obsidian enumeration + config-write path.
test.skip(!obsidianAvailable, `Obsidian not installed (set OBSIDIAN_PATH). Looked for: ${OBSIDIAN_EXECUTABLE ?? "none"}`);

const CONFIG_SYNC = { configSync: { enabled: true, core: false, hotkeys: false, appearance: false, snippets: false, community: true, pluginAllow: ["testplugin"] } };
const TEST_PLUGIN = {
  ".obsidian/plugins/testplugin/manifest.json": JSON.stringify({ id: "testplugin", name: "Test Plugin", version: "1.0.0", minAppVersion: "1.0.0", isDesktopOnly: false }),
  ".obsidian/plugins/testplugin/main.js": 'const { Plugin } = require("obsidian"); module.exports = class extends Plugin { async onload() {} };',
  ".obsidian/community-plugins.json": JSON.stringify(["selfsync", "testplugin"]), // A: selfsync + the test plugin
};

let server: RunningServer | undefined;
let A: StagedVault | undefined, B: StagedVault | undefined;
let appA: ObsidianHandle | undefined, appB: ObsidianHandle | undefined;

test.afterEach(async () => {
  for (const a of [appA, appB]) { if (a) await a.close(); }
  for (const s of [A, B]) { if (s) cleanup(s.root); }
  if (server) server.close();
  appA = appB = A = B = server = undefined;
});

test("a plugin enabled on device A propagates to device B, and B's own enabled plugin is not disabled", async () => {
  const dataRoot = path.join(os.tmpdir(), `selfsync-e2e-cfg-${Date.now()}`);
  server = await startServer(dataRoot);
  await createVault(server.url, "cfg");
  // A brings the test plugin; B independently has a different plugin enabled ('brat', folder absent —
  // enabling a not-installed id is harmless). The union must keep B's 'brat' AND add A's 'testplugin'.
  A = stageVault(server.url, "cfg", TEST_PLUGIN, CONFIG_SYNC);
  B = stageVault(server.url, "cfg", { ".obsidian/community-plugins.json": JSON.stringify(["selfsync", "brat"]) }, CONFIG_SYNC);

  appA = await launchObsidian(A.appDataDir, A.vaultDir, 19222);
  appB = await launchObsidian(B.appDataDir, B.vaultDir, 19223);
  await waitForVaultReady(await getMainWindow(appA));
  await waitForVaultReady(await getMainWindow(appB));

  const bManifest = path.join(B.vaultDir, ".obsidian", "plugins", "testplugin", "manifest.json");
  const bList = path.join(B.vaultDir, ".obsidian", "community-plugins.json");

  // Device B receives the test plugin's FOLDER (the real config-write path through ObsidianVaultIo).
  await expect.poll(() => fs.existsSync(bManifest), { timeout: 90_000, intervals: [2_000] }).toBe(true);

  // B's enabled-list ends up as the UNION: A's 'testplugin' propagated, and B's own 'brat' preserved
  // (a shorter synced list never disables a locally-enabled plugin).
  await expect
    .poll(() => { try { return JSON.parse(fs.readFileSync(bList, "utf8")) as string[]; } catch { return []; } }, { timeout: 90_000, intervals: [2_000] })
    .toContain("testplugin");
  const finalList = JSON.parse(fs.readFileSync(bList, "utf8")) as string[];
  expect(finalList).toContain("brat");     // B's own plugin NOT disabled by A's list
  expect(finalList).toContain("selfsync"); // never drops the sync plugin's own id
});

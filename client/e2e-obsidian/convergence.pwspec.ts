import { test, expect } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import {
  launchObsidian, getMainWindow, waitForVaultReady, obsidianAvailable, OBSIDIAN_EXECUTABLE,
  createNote, modifyNote, readNote, pluginStatus, type ObsidianHandle,
} from "./helpers/obsidian";
import { isPluginLoaded } from "./helpers/obsidianFunctions";
import { startServer, createVault, stageVault, cleanup, type RunningServer, type StagedVault } from "./helpers/env";

// Two-device convergence through REAL Obsidian: launch TWO isolated Obsidian instances (distinct CDP
// ports + user-data-dirs) both syncing one server vault, and prove a note made on device A reaches
// device B — and a change on B flows back to A — end to end through the real plugins. This is the core
// SelfSync promise, and the one thing neither the headless suite nor the single-device smoke can show.
test.skip(!obsidianAvailable, `Obsidian not installed (set OBSIDIAN_PATH). Looked for: ${OBSIDIAN_EXECUTABLE ?? "none"}`);

let server: RunningServer | undefined;
let stagedA: StagedVault | undefined;
let stagedB: StagedVault | undefined;
let appA: ObsidianHandle | undefined;
let appB: ObsidianHandle | undefined;

test.afterEach(async () => {
  for (const a of [appA, appB]) { if (a) await a.close(); }
  for (const s of [stagedA, stagedB]) { if (s) cleanup(s.root); }
  if (server) server.close();
  appA = appB = stagedA = stagedB = server = undefined;
});

test("a note created on device A converges to device B, and a change on B flows back to A", async () => {
  const dataRoot = path.join(os.tmpdir(), `selfsync-e2e-conv-${Date.now()}`);
  server = await startServer(dataRoot);
  await createVault(server.url, "conv");
  stagedA = stageVault(server.url, "conv");
  stagedB = stageVault(server.url, "conv");

  // Launch both devices on distinct CDP ports so they run concurrently.
  appA = await launchObsidian(stagedA.appDataDir, stagedA.vaultDir, 19222);
  appB = await launchObsidian(stagedB.appDataDir, stagedB.vaultDir, 19223);
  const pageA = await getMainWindow(appA);
  const pageB = await getMainWindow(appB);
  await waitForVaultReady(pageA);
  await waitForVaultReady(pageB);

  // Both plugins constructed and reached a NON-error status (connected, not stuck offline).
  await expect.poll(() => pageA.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => pageB.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  for (const page of [pageA, pageB]) {
    await expect
      .poll(() => pluginStatus(page), { timeout: 45_000 })
      .toMatch(/^(idle|syncing|connecting)$/); // a healthy phase, never "offline"/"off"
  }

  // A → B: create on device A, assert device B receives the exact content.
  await createNote(pageA, "shared.md", "hello from A");
  await expect
    .poll(() => readNote(pageB, "shared.md"), { timeout: 90_000, intervals: [1_500] })
    .toBe("hello from A");

  // B → A: modify on device B, assert the change flows back to device A (bidirectional).
  await modifyNote(pageB, "shared.md", "edited on B");
  await expect
    .poll(() => readNote(pageA, "shared.md"), { timeout: 90_000, intervals: [1_500] })
    .toBe("edited on B");
});

import { test, expect } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  launchObsidian, getMainWindow, waitForVaultReady, obsidianAvailable, obsidianBelowMinAppVersion,
  OBSIDIAN_EXECUTABLE, pluginStatus, pluginStatusDetail, type ObsidianHandle,
} from "./helpers/obsidianDriver";
import { isPluginLoaded } from "./helpers/rendererFunctions";
import { startServer, createVault, stageVault, cleanup, type RunningServer, type StagedVault } from "./helpers/env";

// CONFIG-CLAIM PROBE (st008, owner 2026-11-04): with 1.32.0 installed, the status detail read
// "7 unsynced edits: .obsidian/themes/Minimal (0s), .obsidian/plugins/quickadd (0s), ..." and the debug
// log carried eleven "unsynced edit on .obsidian/plugins/<id> has waited 140s with no pass settling it"
// lines. Every named path is a FOLDER, never a file. The hypothesis under test, NOT a finding: on this
// platform Obsidian's "raw" vault event reports the DIRECTORY that changed when a file inside a synced
// plugin or theme folder is written. onRawConfigEvent then records an unsynced-edit claim for that folder
// path, and no reconcile pass ever settles a folder, so the claim stands until the next whole-vault scan.
//
// This arm writes a file inside a synced plugin folder from OUTSIDE Obsidian (the way a plugin's own
// data.json save, or an upgrade, looks to the watcher), records every raw path the renderer sees, reads
// the plugin's own claim map, and asserts that the light settles. The raw paths and the claim keys are
// printed either way, so a failure names the mechanism instead of inferring it.
test.skip(!obsidianAvailable, `Obsidian not installed (set OBSIDIAN_PATH). Looked for: ${OBSIDIAN_EXECUTABLE ?? "none"}`);

const CONFIG_SYNC = { configSync: { enabled: true, core: false, hotkeys: false, appearance: false, snippets: false, community: true, pluginAllow: ["testplugin"], pluginDir: { testplugin: "upload" } } };
const TEST_PLUGIN = {
  ".obsidian/plugins/testplugin/manifest.json": JSON.stringify({ id: "testplugin", name: "Test Plugin", version: "1.0.0", minAppVersion: "1.0.0", isDesktopOnly: false }),
  ".obsidian/plugins/testplugin/main.js": 'const { Plugin } = require("obsidian"); module.exports = class extends Plugin { async onload() {} };',
  ".obsidian/plugins/testplugin/data.json": JSON.stringify({ counter: 0 }),
  ".obsidian/community-plugins.json": JSON.stringify(["selfsync", "testplugin"]),
};
const SETTLE_MS = 45_000;

let server: RunningServer | undefined;
let V: StagedVault | undefined;
let app: ObsidianHandle | undefined;

test.afterEach(async () => {
  if (app) await app.close();
  if (V) cleanup(V.root);
  if (server) server.close();
  app = V = server = undefined;
});

interface Probe { raw: string[]; claims: string[]; status: string | null; detail: { label: string; detail: string } | null }

async function readProbe(page: import("@playwright/test").Page): Promise<Probe> {
  const inner = await page.evaluate(() => {
    const g = globalThis as unknown as { __raw?: string[]; app: { plugins: { plugins: Record<string, { unsyncedEdits?: Map<string, unknown> }> } } };
    const p = g.app.plugins.plugins["selfsync"];
    return { raw: g.__raw ?? [], claims: p?.unsyncedEdits ? [...p.unsyncedEdits.keys()] : [] };
  });
  return { ...inner, status: await pluginStatus(page), detail: await pluginStatusDetail(page) };
}

// The connect baseline, with its holder NAMED on failure. Two of the first four fresh-vault launches of
// this spec sat on "syncing" for the whole 60 s baseline wait before any arm acted, which is the owner's
// symptom itself; a bare poll timeout said only "syncing". So the wait reads the plugin's own claim map
// and rendered detail on every tick and quotes the last reading when it gives up.
async function awaitIdleOrExplain(page: import("@playwright/test").Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  const trail: string[] = [];
  let last = "";
  for (;;) {
    const p = await readProbe(page);
    const s = `${p.status} claims=${JSON.stringify(p.claims)} detail=${JSON.stringify(p.detail?.detail ?? "")}`;
    if (s !== last) { trail.push(`${new Date().toISOString().slice(11, 19)} ${s}`); last = s; }
    if (/idle|Fully synced/i.test(p.status ?? "")) return;
    if (Date.now() > deadline) throw new Error(`never reached idle in 60 s. trail=${JSON.stringify(trail)}`);
    await page.waitForTimeout(1_000);
  }
}

test("ARM A — a write inside a synced plugin folder settles the light; the raw path and the claim key are reported", async () => {
  const port = 19300 + Math.floor(Math.random() * 600);
  const dataRoot = path.join(os.tmpdir(), `selfsync-e2e-cfgclaim-${Date.now()}`);
  server = await startServer(dataRoot);
  await createVault(server.url, "cfgclaim");
  V = stageVault(server.url, "cfgclaim", TEST_PLUGIN, CONFIG_SYNC);
  app = await launchObsidian(V.appDataDir, V.vaultDir, port);
  const page = await getMainWindow(app);
  await waitForVaultReady(page);
  const tooOld = await obsidianBelowMinAppVersion(page);
  test.skip(!!tooOld, tooOld || "");
  await expect.poll(() => page.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  await awaitIdleOrExplain(page);

  // Record every raw path the renderer sees from here on, beside the plugin's own listener.
  await page.evaluate(() => {
    const g = globalThis as unknown as { __raw: string[]; app: { vault: { on(name: string, cb: (p: string) => void): unknown } } };
    g.__raw = [];
    g.app.vault.on("raw", (p: string) => { g.__raw.push(p); });
  });

  // The write a plugin's own save makes: a file inside its folder changes, from outside the editor.
  const dataJson = path.join(V.vaultDir, ".obsidian", "plugins", "testplugin", "data.json");
  fs.writeFileSync(dataJson, JSON.stringify({ counter: 1, at: Date.now() }));

  // Give the watcher, the 600 ms raw debounce and the per-path pass time to run, then read the facts.
  await page.waitForTimeout(4_000);
  const after = await readProbe(page);
  // eslint-disable-next-line no-console
  console.log(`[cfgclaim] after write: raw=${JSON.stringify(after.raw)} claims=${JSON.stringify(after.claims)} status=${after.status} detail=${JSON.stringify(after.detail)}`);

  // The light must settle: no claim open, not Syncing, within the same budget the latch probe uses.
  const deadline = Date.now() + SETTLE_MS;
  let last: Probe = after;
  while (Date.now() < deadline) {
    last = await readProbe(page);
    if (last.claims.length === 0 && !/syncing/i.test(last.status ?? "")) break;
    await page.waitForTimeout(1_000);
  }
  // eslint-disable-next-line no-console
  console.log(`[cfgclaim] final: raw=${JSON.stringify(last.raw)} claims=${JSON.stringify(last.claims)} status=${last.status} detail=${JSON.stringify(last.detail)}`);
  expect(last.claims, `claims still open ${SETTLE_MS / 1000}s after a plugin-folder write. raw=${JSON.stringify(last.raw)} detail=${JSON.stringify(last.detail)}`).toEqual([]);
  expect(last.status).not.toMatch(/syncing/i);
});

// ARM B — no write at all. The owner's eleven claimed folders had file and directory write times months
// old (checked 2026-11-04 with Get-Item: quickadd dirWrite 2026-07-17, themes/Minimal 2026-01-20), while
// every folder's LAST ACCESS time was the same instant, 17:31:42Z, inside a burst of settings-tab config
// renders. Hypothesis under test: READING a synced folder (a directory listing, as the config scan and the
// settings tab do) updates its NTFS last-access time, the watcher reports that as a change to the
// DIRECTORY, Obsidian emits "raw" with the folder path, and the plugin records a claim it can never settle.
test("ARM B — listing a synced plugin folder from outside, with no write, must not leave a claim", async () => {
  const port = 19300 + Math.floor(Math.random() * 600);
  const dataRoot = path.join(os.tmpdir(), `selfsync-e2e-cfgclaim-b-${Date.now()}`);
  server = await startServer(dataRoot);
  await createVault(server.url, "cfgclaim");
  V = stageVault(server.url, "cfgclaim", TEST_PLUGIN, CONFIG_SYNC);
  app = await launchObsidian(V.appDataDir, V.vaultDir, port);
  const page = await getMainWindow(app);
  await waitForVaultReady(page);
  const tooOld = await obsidianBelowMinAppVersion(page);
  test.skip(!!tooOld, tooOld || "");
  await expect.poll(() => page.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  await awaitIdleOrExplain(page);
  await page.waitForTimeout(3_000); // let the post-connect persist and its own raw echoes drain
  await page.evaluate(() => {
    const g = globalThis as unknown as { __raw: string[]; app: { vault: { on(name: string, cb: (p: string) => void): unknown } } };
    g.__raw = [];
    g.app.vault.on("raw", (p: string) => { g.__raw.push(p); });
  });

  const folder = path.join(V.vaultDir, ".obsidian", "plugins", "testplugin");
  // NTFS persists a new last-access time only when the stored one is more than an hour old. A fresh test
  // vault would never cross that line, while the owner's folders are listed every 30 s all day. Age the
  // stored access time past the hour so the next listing is one NTFS actually writes to disk.
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(folder, twoHoursAgo, fs.statSync(folder).mtime);
  await page.waitForTimeout(1_500);
  await page.evaluate(() => { (globalThis as unknown as { __raw: string[] }).__raw.length = 0; });
  const before = fs.statSync(folder).atimeMs;
  // A read-only enumeration, repeated the way a 30 s config scan or a settings-tab render repeats it.
  for (let i = 0; i < 5; i++) { fs.readdirSync(folder); fs.readFileSync(path.join(folder, "manifest.json")); await page.waitForTimeout(300); }
  const after = fs.statSync(folder).atimeMs;
  // Sample the claim map at 100 ms for six seconds: a folder claim lives only until the per-path pass
  // settles it (about a second), so a single reading after the fact would miss it and pass vacuously.
  const seenClaims = new Set<string>();
  let probe = await readProbe(page);
  for (let i = 0; i < 60; i++) {
    probe = await readProbe(page);
    for (const c of probe.claims) seenClaims.add(c);
    await page.waitForTimeout(100);
  }
  // eslint-disable-next-line no-console
  console.log(`[cfgclaim] ARM B: atime moved=${after !== before} (${new Date(before).toISOString()} -> ${new Date(after).toISOString()}) raw=${JSON.stringify(probe.raw)} seenClaims=${JSON.stringify([...seenClaims])} status=${probe.status} detail=${JSON.stringify(probe.detail)}`);
  const folderRaw = probe.raw.filter((p) => p === ".obsidian/plugins/testplugin");
  expect([...seenClaims], `a read-only listing produced a claim. folder raw events=${folderRaw.length} raw=${JSON.stringify(probe.raw)}`).toEqual([]);
  expect(probe.status, `the light is not idle six seconds after a read-only listing. raw=${JSON.stringify(probe.raw)}`).toMatch(/idle/i);
});

// ARM C — the same read-only operations, issued through Obsidian's OWN adapter from inside the renderer,
// one at a time, each followed by a pause and a read of the raw list. This is what the config walk
// (configwalk.ts: adapter.list / adapter.stat) and pluginSyncClean do. If one of these emits "raw" with
// the FOLDER path, that operation is the producer of the owner's folder claims.
test("ARM C — which adapter read operation, if any, emits a raw event for a synced plugin folder", async () => {
  const port = 19300 + Math.floor(Math.random() * 600);
  const dataRoot = path.join(os.tmpdir(), `selfsync-e2e-cfgclaim-c-${Date.now()}`);
  server = await startServer(dataRoot);
  await createVault(server.url, "cfgclaim");
  V = stageVault(server.url, "cfgclaim", TEST_PLUGIN, CONFIG_SYNC);
  app = await launchObsidian(V.appDataDir, V.vaultDir, port);
  const page = await getMainWindow(app);
  await waitForVaultReady(page);
  const tooOld = await obsidianBelowMinAppVersion(page);
  test.skip(!!tooOld, tooOld || "");
  await expect.poll(() => page.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  await awaitIdleOrExplain(page);
  await page.waitForTimeout(3_000);
  await page.evaluate(() => {
    const g = globalThis as unknown as { __raw: string[]; app: { vault: { on(name: string, cb: (p: string) => void): unknown } } };
    g.__raw = [];
    g.app.vault.on("raw", (p: string) => { g.__raw.push(p); });
  });
  const ops = ["list", "stat", "exists", "read", "readBinary", "walk", "pluginSyncClean", "configScan"] as const;
  const seen: Record<string, string[]> = {};
  for (const op of ops) {
    await page.evaluate(async (which) => {
      const g = globalThis as unknown as { __raw: string[]; app: { vault: { adapter: Record<string, (p: string) => Promise<unknown>> }; plugins: { plugins: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> } } };
      g.__raw.length = 0;
      const a = g.app.vault.adapter;
      const dir = ".obsidian/plugins/testplugin";
      const selfsync = g.app.plugins.plugins["selfsync"];
      if (which === "list") await a.list(dir);
      else if (which === "stat") { await a.stat(dir); await a.stat(dir + "/manifest.json"); }
      else if (which === "exists") await a.exists(dir);
      else if (which === "read") await a.read(dir + "/manifest.json");
      else if (which === "readBinary") await a.readBinary(dir + "/data.json");
      else if (which === "walk") { for (let i = 0; i < 3; i++) { const l = (await a.list(dir)) as { files: string[] }; for (const f of l.files) await a.stat(f); } }
      else if (which === "pluginSyncClean") await selfsync.pluginSyncClean?.("testplugin");
      else if (which === "configScan") { (selfsync as unknown as { lastConfigScanAt: number }).lastConfigScanAt = 0; await selfsync.reconcileAllOnce?.(); }
    }, op);
    await page.waitForTimeout(2_500);
    seen[op] = await page.evaluate(() => [...(globalThis as unknown as { __raw: string[] }).__raw]);
  }
  const probe = await readProbe(page);
  // eslint-disable-next-line no-console
  console.log(`[cfgclaim] ARM C raw per op: ${JSON.stringify(seen)} | claims=${JSON.stringify(probe.claims)} status=${probe.status}`);
  const offenders = Object.entries(seen).filter(([, raws]) => raws.includes(".obsidian/plugins/testplugin")).map(([op]) => op);
  expect(probe.claims, `a read-only adapter operation left a claim: ${offenders.join(", ")}. raw per op=${JSON.stringify(seen)}`).toEqual([]);
});

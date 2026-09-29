import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  launchObsidian, getMainWindow, waitForVaultReady, obsidianAvailable,
  obsidianBelowMinAppVersion, OBSIDIAN_EXECUTABLE, createNote, modifyNote, pluginStatus,
  type ObsidianHandle,
} from "./helpers/obsidianDriver";
import { isPluginLoaded } from "./helpers/rendererFunctions";
import { startServer, createVault, stageVault, cleanup, type RunningServer, type StagedVault } from "./helpers/env";

// STATUS-LATCH PROBE — does the status light get stuck on "Syncing…" after a save?
//
// Owner report (2026-09-25), on the real vault: the glyph sits yellow while the vault is fully synced,
// the tooltip reads a bare "Syncing…" with NO count, nothing appears in the debug log for minutes, and
// it "appears right after a save".
//
// A bare "Syncing…" means syncPending === 0 (the count in the detail comes from syncPending alone,
// main.ts:1958), so the yellow is coming from one of the two OTHER inputs to displayPhase (main.ts:2246):
//   (a) localWork > 0        — the per-path busy bracket (reconcile.ts:1109-1128) left un-decremented, or
//   (b) unsyncedEdits non-empty — a disk-backed edit claim that no pass ever settled.
// Neither self-heals: grep 'localWork = |syncPending = ' finds only the paired callbacks, and
// unsyncedEditCount (main.ts:2183-2191) ages out ONLY buffer-only claims, never disk-backed ones.
//
// A third possibility is that both counters are correct and the PAINT is stale: notePathWork skips
// renderLight when a path transfer failed (main.ts:2118, `if (!failed)`), so a thrown per-path pass
// leaves whatever was last painted on screen until something else repaints.
//
// This drives real Obsidian against a real server and reads the plugin's OWN statusText() — the single
// projection every surface renders (main.ts:2253) — so the assertion is on what the user actually sees,
// not on an internal counter.
//
// ARM 2 reproduces the owner's vault more faithfully: a SECOND plugin rewrites the note's frontmatter
// shortly after each save, exactly as update-time-on-edit does there (measured 75-122ms after the write
// in the 2026-09-21 session). That turns one user save into two writes, and is the condition under which
// the owner sees the latch.
test.skip(!obsidianAvailable, `Obsidian not installed (set OBSIDIAN_PATH). Looked for: ${OBSIDIAN_EXECUTABLE ?? "none"}`);

const NOTE = "latch-probe.md";
/** Generous: a save must settle well inside this, or the light is latched, not merely busy. */
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

async function bootVault(seed: Record<string, string>) {
  // A fresh random port per launch: reusing a fixed one leaves TIME_WAIT sockets from the previous run
  // and the CDP attach then fails, which surfaces confusingly as "the plugin never loaded".
  const port = 19300 + Math.floor(Math.random() * 600);
  const dataRoot = path.join(os.tmpdir(), `selfsync-e2e-latch-${Date.now()}`);
  server = await startServer(dataRoot);
  await createVault(server.url, "latch");
  V = stageVault(server.url, "latch", seed);
  app = await launchObsidian(V.appDataDir, V.vaultDir, port);
  const page = await getMainWindow(app);
  await waitForVaultReady(page);
  const tooOld = await obsidianBelowMinAppVersion(page);
  test.skip(!!tooOld, tooOld || "");
  // The plugin must be LOADED before any status reading means anything. Without this the first run of
  // this spec read statusText() as null on both arms and PASSED — a null does not match /Syncing/, so
  // the assertion could not fail. A probe that cannot fail is worse than no probe.
  await expect.poll(() => page.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  await expect
    .poll(() => pluginStatus(page), { timeout: 30_000, intervals: [500] })
    .not.toBeNull(); // statusText() must be reachable, or every assertion below is vacuous
  return page;
}

/**
 * Block until the plugin has actually CONNECTED and gone idle. Without this the probe can "pass" while
 * still in `connecting` — which is not "Syncing…", so the final assertion is satisfied by a plugin that
 * never synced anything. ARM 1 did exactly that on the 2026-09-25 run (trail: ["0.0s connecting"]).
 */
async function awaitIdleBaseline(page: import("@playwright/test").Page): Promise<void> {
  await expect
    .poll(() => pluginStatus(page), { timeout: 60_000, intervals: [1_000] })
    .toMatch(/idle|Fully synced/i);
}

/** Poll statusText() until it stops saying "Syncing", or give up. Returns the observed trail. */
async function settleTrail(page: import("@playwright/test").Page, budgetMs: number): Promise<string[]> {
  const trail: string[] = [];
  const deadline = Date.now() + budgetMs;
  let last = "";
  while (Date.now() < deadline) {
    const s = await pluginStatus(page);
    // A null reading must ABORT, never count as "not syncing" — that is how the first run of this spec
    // passed against a plugin that had not loaded.
    if (s === null) throw new Error("statusText() unreachable — the selfsync instance is absent, so the reading is meaningless");
    if (s !== last) { trail.push(`${((budgetMs - (deadline - Date.now())) / 1000).toFixed(1)}s ${s}`); last = s; }
    if (!/Syncing/i.test(s)) break;
    await page.waitForTimeout(1_000);
  }
  return trail;
}

test("ARM 1 — a plain save settles the status light", async () => {
  const page = await bootVault({});
  await createNote(page, NOTE, "# latch probe\n\nbody\n");
  await awaitIdleBaseline(page); // a real synced baseline, not merely "not syncing"

  await modifyNote(page, NOTE, "# latch probe\n\nbody edited once\n");
  const trail = await settleTrail(page, SETTLE_MS);
  const final = await pluginStatus(page);
  expect(final, "statusText() unreachable at the end of the arm - reading is vacuous").not.toBeNull();
  // eslint-disable-next-line no-console
  console.log(`[latch] ARM1 trail: ${JSON.stringify(trail)} | final=${JSON.stringify(final)}`);

  expect(final, `the light never left "Syncing…" after a plain save. trail=${JSON.stringify(trail)}`).not.toMatch(/Syncing/i);
});

test("ARM 2 — a save that a second writer rewrites 120ms later (the owner's update-time-on-edit shape)", async () => {
  // The second write is driven by the TEST rather than a bundled plugin: a seeded stamper plugin
  // stopped SelfSync itself from loading (enabled=true, loaded=false, no console error), which made the
  // arm unrunnable. vault.modify is the same API update-time-on-edit uses, and the condition that
  // matters here is simply "a second write to the same note, shortly after the user's, from outside the
  // editor" — measured at 75-122ms on the real vault on 2026-09-21.
  const page = await bootVault({});
  await createNote(page, NOTE, "---\nupdated: 2020-01-01T00:00\n---\n\n# latch probe\n\nbody\n");
  await awaitIdleBaseline(page);

  await modifyNote(page, NOTE, "---\nupdated: 2020-01-01T00:00\n---\n\n# latch probe\n\nbody edited once\n");
  await page.waitForTimeout(120);
  await modifyNote(page, NOTE, `---\nupdated: ${new Date().toISOString().slice(0, 16)}\n---\n\n# latch probe\n\nbody edited once\n`);
  const trail = await settleTrail(page, SETTLE_MS);
  const final = await pluginStatus(page);
  expect(final, "statusText() unreachable at the end of the arm - reading is vacuous").not.toBeNull();
  // eslint-disable-next-line no-console
  console.log(`[latch] ARM2 trail: ${JSON.stringify(trail)} | final=${JSON.stringify(final)}`);

  expect(final, `the light latched on "Syncing…" after a save a second plugin rewrote. trail=${JSON.stringify(trail)}`).not.toMatch(/Syncing/i);
});

test("ARM 3 — a save to a note whose folder case differs from the synced spelling (Windows/macOS)", async () => {
  // Hypothesis under test (2026-09-29), NOT a finding: noteLocalChange records the claim under the path
  // Obsidian reports, but reconcilePath canonicalises the path to the base's case-fold sibling BEFORE it
  // fires onPathSettled, so notePathSettled deletes a key that was never set and the claim stands until
  // the next whole-vault pass. Only reachable where caseInsensitivePaths holds and the local spelling of a
  // folder differs from the one the base recorded.
  test.skip(process.platform !== "win32" && process.platform !== "darwin", "needs a case-insensitive filesystem");
  const page1 = await bootVault({ "Folder/note.md": "# case probe\n\nbody\n" });
  await awaitIdleBaseline(page1); // base now records Folder/note.md
  await app!.close();
  app = undefined;

  // Re-case the folder on disk, the way a user (or another OS) renaming Folder to folder would.
  fs.renameSync(path.join(V!.vaultDir, "Folder"), path.join(V!.vaultDir, "Folder__recase"));
  fs.renameSync(path.join(V!.vaultDir, "Folder__recase"), path.join(V!.vaultDir, "folder"));

  app = await launchObsidian(V!.appDataDir, V!.vaultDir, 19300 + Math.floor(Math.random() * 600));
  const page = await getMainWindow(app);
  await waitForVaultReady(page);
  await expect.poll(() => page.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  await awaitIdleBaseline(page);

  // Record the key each settle is issued under, so the arm observes the mismatch instead of inferring it.
  await page.evaluate(() => {
    const p = (globalThis as unknown as { app: { plugins: { plugins: Record<string, Record<string, unknown>> } } }).app.plugins.plugins["selfsync"];
    const settled: string[] = [];
    const orig = p.notePathSettled as (path: string) => void;
    p.__settled = settled;
    p.notePathSettled = function (this: unknown, path: string) { settled.push(path); return orig.call(this, path); };
  });
  await modifyNote(page, "folder/note.md", "# case probe\n\nbody edited once\n");
  const trail = await settleTrail(page, SETTLE_MS);
  const final = await pluginStatus(page);
  // The plugin's own claim map, read so a latch can be attributed rather than inferred.
  const claims = await page.evaluate(() => {
    const p = (globalThis as unknown as { app: { plugins: { plugins: Record<string, { unsyncedEdits?: Map<string, unknown>; __settled?: string[] }> } } }).app.plugins.plugins["selfsync"];
    return p?.unsyncedEdits ? { open: [...p.unsyncedEdits.keys()], settledUnder: p.__settled ?? [] } : null;
  });
  expect(final, "statusText() unreachable at the end of the arm - reading is vacuous").not.toBeNull();
  // eslint-disable-next-line no-console
  console.log(`[latch] ARM3 trail: ${JSON.stringify(trail)} | final=${JSON.stringify(final)} | claims=${JSON.stringify(claims)}`);

  expect(final, `the light latched on "Syncing…" after a save under a re-cased folder. trail=${JSON.stringify(trail)} claims=${JSON.stringify(claims)}`).not.toMatch(/Syncing/i);
});

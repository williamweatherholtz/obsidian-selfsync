import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  launchObsidian, getMainWindow, waitForVaultReady, obsidianAvailable, OBSIDIAN_EXECUTABLE,
  createNote, modifyNote, readNote, pluginStatus, type ObsidianHandle, obsidianBelowMinAppVersion,
} from "./helpers/obsidianDriver";
import { isPluginLoaded } from "./helpers/rendererFunctions";
import {
  startServer, createVault, deleteVault, stageVault, serverHasFile, cleanup, ADMIN,
  type Creds, type RunningServer, type StagedVault,
} from "./helpers/env";

// An ENCRYPTED vault through REAL Obsidian (Sprint 7, D0112): device A creates the vault through the plugin's
// own Encryption password dialog, device B meets it and joins through the plugin's own Join dialog, a note
// converges A -> B and B -> A through the real plugins, and the server's data volume never holds the plaintext.
// E4 (e2eeRealServerE2e) proved the engine against the real server through the test transport; this is the
// same promise through the plugin as the owner runs it. The spec also MEASURES what the owner feels: the
// desktop Argon2id wall time at the shipped default (create and join), the push time of one note, plaintext
// vs encrypted, and the encrypted A -> B convergence time. It prints one JSON line (E2EE-MEASURE ...) and
// writes the same JSON next to the OS temp dir for `keel record measurement`.
//
// Two modes. Default: a server spawned here on loopback, whose data volume the spec greps. Real-server mode:
// set SELFSYNC_E2E_SERVER_URL (+ SELFSYNC_E2E_USERNAME / SELFSYNC_E2E_PASSWORD) to run the same flow against
// a server you operate. The spec then creates vaults named for the run and deletes them at the end; it never
// opens an existing vault. The grep clause cannot run remotely: the spec prints the grep to run on the host.
test.skip(!obsidianAvailable, `Obsidian not installed (set OBSIDIAN_PATH). Looked for: ${OBSIDIAN_EXECUTABLE ?? "none"}`);

const REAL_URL = process.env.SELFSYNC_E2E_SERVER_URL?.replace(/\/+$/, "");
const CREDS: Creds = REAL_URL
  ? { username: process.env.SELFSYNC_E2E_USERNAME ?? "", password: process.env.SELFSYNC_E2E_PASSWORD ?? "" }
  : ADMIN;
const RUN = Date.now().toString(36);
const SEED_VAULT = REAL_URL ? `e2e-seed-${RUN}` : "seed";
const ENC_VAULT = REAL_URL ? `e2e-enc-${RUN}` : "enc";
// 16 chars, not the login password (the dialog refuses a password equal to it), never reused anywhere.
const ENC_PASSWORD = `e2e-pass-${RUN}-${randomUUID().slice(0, 4)}`;
const CONTROL = `SELFSYNC-CONTROL-${randomUUID()}`; // written to the PLAINTEXT seed vault: the grep must find it
const MARKER = `SELFSYNC-E2EE-MARKER-${randomUUID()}`; // written to the ENCRYPTED vault: the grep must not
const MEASURE_OUT = path.join(os.tmpdir(), "selfsync-e2ee-measure.json");

let server: RunningServer | undefined;
let serverUrl = "";
let stagedA: StagedVault | undefined;
let stagedB: StagedVault | undefined;
let appA: ObsidianHandle | undefined;
let appB: ObsidianHandle | undefined;

test.afterEach(async () => {
  for (const a of [appA, appB]) { if (a) await a.close(); }
  // SELFSYNC_E2E_KEEP_LOGS=<dir>: keep each device's plugin log (selfsync-debug.log) before the vaults go,
  // so a slow run can be read (issue020: the live change took 62 s against the owner's server).
  const keep = process.env.SELFSYNC_E2E_KEEP_LOGS;
  if (keep) {
    fs.mkdirSync(keep, { recursive: true });
    for (const [name, s] of [["A", stagedA], ["B", stagedB]] as const) {
      const src = s && path.join(s.vaultDir, ".obsidian", "plugins", "selfsync", "selfsync-debug.log");
      if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(keep, `device${name}-${RUN}.log`));
    }
  }
  for (const s of [stagedA, stagedB]) { if (s) cleanup(s.root); }
  if (REAL_URL) {
    // Real-server mode: the run's own vaults go, nothing else is touched.
    for (const v of [ENC_VAULT, SEED_VAULT]) { try { await deleteVault(serverUrl, v, CREDS); } catch (e) { console.log(`cleanup: ${v}: ${String(e)}`); } }
  }
  if (server) server.close();
  appA = appB = stagedA = stagedB = server = undefined;
});

const plugin = `(globalThis.app.plugins.plugins["selfsync"])`;
const healthy = /^(idle|syncing|connecting)$/;
const seconds = (fromMs: number) => Math.round((Date.now() - fromMs) / 10) / 100;

/** The plugin's pin for an own vault on this device: {e2eeVaultId, vk} once created or joined, else undefined. */
function pinFor(page: Page, vault: string): Promise<{ e2eeVaultId: string; vk: string } | undefined> {
  return page.evaluate((v) => {
    const p = (globalThis as unknown as { app: { plugins: { plugins: Record<string, { e2eePinFor(o: string, n: string): { e2eeVaultId: string; vk: string } | undefined }> } } }).app.plugins.plugins["selfsync"];
    return p.e2eePinFor("", v);
  }, vault);
}

/** Poll until the server holds `file` in `vault`; the seconds it took. */
async function timeUntilOnServer(vault: string, file: string, e2ee: boolean): Promise<number> {
  const t0 = Date.now();
  await expect.poll(() => serverHasFile(serverUrl, vault, file, CREDS, e2ee), { timeout: 90_000, intervals: [250] }).toBe(true);
  return seconds(t0);
}

/** Every file under `dir` whose bytes hold `needle`: chunks, mirror files, the index, the sidecars alike. */
function grepTree(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const n = Buffer.from(needle);
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (fs.readFileSync(full).includes(n)) hits.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return hits.sort();
}

test("an encrypted vault created and joined through the plugin's dialogs syncs both ways, and the server never holds the plaintext", async () => {
  test.setTimeout(420_000);
  if (REAL_URL) {
    serverUrl = REAL_URL;
    expect(CREDS.username, "SELFSYNC_E2E_USERNAME is required with SELFSYNC_E2E_SERVER_URL").not.toBe("");
  } else {
    server = await startServer(path.join(os.tmpdir(), `selfsync-e2e-e2ee-${RUN}`));
    serverUrl = server.url;
  }
  const measure: Record<string, number | string> = { mode: REAL_URL ? "real-server" : "loopback", serverUrl, run: RUN };

  // Device A starts on a PLAINTEXT seed vault, healthy, and pushes the control note. That note is the grep's
  // positive control: a volume that holds it proves the grep sees plaintext when plaintext is there.
  await createVault(serverUrl, SEED_VAULT, CREDS);
  stagedA = stageVault(serverUrl, SEED_VAULT, {}, {}, CREDS);
  appA = await launchObsidian(stagedA.appDataDir, stagedA.vaultDir, 19222);
  const pageA = await getMainWindow(appA);
  await waitForVaultReady(pageA);
  test.skip(!!(await obsidianBelowMinAppVersion(pageA)), (await obsidianBelowMinAppVersion(pageA)) || "");
  await expect.poll(() => pageA.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => pluginStatus(pageA), { timeout: 45_000 }).toMatch(healthy);

  await createNote(pageA, "control.md", `${CONTROL} plaintext seed note`);
  measure.pushPlainSeconds = await timeUntilOnServer(SEED_VAULT, "control.md", false);

  // CREATE through the plugin's own flow: createVaultFlow opens the real EncryptionPasswordModal; the switch
  // afterwards is what the Switch dialog does on a create (vaultswitch.ts). The dialog is driven as the
  // owner drives it: two password fields, the CTA button.
  await pageA.evaluate((name) => {
    const p = (globalThis as unknown as { app: { plugins: { plugins: Record<string, { createVaultFlow(n: string, e: boolean, d: () => Promise<void>): Promise<void>; switchToVault(n: string, m: string): Promise<void> }> } } }).app.plugins.plugins["selfsync"];
    (globalThis as unknown as { __e2eeCreate: Promise<void> }).__e2eeCreate = p.createVaultFlow(name, true, async () => { await p.switchToVault(name, "merge"); });
  }, ENC_VAULT);
  const createModal = pageA.locator(".modal-container", { hasText: "Encryption password" });
  await expect(createModal).toBeVisible({ timeout: 15_000 });
  const pwFields = createModal.locator("input[type=password]");
  await expect(pwFields).toHaveCount(2);
  // Negative first: a mismatched confirmation is refused inline and the dialog stays open.
  await pwFields.nth(0).fill(ENC_PASSWORD);
  await pwFields.nth(1).fill(ENC_PASSWORD + "x");
  await createModal.getByRole("button", { name: "Encrypt and continue" }).click();
  await expect(createModal.locator("p").filter({ hasText: /match|same/i })).toBeVisible({ timeout: 5_000 });
  await expect(createModal).toBeVisible();
  // Then the real thing. The time from the click to the dialog closing is the desktop KDF at the shipped
  // default plus the keyring POST and GET on this link (milliseconds on loopback).
  await pwFields.nth(1).fill(ENC_PASSWORD);
  const tCreate = Date.now();
  await createModal.getByRole("button", { name: "Encrypt and continue" }).click();
  await expect(createModal).toBeHidden({ timeout: 120_000 });
  measure.kdfCreateSeconds = seconds(tCreate);
  await pageA.evaluate(() => (globalThis as unknown as { __e2eeCreate: Promise<void> }).__e2eeCreate);
  const pinA = await pinFor(pageA, ENC_VAULT);
  expect(pinA, "device A pinned the encrypted vault").toBeDefined();
  expect(pinA!.vk).toMatch(/^[0-9a-f]{64}$/);
  await expect.poll(() => pluginStatus(pageA), { timeout: 60_000 }).toMatch(healthy);

  // The encrypted vault now holds the seed note (merge mode pushed it) and the first encrypted note from A.
  await createNote(pageA, "secret.md", `${MARKER} hello from A`);
  measure.pushEncryptedSeconds = await timeUntilOnServer(ENC_VAULT, "secret.md", true);

  // JOIN on device B: an unpinned device that meets the encrypted vault gets the plugin's Join dialog on its
  // own (the connect latch, spec section 4.8). A wrong password is refused inline; the right one pins.
  stagedB = stageVault(serverUrl, ENC_VAULT, {}, {}, CREDS);
  appB = await launchObsidian(stagedB.appDataDir, stagedB.vaultDir, 19223);
  const pageB = await getMainWindow(appB);
  await waitForVaultReady(pageB);
  await expect.poll(() => pageB.evaluate(isPluginLoaded, "selfsync"), { timeout: 30_000 }).toBe(true);
  const joinModal = pageB.locator(".modal-container", { hasText: "Join an encrypted vault" });
  // The connect latch opens the Join dialog once per episode. The first-open ceremony (waitForVaultReady)
  // presses Escape on every modal it meets, and on the first run it met this one (2026-11-11), so the latch
  // was spent before the spec looked. When the dialog is not up, the card's Join action reopens it: that is
  // the plugin's own recovery path (openJoinFromCard, the button on the vault card), not a test-only hook.
  const autoPrompt = await joinModal.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
  if (!autoPrompt) {
    const before = await pluginStatus(pageB);
    expect(before, "device B is not healthy while unenrolled").not.toMatch(healthy);
    await pageB.evaluate(() => {
      const p = (globalThis as unknown as { app: { plugins: { plugins: Record<string, { openJoinFromCard(): void }> } } }).app.plugins.plugins["selfsync"];
      p.openJoinFromCard();
    });
    measure.joinPrompt = `card action (status before: ${before})`;
  } else {
    measure.joinPrompt = "auto prompt";
  }
  const joinUp = await joinModal.waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false);
  if (!joinUp) {
    // Say what the plugin on B holds instead of guessing (D0151): the status, the last issue, the keyring, the latch.
    const diag = await pageB.evaluate(() => {
      const p = (globalThis as unknown as { app: { plugins: { plugins: Record<string, Record<string, unknown>> } } }).app.plugins.plugins["selfsync"];
      const s = p.settings as { vaultId?: string; serverUrl?: string; e2ee?: unknown } | undefined;
      return {
        status: (p.statusText as () => string)?.(), lastIssue: p.lastIssue, keyringHeld: !!p.e2eeServerKeyring,
        promptShown: p.e2eeJoinPromptShown, joinModal: !!p.joinModal, vaultId: s?.vaultId, serverUrl: s?.serverUrl, pins: JSON.stringify(s?.e2ee ?? null),
        modals: document.querySelectorAll(".modal-container").length, buildEnabled: typeof p.createEncryptedVault,
      };
    });
    throw new Error(`the Join dialog did not open on device B: ${JSON.stringify(diag)}`);
  }
  const joinField = joinModal.locator("input[type=password]");
  await joinField.fill("definitely-not-the-password");
  await joinModal.getByRole("button", { name: "Join" }).click();
  await expect(joinModal.locator("p").filter({ hasText: "Wrong password" })).toBeVisible({ timeout: 60_000 });
  await expect(joinModal).toBeVisible();
  expect(await pinFor(pageB, ENC_VAULT), "a wrong password pins nothing").toBeUndefined();
  await joinField.fill(ENC_PASSWORD);
  const tJoin = Date.now();
  await joinModal.getByRole("button", { name: "Join" }).click();
  await expect(joinModal).toBeHidden({ timeout: 120_000 });
  measure.kdfJoinSeconds = seconds(tJoin);
  const pinB = await pinFor(pageB, ENC_VAULT);
  expect(pinB, "device B pinned the encrypted vault").toBeDefined();
  expect(pinB!.e2eeVaultId).toBe(pinA!.e2eeVaultId);
  expect(pinB!.vk).toBe(pinA!.vk); // the same vault key, unwrapped from the same record with the same password
  await expect.poll(() => pluginStatus(pageB), { timeout: 60_000 }).toMatch(healthy);

  // A -> B: the note A wrote before B joined arrives on B, decrypted to the same bytes.
  const tConv = Date.now();
  await expect.poll(() => readNote(pageB, "secret.md"), { timeout: 120_000, intervals: [1_000] }).toBe(`${MARKER} hello from A`);
  measure.convergeEncryptedSeconds = seconds(tConv);
  // B -> A: a change on B flows back to A through the same encrypted path.
  await modifyNote(pageB, "secret.md", `${MARKER} edited on B`);
  await expect.poll(() => readNote(pageA, "secret.md"), { timeout: 120_000, intervals: [1_000] }).toBe(`${MARKER} edited on B`);
  // A second encrypted note made after both devices are pinned, timed A -> B end to end.
  const tNote2 = Date.now();
  measure.liveNoteAt = new Date(tNote2).toISOString();
  // issue020 diagnostics: what device B believes about its socket at the moment A writes the live note.
  measure.deviceBTransportBefore = await pageB.evaluate(() => {
    const p = (globalThis as unknown as { app: { plugins: { plugins: Record<string, { transport?: string; lastWsActivity?: number; ws?: { readyState?: number } }> } } }).app.plugins.plugins["selfsync"];
    return `transport=${p.transport} wsReadyState=${p.ws?.readyState} msSinceLastWsFrame=${p.lastWsActivity ? Date.now() - p.lastWsActivity : "n/a"}`;
  });
  await createNote(pageA, "second.md", `${MARKER} second note`);
  await expect.poll(() => readNote(pageB, "second.md"), { timeout: 120_000, intervals: [500] }).toBe(`${MARKER} second note`);
  measure.convergeEncryptedSecondsLive = seconds(tNote2);

  // The plaintext clause. Loopback mode: grep the data volume. The control marker from the plaintext seed
  // vault must be there (the grep works); the encrypted vault's marker must be nowhere: not in a chunk, not
  // in a mirror file, not in an index row. Real-server mode: print the grep for the host.
  if (server) {
    const controlHits = grepTree(server.dataRoot, CONTROL);
    expect(controlHits.length, "the plaintext control marker is on the volume (grep positive control)").toBeGreaterThan(0);
    const markerHits = grepTree(server.dataRoot, MARKER);
    expect(markerHits, "the encrypted vault's plaintext is nowhere on the server volume").toEqual([]);
    const passwordHits = grepTree(server.dataRoot, ENC_PASSWORD);
    expect(passwordHits, "the encryption password is nowhere on the server volume").toEqual([]);
    measure.grep = `control hits ${controlHits.length}, marker hits 0, password hits 0`;
  } else {
    measure.grep = `run on the server host: grep -rl -- '${MARKER}' <DATA_ROOT>   (expected: no output)`;
  }
  // The plugin's own data on each device never holds the password either (only the pin: vault id + vk).
  for (const s of [stagedA, stagedB]) {
    const data = fs.readFileSync(path.join(s!.vaultDir, ".obsidian", "plugins", "selfsync", "data.json"), "utf8");
    expect(data).not.toContain(ENC_PASSWORD);
  }

  fs.writeFileSync(MEASURE_OUT, JSON.stringify(measure, null, 2));
  console.log(`E2EE-MEASURE ${JSON.stringify(measure)}`);
  console.log(`E2EE-MEASURE written to ${MEASURE_OUT}`);
});

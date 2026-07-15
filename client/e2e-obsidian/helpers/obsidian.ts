/**
 * Launch / drive the real Obsidian Electron app for the SelfSync real-Obsidian e2e layer (D0026,
 * Phase 3). Ported from origin/test_real_obsidian's test_e2e/helpers/obsidian.ts, adapted to this fork.
 *
 * Playwright's `_electron.launch()` cannot reliably attach to Obsidian.exe (it doesn't expose the
 * DevTools URL the way Playwright expects). So we spawn Obsidian with a fixed --remote-debugging-port,
 * poll /json/version until ready, and attach with chromium.connectOverCDP(). This validates the ONE
 * thing the headless vitest layer structurally cannot: the real ObsidianVaultIo + requestUrl transport
 * + file-event glue loading inside Obsidian.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { enablePlugin, isPluginEnabled } from "./obsidianFunctions";

// Resolve the Obsidian executable across the common Windows install locations (this machine installs
// under Local/Programs/Obsidian; older installs use Local/Obsidian) plus macOS/Linux. OBSIDIAN_PATH wins.
function resolveObsidian(): string | null {
  if (process.env.OBSIDIAN_PATH) return process.env.OBSIDIAN_PATH;
  const home = os.homedir();
  const candidates =
    os.platform() === "win32"
      ? [
          path.join(home, "AppData", "Local", "Programs", "Obsidian", "Obsidian.exe"),
          path.join(home, "AppData", "Local", "Obsidian", "Obsidian.exe"),
        ]
      : os.platform() === "darwin"
        ? ["/Applications/Obsidian.app/Contents/MacOS/Obsidian"]
        : ["/usr/bin/obsidian", "/opt/Obsidian/obsidian"];
  return candidates.find(existsSync) ?? null;
}

export const OBSIDIAN_EXECUTABLE = resolveObsidian();
/** True iff a real Obsidian install was found — specs skip themselves when false (local/nightly gate). */
export const obsidianAvailable = OBSIDIAN_EXECUTABLE !== null;

const CDP_PORT = 19222; // default; pass a distinct port per instance to run TWO devices concurrently

export interface ObsidianHandle {
  firstWindow(): Promise<Page>;
  close(): Promise<void>;
}

async function waitForCDP(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1_000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Obsidian CDP port ${port} not ready within ${timeoutMs}ms`);
}

/**
 * Launch an ISOLATED Obsidian instance opening `vaultDir`. We deliberately do NOT use the
 * `obsidian://open` URI: that is routed by the OS protocol handler to any ALREADY-RUNNING Obsidian
 * (the user's), which would hijack their session and leave our --remote-debugging-port with no window.
 * Instead we pre-seed the isolated user-data-dir's `obsidian.json` vault registry (path + open:true) and
 * launch with only --user-data-dir; Obsidian's single-instance lock is keyed to that dir, so a separate
 * instance starts and opens our vault directly — independent of the user's running Obsidian.
 */
export async function launchObsidian(fakeAppData: string, vaultDir: string, cdpPort: number = CDP_PORT): Promise<ObsidianHandle> {
  if (!OBSIDIAN_EXECUTABLE) throw new Error("Obsidian executable not found (set OBSIDIAN_PATH)");
  const vaultId = "e2e" + Date.now().toString(16) + cdpPort;
  writeFileSync(
    path.join(fakeAppData, "obsidian.json"),
    JSON.stringify({ vaults: { [vaultId]: { path: vaultDir, ts: Date.now(), open: true } } }),
  );
  const proc: ChildProcess = spawn(
    OBSIDIAN_EXECUTABLE,
    [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${fakeAppData}`, "--no-sandbox", "--lang=en"],
    { env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" } },
  );
  proc.on("error", (err) => console.error("[launchObsidian] spawn error:", err.message));

  await waitForCDP(cdpPort, 60_000);
  const browser: Browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

  return {
    close: async () => {
      try { await browser.close(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    },
    firstWindow: async (): Promise<Page> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        for (const ctx of browser.contexts()) {
          const pages = ctx.pages().filter((p) => !p.isClosed());
          if (pages.length > 0) return pages[0];
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error("No Obsidian window found after 30s");
    },
  };
}

export async function getMainWindow(app: ObsidianHandle): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  return page;
}

/** Dismiss the first-open trust prompt + community-plugins modal, then wait for the workspace. */
export async function waitForVaultReady(page: Page): Promise<void> {
  const trustButton = page.getByRole("button", { name: /trust author and enable plugins/i });
  try {
    await trustButton.waitFor({ state: "visible", timeout: 15_000 });
    await trustButton.click();
    await page.waitForTimeout(1_500);
  } catch { /* already trusted / safe mode off */ }
  try {
    const modal = page.locator(".modal-container").filter({ hasText: /community plugins/i });
    await modal.waitFor({ state: "visible", timeout: 5_000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(10);
  } catch { /* not shown */ }
  await page.waitForSelector(".workspace-ribbon", { timeout: 60_000 });
}

export function enablePluginInObsidian(page: Page, pluginName: string): Promise<void> {
  return page.evaluate(enablePlugin, pluginName);
}
export function isPluginEnabledInObsidian(page: Page, pluginName: string): Promise<boolean> {
  return page.evaluate(isPluginEnabled, pluginName);
}

// ---------------------------------------------------------------------------
// Vault helpers — drive/observe notes through the REAL Obsidian vault API (app.vault), so a create/
// modify fires the genuine file events the plugin listens on, and a read reflects what actually synced.
// ---------------------------------------------------------------------------

export function createNote(page: Page, notePath: string, content: string): Promise<void> {
  return page.evaluate(async ({ notePath, content }) => {
    await window.app.vault.create(notePath, content);
  }, { notePath, content });
}

export function modifyNote(page: Page, notePath: string, content: string): Promise<void> {
  return page.evaluate(async ({ notePath, content }) => {
    const f = window.app.vault.getAbstractFileByPath(notePath);
    if (!f) throw new Error("note not found: " + notePath);
    await window.app.vault.modify(f as never, content);
  }, { notePath, content });
}

/** Content of a note, or null if it isn't present in this vault (used to poll for convergence). */
export function readNote(page: Page, notePath: string): Promise<string | null> {
  return page.evaluate(async (notePath) => {
    const f = window.app.vault.getAbstractFileByPath(notePath);
    if (!f) return null;
    return await window.app.vault.read(f as never);
  }, notePath);
}

/** Paths of all markdown files in the vault (to detect conflict-copy files by their derived name). */
export function listNotes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.app.vault.getMarkdownFiles().map((f) => f.path));
}

/** The plugin's own computed status phase (idle/syncing/offline/…) — for the status-UI assertion. */
export function pluginStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const p = window.app.plugins.plugins["selfsync"] as { statusText?: () => string } | undefined;
    return p?.statusText?.() ?? null;
  });
}

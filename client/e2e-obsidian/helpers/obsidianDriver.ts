// Drive a REAL Obsidian desktop instance for the SelfSync end-to-end layer (D0026, Phase 3).
//
// Why this exists: the headless vitest layer cannot exercise the real ObsidianVaultIo, the requestUrl
// transport, or the vault file-event glue as they behave inside Obsidian itself. This launches an
// isolated Obsidian, attaches Playwright over the Chrome DevTools Protocol, and lets specs act through
// the genuine `app.vault` API so the events the plugin listens on are the real ones.
//
// Original SelfSync work. It shares no code with any other project; it is written directly against
// Playwright's connectOverCDP and Node's child_process / net / http primitives plus `ws`.
//
// Design notes:
//  - We never use the `obsidian://` URI to open the vault. The OS protocol handler routes that to
//    whatever Obsidian is ALREADY running — the user's — hijacking their session and leaving our
//    debugging port with no window. Instead we pre-seed an isolated user-data-dir's vault registry
//    and launch with --user-data-dir only; Obsidian's single-instance lock is keyed to that dir, so a
//    second, independent instance starts and opens our vault.
//  - THE SHIM (issueForkedE2eHelpersUnattributed, found while re-implementing): Playwright's
//    connectOverCDP unconditionally sends `Browser.setDownloadBehavior`, and Obsidian's Electron
//    (Electron 28 / Chrome 120 in Obsidian 1.5.8) answers "Browser context management is not
//    supported" — so EVERY attach failed, at Playwright 1.61.1 and 1.63.0 alike, and the layer was
//    dead here. `_electron.launch` was tried and times out with no window. So the driver runs a tiny
//    local WebSocket proxy between Playwright and Obsidian: it answers that one method with an empty
//    success and forwards every other message byte-for-byte. Measured against a real launch: exactly
//    one message shimmed; page title, evaluate, selectors and role queries all work through it.
//  - close() waits for the process to actually EXIT (bounded), so a following test can reuse the
//    same port without racing a dying process.
import { chromium, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { enablePlugin, isPluginEnabled } from "./rendererFunctions";

// ---------------------------------------------------------------------------------------------------
// Locating Obsidian
// ---------------------------------------------------------------------------------------------------

/** Well-known install locations per platform. OBSIDIAN_PATH overrides all of them. */
const INSTALL_CANDIDATES: Record<string, () => string[]> = {
  win32: () => {
    const local = join(homedir(), "AppData", "Local");
    return [join(local, "Programs", "Obsidian", "Obsidian.exe"), join(local, "Obsidian", "Obsidian.exe")];
  },
  darwin: () => ["/Applications/Obsidian.app/Contents/MacOS/Obsidian"],
  linux: () => ["/usr/bin/obsidian", "/opt/Obsidian/obsidian", "/usr/local/bin/obsidian"],
};

function locateObsidian(): string | null {
  const override = process.env.OBSIDIAN_PATH;
  if (override) return override;
  for (const c of INSTALL_CANDIDATES[platform()]?.() ?? []) if (existsSync(c)) return c;
  return null;
}

export const OBSIDIAN_EXECUTABLE: string | null = locateObsidian();
/** Specs skip themselves when this is false (no install here — e.g. CI). */
export const obsidianAvailable: boolean = OBSIDIAN_EXECUTABLE !== null;

// ---------------------------------------------------------------------------------------------------
// Small async utilities
// ---------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Re-run `attempt` until it returns a non-undefined value or the deadline passes. Errors thrown by an
 * attempt count as "not yet". One helper for every readiness wait in this file.
 */
async function until<T>(
  attempt: () => Promise<T | undefined> | T | undefined,
  opts: { timeoutMs: number; everyMs: number; what: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastError: unknown;
  do {
    try {
      const v = await attempt();
      if (v !== undefined) return v;
    } catch (e) { lastError = e; }
    await sleep(opts.everyMs);
  } while (Date.now() < deadline);
  const why = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(`timed out after ${opts.timeoutMs}ms waiting for ${opts.what}${why}`);
}

/** Resolve true once something accepts a TCP connection on 127.0.0.1:port. */
function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(750, () => done(false));
  });
}

/** GET a JSON document from the DevTools discovery endpoint. */
function devtoolsJson<T>(port: number, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body) as T); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

// ---------------------------------------------------------------------------------------------------
// The CDP shim
// ---------------------------------------------------------------------------------------------------

/** CDP methods this Obsidian's Electron rejects; answered locally with an empty success. */
const UNSUPPORTED_BY_ELECTRON = new Set(["Browser.setDownloadBehavior"]);

/**
 * A local WebSocket proxy in front of Obsidian's browser-level DevTools socket. Every message passes
 * through untouched except a request for a method Electron lacks, which gets a synthetic `result: {}`
 * so Playwright's attach sequence completes. Runs on an OS-assigned port, one upstream connection per
 * client connection, and closes both ends together.
 */
class CdpShim {
  private constructor(private readonly server: WebSocketServer, readonly url: string) {}

  static async start(upstreamWsUrl: string): Promise<CdpShim> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); });
    server.on("connection", (client) => {
      const upstream = new WebSocket(upstreamWsUrl, { perMessageDeflate: false });
      const pending: string[] = [];
      upstream.on("open", () => { for (const m of pending) upstream.send(m); pending.length = 0; });
      client.on("message", (raw) => {
        const text = raw.toString();
        try {
          const msg = JSON.parse(text) as { id?: number; sessionId?: string; method?: string };
          if (msg.method && UNSUPPORTED_BY_ELECTRON.has(msg.method)) {
            client.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result: {} }));
            return;
          }
        } catch { /* not JSON — forward as-is */ }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else pending.push(text);
      });
      upstream.on("message", (raw) => { if (client.readyState === WebSocket.OPEN) client.send(raw.toString()); });
      const closeBoth = () => { try { client.close(); } catch { /* gone */ } try { upstream.close(); } catch { /* gone */ } };
      client.on("close", closeBoth); client.on("error", closeBoth);
      upstream.on("close", closeBoth); upstream.on("error", closeBoth);
    });
    const { port } = server.address() as AddressInfo;
    return new CdpShim(server, `ws://127.0.0.1:${port}`);
  }

  close(): Promise<void> {
    for (const c of this.server.clients) { try { c.terminate(); } catch { /* gone */ } }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------------------------------

const DEFAULT_CDP_PORT = 19222; // give each concurrently-launched instance its own port

export interface ObsidianHandle {
  /** The first non-closed window, waiting for it to appear. */
  firstWindow(): Promise<Page>;
  /** Detach and terminate; resolves once the process has exited (or a bounded wait elapses). */
  close(): Promise<void>;
}

/** Write the vault registry Obsidian reads on start, so it opens `vaultDir` without any URI hand-off. */
function seedVaultRegistry(userDataDir: string, vaultDir: string): void {
  const registry = { vaults: { [randomUUID().replace(/-/g, "")]: { path: vaultDir, ts: Date.now(), open: true } } };
  writeFileSync(join(userDataDir, "obsidian.json"), JSON.stringify(registry));
}

/** Same directory, tolerant of slash direction and case on Windows and of a trailing separator. */
function sameDir(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const canon = (p: string) => {
    let s = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
    if (platform() === "win32") s = s.toLowerCase();
    return s;
  };
  return canon(a) === canon(b);
}

class ObsidianInstance implements ObsidianHandle {
  private constructor(
    private readonly proc: ChildProcess,
    private readonly shim: CdpShim,
    private readonly browser: Browser,
    private readonly cdpPort: number,
  ) {}

  static async start(userDataDir: string, vaultDir: string, cdpPort: number): Promise<ObsidianInstance> {
    if (!OBSIDIAN_EXECUTABLE) throw new Error("Obsidian is not installed here (set OBSIDIAN_PATH to point at it)");

    // PRE-FLIGHT: the port must be FREE before we spawn. Serial specs reuse the same ports, and a
    // previous instance can still hold its port for a moment after its process is told to exit. If we
    // spawned into that, the readiness probe below would see the OLD instance's open port and we would
    // attach to a dying Obsidian with someone else's vault — which is precisely what a smoke run did:
    // plugin reported enabled but never loaded. Wait (bounded) for the port to close; if it stays held,
    // say so plainly instead of guessing.
    await until(async () => ((await portAccepting(cdpPort)) ? undefined : true), {
      timeoutMs: 20_000, everyMs: 300, what: `CDP port ${cdpPort} to be free (another Obsidian is still holding it)`,
    });
    seedVaultRegistry(userDataDir, vaultDir);

    const args = [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, "--no-sandbox", "--lang=en"];
    const proc = spawn(OBSIDIAN_EXECUTABLE, args, { env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" }, stdio: "ignore" });
    let spawnFailure: Error | undefined;
    proc.once("error", (e) => { spawnFailure = e; });

    await until(async () => {
      if (spawnFailure) throw spawnFailure;
      return (await portAccepting(cdpPort)) ? true : undefined;
    }, { timeoutMs: 60_000, everyMs: 400, what: `Obsidian to listen on CDP port ${cdpPort}` });

    const { webSocketDebuggerUrl } = await until(
      () => devtoolsJson<{ webSocketDebuggerUrl: string }>(cdpPort, "/json/version"),
      { timeoutMs: 15_000, everyMs: 300, what: "the DevTools discovery endpoint" },
    );
    const shim = await CdpShim.start(webSocketDebuggerUrl);
    try {
      const browser = await chromium.connectOverCDP(shim.url, { timeout: 30_000 });
      const instance = new ObsidianInstance(proc, shim, browser, cdpPort);
      // OWNERSHIP CHECK: prove the Obsidian we attached to is the one we launched, by asking the
      // renderer which vault it has open and comparing it to ours. Two instances are otherwise
      // indistinguishable over CDP (both are app://obsidian.md/index.html). A mismatch is a hard
      // error — never a silent test against the wrong vault.
      const page = await instance.firstWindow();
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
      const openVault = await until(
        () => page.evaluate(() => {
          const adapter = (globalThis as unknown as { app?: { vault?: { adapter?: { getBasePath?: () => string; basePath?: string } } } }).app?.vault?.adapter;
          return adapter?.getBasePath?.() ?? adapter?.basePath;
        }),
        { timeoutMs: 30_000, everyMs: 300, what: "the renderer to report its open vault" },
      );
      if (!sameDir(openVault, vaultDir)) {
        throw new Error(`attached to the wrong Obsidian: it has "${openVault}" open, we launched "${vaultDir}" (port ${cdpPort} was held by another instance)`);
      }
      return instance;
    } catch (e) {
      await shim.close();
      try { proc.kill(); } catch { /* already gone */ }
      throw e;
    }
  }

  firstWindow(): Promise<Page> {
    return until(
      () => this.browser.contexts().flatMap((c) => c.pages()).find((p) => !p.isClosed()),
      { timeoutMs: 30_000, everyMs: 250, what: "an Obsidian window" },
    );
  }

  async close(): Promise<void> {
    const exited = new Promise<void>((r) => {
      if (this.proc.exitCode !== null) return r();
      this.proc.once("exit", () => r());
    });
    try { await this.browser.close(); } catch { /* already gone */ }
    await this.shim.close();
    if (this.proc.exitCode === null) { try { this.proc.kill(); } catch { /* already gone */ } }
    await Promise.race([exited, sleep(10_000)]); // bounded: never hang a teardown on a stuck process
    // The PORT is what the next launch contends for, and it can outlive the exit event briefly.
    // Wait for it to actually close so a serial successor never sees our corpse as "ready".
    await until(async () => ((await portAccepting(this.cdpPort)) ? undefined : true), {
      timeoutMs: 10_000, everyMs: 250, what: `CDP port ${this.cdpPort} to be released`,
    }).catch(() => { /* bounded; the next launch's pre-flight check is the second line of defence */ });
  }
}

/** Launch an isolated Obsidian opening `vaultDir`, with `userDataDir` as its private profile. */
export function launchObsidian(userDataDir: string, vaultDir: string, cdpPort: number = DEFAULT_CDP_PORT): Promise<ObsidianHandle> {
  return ObsidianInstance.start(userDataDir, vaultDir, cdpPort);
}

/** The main window, once its DOM has loaded. */
export async function getMainWindow(app: ObsidianHandle): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  return page;
}

// ---------------------------------------------------------------------------------------------------
// First-open ceremony
// ---------------------------------------------------------------------------------------------------

/**
 * A freshly-seeded vault greets you with dialogs — the "trust author and enable plugins" prompt, and
 * possibly a community-plugins notice. Clear whatever appears, in whatever order, then wait for the
 * workspace to be usable. Rounds are bounded so an unexpected dialog cannot loop forever.
 */
export async function waitForVaultReady(page: Page): Promise<void> {
  for (let round = 0; round < 4; round++) {
    let acted = false;
    const trust = page.getByRole("button", { name: /trust author and enable plugins/i });
    if (await trust.isVisible({ timeout: round === 0 ? 15_000 : 1_500 }).catch(() => false)) {
      await trust.click();
      acted = true;
      await sleep(1_000);
    }
    const anyModal = page.locator(".modal-container");
    if (await anyModal.first().isVisible({ timeout: 1_500 }).catch(() => false)) {
      await page.keyboard.press("Escape");
      acted = true;
      await sleep(250);
    }
    if (!acted) break;
  }
  await page.waitForSelector(".workspace-ribbon", { timeout: 60_000 });
}

// ---------------------------------------------------------------------------------------------------
// Version gate — the installed Obsidian must be one the plugin claims to support
// ---------------------------------------------------------------------------------------------------

/** The running Obsidian's version, read from its renderer user agent (`... obsidian/1.5.8 ...`), or null. */
export async function installedObsidianVersion(page: Page): Promise<string | null> {
  const ua = await page.evaluate(() => navigator.userAgent);
  return /obsidian\/(\d+\.\d+\.\d+)/i.exec(ua)?.[1] ?? null;
}

/** manifest.json's minAppVersion — the floor the plugin declares, which BRAT and Obsidian enforce. */
export function manifestMinAppVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "..", "manifest.json"), "utf8")) as { minAppVersion?: string };
  return manifest.minAppVersion ?? "0.0.0";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

/**
 * True when the installed Obsidian is OLDER than manifest.json's minAppVersion. A spec that proceeds on
 * such an install is not demonstrating the shipped plugin: Obsidian itself refuses to enable the plugin
 * below minAppVersion, and APIs the plugin uses (e.g. SettingGroup) may not exist, so a green run there
 * would be a false assurance and a red one would be noise. Specs skip loudly instead
 * (issueE2eObsidianBelowMinAppVersion). Unknown version (no UA match) => not below, run proceeds.
 */
export async function obsidianBelowMinAppVersion(page: Page): Promise<false | string> {
  const installed = await installedObsidianVersion(page);
  if (!installed) return false;
  const min = manifestMinAppVersion();
  return compareVersions(installed, min) < 0 ? `installed Obsidian ${installed} is below manifest minAppVersion ${min}` : false;
}

// ---------------------------------------------------------------------------------------------------
// Plugin registry (renderer-side, via the serialization-safe functions)
// ---------------------------------------------------------------------------------------------------

export function enablePluginInObsidian(page: Page, pluginId: string): Promise<void> {
  return page.evaluate(enablePlugin, pluginId);
}
export function isPluginEnabledInObsidian(page: Page, pluginId: string): Promise<boolean> {
  return page.evaluate(isPluginEnabled, pluginId);
}

// ---------------------------------------------------------------------------------------------------
// Vault operations through the REAL app.vault, so the genuine file events fire
// ---------------------------------------------------------------------------------------------------

type VaultApp = { vault: {
  create(path: string, data: string): Promise<unknown>;
  modify(file: unknown, data: string): Promise<void>;
  read(file: unknown): Promise<string>;
  getAbstractFileByPath(path: string): unknown | null;
  getMarkdownFiles(): { path: string }[];
}; plugins: { plugins: Record<string, unknown> } };

export function createNote(page: Page, notePath: string, content: string): Promise<void> {
  return page.evaluate(async ([p, c]) => {
    await (globalThis as unknown as { app: VaultApp }).app.vault.create(p, c);
  }, [notePath, content] as const);
}

export function modifyNote(page: Page, notePath: string, content: string): Promise<void> {
  return page.evaluate(async ([p, c]) => {
    const app = (globalThis as unknown as { app: VaultApp }).app;
    const file = app.vault.getAbstractFileByPath(p);
    if (!file) throw new Error(`no such note: ${p}`);
    await app.vault.modify(file, c);
  }, [notePath, content] as const);
}

/** A note's content, or null when it is not present in this vault (poll it to observe convergence). */
export function readNote(page: Page, notePath: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    const app = (globalThis as unknown as { app: VaultApp }).app;
    const file = app.vault.getAbstractFileByPath(p);
    return file ? await app.vault.read(file) : null;
  }, notePath);
}

/** Every markdown path in the vault — conflict copies are recognisable by their derived names. */
export function listNotes(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as unknown as { app: VaultApp }).app.vault.getMarkdownFiles().map((f) => f.path));
}

/** SelfSync's own computed status phase, for the status-UI assertion; null if the plugin isn't loaded. */
export function pluginStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const instance = (globalThis as unknown as { app: VaultApp }).app.plugins.plugins["selfsync"] as { statusText?: () => string } | undefined;
    return instance?.statusText?.() ?? null;
  });
}

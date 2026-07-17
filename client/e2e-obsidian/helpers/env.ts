// Stage a throwaway Obsidian vault with the freshly-built SelfSync plugin pre-installed + auto-enabled
// and pointed at a freshly-spawned real server — the TS equivalent of scripts/e2e.ps1's Stage-Vault,
// so a Playwright+CDP spec drives the REAL plugin against the REAL server. Loopback http is allowed
// (the plugin only refuses cleartext http to a REMOTE host), so no TLS is needed here.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";

// Playwright compiles specs as CommonJS (no "type":"module" in client/package.json), so use __dirname
// rather than import.meta.url. This module is imported only by the Playwright e2e, never by vitest.
const clientDir = path.resolve(__dirname, "../.."); // client/
const repoRoot = path.resolve(clientDir, "..");
const serverBin = path.join(
  repoRoot, "server", "target", "debug", "new-livesync-server" + (process.platform === "win32" ? ".exe" : ""),
);

export interface RunningServer { url: string; close: () => void; dataRoot: string; }

/** Spawn the real server on an ephemeral loopback port; resolve once it prints "listening on". */
export function startServer(dataRoot: string): Promise<RunningServer> {
  fs.mkdirSync(dataRoot, { recursive: true });
  const proc: ChildProcess = spawn(serverBin, [], {
    env: { ...process.env, BIND_ADDR: "127.0.0.1:0", ADMIN_USER: "admin", ADMIN_PASSWORD: "admin", ALLOW_WEAK_ADMIN: "1", DATA_ROOT: dataRoot, RUST_LOG: "info" },
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/listening on (\S+)/);
      if (m) {
        const url = "http://" + m[1].replace(/^https?:\/\//, "");
        resolve({ url, dataRoot, close: () => { try { proc.kill(); } catch { /* ignore */ } } });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData); // the "listening on" line goes to the log (stderr in this build)
    proc.on("error", reject);
    setTimeout(() => reject(new Error("server did not report listening within 30s")), 30_000);
  });
}

/** Log in as admin and create a vault via the server API (so the plugin has a real vault to sync). */
export async function createVault(serverUrl: string, vault: string): Promise<void> {
  const login = await fetch(`${serverUrl}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const token = ((await login.json()) as { token: string }).token;
  const r = await fetch(`${serverUrl}/api/vaults`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name: vault }),
  });
  if (!r.ok && r.status !== 409) throw new Error(`create vault ${r.status}`);
}

/** True once the server has a committed file at `path` in `vault` — i.e. the plugin actually synced it. */
export async function serverHasFile(serverUrl: string, vault: string, filePath: string): Promise<boolean> {
  const login = await fetch(`${serverUrl}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  if (!login.ok) return false;
  const token = ((await login.json()) as { token: string }).token;
  const r = await fetch(`${serverUrl}/api/v/${encodeURIComponent(vault)}/meta?path=${encodeURIComponent(filePath)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return r.status === 200;
}

export interface StagedVault { root: string; vaultDir: string; appDataDir: string; }

/** Create a temp vault dir with the built plugin + data.json + community-plugins.json (auto-enable).
 * `settings` is merged into data.settings (e.g. to turn config sync on); a `seedFiles` entry for
 * `.obsidian/community-plugins.json` overrides the default enabled-list. */
export function stageVault(serverUrl: string, vault: string, seedFiles: Record<string, string> = {}, settings: Record<string, unknown> = {}): StagedVault {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selfsync-e2e-"));
  const vaultDir = path.join(root, "vault");
  const pluginDir = path.join(vaultDir, ".obsidian", "plugins", "selfsync");
  const appDataDir = path.join(root, "appdata");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });

  for (const asset of ["main.js", "styles.css"]) {
    const src = path.join(clientDir, asset);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pluginDir, asset));
  }
  fs.copyFileSync(path.join(repoRoot, "manifest.json"), path.join(pluginDir, "manifest.json"));
  // The plugin persists as { settings: {...}, base: {...} } and reads data.settings (main.ts
  // loadSettings) — top-level keys are IGNORED. Nest the connection config under `settings` so the
  // plugin auto-connects on load (onLayoutReady -> reconnect) instead of opening the setup wizard.
  fs.writeFileSync(
    path.join(pluginDir, "data.json"),
    JSON.stringify({ settings: { serverUrl, username: "admin", password: "admin", vaultId: vault, storePassword: true, ...settings } }),
  );
  fs.writeFileSync(path.join(vaultDir, ".obsidian", "community-plugins.json"), JSON.stringify(["selfsync"]));
  for (const [rel, content] of Object.entries(seedFiles)) {
    const p = path.join(vaultDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { root, vaultDir, appDataDir };
}

export function cleanup(...roots: string[]): void {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } }
}

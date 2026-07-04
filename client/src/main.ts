import { App, Modal, Notice, Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";
import { HttpTransport } from "./transport";
import { SyncState, VaultIo, ChunkCache } from "./sync";
import { BaseStore } from "./base";
import { reconcileAll, reconcilePath, ReconcileDeps } from "./reconcile";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab } from "./settings";
import { OnboardingModal } from "./onboarding";

type ConnState = "off" | "connecting" | "connected" | "offline";

class ObsidianVaultIo implements VaultIo {
  constructor(private plugin: NewLiveSyncPlugin) {}
  async list() {
    const m = new Map<string, { mtime: number }>();
    for (const f of this.plugin.app.vault.getFiles()) m.set(f.path, { mtime: f.stat.mtime });
    return m;
  }
  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(normalizePath(path)));
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    const p = normalizePath(path);
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !(await this.plugin.app.vault.adapter.exists(dir))) await this.plugin.app.vault.adapter.mkdir(dir);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.plugin.app.vault.adapter.writeBinary(p, buf);
  }
  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    if (await this.plugin.app.vault.adapter.exists(p)) await this.plugin.app.vault.adapter.remove(p);
  }
}

/** A scrollable, copyable view of the recent sync log. */
class LogModal extends Modal {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }
  onOpen() {
    this.titleEl.setText("New LiveSync — sync log");
    const pre = this.contentEl.createEl("pre", { text: this.plugin.getLogText() });
    pre.setAttribute("style", "max-height:60vh;overflow:auto;white-space:pre-wrap;user-select:text;font-size:12px;");
    const bar = this.contentEl.createEl("div");
    bar.setAttribute("style", "display:flex;gap:8px;margin-top:10px;");
    const copyBtn = bar.createEl("button", { text: "Copy to clipboard" });
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(this.plugin.getLogText()); new Notice("Sync log copied"); }
      catch { new Notice("Copy failed — select the text manually"); }
    };
    const clearBtn = bar.createEl("button", { text: "Clear log" });
    clearBtn.onclick = () => { this.plugin.clearLogs(); pre.setText(this.plugin.getLogText()); new Notice("Sync log cleared"); };
  }
  onClose() { this.contentEl.empty(); }
}

export default class NewLiveSyncPlugin extends Plugin {
  settings!: NewLiveSyncSettings;
  private api?: HttpTransport;
  private ws?: WebSocket;
  private io = new ObsidianVaultIo(this);
  private state: SyncState = { version: 0 };
  private base = new BaseStore();
  private cache: ChunkCache = new Map();
  private applying = false; // guard: suppress reconcile re-entrancy from our own writes

  // --- observability + connection lifecycle ---
  private statusEl?: HTMLElement;
  private logs: string[] = [];
  private connState: ConnState = "off";
  private reconnectTimer?: number;
  private pollTimer?: number;
  private backoff = 3000;
  private unloading = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NewLiveSyncSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.setStatus("off");

    this.addCommand({ id: "setup", name: "Set up / switch vault", callback: () => new OnboardingModal(this.app, this).open() });
    this.addCommand({ id: "show-log", name: "Show sync log", callback: () => this.showLog() });
    this.addCommand({ id: "clear-log", name: "Clear sync log", callback: () => this.clearLogs() });
    this.addCommand({ id: "reconnect", name: "Reconnect now", callback: () => this.reconnect() });

    this.registerEvent(this.app.vault.on("modify", (f) => this.onLocalEvent(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onLocalEvent(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onLocalDelete(f.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onLocalRename(file, oldPath)));

    this.log("plugin loaded", true);
    this.app.workspace.onLayoutReady(() => this.reconnect());
  }

  onunload() {
    this.unloading = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.ws?.close();
    this.log("plugin unloaded");
  }

  // ---- logging + status ----
  log(msg: string, notice = false) {
    const line = `${new Date().toLocaleTimeString()}  ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    console.debug(`[new-livesync] ${line}`);
    if (notice || this.settings.verbose) new Notice(`SelfSync: ${msg}`);
  }
  getLogText() { return this.logs.join("\n"); }
  clearLogs() { this.logs = []; this.log("log cleared"); }
  showLog() { new LogModal(this.app, this).open(); }
  openSetup() { new OnboardingModal(this.app, this).open(); }

  private setStatus(state: ConnState, detail = "") {
    this.connState = state;
    // "SelfSync" + a status light: green = up to date, amber = connecting/syncing,
    // red = offline, grey = off. Full detail lives in the hover tooltip.
    const color =
      state === "connected" ? "#3fb950"   // green — synced / up to date
      : state === "connecting" ? "#d29922" // amber — connecting/syncing
      : state === "offline" ? "#f85149"    // red — offline (retrying)
      : "#8b949e";                          // grey — off
    const tip =
      state === "connected" ? `Up to date${detail ? " (" + detail + ")" : ""}`
      : state === "connecting" ? "Connecting / syncing…"
      : state === "offline" ? "Offline — retrying"
      : "Not connected";
    if (this.statusEl) {
      this.statusEl.empty();
      const dot = this.statusEl.createSpan({ text: "●" });
      dot.setAttribute("style", `color:${color};margin-right:4px;`);
      this.statusEl.createSpan({ text: "SelfSync" });
      this.statusEl.setAttribute("aria-label", `SelfSync — ${tip}`);
    }
  }
  statusText() { return this.connState; }

  // ---- reconcile deps ----
  private deviceLabel(): string {
    if (this.settings.deviceName) return this.settings.deviceName;
    const plat = (navigator as unknown as { platform?: string }).platform ?? "device";
    return plat.replace(/[^A-Za-z0-9]+/g, "").slice(0, 12) || "device";
  }
  private deps(): ReconcileDeps {
    return {
      api: this.api!, io: this.io, base: this.base, cache: this.cache, state: this.state,
      device: this.deviceLabel(), strategy: this.settings.conflictStrategy,
      onConflict: (p, c) => this.log(`conflict on ${p} → kept your copy as ${c}`, true),
      onBaseChanged: () => { void this.persist(); },
    };
  }

  // ---- connection lifecycle (self-healing) ----
  async reconnect() {
    if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.setStatus("connecting");
    this.log(`connecting to ${this.settings.serverUrl} as '${this.settings.username}'`);
    try {
      this.ws?.close();
      const token = await HttpTransport.login(this.settings.serverUrl, this.settings.username, this.settings.password);
      this.log("login OK");
      this.api = new HttpTransport(this.settings.serverUrl, token, this.settings.vaultId || "default");

      this.applying = true;
      try { await reconcileAll(this.deps()); } finally { this.applying = false; }
      this.log(`reconciled → v${this.state.version}`);

      const ws = this.api.connectWs(() => this.onRemoteChanged());
      this.ws = ws ?? undefined;
      if (ws) {
        ws.addEventListener("open", () => this.log("ws channel open (instant sync)"));
        ws.addEventListener("error", () => this.log("ws unavailable — polling fallback active"));
        ws.addEventListener("close", () => { if (!this.unloading) this.log("ws closed — polling continues"); });
      } else {
        this.log("ws not available — polling fallback active");
      }
      this.startPolling();

      this.backoff = 3000;
      this.setStatus("connected", `v${this.state.version}`);
      this.log(`connected @ v${this.state.version}`, true);
    } catch (e: any) {
      this.applying = false;
      this.setStatus("offline");
      this.log(`connect FAILED: ${e?.message ?? e}`, true);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== undefined || this.unloading) return;
    const delay = this.backoff;
    this.log(`retrying in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; this.reconnect(); }, delay);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  private startPolling() {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => this.poll(), 4000);
  }
  private async poll() {
    if (!this.api || this.applying) return;
    await this.onRemoteChanged();
  }

  private async onRemoteChanged() {
    if (!this.api || this.applying) return;
    this.applying = true;
    try {
      const before = this.state.version;
      await reconcileAll(this.deps());
      // Reachable + reconciled → up to date (green). Log only on an actual change.
      if (this.state.version !== before) this.log(`remote change → reconciled (v${before} → v${this.state.version})`);
      this.setStatus("connected", `v${this.state.version}`);
    } catch (e: any) {
      // Any failure (server down, 401, network) means we're NOT up to date: go red
      // and hand recovery to the backoff reconnect (which restarts polling + WS on
      // success). Stop the redundant poll so the two don't retry in parallel.
      this.log(`reconcile FAILED: ${e?.message ?? e}`);
      this.setStatus("offline");
      if (this.pollTimer !== undefined) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
      this.scheduleReconnect();
    } finally { this.applying = false; }
  }

  private async onLocalEvent(f: TAbstractFile) {
    if (this.applying || !this.api || !(f instanceof TFile)) return;
    this.applying = true;
    try { await reconcilePath(this.deps(), f.path); this.setStatus("connected", `v${this.state.version}`); }
    catch (e: any) { this.log(`sync FAILED for ${f.path}: ${e?.message ?? e}`); }
    finally { this.applying = false; }
  }

  private async onLocalDelete(path: string) {
    if (this.applying || !this.api) return;
    this.applying = true;
    try { await reconcilePath(this.deps(), path); }
    catch (e: any) { this.log(`delete sync FAILED for ${path}: ${e?.message ?? e}`); }
    finally { this.applying = false; }
  }

  private async onLocalRename(file: TAbstractFile, oldPath: string) {
    if (this.applying || !this.api || !(file instanceof TFile)) return;
    this.applying = true;
    try { await reconcilePath(this.deps(), oldPath); await reconcilePath(this.deps(), file.path); }
    catch (e: any) { this.log(`rename sync FAILED: ${e?.message ?? e}`); }
    finally { this.applying = false; }
  }

  async loadSettings() {
    const data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});
    this.base = new BaseStore(data.base ?? {});
  }
  async saveSettings() { await this.persist(); }
  private async persist() { await this.saveData({ settings: this.settings, base: this.base.toJSON() }); }
}

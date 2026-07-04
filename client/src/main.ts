import { App, Modal, Notice, Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";
import { HttpTransport } from "./transport";
import { pull, pushFile, pushLocalNew, SyncState, VaultIo, ChunkCache } from "./sync";
import { sha256hex } from "./chunker";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab } from "./settings";

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
    await this.plugin.noteSyncedBytes(p, bytes);
  }
  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    if (await this.plugin.app.vault.adapter.exists(p)) await this.plugin.app.vault.adapter.remove(p);
    this.plugin.forgetSynced(p);
  }
}

/** A scrollable, copyable view of the recent sync log. */
class LogModal extends Modal {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }
  onOpen() {
    this.titleEl.setText("New LiveSync — sync log");
    const pre = this.contentEl.createEl("pre", { text: this.plugin.getLogText() });
    pre.setAttribute("style", "max-height:60vh;overflow:auto;white-space:pre-wrap;user-select:text;font-size:12px;");
    const btn = this.contentEl.createEl("button", { text: "Copy to clipboard" });
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(this.plugin.getLogText()); new Notice("Sync log copied"); }
      catch { new Notice("Copy failed — select the text manually"); }
    };
  }
  onClose() { this.contentEl.empty(); }
}

export default class NewLiveSyncPlugin extends Plugin {
  settings!: NewLiveSyncSettings;
  private api?: HttpTransport;
  private ws?: WebSocket;
  private io = new ObsidianVaultIo(this);
  private state: SyncState = { version: 0 };
  private known = new Set<string>();
  private applying = false; // guard: don't echo server-driven writes back as pushes
  private lastHash = new Map<string, string>(); // path -> last-synced file SHA-256 (echo-suppression)
  private cache: ChunkCache = new Map(); // content-addressed chunk cache

  // --- observability + connection lifecycle ---
  private statusEl?: HTMLElement;
  private logs: string[] = [];
  private connState: ConnState = "off";
  private reconnectTimer?: number;
  private pollTimer?: number;
  private backoff = 3000; // ms, doubles up to 30s
  private unloading = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NewLiveSyncSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.setStatus("off");

    this.addCommand({ id: "show-log", name: "Show sync log", callback: () => this.showLog() });
    this.addCommand({ id: "reconnect", name: "Reconnect now", callback: () => this.reconnect() });

    this.registerEvent(this.app.vault.on("modify", (f) => this.onLocalChange(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onLocalChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onLocalDelete(f.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onLocalRename(file, oldPath)));

    this.log("plugin loaded", true); // Notice confirms the plugin is actually enabled
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
    if (notice || this.settings.verbose) new Notice(`LiveSync: ${msg}`);
  }
  getLogText() { return this.logs.join("\n"); }
  showLog() { new LogModal(this.app, this).open(); }

  private setStatus(state: ConnState, detail = "") {
    this.connState = state;
    const label =
      state === "connected" ? `LiveSync ● connected${detail ? " " + detail : ""}`
      : state === "connecting" ? "LiveSync ◌ connecting…"
      : state === "offline" ? "LiveSync ⚠ offline (retrying)"
      : "LiveSync ○ off";
    if (this.statusEl) { this.statusEl.setText(label); this.statusEl.setAttribute("aria-label", label); }
  }
  statusText() { return this.connState; }

  // ---- connection lifecycle (self-healing) ----
  async reconnect() {
    if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.setStatus("connecting");
    this.log(`connecting to ${this.settings.serverUrl} as '${this.settings.username}'`);
    try {
      this.ws?.close();
      const token = await HttpTransport.login(this.settings.serverUrl, this.settings.username, this.settings.password);
      this.log("login OK");
      this.api = new HttpTransport(this.settings.serverUrl, token);

      this.applying = true;
      await pull(this.api, this.io, this.state, this.cache);
      this.log(`initial pull → now at v${this.state.version}`);
      this.known = new Set((await this.api.changes(0)).upserts.map((m) => m.path));
      await pushLocalNew(this.api, this.io, this.state, this.cache, this.known);
      this.log(`initial push (server had ${this.known.size} files) → v${this.state.version}`);
      this.applying = false;

      // Best-effort instant channel; the polling loop below is the reliable path.
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
    // Reliable propagation even if the WebSocket is blocked: pull every few seconds.
    this.pollTimer = window.setInterval(() => this.poll(), 4000);
  }
  private async poll() {
    if (!this.api || this.applying) return;
    await this.onRemoteChanged();
  }

  private async onRemoteChanged() {
    if (!this.api) return;
    this.applying = true;
    try {
      const before = this.state.version;
      await pull(this.api, this.io, this.state, this.cache);
      if (this.state.version !== before) {
        this.log(`remote change → pulled (v${before} → v${this.state.version})`);
        this.setStatus("connected", `v${this.state.version}`);
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.log(`pull FAILED: ${msg}`);
      if (msg.includes("401")) { this.applying = false; this.scheduleReconnect(); }
    } finally { this.applying = false; }
  }

  private async onLocalChange(f: TAbstractFile) {
    if (this.applying || !this.api || !(f instanceof TFile)) return;
    try {
      const bytes = await this.io.read(f.path);
      const h = await sha256hex(bytes);
      if (this.lastHash.get(f.path) === h) return; // echo of a server-driven write
      await pushFile(this.api, this.io, this.state, this.cache, f.path);
      this.known.add(f.path);
      this.lastHash.set(f.path, h);
      this.log(`local edit ${f.path} → pushed (v${this.state.version})`);
      this.setStatus("connected", `v${this.state.version}`);
    } catch (e: any) { this.log(`push FAILED for ${f.path}: ${e?.message ?? e}`); }
  }

  private async onLocalDelete(path: string) {
    if (this.applying || !this.api) return;
    try {
      await this.api.deleteFile(path);
      this.known.delete(path);
      this.lastHash.delete(path);
      this.log(`local delete ${path} → pushed`);
    } catch (e: any) { this.log(`delete push FAILED for ${path}: ${e?.message ?? e}`); }
  }

  private async onLocalRename(file: TAbstractFile, oldPath: string) {
    if (this.applying || !this.api || !(file instanceof TFile)) return;
    try {
      await this.api.deleteFile(oldPath);
      this.known.delete(oldPath);
      this.lastHash.delete(oldPath);
      await pushFile(this.api, this.io, this.state, this.cache, file.path);
      this.known.add(file.path);
      this.lastHash.set(file.path, await sha256hex(await this.io.read(file.path)));
      this.log(`local rename ${oldPath} → ${file.path} (v${this.state.version})`);
    } catch (e: any) { this.log(`rename push FAILED for ${file.path}: ${e?.message ?? e}`); }
  }

  async noteSyncedBytes(path: string, bytes: Uint8Array) { this.lastHash.set(path, await sha256hex(bytes)); }
  forgetSynced(path: string) { this.lastHash.delete(path); }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

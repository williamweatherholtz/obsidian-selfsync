import { App, Modal, Notice, Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";
import { HttpTransport } from "./transport";
import { pull, pushLocal, SyncState, VaultIo } from "./sync";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab } from "./settings";

type ConnState = "off" | "connecting" | "connected" | "offline";

class ObsidianVaultIo implements VaultIo {
  constructor(private plugin: NewLiveSyncPlugin) {}
  async list() {
    const m = new Map<string, { mtime: number }>();
    for (const f of this.plugin.app.vault.getFiles()) m.set(f.path, { mtime: f.stat.mtime });
    return m;
  }
  async read(path: string) { return this.plugin.app.vault.adapter.read(normalizePath(path)); }
  async write(path: string, data: string) {
    const p = normalizePath(path);
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !(await this.plugin.app.vault.adapter.exists(dir))) await this.plugin.app.vault.adapter.mkdir(dir);
    await this.plugin.app.vault.adapter.write(p, data);
    this.plugin.noteSynced(p, data);
  }
  async remove(path: string) {
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
  private lastSynced = new Map<string, string>(); // content-equality echo-suppression (async event race)

  // --- observability + connection lifecycle ---
  private statusEl?: HTMLElement;
  private logs: string[] = [];
  private connState: ConnState = "off";
  private reconnectTimer?: number;
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
      await pull(this.api, this.io, this.state);
      this.log(`initial pull → now at v${this.state.version}`);
      const manifest = await this.api.changes(0);
      this.known = new Set(manifest.upserts.map((m) => m.path));
      await pushLocal(this.api, this.io, this.state, this.known);
      this.log(`initial push (server had ${this.known.size} files) → v${this.state.version}`);
      this.applying = false;

      this.ws = this.api.connectWs(() => this.onRemoteChanged());
      this.ws.addEventListener("open", () => this.log("ws channel open"));
      this.ws.addEventListener("close", () => {
        if (this.unloading) return;
        this.log("ws closed — scheduling reconnect");
        this.setStatus("offline");
        this.scheduleReconnect();
      });
      this.ws.addEventListener("error", () => this.log("ws error"));

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

  private async onRemoteChanged() {
    if (!this.api) return;
    this.applying = true;
    try {
      const before = this.state.version;
      await pull(this.api, this.io, this.state);
      this.log(`remote change → pulled (v${before} → v${this.state.version})`);
      this.setStatus("connected", `v${this.state.version}`);
    } catch (e: any) {
      this.log(`pull FAILED: ${e?.message ?? e}`);
    } finally { this.applying = false; }
  }

  private async onLocalChange(f: TAbstractFile) {
    if (this.applying || !this.api || !(f instanceof TFile)) return;
    try {
      const data = await this.io.read(f.path);
      if (this.lastSynced.get(f.path) === data) return; // echo of a server-driven write
      const meta = await this.api.putFile(f.path, data, f.stat.mtime);
      this.state.version = Math.max(this.state.version, meta.version);
      this.known.add(f.path);
      this.lastSynced.set(f.path, data);
      this.log(`local edit ${f.path} → pushed (v${meta.version})`);
      this.setStatus("connected", `v${this.state.version}`);
    } catch (e: any) { this.log(`push FAILED for ${f.path}: ${e?.message ?? e}`); }
  }

  private async onLocalDelete(path: string) {
    if (this.applying || !this.api) return;
    try {
      await this.api.deleteFile(path);
      this.known.delete(path);
      this.lastSynced.delete(path);
      this.log(`local delete ${path} → pushed`);
    } catch (e: any) { this.log(`delete push FAILED for ${path}: ${e?.message ?? e}`); }
  }

  private async onLocalRename(file: TAbstractFile, oldPath: string) {
    if (this.applying || !this.api || !(file instanceof TFile)) return;
    try {
      await this.api.deleteFile(oldPath);
      this.known.delete(oldPath);
      this.lastSynced.delete(oldPath);
      const data = await this.io.read(file.path);
      const meta = await this.api.putFile(file.path, data, file.stat.mtime);
      this.state.version = Math.max(this.state.version, meta.version);
      this.known.add(file.path);
      this.lastSynced.set(file.path, data);
      this.log(`local rename ${oldPath} → ${file.path} (v${meta.version})`);
    } catch (e: any) { this.log(`rename push FAILED for ${file.path}: ${e?.message ?? e}`); }
  }

  showLog() { new LogModal(this.app, this).open(); }

  noteSynced(path: string, data: string) { this.lastSynced.set(path, data); }
  forgetSynced(path: string) { this.lastSynced.delete(path); }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

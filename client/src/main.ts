import { Plugin, TFile, normalizePath } from "obsidian";
import { HttpTransport } from "./transport";
import { pull, pushLocal, SyncState, VaultIo } from "./sync";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab } from "./settings";

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

export default class NewLiveSyncPlugin extends Plugin {
  settings!: NewLiveSyncSettings;
  private api?: HttpTransport;
  private ws?: WebSocket;
  private io = new ObsidianVaultIo(this);
  private state: SyncState = { version: 0 };
  private known = new Set<string>();
  private applying = false; // guard: don't echo server-driven writes back as pushes
  private lastSynced = new Map<string, string>(); // content-equality echo-suppression (async event race)

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NewLiveSyncSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => this.reconnect());
    this.registerEvent(this.app.vault.on("modify", (f) => this.onLocalChange(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onLocalChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onLocalDelete(f.path)));
  }

  onunload() { this.ws?.close(); }

  async reconnect() {
    try {
      this.ws?.close();
      const token = await HttpTransport.login(this.settings.serverUrl, this.settings.username, this.settings.password);
      this.api = new HttpTransport(this.settings.serverUrl, token);
      this.applying = true;
      await pull(this.api, this.io, this.state);          // get server state first
      const manifest = await this.api.changes(0);
      this.known = new Set(manifest.upserts.map((m) => m.path));
      await pushLocal(this.api, this.io, this.state, this.known); // push anything server lacks
      this.applying = false;
      this.ws = this.api.connectWs(() => this.onRemoteChanged());
      console.log("New LiveSync connected @ version", this.state.version);
    } catch (e) { this.applying = false; console.error("New LiveSync connect failed", e); }
  }

  private async onRemoteChanged() {
    if (!this.api) return;
    this.applying = true;
    try { await pull(this.api, this.io, this.state); } finally { this.applying = false; }
  }

  private async onLocalChange(f: any) {
    if (this.applying || !this.api || !(f instanceof TFile)) return;
    const data = await this.io.read(f.path);
    if (this.lastSynced.get(f.path) === data) return; // echo of a server-driven write, not a real edit
    const meta = await this.api.putFile(f.path, data, f.stat.mtime);
    this.state.version = Math.max(this.state.version, meta.version);
    this.known.add(f.path);
    this.lastSynced.set(f.path, data);
  }

  private async onLocalDelete(path: string) {
    if (this.applying || !this.api) return;
    await this.api.deleteFile(path);
    this.known.delete(path);
    this.lastSynced.delete(path);
  }

  noteSynced(path: string, data: string) { this.lastSynced.set(path, data); }
  forgetSynced(path: string) { this.lastSynced.delete(path); }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

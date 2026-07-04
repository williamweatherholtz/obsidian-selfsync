import { App, Modal, Notice, Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";
import { HttpTransport } from "./transport";
import { SyncState, VaultIo, ChunkCache } from "./sync";
import { BaseStore } from "./base";
import { reconcileAll, reconcilePath, ReconcileDeps } from "./reconcile";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab } from "./settings";
import { SetupWizardModal } from "./setupwizard";
import { encodeSetupLink } from "./connstr";
import { SyncMachine, Phase, light } from "./syncstate";
import { shouldSync, pluginIdOf, DEFAULT_CONFIG_SYNC } from "./configsync";

class ObsidianVaultIo implements VaultIo {
  constructor(private plugin: NewLiveSyncPlugin) {}

  // The single selective-sync gate: notes always pass; `.obsidian/` paths pass only
  // per the config selection, and SelfSync's own folder never passes (see configsync).
  private passes(path: string): boolean {
    return shouldSync(path, this.plugin.settings.configSync, this.plugin.selfFolderId());
  }

  async list() {
    const m = new Map<string, { mtime: number }>();
    // getFiles() returns notes/attachments only (never .obsidian); passes() is a
    // belt-and-suspenders guard.
    for (const f of this.plugin.app.vault.getFiles()) {
      if (this.passes(f.path)) m.set(f.path, { mtime: f.stat.mtime });
    }
    if (this.plugin.settings.configSync.enabled) await this.enumerateConfig(".obsidian", m);
    return m;
  }

  // Recursively enumerate the hidden .obsidian/ config surface via the low-level
  // adapter (getFiles() can't see it), keeping only paths that pass the filter.
  private async enumerateConfig(dir: string, m: Map<string, { mtime: number }>): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    let listing: { files: string[]; folders: string[] };
    try { listing = await adapter.list(dir); } catch { return; }
    for (const file of listing.files) {
      if (!this.passes(file)) continue;
      try { const st = await adapter.stat(file); m.set(file, { mtime: st?.mtime ?? 0 }); } catch { /* skip unreadable */ }
    }
    for (const folder of listing.folders) await this.enumerateConfig(folder, m);
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(normalizePath(path)));
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    if (!this.passes(path)) return; // excluded path must never overwrite locally
    const p = normalizePath(path);
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !(await this.plugin.app.vault.adapter.exists(dir))) await this.plugin.app.vault.adapter.mkdir(dir);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.plugin.app.vault.adapter.writeBinary(p, buf);
    this.plugin.onConfigWritten(path); // best-effort live-reload of the affected surface
  }
  async remove(path: string): Promise<void> {
    if (!this.passes(path)) return;
    const p = normalizePath(path);
    if (await this.plugin.app.vault.adapter.exists(p)) await this.plugin.app.vault.adapter.remove(p);
  }
}

/** A scrollable, copyable view of the recent sync log. */
class LogModal extends Modal {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }
  onOpen() {
    this.titleEl.setText("SelfSync — sync log");
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

  // --- observability + connection lifecycle (explicit FSM, see syncstate.ts) ---
  private statusEl?: HTMLElement;
  private logs: string[] = [];
  private machine = new SyncMachine((phase) => this.renderLight(phase));
  private reconnectTimer?: number;
  private pollTimer?: number;
  private backoff = 3000;
  private unloading = false;
  private connecting = false;               // H2: only one reconnect() in flight at a time
  private pendingLocal = new Set<string>(); // H1: local edits that arrived mid-sync; drained after
  private lastIssue?: string;               // human reason for the current non-idle state (shown on the card)
  getLastIssue(): string | undefined { return this.lastIssue; }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NewLiveSyncSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.renderLight(this.machine.get()); // initial: off

    this.addCommand({ id: "setup", name: "Set up / switch vault", callback: () => this.openSetup() });
    this.addCommand({ id: "show-log", name: "Show sync log", callback: () => this.showLog() });
    this.addCommand({ id: "clear-log", name: "Clear sync log", callback: () => this.clearLogs() });
    this.addCommand({ id: "reconnect", name: "Reconnect now", callback: () => this.reconnect() });

    this.registerEvent(this.app.vault.on("modify", (f) => this.onLocalEvent(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onLocalEvent(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onLocalDelete(f.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onLocalRename(file, oldPath)));

    this.log("plugin loaded", true);
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.vaultId || !this.settings.serverUrl || !this.settings.username) this.openSetup();
      else void this.reconnect();
    });
  }

  onunload() {
    this.unloading = true;
    this.machine.dispatch("unload");
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
    console.debug(`[selfsync] ${line}`);
    if (notice || this.settings.verbose) new Notice(`SelfSync: ${msg}`);
  }
  getLogText() { return this.logs.join("\n"); }
  clearLogs() { this.logs = []; this.log("log cleared"); }
  showLog() { new LogModal(this.app, this).open(); }
  openSetup() { new SetupWizardModal(this.app, this).open(); }

  // The plugin's ACTUAL install-folder name (last segment of manifest.dir), which is
  // what shouldSync must exclude. Keying on manifest.dir rather than manifest.id keeps
  // the credential-bearing self folder excluded even if the folder ≠ the id (C3).
  selfFolderId(): string {
    const dir = this.manifest.dir;
    if (dir) {
      const seg = dir.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
      if (seg) return seg;
    }
    return this.manifest.id;
  }

  // H1: drain local edits that were queued because they fired while a sync was running.
  // Each reconcilePath re-guards `applying`; loop until the queue empties (new edits may
  // arrive during draining and are picked up).
  private async drainPending() {
    while (!this.applying && this.api && !this.unloading && this.pendingLocal.size > 0) {
      const path = this.pendingLocal.values().next().value as string;
      this.pendingLocal.delete(path);
      this.applying = true;
      try { await reconcilePath(this.deps(), path); }
      catch (e: any) { this.log(`queued sync FAILED for ${path}: ${e?.message ?? e}`); }
      finally { this.applying = false; }
    }
  }

  setAuthToken(token: string) { this.settings.authToken = token; void this.saveSettings(); }

  // Reuse the cached token when it still works; otherwise re-login with the stored
  // password (tokens are ephemeral server-side until B7). listVaults is a cheap
  // authenticated probe. Throws if neither path yields a working token.
  private async acquireToken(): Promise<string> {
    const url = this.settings.serverUrl;
    if (this.settings.authToken) {
      try { await HttpTransport.listVaults(url, this.settings.authToken); this.log("token OK"); return this.settings.authToken; }
      catch { this.log("cached token rejected — re-logging in"); }
    }
    if (!this.settings.password) throw new Error("no password stored; re-run setup");
    const token = await HttpTransport.login(url, this.settings.username, this.settings.password);
    this.setAuthToken(token);
    this.log("login OK");
    return token;
  }

  // Unbind this vault (keep local files); return to the unconfigured state.
  async disconnect() {
    this.settings.vaultId = "";
    await this.saveSettings();
    this.ws?.close();
    if (this.pollTimer !== undefined) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.machine.dispatch("unload");
    this.log("disconnected (local files kept)", true);
  }

  // Sign out: forget credentials + token, drop to Not-set-up.
  async signOut() {
    this.settings.authToken = undefined;
    this.settings.password = "";
    await this.disconnect();
  }

  // A shareable setup link for another device (server + username only, never password).
  addDeviceLink(): string {
    return encodeSetupLink({ server: this.settings.serverUrl, user: this.settings.username });
  }

  // --- switch vault without re-login: reuse the existing session (token / stored
  // password), so the "Switch vault" flow never re-asks for server or account. ---
  async currentVaults(): Promise<string[]> {
    const token = await this.acquireToken();
    return HttpTransport.listVaults(this.settings.serverUrl, token);
  }
  async createRemoteVault(name: string): Promise<void> {
    const token = await this.acquireToken();
    await HttpTransport.createVault(this.settings.serverUrl, token, name);
  }
  async switchToVault(name: string): Promise<void> {
    this.settings.vaultId = name;
    await this.saveSettings();
    await this.reconnect();
  }

  // --- selective config sync: guarded, best-effort live reload -----------------
  // The IO records each synced .obsidian/ file here; we flush once per reconcile so a
  // plugin is reloaded at most once even if several of its files changed.
  private pendingReload = new Set<string>();
  onConfigWritten(path: string) { this.pendingReload.add(path); }

  async flushConfigReload(): Promise<void> {
    if (this.pendingReload.size === 0) return;
    const paths = [...this.pendingReload];
    this.pendingReload.clear();
    const app = this.app as any; // app.plugins / app.customCss are not in the public typings
    let needsRestart = false;

    // Appearance: reload theme + snippet CSS live.
    if (paths.some((p) => /(^|\/)appearance\.json$/.test(p) || p.includes("/themes/") || p.includes("/snippets/"))) {
      try { app.customCss?.loadData?.(); app.customCss?.loadSnippets?.(); this.app.workspace.trigger("css-change"); }
      catch { needsRestart = true; }
    }

    // Community plugins: disable+enable each touched plugin (never SelfSync itself;
    // tolerate a plugin whose code isn't installed yet — reload must not throw).
    const pluginIds = new Set<string>();
    for (const p of paths) { const id = pluginIdOf(p); if (id && id !== this.selfFolderId()) pluginIds.add(id); }
    for (const id of pluginIds) {
      try {
        if (app.plugins?.enabledPlugins?.has?.(id) && app.plugins?.plugins?.[id]) {
          await app.plugins.disablePlugin(id);
          await app.plugins.enablePlugin(id);
        }
      } catch { needsRestart = true; }
    }

    // Core settings / hotkeys / the plugin-enable list can't be fully re-applied live.
    if (paths.some((p) => /(app|core-plugins|community-plugins|hotkeys)\.json$/.test(p))) needsRestart = true;

    if (needsRestart) new Notice("SelfSync: some synced settings will apply after you reload Obsidian.");
    else this.log(`applied synced config (${paths.length} file(s))`);
  }

  // The status light is a pure function of the FSM phase (see syncstate.ts).
  private renderLight(phase: Phase) {
    const spec = light(phase, `v${this.state.version}`);
    if (this.statusEl) {
      this.statusEl.empty();
      const dot = this.statusEl.createSpan({ text: "●" });
      dot.setAttribute("style", `color:${spec.color};margin-right:4px;`);
      this.statusEl.createSpan({ text: spec.label });
      this.statusEl.setAttribute("aria-label", `${spec.label} — ${spec.tip}`);
    }
  }
  statusText() { return this.machine.get(); }

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
    if (this.connecting || this.unloading) return; // H2: one at a time; never after unload
    this.connecting = true;
    if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.machine.dispatch("connect");
    this.log(`connecting to ${this.settings.serverUrl} as '${this.settings.username}'`);
    try {
      this.ws?.close();
      const token = await this.acquireToken();
      this.api = new HttpTransport(this.settings.serverUrl, token, this.settings.vaultId || "default");

      // Never reconcile against a degraded server: a corrupt index makes the server
      // 503 all sync ops, and acting on the resulting empty manifest could delete
      // local files. Surface the operator action clearly instead of a bare 503.
      const health = await this.api.status();
      if (health.status !== "ready") {
        this.machine.dispatch("error");
        this.lastIssue = `Server vault '${this.settings.vaultId || "default"}' needs repair (${health.detail || health.status}) — run reindex on the server. Not syncing until then.`;
        this.log(this.lastIssue, true);
        this.scheduleReconnect();
        return;
      }

      this.applying = true;
      try { await reconcileAll(this.deps()); } finally { this.applying = false; }
      await this.flushConfigReload();
      this.log(`reconciled → v${this.state.version}`);

      if (this.unloading) return; // H2: torn down while awaiting — don't spin up WS/poll
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
      this.lastIssue = undefined;
      this.machine.dispatch("connected");
      this.settings.lastSyncedAt = Date.now(); void this.saveSettings();
      this.log(`connected @ v${this.state.version}`, true);
    } catch (e: any) {
      this.applying = false;
      this.machine.dispatch("error");
      this.lastIssue = /no password stored/.test(String(e?.message))
        ? "Session needs your password again — use “Set up / switch vault” to re-enter it."
        : `Can't reach the server (${e?.message ?? e}). Retrying…`;
      this.log(`connect FAILED: ${e?.message ?? e}`, true);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
    void this.drainPending(); // flush any edits queued during the initial reconcile
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
      // Cheap incremental check first: only reconcile if the server advanced past
      // our version. Idle polls do one tiny request and stay silent (no log spam,
      // no full re-list). Local edits are handled separately by vault events.
      const delta = await this.api.changes(this.state.version);
      if (delta.upserts.length === 0 && delta.deletes.length === 0) {
        this.machine.dispatch("syncDone"); // reachable + up to date
        return;
      }
      this.machine.dispatch("syncStart");
      const before = this.state.version;
      await reconcileAll(this.deps());
      await this.flushConfigReload();
      if (this.state.version !== before) this.log(`remote change → reconciled (v${before} → v${this.state.version})`);
      this.machine.dispatch("syncDone");
      this.settings.lastSyncedAt = Date.now();
    } catch (e: any) {
      // Any failure (server down, 401, network) means we're NOT up to date: go red
      // and hand recovery to the backoff reconnect (which restarts polling + WS on
      // success). Stop the redundant poll so the two don't retry in parallel.
      this.log(`reconcile FAILED: ${e?.message ?? e}`);
      this.machine.dispatch("error");
      if (this.pollTimer !== undefined) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
      this.scheduleReconnect();
    } finally { this.applying = false; }
    void this.drainPending(); // H1: flush edits queued during this reconcile
  }

  private async onLocalEvent(f: TAbstractFile) {
    if (!this.api || !(f instanceof TFile)) return;
    if (this.applying) { this.pendingLocal.add(f.path); return; } // H1: queue, don't drop
    this.applying = true;
    this.machine.dispatch("syncStart");
    try { await reconcilePath(this.deps(), f.path); this.machine.dispatch("syncDone"); }
    catch (e: any) { this.log(`sync FAILED for ${f.path}: ${e?.message ?? e}`); this.machine.dispatch("error"); }
    finally { this.applying = false; }
    void this.drainPending();
  }

  private async onLocalDelete(path: string) {
    if (!this.api) return;
    if (this.applying) { this.pendingLocal.add(path); return; }
    this.applying = true;
    try { await reconcilePath(this.deps(), path); }
    catch (e: any) { this.log(`delete sync FAILED for ${path}: ${e?.message ?? e}`); }
    finally { this.applying = false; }
    void this.drainPending();
  }

  private async onLocalRename(file: TAbstractFile, oldPath: string) {
    if (!this.api || !(file instanceof TFile)) return;
    if (this.applying) { this.pendingLocal.add(oldPath); this.pendingLocal.add(file.path); return; }
    this.applying = true;
    try { await reconcilePath(this.deps(), oldPath); await reconcilePath(this.deps(), file.path); }
    catch (e: any) { this.log(`rename sync FAILED: ${e?.message ?? e}`); }
    finally { this.applying = false; }
    void this.drainPending();
  }

  async loadSettings() {
    const data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});
    // Fresh, fully-defaulted configSync object (never share the module constant, and
    // backfill any categories added since this vault last saved).
    this.settings.configSync = { ...DEFAULT_CONFIG_SYNC, ...(data.settings?.configSync ?? {}) };
    this.base = new BaseStore(data.base ?? {});
  }
  async saveSettings() { await this.persist(); }
  private async persist() {
    // Never silently swallow a persist failure: a lost base write corrupts the next
    // merge's ancestor, and callers fire this with `void`. Log loudly instead.
    try { await this.saveData({ settings: this.settings, base: this.base.toJSON() }); }
    catch (e: any) { this.log(`WARNING: could not save settings/base: ${e?.message ?? e}`, true); }
  }
}

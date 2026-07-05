import { App, Modal, Notice, Plugin, Platform, MarkdownView, TAbstractFile, TFile, normalizePath, setIcon } from "obsidian";
import { HttpTransport, SharedVaultRef } from "./transport";
import { SyncState, VaultIo, ChunkCache, AppendHandle } from "./sync";
import { BaseStore } from "./base";
import { reconcileAll, reconcilePath, switchTo, SwitchMode, ReconcileDeps, DEFAULT_MAX_SYNC_BYTES, resolveConfigConflict } from "./reconcile";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab } from "./settings";
import { SetupWizardModal } from "./setupwizard";
import { ConfigConflictModal } from "./configconflict";
import { encodeSetupLink } from "./connstr";
import { SyncMachine, Phase, light } from "./syncstate";
import { shouldSync, pluginIdOf, DEFAULT_CONFIG_SYNC } from "./configsync";
import { androidModelFromUA, platformDisplayName } from "./devicename";

// Polls between forced full config-aware reconciles (poll interval is 4s → ~32s). Local config
// changes fire no vault event and don't advance the server version, so only a periodic full
// reconcile catches them; this bounds the detection latency without re-listing every poll.
const CONFIG_SCAN_EVERY_POLLS = 8;
// Coalesce the burst of "raw" events a single config change emits before reconciling.
const RAW_DEBOUNCE_MS = 600;
// Ignore a "raw" event for a path WE just wrote (the change echoing back) within this window.
const SELF_WRITE_WINDOW_MS = 4000;

class ObsidianVaultIo implements VaultIo {
  // Desktop-only streamed writer (Electron Node fs); left undefined on mobile so the
  // reconciler falls back to buffered writes there (Obsidian's adapter has no incremental
  // binary write). Assigned only when Node's require is actually available.
  appendWrite?: (path: string) => Promise<AppendHandle>;
  private lastCfgCount = -1; // last-logged config-scope size; log only on change (list() runs every reconcile)
  constructor(private plugin: NewLiveSyncPlugin) {
    if (Platform.isDesktop && (window as unknown as { require?: unknown }).require) {
      this.appendWrite = (path: string) => this.openAppend(path);
    }
  }

  // Stream a file to disk via Node fs: append to a temp file, fsync, then atomically rename.
  private async openAppend(path: string): Promise<AppendHandle> {
    const noop: AppendHandle = { append: async () => {}, close: async () => {}, abort: async () => {} };
    if (!this.passes(path)) return noop; // excluded paths are never written locally
    const req = (window as unknown as { require: (m: string) => any }).require;
    const fs = req("fs");
    const nodePath = req("path");
    const adapter = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
    const base = adapter.getBasePath ? adapter.getBasePath() : (adapter.basePath ?? "");
    const abs = nodePath.join(base, normalizePath(path));
    await fs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
    const tmp = abs + ".selfsync-part";
    const fh = await fs.promises.open(tmp, "w");
    return {
      append: async (bytes: Uint8Array) => { await fh.write(bytes); },
      close: async () => { await fh.sync(); await fh.close(); await fs.promises.rename(tmp, abs); this.plugin.onConfigWritten(path); },
      abort: async () => { try { await fh.close(); } catch { /* already closed */ } try { await fs.promises.rm(tmp, { force: true }); } catch { /* gone */ } },
    };
  }

  // The single selective-sync gate: notes always pass; `.obsidian/` paths pass only
  // per the config selection, and SelfSync's own folder never passes (see configsync).
  private passes(path: string): boolean {
    return shouldSync(path, this.plugin.settings.configSync, this.plugin.selfFolderId());
  }

  async list() {
    const m = new Map<string, { mtime: number; size: number }>();
    // getFiles() returns notes/attachments only (never .obsidian); passes() is a
    // belt-and-suspenders guard.
    for (const f of this.plugin.app.vault.getFiles()) {
      if (this.passes(f.path)) m.set(f.path, { mtime: f.stat.mtime, size: f.stat.size });
    }
    if (this.plugin.settings.configSync.enabled) {
      await this.enumerateConfig(".obsidian", m);
      const cfg = [...m.keys()].filter((k) => k.startsWith(".obsidian/")).length;
      // Log the scope only when it CHANGES — list() runs on every reconcile (incl. the periodic
      // config scan), so logging every time would spam. A changed count is the useful signal.
      if (cfg !== this.lastCfgCount) { this.plugin.log(`config sync ON — ${cfg} .obsidian file(s) in scope`); this.lastCfgCount = cfg; }
    }
    return m;
  }

  // Recursively enumerate the hidden .obsidian/ config surface via the low-level
  // adapter (getFiles() can't see it), keeping only paths that pass the filter.
  private async enumerateConfig(dir: string, m: Map<string, { mtime: number; size: number }>): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    let listing: { files: string[]; folders: string[] };
    try { listing = await adapter.list(dir); } catch { return; }
    for (const file of listing.files) {
      if (!this.passes(file)) continue;
      try { const st = await adapter.stat(file); m.set(file, { mtime: st?.mtime ?? 0, size: st?.size ?? 0 }); } catch { /* skip unreadable */ }
    }
    for (const folder of listing.folders) await this.enumerateConfig(folder, m);
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(normalizePath(path)));
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    if (!this.passes(path)) {
      // A synced config file this device hasn't opted into — dropped by design. Log it so
      // "plugins aren't syncing" is diagnosable: enable the matching category on THIS device.
      if (path.startsWith(".obsidian/")) this.plugin.log(`config write skipped — '${path}' isn't in this device's sync selection (enable the matching category here to receive it)`);
      return;
    }
    const p = normalizePath(path);
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !(await this.plugin.app.vault.adapter.exists(dir))) await this.plugin.app.vault.adapter.mkdir(dir);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.plugin.app.vault.adapter.writeBinary(p, buf);
    this.plugin.onConfigWritten(path); // best-effort live-reload of the affected surface
  }
  async remove(path: string): Promise<void> {
    if (!this.passes(path)) return;
    this.plugin.markConfigSelfWrite(path); // suppress the "raw" echo of our own removal
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
  private ribbonEl?: HTMLElement; // state-colored ribbon icon (the sync indicator on mobile)
  statusListener?: () => void;    // settings tab registers this to live-refresh its status card
  private editorActionEls = new Set<HTMLElement>(); // optional in-editor indicators (opt-in)
  private editorViews = new WeakSet<MarkdownView>();
  private logs: string[] = [];
  private machine = new SyncMachine((phase) => this.renderLight(phase));
  private reconnectTimer?: number;
  private pollTimer?: number;
  private configScanCountdown = 1; // polls until the next forced full config-aware reconcile (see onRemoteChanged)
  private rawBuffer = new Set<string>();      // config paths from "raw" events, coalesced before reconcile
  private rawDebounce?: number;               // debounce timer for the raw-event burst
  private recentSelfWrites = new Map<string, number>(); // config path -> when WE wrote it, to ignore the echo
  private backoff = 3000;
  private unloading = false;
  private connecting = false;               // H2: only one reconnect() in flight at a time
  private pendingLocal = new Set<string>(); // H1: local edits that arrived mid-sync; drained after
  private skipNotified = new Set<string>(); // paths we've already warned are too large (notice once)
  private lastIssue?: string;               // human reason for the current non-idle state (shown on the card)
  getLastIssue(): string | undefined { return this.lastIssue; }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NewLiveSyncSettingTab(this.app, this));

    // ONE state indicator per platform — two would be redundant (the anti-pattern we're
    // avoiding): the quiet status-bar item on desktop (click → log), the ribbon icon on
    // mobile (which has no status bar). An optional in-editor indicator is opt-in below.
    if (Platform.isMobile) {
      this.ribbonEl = this.addRibbonIcon("refresh-cw", "SelfSync", () => this.showLog());
    } else {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass("mod-clickable");
      this.statusEl.onClickEvent(() => this.showLog());
    }
    this.renderLight(this.machine.get()); // initial: off

    this.addCommand({ id: "setup", name: "Set up / switch vault", callback: () => this.openSetup() });
    this.addCommand({ id: "show-log", name: "Show sync log", callback: () => this.showLog() });
    this.addCommand({ id: "clear-log", name: "Clear sync log", callback: () => this.clearLogs() });
    this.addCommand({ id: "reconnect", name: "Reconnect now", callback: () => this.reconnect() });

    this.registerEvent(this.app.vault.on("modify", (f) => this.onLocalEvent(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onLocalEvent(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onLocalDelete(f.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onLocalRename(file, oldPath)));
    // Event-driven config sync: the TFile events above never fire for hidden `.obsidian/` files,
    // but the low-level "raw" event does (desktop file-system watcher). This makes a plugin/theme/
    // settings add/edit/remove sync the moment it happens, not on the next poll. "raw" is not in
    // the public typings + is unreliable on mobile, so it's feature-detected and the periodic
    // config scan (onRemoteChanged) stays as the mobile fallback + safety net.
    try {
      const vaultEvents = this.app.vault as unknown as { on(name: string, cb: (path: string) => void): import("obsidian").EventRef };
      this.registerEvent(vaultEvents.on("raw", (path: string) => this.onRawConfigEvent(path)));
    } catch { /* "raw" unavailable on this build — periodic scan covers it */ }
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.applyEditorStatus()));

    this.log("plugin loaded");
    this.app.workspace.onLayoutReady(() => {
      this.applyEditorStatus();
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
    // Popups are reserved for rare, action-worthy events (conflicts, data-safety, save
    // failures) via notice=true. Sync/connection state is shown by the status icon + this
    // log — never by a toast, so a flaky connection can't spam notices.
    if (notice) new Notice(`SelfSync: ${msg}`);
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

  // --- config adjudication (D00xx): divergent/removed `.obsidian/` files are never auto-
  // resolved; they queue here for the user to decide which side wins. See ConfigConflictModal.
  getConfigConflicts(): string[] { return this.settings.configConflicts; }
  openConfigConflicts() { new ConfigConflictModal(this.app, this).open(); }
  // Which sides currently hold a conflicting config path — so the adjudication UI can say
  // "removed here / present on the server" rather than a bare choice.
  async configConflictSides(path: string): Promise<{ local: boolean; remote: boolean }> {
    let local = false;
    try { await this.io.read(path); local = true; } catch { local = false; }
    let remote = false;
    try { remote = (await this.api?.fileMeta(path)) != null; } catch { remote = false; }
    return { local, remote };
  }
  private recordConfigConflict(path: string, reason: string): void {
    if (this.settings.configConflicts.includes(path)) return; // already queued
    this.settings.configConflicts.push(path);
    void this.saveSettings();
    this.log(`config differs across devices: '${path}' (${reason}) — kept as-is on each device; resolve in SelfSync settings → Config differences`, true);
    this.statusListener?.();
  }
  // Apply the user's adjudication for one path, then drop it from the queue.
  async resolveConfigConflict(path: string, choice: "local" | "remote"): Promise<void> {
    await resolveConfigConflict(this.deps(), path, choice);
    this.settings.configConflicts = this.settings.configConflicts.filter((p) => p !== path);
    await this.saveSettings();
    this.statusListener?.();
  }

  // Local file size (0 if unknown/absent) — lets reconcilePath apply the size gate on
  // the event path, not just the batch path.
  private localSizeOf(path: string): number {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f.stat.size : 0;
  }

  // H1: drain local edits that were queued because they fired while a sync was running.
  // Each reconcilePath re-guards `applying`; loop until the queue empties (new edits may
  // arrive during draining and are picked up).
  private async drainPending() {
    while (!this.applying && this.api && !this.unloading && this.pendingLocal.size > 0) {
      const path = this.pendingLocal.values().next().value as string;
      this.pendingLocal.delete(path);
      this.applying = true;
      this.machine.dispatch("syncStart");
      try { await reconcilePath(this.deps(), path, this.localSizeOf(path)); this.machine.dispatch("syncDone"); }
      catch (e: any) { this.log(`queued sync FAILED for ${path}: ${e?.message ?? e}`); this.machine.dispatch("error"); }
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
    // Token-only mode (storePassword off): no password at rest, so a dead token means the
    // user must re-authenticate — open setup rather than fail silently.
    if (!this.settings.password) {
      this.openSetup();
      throw new Error("session expired — please re-enter your password in setup");
    }
    const token = await HttpTransport.login(url, this.settings.username, this.settings.password);
    // Drop the plaintext password from disk if the user opted into token-only storage.
    if (!this.settings.storePassword) this.settings.password = "";
    this.setAuthToken(token); // persists the token (and the cleared password)
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
    this.log("disconnected (local files kept)"); // the settings UI reflects it — no toast needed
  }

  // Sign out: forget credentials + token, drop to Not-set-up.
  async signOut() {
    this.settings.authToken = undefined;
    this.settings.password = "";
    await this.disconnect();
  }

  // A shareable setup link for another device (server + username only, never password).
  addDeviceLink(): string {
    return encodeSetupLink({ server: this.settings.serverUrl, user: this.settings.username, vault: this.settings.vaultId });
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
  // Switching which remote vault this local vault syncs to is a one-time transition, not
  // a persistent setting: the caller (the switch modal) picks the resolution and it is
  // applied ONCE on the next reconnect, then forgotten. `merge` is the safe default union.
  private pendingSwitchMode?: SwitchMode;
  async switchToVault(name: string, mode: SwitchMode = "merge", owner = "", readOnly = false): Promise<void> {
    this.settings.vaultId = name;
    this.settings.vaultOwner = owner || undefined; // empty = own vault
    this.settings.vaultReadOnly = readOnly;
    await this.saveSettings();
    this.pendingSwitchMode = mode;
    await this.reconnect();
  }
  // Vaults shared WITH this account (owned by others) — offered in the switch modal.
  async listSharedVaults(): Promise<SharedVaultRef[]> {
    const token = await this.acquireToken();
    return HttpTransport.listShared(this.settings.serverUrl, token);
  }
  // Does this local vault hold any syncable content (notes + any enabled synced config)?
  // io.list() is already selective-sync-filtered, so this excludes SelfSync's own files.
  async hasLocalData(): Promise<boolean> {
    try { return (await this.io.list()).size > 0; } catch { return false; }
  }

  // --- selective config sync: guarded, best-effort live reload -----------------
  // The IO records each synced .obsidian/ file here; we flush once per reconcile so a
  // plugin is reloaded at most once even if several of its files changed.
  private pendingReload = new Set<string>();
  onConfigWritten(path: string) { this.pendingReload.add(path); this.markConfigSelfWrite(path); } // mark: ignore the raw echo

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

  // The status light is a pure function of the FSM phase (see syncstate.ts). It drives
  // the one platform indicator, any opt-in editor indicators, and (if the settings tab is
  // open) its live status card — all from a single source of truth, never diverging.
  private renderLight(phase: Phase) {
    const spec = light(phase, `v${this.state.version}`);
    // Vary the GLYPH with state too, so it isn't conveyed by color alone (colorblind users).
    const glyph = phase === "idle" ? "check"
      : phase === "offline" ? "alert-triangle"
      : phase === "off" ? "circle-slash"
      : "refresh-cw"; // connecting / syncing
    if (this.statusEl) {
      this.statusEl.empty();
      const dot = this.statusEl.createSpan({ text: "●" });
      dot.setAttribute("style", `color:${spec.color};margin-right:4px;`);
      this.statusEl.createSpan({ text: spec.label });
      this.statusEl.setAttribute("aria-label", `${spec.label} — ${spec.tip}`);
    }
    if (this.ribbonEl) {
      this.ribbonEl.style.color = spec.color; // SVG uses currentColor -> tints the icon
      setIcon(this.ribbonEl, glyph);
      this.ribbonEl.setAttribute("aria-label", `${spec.label} — ${spec.tip}`);
    }
    for (const el of this.editorActionEls) {
      if (!el.isConnected) { this.editorActionEls.delete(el); continue; } // view closed — prune
      el.style.color = spec.color;
      setIcon(el, glyph);
      el.setAttribute("aria-label", `${spec.label} — ${spec.tip}`);
    }
    this.statusListener?.(); // refresh the settings status card if it's on screen
  }

  // Opt-in in-editor indicator: a state-tinted action button on the active markdown view.
  // Off by default; added lazily per view and pruned automatically when views close.
  applyEditorStatus() {
    // Opt-in on both platforms (off by default — screen space is at a premium on mobile).
    // When on, an icon shows in the open note's header; on mobile that's the way to get a
    // visible indicator, since the ribbon icon sits in the left sidebar drawer.
    if (!this.settings.editorStatus) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || this.editorViews.has(view)) { this.renderLight(this.machine.get()); return; }
    this.editorViews.add(view);
    this.editorActionEls.add(view.addAction("refresh-cw", "SelfSync sync status", () => this.showLog()));
    this.renderLight(this.machine.get());
  }
  setEditorStatus(on: boolean) {
    this.settings.editorStatus = on;
    void this.saveSettings();
    if (on) { this.applyEditorStatus(); return; }
    for (const el of this.editorActionEls) el.remove();
    this.editorActionEls.clear();
    this.editorViews = new WeakSet();
  }
  statusText() { return this.machine.get(); }

  // ---- reconcile deps ----
  // The name used when the Device name field is left blank. Prefer a friendly label over
  // navigator.platform (which is "Linux aarch64" on Android → the useless "Linuxaarch64").
  // Shown as muted placeholder text in settings so the user sees what will be used.
  autoDeviceName(): string {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const android = androidModelFromUA(ua); // e.g. "Pixel 9"; null on desktop or a frozen "K"
    if (android) return android;
    if (Platform.isIosApp) return Platform.isPhone ? "iPhone" : "iPad";
    if (Platform.isAndroidApp) return "Android";
    if (Platform.isMacOS) return "Mac";
    if (Platform.isWin) return "Windows";
    if (Platform.isLinux) return "Linux";
    const plat = (navigator as unknown as { platform?: string }).platform ?? "";
    return platformDisplayName(plat) || "device"; // strip arch tokens — never surface "Linux aarch64"
  }
  private deviceLabel(): string {
    return this.settings.deviceName || this.autoDeviceName();
  }
  private deps(): ReconcileDeps {
    return {
      api: this.api!, io: this.io, base: this.base, cache: this.cache, state: this.state,
      device: this.deviceLabel(), strategy: this.settings.conflictStrategy,
      readOnly: this.settings.vaultReadOnly,
      // Same selective-sync gate the io uses: a filtered `.obsidian/` path is skipped in
      // reconcile too, so a device that opted out never records a base for it (no phantom delete).
      accepts: (p) => shouldSync(p, this.settings.configSync, this.selfFolderId()),
      onReadOnly: (p) => this.log(`read-only shared vault: local change to '${p}' won't sync`),
      onConflict: (p, c) => this.log(`conflict on ${p} → kept your copy as ${c}`, true),
      onConfigConflict: (p, reason) => this.recordConfigConflict(p, reason),
      onFileError: (p, e) => this.log(`couldn't sync '${p}': ${e instanceof Error ? e.message : String(e)} — skipped it, other files continue`),
      onBaseChanged: () => { void this.persist(); },
      onGuard: (p) => this.log(`server manifest empty but '${p}' is in our history — NOT deleting it (possible server data loss)`, true),
      onSkip: (p, bytes) => {
        if (this.skipNotified.has(p)) { this.log(`skipped '${p}' — too large to sync`); return; } // notice once/session
        this.skipNotified.add(p);
        this.log(`skipped '${p}' — too large to sync (${Math.round(bytes / 1048576)} MB, over the ${Math.round(DEFAULT_MAX_SYNC_BYTES / 1048576)} MB limit)`, true);
      },
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
      this.api = new HttpTransport(this.settings.serverUrl, token, this.settings.vaultId || "default", this.settings.vaultOwner || "");

      // Never reconcile against a degraded server: a corrupt index makes the server
      // 503 all sync ops, and acting on the resulting empty manifest could delete
      // local files. Surface the operator action clearly instead of a bare 503.
      const health = await this.api.status();
      if (health.status !== "ready") {
        this.machine.dispatch("error");
        this.lastIssue = `This vault's data on the server is damaged and can't sync safely. Someone with server access needs to repair it (run “reindex” on the server). Not syncing until then.`;
        this.log(this.lastIssue); // red status icon + the settings status card show it — no toast (would repeat every retry)
        this.scheduleReconnect();
        return;
      }

      // A pending vault switch applies its chosen resolution ONCE, then reverts to normal
      // reconcile; captured-and-cleared up front so a failed switch never silently
      // re-applies an authoritative overwrite on a later reconnect.
      const switchMode = this.pendingSwitchMode; this.pendingSwitchMode = undefined;
      this.applying = true;
      try {
        if (switchMode) await switchTo(this.deps(), switchMode);
        else await reconcileAll(this.deps());
      } finally { this.applying = false; }
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
      this.log(`connected @ v${this.state.version}`); // status bar/ribbon show it — no toast
    } catch (e: any) {
      this.applying = false;
      this.machine.dispatch("error");
      this.lastIssue = /no password stored/.test(String(e?.message))
        ? "Session needs your password again — use “Set up / switch vault” to re-enter it."
        : `Can't reach the server (${e?.message ?? e}). Retrying…`;
      this.log(`connect FAILED: ${e?.message ?? e}`); // goes red in the status bar; no toast on each retry
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
      // no full re-list). Local NOTE edits are handled separately by vault events.
      //
      // But local CONFIG changes (.obsidian: adding/removing a plugin, editing settings)
      // fire NO vault event (config files aren't TFiles) and don't advance the server
      // version — so the incremental check would never notice them, and they'd sync only
      // at reconnect. When config sync is on, force a full reconcile every N polls so a
      // local config change is picked up (and pushed) within ~N*pollInterval, not never.
      const forceConfigScan = this.settings.configSync.enabled && --this.configScanCountdown <= 0;
      if (forceConfigScan) this.configScanCountdown = CONFIG_SCAN_EVERY_POLLS;
      const delta = await this.api.changes(this.state.version);
      // Short-circuit only when nothing changed AND the server version matches ours (and no
      // config scan is due). A version MISMATCH with no upserts/deletes means the server
      // manifest was rebuilt/rewound (e.g. reindex reset the version, or a delete burst was
      // compacted out of the tombstone window) — fall through to a full reconcile.
      if (!forceConfigScan && delta.upserts.length === 0 && delta.deletes.length === 0 && delta.version === this.state.version) {
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

  // A "raw" adapter event for a hidden `.obsidian/` file (desktop). Filter to config paths we
  // sync, drop the echo of our own writes, then coalesce the burst and reconcile the changed
  // paths — so a plugin/theme/settings add/edit/remove syncs immediately, not on the next poll.
  private onRawConfigEvent(path: string) {
    if (!this.api || this.unloading) return;
    if (!path.startsWith(".obsidian/")) return;                    // notes are handled by TFile events
    if (!this.settings.configSync.enabled) return;
    if (!shouldSync(path, this.settings.configSync, this.selfFolderId())) return; // out of scope / self folder
    const wrote = this.recentSelfWrites.get(path);
    if (wrote !== undefined && Date.now() - wrote < SELF_WRITE_WINDOW_MS) return;  // our own write echoing back
    this.rawBuffer.add(path);
    if (this.rawDebounce !== undefined) window.clearTimeout(this.rawDebounce);
    this.rawDebounce = window.setTimeout(() => void this.flushRawConfig(), RAW_DEBOUNCE_MS);
  }

  private async flushRawConfig() {
    this.rawDebounce = undefined;
    const paths = [...this.rawBuffer]; this.rawBuffer.clear();
    if (!this.api || this.unloading || paths.length === 0) return;
    // Mid-sync: queue onto the same drain the note events use, so we never reconcile re-entrantly.
    if (this.applying) { for (const p of paths) this.pendingLocal.add(p); return; }
    this.applying = true;
    this.machine.dispatch("syncStart");
    try {
      for (const p of paths) await reconcilePath(this.deps(), p, this.localSizeOf(p));
      await this.flushConfigReload();
      this.machine.dispatch("syncDone");
      this.settings.lastSyncedAt = Date.now();
    } catch (e: any) { this.log(`config change sync FAILED: ${e?.message ?? e}`); this.machine.dispatch("error"); }
    finally { this.applying = false; }
    void this.drainPending();
  }

  // Record that WE just wrote/removed a config path, so its "raw" echo is ignored. Prune the
  // stale entries opportunistically so the map can't grow without bound.
  markConfigSelfWrite(path: string) {
    const now = Date.now();
    this.recentSelfWrites.set(path, now);
    if (this.recentSelfWrites.size > 64) {
      for (const [p, t] of this.recentSelfWrites) if (now - t > SELF_WRITE_WINDOW_MS) this.recentSelfWrites.delete(p);
    }
  }

  private async onLocalEvent(f: TAbstractFile) {
    if (!this.api || !(f instanceof TFile)) return;
    if (this.applying) { this.pendingLocal.add(f.path); return; } // H1: queue, don't drop
    this.applying = true;
    this.machine.dispatch("syncStart");
    try { await reconcilePath(this.deps(), f.path, f.stat.size); this.machine.dispatch("syncDone"); }
    catch (e: any) { this.log(`sync FAILED for ${f.path}: ${e?.message ?? e}`); this.machine.dispatch("error"); }
    finally { this.applying = false; }
    void this.drainPending();
  }

  private async onLocalDelete(path: string) {
    if (!this.api) return;
    if (this.applying) { this.pendingLocal.add(path); return; }
    this.applying = true;
    this.machine.dispatch("syncStart");
    try { await reconcilePath(this.deps(), path); this.machine.dispatch("syncDone"); }
    catch (e: any) { this.log(`delete sync FAILED for ${path}: ${e?.message ?? e}`); this.machine.dispatch("error"); }
    finally { this.applying = false; }
    void this.drainPending();
  }

  private async onLocalRename(file: TAbstractFile, oldPath: string) {
    if (!this.api || !(file instanceof TFile)) return;
    if (this.applying) { this.pendingLocal.add(oldPath); this.pendingLocal.add(file.path); return; }
    this.applying = true;
    this.machine.dispatch("syncStart");
    try {
      await reconcilePath(this.deps(), oldPath);                    // old path removed
      await reconcilePath(this.deps(), file.path, file.stat.size); // new path created
      this.machine.dispatch("syncDone");
    } catch (e: any) { this.log(`rename sync FAILED: ${e?.message ?? e}`); this.machine.dispatch("error"); }
    finally { this.applying = false; }
    void this.drainPending();
  }

  async loadSettings() {
    const data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});
    // Fresh, fully-defaulted configSync object (never share the module constant, and
    // backfill any categories added since this vault last saved).
    this.settings.configSync = { ...DEFAULT_CONFIG_SYNC, ...(data.settings?.configSync ?? {}) };
    // Fresh array (never share the module constant's []) — the adjudication queue is mutated in place.
    this.settings.configConflicts = [...(data.settings?.configConflicts ?? [])];
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

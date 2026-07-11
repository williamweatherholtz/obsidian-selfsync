import { App, Modal, Notice, Plugin, Platform, MarkdownView, TAbstractFile, TFile, normalizePath, setIcon } from "obsidian";
import { HttpTransport, SharedVaultRef, SharePerm, ShareLinkInfo, VaultShares } from "./transport";
import { SyncState, VaultIo, ChunkCache, AppendHandle, SyncApi } from "./sync";
import { BaseStore, originalOfConflictCopy } from "./base";
import { reconcileAll, reconcileDelta, reconcileLocalConfig, reconcilePath, switchTo, SwitchMode, ReconcileDeps, DeleteRateGuard, DEFAULT_MAX_SYNC_BYTES, MAX_PULL_RETRIES, resolveConfigConflict } from "./reconcile";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab } from "./settings";
import { SetupWizardModal } from "./setupwizard";
import { ConfigConflictModal } from "./configconflict";
import { NoteConflictModal } from "./noteconflict";
import { encodeSetupLink, normalizeServer } from "./connstr";
import { encodeShareLink, parseShareLink } from "./sharelink";
import { Phase, light, isWsStale } from "./syncstate";
import { CLIENT_API_VERSION } from "./protocol";
import { SyncEngine } from "./syncengine";
import { shouldSync, pluginIdOf, DEFAULT_CONFIG_SYNC } from "./configsync";
import { isSafeVaultPath } from "./pathsafe";
import { androidModelFromUA, platformDisplayName, usableModel } from "./devicename";

// Max wall-clock between forced full config-aware reconciles. Local config changes fire no vault
// event and don't advance the server version, so only a periodic full reconcile catches them (the
// mobile fallback + safety net; desktop also has the live `raw` path). A wall-clock interval —
// rather than a poll COUNT — keeps detection latency stable regardless of how the poll cadence
// changes, and reads as an actual latency bound instead of an arbitrary tick count.
// Periodic full-config reconcile cadence — the mobile fallback for config edits (which fire no
// reliable `raw` event). Raised 32s → 120s: the scan re-hashes local files, so a tight cadence
// burns battery on a large mobile vault; config changes are infrequent so ~2-min latency is fine,
// and desktop gets instant config sync via the raw watcher regardless. (R11-#3; a config-ONLY scan
// that skips re-hashing notes is the deeper fix, planned for the config-sync round.)
const CONFIG_SCAN_INTERVAL_MS = 120_000;
// Mobile has no streamed I/O (ObsidianVaultIo.appendWrite is desktop-only), so a synced file is
// buffered whole in the WebView heap (~2× its size during fetch+concat). Cap the buffered size well
// below the desktop ceiling so a mid-size attachment can't OOM-crash the app; bigger files sync on
// desktop and the peer's copy is never endangered (skipped, not deleted). (R11-#2)
const MOBILE_MAX_SYNC_BYTES = 50 * 1024 * 1024;
// Whole-vault re-hash cadence (R13): the config scan above is now CONFIG-ONLY (cheap), so a LOCAL
// note edit whose vault event was dropped (external/cloud write, missed event) is caught by this
// slower full pass instead of a costly full re-hash every config tick. 15 min balances safety vs
// battery. (A reconnect also does a full pass; this covers a device that stays connected for hours.)
const FULL_SCAN_INTERVAL_MS = 15 * 60 * 1000;
// Poll cadence (perf, Finding 3a): the WebSocket delivers remote changes INSTANTLY, so while it's
// healthy the poll is only a liveness backstop and runs slowly (spare the mobile radio — 4s was
// ~900 needless wakeups/hour). It upshifts to the fast cadence the moment the WS drops/closes so a
// WS-less client still converges quickly.
const POLL_ACTIVE_MS = 4000;        // WS down/unavailable — the poll is the primary change detector
const POLL_IDLE_MS = 60 * 1000;     // WS healthy — liveness backstop only
// WS half-open liveness (crit-round residual): the server sends an app heartbeat every ~30s. If the
// client sees NO frame (heartbeat or change) for this long, the socket is silently dead → re-dial.
const WS_STALE_MS = 75 * 1000;      // ~2.5 missed heartbeats
const WS_LIVENESS_CHECK_MS = 20 * 1000;
// Coalesce the burst of "raw" events a single config change emits before reconciling.
const RAW_DEBOUNCE_MS = 600;
// Ignore a "raw" event for a path WE just wrote (the change echoing back) within this window.
const SELF_WRITE_WINDOW_MS = 4000;

// Best-effort fsync of a freshly-opened handle (file or directory), ALWAYS closing it. `open()` may
// throw (mobile / unsupported dir-fsync) and `.sync()` may throw (I/O error) — either way we swallow
// it (the content is already written; this only upgrades durability) but the `finally` guarantees the
// handle is closed so a sync-error path can't leak a file descriptor (R24). No-op if open() throws.
async function fsyncHandle(open: () => Promise<{ sync(): Promise<void>; close(): Promise<void> }>): Promise<void> {
  let fh: { sync(): Promise<void>; close(): Promise<void> } | undefined;
  try { fh = await open(); await fh.sync(); }
  catch { /* best-effort: durability upgrade only, never fatal */ }
  finally { try { await fh?.close(); } catch { /* already closed / never opened */ } }
}

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
    // An excluded path should never reach the writer (reconcile's accepts() gates it with the same
    // shouldSync as passes()). If it ever does, FAIL LOUD (R18): a silent no-op handle would let
    // streamFileToDisk's hash — computed from the FETCHED bytes, not what was persisted — pass, set
    // base for a file that was never written to disk, and then delete-remote it fleet-wide on the next
    // reconcile. Throwing is isolated per-file (onFileError); a silent no-op is a latent data-loss trap.
    if (!this.passes(path)) throw new Error(`refusing to stream-write an excluded path: '${path}'`);
    // R23 SEC: reject a server-supplied path that could escape the vault (traversal/absolute). Fail
    // loud (per-file isolated via onFileError) rather than write outside the vault via unsandboxed fs.
    if (!isSafeVaultPath(path)) throw new Error(`refusing to write an unsafe/traversing path: '${path}'`);
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
      close: async () => {
        await fh.sync(); await fh.close(); await fs.promises.rename(tmp, abs);
        // Fsync the PARENT DIRECTORY so the rename's directory entry is durable, not just the file
        // contents (R22-DI: the server's atomic_write/write_mirror already do this). Without it, a
        // power loss can land the persisted base map (data.json) on disk while the rename is still in
        // the page cache — on reboot the note is absent but base==remote, so decide() yields an
        // UNGUARDED delete-remote that propagates the loss fleet-wide. Best-effort: opening a dir as a
        // file works on Unix; on Windows/mobile it throws harmlessly (rename durability differs there).
        await fsyncHandle(() => fs.promises.open(nodePath.dirname(abs)));
        this.plugin.onConfigWritten(path);
      },
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
    // R24 SEC: guard the READ sink too (R23 covered only write/remove). A traversing server-supplied
    // path — e.g. a tombstone `deletes:[{path:"../../../.ssh/id_rsa"}]` — resolves to a local read whose
    // `..` escapes the vault via the adapter; that read then feeds decide()→push, EXFILTRATING the
    // out-of-vault file to a malicious/compromised server. Fail loud (per-file isolated) so the read
    // never happens and decide() sees the file as absent.
    if (!isSafeVaultPath(path)) throw new Error(`refusing to read an unsafe/traversing path: '${path}'`);
    return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(normalizePath(path)));
  }
  async exists(path: string): Promise<boolean> {
    // A traversing path is treated as "not present" — never probe outside the vault (R24 SEC).
    if (!isSafeVaultPath(path)) return false;
    return this.plugin.app.vault.adapter.exists(normalizePath(path));
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    // R23 SEC: reject a traversing/absolute server-supplied path before touching the FS (see openAppend).
    if (!isSafeVaultPath(path)) throw new Error(`refusing to write an unsafe/traversing path: '${path}'`);
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
    // R23-DI: fsync the note (and its parent dir) BEFORE returning so it is durable before the caller
    // records base + persists data.json. Round 8 gave the ≥8 MiB STREAMED path this guarantee; the
    // buffered path (all small notes / config / conflict copies on desktop) lacked it, leaving the same
    // window: base persisted while the note sits in the page cache → on crash the note is absent but
    // base==remote → unguarded delete-remote fleet-wide. Best-effort, desktop-only (Obsidian's adapter
    // and mobile expose no fsync — mobile remains a documented residual).
    await this.fsyncDurable(p);
    this.plugin.onConfigWritten(path); // best-effort live-reload of the affected surface
  }
  // Desktop-only best-effort fsync of a vault-relative file + its parent directory, mirroring the
  // server's atomic_write/write_mirror durability bar. No-op (silently) on mobile / when Node fs is
  // unavailable, and swallows errors — the file content is already written; this only upgrades its
  // durability, so a failure here must never abort the write.
  private async fsyncDurable(relPath: string): Promise<void> {
    const require = (window as unknown as { require?: (m: string) => any }).require;
    if (!Platform.isDesktop || !require) return;
    try {
      const fs = require("fs"); const nodePath = require("path");
      const adapter = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
      const base = adapter.getBasePath ? adapter.getBasePath() : (adapter.basePath ?? "");
      const abs = nodePath.join(base, relPath);
      await fsyncHandle(() => fs.promises.open(abs, "r+")); // fsync the note contents
      await fsyncHandle(() => fs.promises.open(nodePath.dirname(abs))); // and its parent dir entry
    } catch { /* Node fs unavailable — mobile fallback, documented residual */ }
  }
  async remove(path: string): Promise<void> {
    // R23 SEC: never let a traversing server-supplied path drive a local delete outside the vault.
    if (!isSafeVaultPath(path)) throw new Error(`refusing to remove an unsafe/traversing path: '${path}'`);
    if (!this.passes(path)) return;
    this.plugin.markConfigSelfWrite(path); // suppress the "raw" echo of our own removal
    const p = normalizePath(path);
    if (!(await this.plugin.app.vault.adapter.exists(p))) return;
    // SEC-DATA (audit): a sync-driven deletion goes to the vault's `.trash`, NOT a hard unlink. The
    // server is the most likely thing to be compromised on an internet-facing deployment; if a
    // malicious/buggy server ever drives a mass delete (e.g. paced tombstones), the user can RECOVER
    // from .trash instead of losing data irrecoverably. Fall back to a hard remove only if trashing
    // is unavailable on this adapter.
    const adapter = this.plugin.app.vault.adapter as unknown as { trashLocal?: (p: string) => Promise<void>; remove: (p: string) => Promise<void> };
    if (adapter.trashLocal) { try { await adapter.trashLocal(p); return; } catch { /* fall through to hard remove */ } }
    await adapter.remove(p);
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

// The sync-server client the plugin talks to: the reconcile SyncApi plus the two transport extras
// main.ts uses directly. Narrowed to an interface (not the concrete HttpTransport) so tests can
// inject a fake via buildApi() — the seam that makes the orchestration wiring testable.
export type ApiClient = SyncApi & {
  connectWs(onChanged: () => void): WebSocket | null;
  status(): Promise<{ status: string; detail: string; version: number; apiVersion?: number }>;
};

export default class NewLiveSyncPlugin extends Plugin {
  settings!: NewLiveSyncSettings;
  private api?: ApiClient;
  private ws?: WebSocket;
  private io!: VaultIo; // set in onload via buildIo() (injectable for tests)
  private state: SyncState = { version: 0 };
  private base = new BaseStore();
  private cache: ChunkCache = new Map();

  // --- observability + connection lifecycle ---
  // The OPERATIONAL state now lives in one authoritative machine (syncengine.ts): a serial event
  // queue with run-to-completion semantics. It replaces the old scattered flags (applying/
  // connecting/remoteDirty/pendingLocal) + the six duplicated try/finally/drain blocks — those
  // races are structurally impossible when there's one queue, one drain site, one recovery path.
  // Vault/WS/poll events are just PRODUCERS that enqueue; the reconcile/connect logic is injected
  // as EFFECTS; the status light is a pure PROJECTION of the engine's phase (renderLight).
  private engine!: SyncEngine; // created in onload (its effects close over `this`)
  private statusEl?: HTMLElement;
  private ribbonEl?: HTMLElement; // state-colored ribbon icon (the sync indicator on mobile)
  statusListener?: () => void;    // settings tab registers this to live-refresh its status card
  settingsRefresh?: () => void;   // settings tab registers this to re-render (e.g. when the conflict count changes)
  private editorActionEls = new Set<HTMLElement>(); // optional in-editor indicators (opt-in)
  private editorViews = new WeakSet<MarkdownView>();
  private logs: string[] = [];
  private reconnectTimer?: number;
  private pollTimer?: number;
  private lastConfigScanAt = 0; // wall-clock ms of the last CONFIG-ONLY scan (see doReconcileAll)
  private lastWsActivity = 0;        // ms of the last WS frame (heartbeat or change) — for half-open detection
  private wsLivenessTimer?: number;
  private realtimeConnected = false; // is the change-notification WebSocket currently OPEN? Drives the
  // status light's realtime-vs-polling distinction (syncstate.light) so green "Fully synced" never
  // shows over a dead socket. Polling still keeps data current when this is false.
  private lastFullScanAt = 0;   // wall-clock ms of the last WHOLE-VAULT reconcile (note-drift safety net)
  private rawBuffer = new Set<string>();      // config paths from "raw" events, coalesced before reconcile
  private rawDebounce?: number;               // debounce timer for the raw-event burst
  private recentSelfWrites = new Map<string, number>(); // config path -> when WE wrote it, to ignore the echo
  private backoff = 3000;
  private unloading = false;
  private skipNotified = new Set<string>(); // paths we've already warned are too large (notice once)
  // R18 bounded-retry state (persists across reconcile passes): per-path consecutive pull-failure
  // budget, and the set of paths we've already surfaced as "server copy corrupt" (notice once).
  private pullRetries = new Map<string, { version: number; count: number }>();
  // SEC-DATA: one cumulative delete-rate guard for the whole session (survives across reconcile passes)
  // so a paced-tombstone vault drain from a compromised server is caught, not just per-pass ratio spikes.
  private deleteGuard = new DeleteRateGuard();
  private pullExhaustedNotified = new Set<string>();
  private setupOpen = false; // R11-#8: guard against stacking a new setup wizard every backoff tick
  private versionNoticeShown = false; // R12-PB6: toast a protocol-version mismatch once, not every retry
  private guardBuffer = new Set<string>();  // C2-guarded paths pending a single coalesced notice
  private guardTimer?: number;              // debounce so a bulk empty-manifest event is ONE toast, not N
  private lastIssue?: string;               // human reason for the current non-idle state (shown on the card)
  getLastIssue(): string | undefined { return this.lastIssue; }

  // Injection seams (overridable in tests): the real Obsidian-backed io + HTTP transport, and the
  // two static auth calls. A test subclass returns in-memory fakes so the whole producer→engine→
  // effect→reconcile wiring runs without Obsidian or a server.
  protected buildIo(): VaultIo { return new ObsidianVaultIo(this); }
  protected buildApi(token: string): ApiClient {
    return new HttpTransport(this.settings.serverUrl, token, this.settings.vaultId || "default", this.settings.vaultOwner || "");
  }
  protected loginRemote(): Promise<string> {
    return HttpTransport.login(this.settings.serverUrl, this.settings.username, this.settings.password);
  }

  async onload() {
    await this.loadSettings();
    this.io = this.buildIo();
    void this.resolveUaChModel(); // async, fire-and-forget: upgrade the auto device name to the real Android model
    // The one operational state machine. Effects are the (previously inline) connect/reconcile/
    // teardown bodies; the engine owns state, serialization, coalescing, and recovery.
    this.engine = new SyncEngine({
      connect: () => this.doConnect(),
      reconcileAll: () => this.doReconcileAll(),
      reconcilePath: (p, size) => this.doReconcilePath(p, size),
      rews: () => this.doRews(),
      teardown: () => this.doTeardown(),
      onPhase: (p) => this.renderLight(p),
      onError: (where, e: any) => this.log(`${where} FAILED: ${e?.message ?? e}`),
      scheduleReconnect: () => this.scheduleReconnect(),
    });
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
    this.renderLight(this.engine.phase()); // initial: off

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
    this.engine.enqueue({ kind: "unload" }); // → teardown (stops timers, closes ws), projects off
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
  openSetup() {
    // R11-#8: token-only mode with an expired token retries {connect} forever; without this guard,
    // each ~30s attempt opened ANOTHER wizard, stacking modals the user couldn't escape. Open at most one.
    if (this.setupOpen) return;
    this.setupOpen = true;
    const modal = new SetupWizardModal(this.app, this);
    const done = modal.onClose.bind(modal);
    modal.onClose = () => { this.setupOpen = false; done(); };
    modal.open();
  }

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

  // --- note conflicts: when concurrent edits can't merge cleanly, this device's version is kept as
  // a conflict-copy file beside the note (which holds the other version). We track ONLY the copies
  // SelfSync itself created (recorded from onConflict) — never files merely matching the conflict
  // name — so a user's own "(conflict …)"-named note can't be mistaken for one and destroyed. The
  // list self-cleans: a copy the user deleted (or resolved) drops off. See NoteConflictModal.
  listNoteConflicts(): { copy: string; original: string }[] {
    const present = this.settings.noteConflicts.filter((copy) => this.app.vault.getAbstractFileByPath(copy) != null);
    if (present.length !== this.settings.noteConflicts.length) { this.settings.noteConflicts = present; void this.saveSettings(); }
    return present.map((copy) => ({ copy, original: originalOfConflictCopy(copy) ?? copy }));
  }
  private recordNoteConflict(copy: string): void {
    if (this.settings.noteConflicts.includes(copy)) return;
    this.settings.noteConflicts.push(copy);
    void this.saveSettings();
    this.settingsRefresh?.(); this.statusListener?.();
  }
  private clearNoteConflict(copy: string): void {
    if (!this.settings.noteConflicts.includes(copy)) return;
    this.settings.noteConflicts = this.settings.noteConflicts.filter((p) => p !== copy);
    void this.saveSettings();
  }
  openNoteConflicts() { new NoteConflictModal(this.app, this).open(); }
  // Text of a file for the conflict preview ("" if gone or unreadable).
  async readTextOrEmpty(path: string): Promise<string> {
    try { return new TextDecoder().decode(await this.io.read(path)); } catch { return ""; }
  }
  // Resolve one note conflict. "mine" promotes this device's copy to canonical; "theirs" keeps the
  // on-disk (other) version; both then delete the copy. Each change is enqueued so it propagates.
  // "manual" opens both files for hand-merging and leaves them (the copy stays until the user deletes it).
  // Returns false (without touching anything) if `original` changed since the modal previewed it —
  // so "keep mine" can't silently overwrite a newer version that a poll pulled in while the modal sat
  // open (critique R9-M2). previewedOther is the "other version" text the modal showed.
  async resolveNoteConflict(copy: string, original: string, choice: "mine" | "theirs" | "manual", previewedOther?: string): Promise<boolean> {
    if (choice === "manual") {
      await this.app.workspace.openLinkText(original, "", false);
      await this.app.workspace.openLinkText(copy, "", "split");
      return true;
    }
    if (choice === "mine") {
      if (previewedOther !== undefined && (await this.readTextOrEmpty(original)) !== previewedOther) {
        new Notice("SelfSync: that file changed since you opened this — review it again");
        return false; // don't clobber the newer version; the modal re-renders with the new content
      }
      const bytes = await this.io.read(copy);
      await this.io.write(original, bytes);
      this.engine.enqueue({ kind: "path", path: original, size: bytes.byteLength });
    }
    await this.io.remove(copy);
    this.engine.enqueue({ kind: "path", path: copy, size: 0 });
    this.clearNoteConflict(copy);
    return true;
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
    this.settingsRefresh?.(); this.statusListener?.();
  }
  // C2 guard fired for a path (server manifest empty while we hold it in history — refused to
  // delete). Log each path, but COALESCE the toast: a bulk empty-manifest read (e.g. a transient
  // during a vault switch) trips this for many files at once, and 13 alarming toasts read like a
  // failure when nothing is wrong. One calm summary per burst instead; detail stays in the log.
  private noteGuard(path: string): void {
    this.guardBuffer.add(path);
    this.log(`server manifest empty but '${path}' is in our history — NOT deleting it (possible server data loss)`); // log only
    if (this.guardTimer !== undefined) window.clearTimeout(this.guardTimer);
    this.guardTimer = window.setTimeout(() => {
      const n = this.guardBuffer.size; this.guardBuffer.clear(); this.guardTimer = undefined;
      if (n > 0) this.log(`kept ${n} local file${n === 1 ? "" : "s"} — the server's copy looked empty, so nothing was deleted (see log)`, true);
    }, 900);
  }

  // A config path reconciled cleanly — drop any stale pending entry so the count reflects reality
  // (this is what makes the "Config differences" badge self-clear as things resolve).
  private clearConfigConflict(path: string): void {
    if (!this.settings.configConflicts.includes(path)) return;
    this.settings.configConflicts = this.settings.configConflicts.filter((p) => p !== path);
    void this.saveSettings();
    this.settingsRefresh?.(); this.statusListener?.();
  }
  // Apply the user's adjudication for a whole GROUP of paths (a plugin = all its files) in one go,
  // then drop them from the queue and refresh the settings badge so it can't show a stale count.
  async resolveConfigGroup(paths: string[], choice: "local" | "remote"): Promise<void> {
    const d = this.deps();
    for (const p of paths) await resolveConfigConflict(d, p, choice);
    const done = new Set(paths);
    this.settings.configConflicts = this.settings.configConflicts.filter((p) => !done.has(p));
    await this.saveSettings();
    this.settingsRefresh?.(); this.statusListener?.();
  }

  // Local file size (0 if unknown/absent) — lets reconcilePath apply the size gate on
  // the event path, not just the batch path.
  private localSizeOf(path: string): number {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f.stat.size : 0;
  }

  setAuthToken(token: string) { this.settings.authToken = token; void this.saveSettings(); }

  // Use the stored token OPTIMISTICALLY — no proactive validation probe, no arbitrary
  // "recently-validated" TTL. The old design probed listVaults on a wall-clock cache window
  // (a timing crutch): a fabricated freshness guess that still 401s the moment the token
  // actually expires. Instead we just use the token and react to a real 401 (withAuth /
  // doConnect re-login once), so token validity is driven by the server's answer, not a guess.
  private async acquireToken(): Promise<string> {
    if (this.settings.authToken) return this.settings.authToken;
    return this.freshLogin();
  }

  // Exchange the stored password for a new token (and drop the plaintext password if the user
  // opted into token-only storage). No password at rest ⇒ the session can't self-renew, so
  // open setup for the user to re-authenticate rather than fail silently.
  // SINGLE-FLIGHT (Round-6 CONC): both the engine's reactive-401 path (doConnect) and the non-engine
  // withAuth path (setup/switch modals) can call this concurrently. `freshLogin` READS the password
  // (in loginRemote) and then destructively CLEARS it — two entrants would race that read-modify-
  // write, so the second reads an emptied password and spuriously prompts "session expired" while a
  // login is actually succeeding, minting an orphan token. Coalesce concurrent calls into one login.
  private loginInFlight?: Promise<string>;
  private freshLogin(): Promise<string> {
    if (this.loginInFlight) return this.loginInFlight;
    const run = (async () => {
      if (!this.settings.password) {
        this.openSetup();
        throw new Error("session expired — please re-enter your password in setup");
      }
      const token = await this.loginRemote();
      if (!this.settings.storePassword) this.settings.password = "";
      this.setAuthToken(token); // persists the token (and the cleared password)
      this.log("login OK");
      return token;
    })();
    this.loginInFlight = run;
    return run.finally(() => { this.loginInFlight = undefined; });
  }

  // A server auth rejection (401) — the reactive signal that replaces the proactive probe.
  private isAuthError(e: unknown): boolean {
    return /HTTP 401/.test(e instanceof Error ? e.message : String(e));
  }

  // Run an authenticated call with the current token; on a 401 (token expired/revoked), clear it,
  // re-login ONCE, and retry. This is the reactive replacement for the validation-TTL cache: the
  // token is trusted until the server says otherwise, and a stale token self-heals on first use.
  private async withAuth<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.acquireToken();
    try { return await fn(token); }
    catch (e) {
      if (!this.isAuthError(e)) throw e;
      this.log("token rejected — re-logging in");
      this.settings.authToken = undefined;
      const fresh = await this.freshLogin();
      return fn(fresh);
    }
  }

  // Unbind this vault (keep local files); return to the unconfigured state.
  async disconnect() {
    this.settings.vaultId = "";
    await this.saveSettings();
    this.engine.enqueue({ kind: "disconnect" }); // → teardown (stops timers + closes ws), state off
    this.log("disconnected (local files kept)"); // the settings UI reflects it — no toast needed
  }

  // Sign out: forget credentials + token, drop to Not-set-up.
  async signOut() {
    this.settings.authToken = undefined;
    this.settings.password = "";
    await this.disconnect();
  }

  // Layered connection diagnosis for the settings "Diagnose" button — names the first broken link
  // (unreachable / version / auth / vault / degraded) so a silent offline gets an actionable reason.
  // Uses the CURRENT stored token as-is (no forced re-login) so it reflects the real session state.
  async diagnoseConnection() {
    return HttpTransport.diagnose(this.settings.serverUrl, this.settings.authToken, this.settings.vaultId, this.settings.vaultOwner || undefined);
  }

  // A shareable setup link for another device (server + username only, never password).
  addDeviceLink(): string {
    return encodeSetupLink({ server: this.settings.serverUrl, user: this.settings.username, vault: this.settings.vaultId });
  }

  // --- switch vault without re-login: reuse the existing session (token / stored
  // password), so the "Switch vault" flow never re-asks for server or account. ---
  async currentVaults(): Promise<string[]> {
    return this.withAuth((t) => HttpTransport.listVaults(this.settings.serverUrl, t));
  }
  async createRemoteVault(name: string): Promise<void> {
    await this.withAuth((t) => HttpTransport.createVault(this.settings.serverUrl, t, name));
  }
  // Switching which remote vault this local vault syncs to is a one-time transition, not
  // a persistent setting: the caller (the switch modal) picks the resolution and it is
  // applied ONCE on the next reconnect, then forgotten. `merge` is the safe default union.
  async switchToVault(name: string, mode: SwitchMode = "merge", owner = "", readOnly = false): Promise<void> {
    this.settings.vaultId = name;
    this.settings.vaultOwner = owner || undefined; // empty = own vault
    this.settings.vaultReadOnly = readOnly;
    this.settings.pendingSwitch = mode; // persist the resolution WITH the vaultId (atomic) so a restart mid-switch replays it (R12-CA1)
    await this.saveSettings();
    await this.reconnect();
  }
  // Vaults shared WITH this account (owned by others) — offered in the switch modal.
  async listSharedVaults(): Promise<SharedVaultRef[]> {
    return this.withAuth((t) => HttpTransport.listShared(this.settings.serverUrl, t));
  }

  // Self-service password change (R14 sec#2). On success the server revokes every session and
  // returns a FRESH token; persist it (+ the new stored password, if we keep one) so this device
  // stays logged in while every OTHER session (incl. a leaked one) is invalidated at once.
  async changePassword(current: string, newPassword: string): Promise<void> {
    const fresh = await HttpTransport.changePassword(this.settings.serverUrl, await this.acquireToken(), current, newPassword);
    this.settings.authToken = fresh;
    if (this.settings.storePassword) this.settings.password = newPassword;
    await this.saveSettings();
  }
  // Owner-scoped share management (R14 sec#4): the caller's own vaults + who each is shared with,
  // and grant/revoke — all reachable on the public port now (was admin-router-only).
  async myVaultShares(): Promise<VaultShares[]> {
    return this.withAuth((t) => HttpTransport.myVaults(this.settings.serverUrl, t));
  }
  async shareVault(vault: string, grantee: string, perm: SharePerm): Promise<void> {
    await this.withAuth((t) => HttpTransport.shareCreate(this.settings.serverUrl, t, vault, grantee, perm));
  }
  async unshareVault(vault: string, grantee: string): Promise<void> {
    await this.withAuth((t) => HttpTransport.shareDelete(this.settings.serverUrl, t, vault, grantee));
  }
  // D0023 capability share-links. Create returns the full selfsync-share:// link to hand out (Copy).
  async createShareLink(vault: string, perm: SharePerm, label = "", ttlSecs?: number): Promise<string> {
    const linkToken = await this.withAuth((t) => HttpTransport.createShareLink(this.settings.serverUrl, t, vault, perm, label, ttlSecs));
    return encodeShareLink({ server: this.settings.serverUrl, token: linkToken });
  }
  listShareLinks(): Promise<ShareLinkInfo[]> {
    return this.withAuth((t) => HttpTransport.listShareLinks(this.settings.serverUrl, t));
  }
  revokeShareLink(id: string): Promise<void> {
    return this.withAuth((t) => HttpTransport.revokeShareLink(this.settings.serverUrl, t, id));
  }
  // Redeem a pasted share-link: it must be for the server this device is configured against (the token
  // is server-specific; cross-server redemption needs an account there first). Binds a grant to this
  // account and returns {owner,vault,perm} so the caller can offer to switch to the shared vault.
  async redeemShareLink(link: string): Promise<SharedVaultRef> {
    const { server, token } = parseShareLink(link);
    if (normalizeServer(server) !== normalizeServer(this.settings.serverUrl)) {
      throw new Error(`This link is for ${server}. Set up SelfSync against that server first, then redeem it.`);
    }
    return this.withAuth((t) => HttpTransport.redeemShareLink(this.settings.serverUrl, t, token));
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

    // SECURITY (Round-6 SEC): config that arrives via SYNC can carry UNTRUSTED, executable content.
    // A share peer — OR the owner of a vault shared with you — can commit community-plugin CODE
    // (.obsidian/plugins/<id>/main.js) or theme/snippet CSS (exfil/phishing via Obsidian's un-CSP'd
    // renderer). We therefore NEVER auto-execute or auto-apply sync-driven config, for ANY vault.
    // The previous gate only covered NON-OWNED vaults (`vaultOwner` set) and auto-reloaded plugin
    // code + auto-applied CSS for owned vaults — but a vault you OWN and share readWrite also holds
    // a peer's untrusted content (the owner-direction RCE). And CSS was never gated at all. The
    // safe, uniform rule: surface a reload notice; the user applies changes explicitly. Non-code,
    // non-CSS config (e.g. a plugin's data.json) is already written to disk and read on next load.
    const touchedCss = paths.some((p) => /(^|\/)appearance\.json$/.test(p) || p.includes("/themes/") || p.includes("/snippets/"));
    const pluginIds = new Set<string>();
    for (const p of paths) { const id = pluginIdOf(p); if (id && id !== this.selfFolderId()) pluginIds.add(id); }
    const touchedCore = paths.some((p) => /(app|core-plugins|community-plugins|hotkeys)\.json$/.test(p));

    if (pluginIds.size > 0) {
      // R14 sec#1: NAME the plugins whose executable code changed via sync, so the user makes an
      // INFORMED trust decision instead of dismissing a generic notice. On a shared vault a peer (or
      // the owner of a vault shared to you) can push code for a plugin you already trust; seeing
      // exactly which plugin's code changed — and that it's executable and unapplied until reload —
      // is the barrier before you reload it into Obsidian's un-CSP'd renderer.
      const names = [...pluginIds].sort().join(", ");
      new Notice(`SelfSync: community-plugin CODE changed via sync — ${names}. This is executable code; it is NOT applied until you reload Obsidian, and you should reload ONLY if you trust the source of these changes.`, 15000);
    } else if (touchedCss || touchedCore) {
      new Notice("SelfSync: some synced settings (appearance / core) will apply after you reload Obsidian.");
    } else {
      this.log(`applied synced config (${paths.length} file(s))`);
    }
  }

  // The status light is a pure function of the FSM phase (see syncstate.ts). It drives
  // the one platform indicator, any opt-in editor indicators, and (if the settings tab is
  // open) its live status card — all from a single source of truth, never diverging.
  private renderLight(phase: Phase) {
    const spec = light(phase, `v${this.state.version}`, this.realtimeConnected);
    // Vary the GLYPH with state too, so it isn't conveyed by color alone (colorblind users). When idle
    // but the realtime socket is down (polling fallback), show the "reconnecting" glyph, not the check.
    const glyph = phase === "idle" ? (this.realtimeConnected ? "check" : "refresh-cw")
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
    if (!view || this.editorViews.has(view)) { this.renderLight(this.engine.phase()); return; }
    this.editorViews.add(view);
    this.editorActionEls.add(view.addAction("refresh-cw", "SelfSync sync status", () => this.showLog()));
    this.renderLight(this.engine.phase());
  }
  setEditorStatus(on: boolean) {
    this.settings.editorStatus = on;
    void this.saveSettings();
    if (on) { this.applyEditorStatus(); return; }
    for (const el of this.editorActionEls) el.remove();
    this.editorActionEls.clear();
    this.editorViews = new WeakSet();
  }
  statusText() { return this.engine.phase(); }

  // Applying a config-sync change (master/category/per-plugin toggle) must take effect NOW — otherwise
  // the switch looks inert for up to CONFIG_SCAN_INTERVAL_MS (~2 min), which is exactly the "I flipped
  // it and nothing happened" complaint. Persist, then (if connected) force a CONFIG scan on the next
  // reconcile and kick one immediately, so a newly-enabled category/plugin syncs right away (and a
  // newly-disabled one stops being pushed). If not connected, it applies on the next connect.
  async applyConfigSyncChange(): Promise<void> {
    await this.saveSettings();
    if (!this.api) return;
    this.lastConfigScanAt = 0; // force the config-only re-hash on the coming reconcile (doReconcileAll)
    this.engine.enqueue({ kind: "remote" });
  }

  // ---- reconcile deps ----
  // The name used when the Device name field is left blank. Prefer a friendly label over
  // navigator.platform (which is "Linux aarch64" on Android → the useless "Linuxaarch64").
  // Shown as muted placeholder text in settings so the user sees what will be used.
  private uaChModel: string | null = null; // device model from UA Client Hints (Android), resolved async at startup

  // Resolve the Android device model via UA Client Hints — the canonical way that survives UA
  // reduction (returns "Pixel 9" even when the UA string is frozen to "K"). Chromium/WebView only;
  // unsupported on iOS/WebKit (feature-detected). Cached; refreshes the settings placeholder on land.
  private async resolveUaChModel(): Promise<void> {
    try {
      const uaData = (navigator as unknown as { userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ model?: string }> } }).userAgentData;
      if (!uaData?.getHighEntropyValues) return;
      const hi = await uaData.getHighEntropyValues(["model"]);
      const m = usableModel(hi?.model);
      if (m) { this.uaChModel = m; this.statusListener?.(); } // refresh so the muted device-name placeholder updates
    } catch { /* not supported / rejected — the UA-string + platform fallbacks cover it */ }
  }

  autoDeviceName(): string {
    if (this.uaChModel) return this.uaChModel; // UA Client Hints model — best on Android, survives UA reduction
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const android = androidModelFromUA(ua); // e.g. "Pixel 9" from the UA string (WebView isn't UA-reduced); null on desktop or a frozen "K"
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
      device: this.deviceLabel(),
      readOnly: this.settings.vaultReadOnly,
      maxSyncBytes: this.io.appendWrite ? undefined : MOBILE_MAX_SYNC_BYTES, // R11-#2: tighter buffered cap on mobile (no streaming)
      // Same selective-sync gate the io uses: a filtered `.obsidian/` path is skipped in
      // reconcile too, so a device that opted out never records a base for it (no phantom delete).
      accepts: (p) => shouldSync(p, this.settings.configSync, this.selfFolderId()),
      localSizeOf: (p) => this.localSizeOf(p), // O(1) size for the incremental (RS-3) size gate
      onReadOnly: (p) => this.log(`read-only shared vault: local change to '${p}' won't sync`),
      onConflict: (p, c) => { this.log(`conflict on ${p} → kept your copy as ${c}`, true); this.recordNoteConflict(c); },
      onConfigConflict: (p, reason) => this.recordConfigConflict(p, reason),
      onConfigResolved: (p) => this.clearConfigConflict(p),
      onFileError: (p, e) => this.log(`couldn't sync '${p}': ${e instanceof Error ? e.message : String(e)} — skipped it, other files continue`),
      onBaseChanged: () => { void this.persist(); },
      onGuard: (p) => this.noteGuard(p),
      deleteGuard: this.deleteGuard, // SEC-DATA: cross-pass cumulative delete-rate guard (anti-drain)
      retryBudget: this.pullRetries, // R18: bound re-download of a permanently-corrupt server file
      onPullExhausted: (p) => {
        if (this.pullExhaustedNotified.has(p)) return; // once per path per session
        this.pullExhaustedNotified.add(p);
        this.log(`'${p}' can't be downloaded — the server's copy failed its integrity check ${MAX_PULL_RETRIES} times (corrupt / bit-rotted). It needs a server reindex; other files keep syncing.`, true);
      },
      onSkip: (p, bytes) => {
        if (this.skipNotified.has(p)) { this.log(`skipped '${p}' — too large to sync`); return; } // notice once/session
        this.skipNotified.add(p);
        const cap = this.io.appendWrite ? DEFAULT_MAX_SYNC_BYTES : MOBILE_MAX_SYNC_BYTES; // platform-aware: mobile buffers, desktop streams
        this.log(`skipped '${p}' — ${Math.round(bytes / 1048576)} MB, over this device's ${Math.round(cap / 1048576)} MB sync limit${this.io.appendWrite ? "" : " (larger files sync on desktop)"}`, true);
      },
    };
  }

  // ---- connection lifecycle: public entry + engine effects ----
  // Public entry (commands / settings / switch-vault): just enqueue a connect. The engine
  // serializes it against any in-flight reconcile and dedups concurrent requests — no `connecting`
  // flag needed (that state now lives in the machine).
  async reconnect() { this.engine.enqueue({ kind: "connect" }); }

  // True when the last connect failed because the vault is GONE server-side (a 404 — deleted or
  // renamed). Drives the "Re-create this vault from this device" prompt in settings (D0021).
  private vaultGone = false;
  isVaultGone(): boolean { return this.vaultGone; }

  // Deliberate recovery from a deleted vault (D0021): re-create the same-named vault on the server,
  // then reconnect. The vault comes back EMPTY, so the normal reconcile keeps this device's local
  // files and pushes them back up (tombstone-authoritative), repopulating it from this device's
  // copy — the no-data-loss behavior, now an explicit user choice rather than implicit. Other
  // devices' server-side history is NOT restored (only this device's current content).
  async recreateVault(): Promise<void> {
    try {
      await this.withAuth((t) => HttpTransport.createVault(this.settings.serverUrl, t, this.settings.vaultId));
      this.log(`re-created vault '${this.settings.vaultId}' — repopulating from this device`, true);
      this.vaultGone = false;
      await this.reconnect();
    } catch (e: any) {
      this.log(`could not re-create the vault: ${e?.message ?? e}`, true);
    }
  }

  // EFFECT: (re)establish the connection — acquire token, health-check, initial reconcile (or a
  // pending switch), then spin up the WS + poll. THROWS on any failure; the engine catches it,
  // goes offline, and arms the backoff reconnect. No re-entrancy flags here: the engine guarantees
  // exactly one effect runs at a time, so the old CONC-3 interleave is impossible by construction.
  private async doConnect(): Promise<void> {
    this.lastIssue = undefined;
    // crit-round (sync F4): a connect means the realtime socket is not (yet) live. Reset the flag up
    // front so the status light can't briefly show green "Fully synced" during connect→idle before the
    // new socket's open handler fires (the close handler's `this.ws !== ws` early-return can otherwise
    // leave it stale-true after a non-socket failure).
    this.realtimeConnected = false;
    // A connect is happening now — cancel any pending backoff timer so it can't later fire a
    // redundant {connect} after this one succeeds.
    if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    try {
      this.log(`connecting to ${this.settings.serverUrl} as '${this.settings.username}'`);
      // Clear the ref BEFORE the awaits below: the close we just triggered fires asynchronously,
      // and the close handler only suppresses a superseded socket via the `this.ws !== ws` check.
      // Leaving this.ws pointing at the closing socket during the await would let its close enqueue
      // a spurious {rews} that re-dials on top of this connect. (Round-6 CONC)
      this.ws?.close(); this.ws = undefined;
      const token = await this.acquireToken();
      this.api = this.buildApi(token);
      // Never reconcile against a degraded server: a corrupt index 503s all sync ops, and acting
      // on the resulting empty manifest could delete local files. Surface the operator action.
      // status() is the first authed call; if the stored token was rejected (401), re-login ONCE
      // and rebuild the transport (reactive auth — no proactive validation probe). A still-failing
      // auth then throws → the engine backs off and retries.
      let health;
      try { health = await this.api.status(); }
      catch (e) {
        if (!this.isAuthError(e)) throw e;
        this.log("token rejected — re-logging in");
        this.settings.authToken = undefined;
        const fresh = await this.freshLogin();
        this.api = this.buildApi(fresh);
        health = await this.api.status();
      }
      // Version handshake: refuse to sync against a server on a different protocol/schema version
      // (a self-hoster auto-updates the plugin independently of the server). A clear, actionable
      // message beats an undiagnosable malformed-response retry loop — and the vault is untouched.
      // R12-PB2: fail CLOSED — an absent apiVersion (a pre-versioning server, or a proxy that strips
      // the field) means we CAN'T confirm compatibility, so don't sync (was: undefined skipped the
      // check → failed open, the wrong default for the mixed-version case the gate exists for).
      if (health.apiVersion !== CLIENT_API_VERSION) {
        const server = health.apiVersion === undefined ? "an unknown version" : `v${health.apiVersion}`;
        this.lastIssue = `This plugin (sync protocol v${CLIENT_API_VERSION}) and your server (${server}) don't match. Update whichever is older so they're on the same version — not syncing until they match (your notes are untouched).`;
        // R12-PB6: toast ONCE per mismatch episode, not on every ~30s backoff retry (the card keeps showing it).
        this.log(this.lastIssue, !this.versionNoticeShown);
        this.versionNoticeShown = true;
        throw new Error(`incompatible protocol: client v${CLIENT_API_VERSION} vs server ${server}`);
      }
      this.versionNoticeShown = false; // versions match → reset so a later mismatch toasts again
      if (health.status !== "ready") {
        this.lastIssue = `This vault's data on the server is damaged and can't sync safely. Someone with server access needs to repair it (run “reindex” on the server). Not syncing until then.`;
        this.log(this.lastIssue);
        throw new Error("server vault not ready (reindex needed)");
      }
      // Connection is now established (token + health OK). Flip the indicator from "Connecting…" to
      // "Syncing…" before the initial reconcile — which is the bulk of the time and was showing
      // "Connecting…" for its whole duration (critique/field bug). The engine settles to idle after.
      this.engine.markReconciling();
      // A pending vault switch applies its chosen resolution ONCE, then reverts to normal reconcile.
      // CONC#5: clear pendingSwitchMode ONLY AFTER switchTo fully succeeds. Clearing it up-front meant
      // a mid-switch failure (network drop, throw) left the next reconnect doing a plain merge
      // reconcile — silently DOWNGRADING an authoritative overwrite (download = take-remote, upload =
      // take-local) into a merge that could conflict-copy or resurrect. Leaving it set until success
      // makes the switch resolution durable across a failed attempt (it retries as the switch, not a merge).
      const switchMode = this.settings.pendingSwitch;
      if (switchMode) { await switchTo(this.deps(), switchMode); this.settings.pendingSwitch = undefined; await this.saveSettings(); }
      else await this.reconcileFull(); // D0019: full reconcile WITH reset detection + notify (DI-H1)
      await this.flushConfigReload();
      this.lastConfigScanAt = Date.now(); this.lastFullScanAt = Date.now(); // this reconcile was a full, config-aware pass — start both scan windows now
      this.spinUpWs();
      this.startPolling();
      this.backoff = 3000;
      this.lastIssue = undefined;
      this.vaultGone = false; // a successful connect means the vault exists again
      this.settings.lastSyncedAt = Date.now(); void this.saveSettings();
      this.log(`connected @ v${this.state.version}`); // status bar/ribbon show it — no toast
    } catch (e: any) {
      // Keep the specific reason if one was already set (the health case); else a friendly generic.
      // A 404 means the server is reachable but the VAULT is gone (deleted/renamed) — that's not a
      // connectivity problem, so say so actionably instead of "retrying…" forever (Round-7 RC-3).
      const em = String(e?.message);
      this.vaultGone = /HTTP 404/.test(em); // the vault was deleted/renamed server-side (D0021 prompt)
      this.lastIssue = /no password stored|session expired/.test(em)
        ? "Session needs your password again — use “Set up / switch vault” to re-enter it."
        : this.vaultGone
        ? "This vault no longer exists on the server — re-create it from this device (button below) or pick another in “Set up / switch vault”. Your local files are untouched."
        : (this.lastIssue ?? `Can't reach the server (${e?.message ?? e}). Retrying…`);
      throw e; // → engine: onError logs it, state goes offline, backoff reconnect is scheduled
    }
  }

  // EFFECT (teardown): stop timers + close the socket. Called on disconnect/unload by the engine.
  private doTeardown(): void {
    if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    if (this.pollTimer !== undefined) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
    if (this.wsLivenessTimer !== undefined) { window.clearInterval(this.wsLivenessTimer); this.wsLivenessTimer = undefined; }
    this.ws?.close(); this.ws = undefined;
    this.realtimeConnected = false; // torn down → no realtime channel
  }

  // Open the change-notification WebSocket and route its lifecycle through the ONE engine queue:
  // a server poke → {remote}; a close → {rews} (re-dial) if it had opened, else {connect} (a
  // never-opened socket means a bad/expired token). Because both recovery paths are just events on
  // the serial queue, the old parallel redial-vs-reconnect timer race (CONC-R2#4/#6, CONC-R3#1 —
  // three separate patches) is impossible by construction — no wsRedialTimer, no cross-cancellation.
  private spinUpWs(): WebSocket | null {
    if (this.unloading || !this.api) return null;
    this.ws?.close();
    const ws = this.api.connectWs(() => this.engine.enqueue({ kind: "remote" }));
    this.ws = ws ?? undefined;
    if (!ws) { this.log("ws not available — polling fallback active"); return null; }
    let opened = false;
    // Half-open liveness (crit-round residual): bump on ANY frame — the server's app heartbeat or a
    // real change poke — so a silent (half-open) socket is detectable. Additive to the transport's own
    // onmessage handler (which only reacts to type:"changed").
    this.lastWsActivity = Date.now();
    ws.addEventListener("message", () => { this.lastWsActivity = Date.now(); });
    this.startWsLiveness(ws);
    ws.addEventListener("open", () => {
      opened = true; this.log("ws channel open (instant sync)");
      this.lastWsActivity = Date.now();
      this.realtimeConnected = true; this.renderLight(this.engine.phase()); // light → true realtime health
      this.startPolling(POLL_IDLE_MS); // WS live → downshift the poll to a slow liveness backstop (Finding 3a)
    });
    ws.addEventListener("error", () => { this.log("ws unavailable — polling fallback active"); this.realtimeConnected = false; this.renderLight(this.engine.phase()); this.startPolling(POLL_ACTIVE_MS); });
    ws.addEventListener("close", () => {
      if (this.unloading || !this.api || this.ws !== ws) return; // superseded/torn down
      this.realtimeConnected = false; this.renderLight(this.engine.phase()); // socket down → light stops claiming instant sync
      this.startPolling(POLL_ACTIVE_MS); // WS dropped → upshift the poll until it's back (or connect restarts it)
      if (opened) {
        // R11-#7: delay the WS re-dial so a server that flaps the socket (accept-then-drop) can't be
        // hammered with reconnects many times a second (rews had no backoff). A normal one-off drop
        // just waits ~2s; the 4s poll keeps catching remote changes in the meantime.
        window.setTimeout(() => { if (!this.unloading && this.api && this.ws === ws) this.engine.enqueue({ kind: "rews" }); }, 2000);
      } else {
        this.engine.enqueue({ kind: "connect" }); // never opened → full, backed-off reconnect
      }
    });
    return ws;
  }

  // Detect a HALF-OPEN socket (crit-round residual): the browser hides protocol ping/pong from JS, so
  // a socket whose TCP has silently died still reads as "open" and the light would stay green with the
  // poll downshifted. The server heartbeats every ~30s; if we see no frame within WS_STALE_MS, treat
  // the socket as dead — drop realtime health, upshift the poll, and re-dial (idempotent on the queue).
  private startWsLiveness(ws: WebSocket): void {
    if (this.wsLivenessTimer !== undefined) window.clearInterval(this.wsLivenessTimer);
    this.wsLivenessTimer = window.setInterval(() => {
      if (this.unloading || this.ws !== ws || !this.realtimeConnected) return;
      if (isWsStale(this.lastWsActivity, Date.now(), WS_STALE_MS)) {
        this.log("ws silent past the liveness deadline — treating as half-open, re-dialing");
        this.realtimeConnected = false; this.renderLight(this.engine.phase());
        this.lastWsActivity = Date.now();   // don't re-fire every tick until the re-dial settles
        this.startPolling(POLL_ACTIVE_MS);
        this.engine.enqueue({ kind: "rews" });
      }
    }, WS_LIVENESS_CHECK_MS);
  }

  // EFFECT: re-establish ONLY the WS socket (no token re-acquire, no reconcile). Rejects if it
  // can't open, so the engine escalates to a full {connect}.
  private async doRews(): Promise<void> {
    if (!this.spinUpWs()) throw new Error("ws could not be opened");
  }

  // Arm the backoff reconnect: after a jittered delay, enqueue {connect}. Stops the poll while
  // offline (the connect restarts it) so the two don't retry in parallel. Full jitter avoids a
  // thundering-herd reconnect after a server restart / LAN blip (CONC-10).
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.unloading) return;
    if (this.pollTimer !== undefined) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
    const base = this.backoff;
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.log(`retrying in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; this.engine.enqueue({ kind: "connect" }); }, delay);
    this.backoff = Math.min(base * 2, 30000);
  }

  // The 4s safety-net poll is now just an event SOURCE: it enqueues {remote}; the engine serializes
  // it and doReconcileAll does the cheap incremental check, so an idle poll stays one tiny request.
  private startPolling(intervalMs: number = POLL_ACTIVE_MS): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => this.engine.enqueue({ kind: "remote" }), intervalMs);
  }

  // EFFECT: reconcile against the server (a remote poke or a poll tick). Cheap incremental check
  // first — an idle poll does one tiny changes() request and returns; a full reconcile runs only
  // when the version advanced or a periodic config scan is due. THROWS on failure → the engine goes
  // offline and schedules the backoff reconnect. (No applying/remoteDirty here: a poke arriving
  // mid-reconcile is just another queued {remote} the engine runs next — CONC-R3#3/R4#1 for free.)
  private async doReconcileAll(): Promise<void> {
    if (!this.api) throw new Error("not connected");
    // Local CONFIG edits fire no reliable event (mobile has no `raw` watcher) → a CONFIG-ONLY re-hash
    // runs at most every CONFIG_SCAN_INTERVAL_MS (cheap: only `.obsidian/` files). A missed local NOTE
    // edit is caught by a WHOLE-VAULT pass on the slower FULL_SCAN_INTERVAL_MS cadence. (R13)
    const now = Date.now();
    const forceConfigScan = this.settings.configSync.enabled && now - this.lastConfigScanAt >= CONFIG_SCAN_INTERVAL_MS;
    const forceFullScan = now - this.lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
    if (forceConfigScan) this.lastConfigScanAt = now;
    if (forceFullScan) this.lastFullScanAt = now;
    const delta = await this.api.changes(this.state.version);
    // D0019 (critique-R8): detect a server DELETION-HISTORY RESET from the PERSISTED per-vault floor +
    // last-version (both survive a restart, unlike the ephemeral state.version). A reset routes to the
    // FULL reconcile so every local file is visited + kept-and-collected, and noteHistory notifies.
    const reset = this.historyResetDetected(delta.version, delta.history_floor);
    // Short-circuit an idle poll (nothing changed AND no reset) — but still RECORD the floor/version
    // first (noteHistory), so an idle vault tracks them and a LATER reset stays detectable (a pure
    // tombstone-prune bumps the floor without any delta). No reconcile ran, so nothing was kept.
    const noChange = delta.upserts.length === 0 && delta.deletes.length === 0 && delta.version === this.state.version;
    if (!forceConfigScan && !forceFullScan && !reset && noChange) {
      this.noteHistory(delta.version, delta.history_floor, []);
      return;
    }
    const before = this.state.version;
    const kept: string[] = [];
    const d = this.deps();
    d.onKeptAbsent = (p) => kept.push(p); // always collect; noteHistory decides whether to notify
    // Show "Syncing…" only for genuine work, so "Fully synced" doesn't clip on every poll. A real
    // delta or a history reset IS work → escalate now (so a large transfer shows syncing throughout).
    // A FORCED config scan with an empty delta might be a no-op → escalate lazily: only when the scan
    // actually mutates a base (onBaseChanged), so a scan that finds nothing stays "Fully synced".
    if (!noChange || reset) {
      this.engine.beginReconcile();
    } else {
      const prevOnBaseChanged = d.onBaseChanged;
      d.onBaseChanged = () => { this.engine.beginReconcile(); prevOnBaseChanged?.(); };
    }
    // Whole-vault reconcile on a history RESET or the slow full-scan cadence — the only pass that
    // visits every local file (catches a LOCAL note edit whose event was dropped) + carries the
    // bulk-delete guard. Otherwise: the incremental delta (remote changes) + a cheap CONFIG-ONLY
    // re-hash on the frequent config tick (local config edits, which fire no reliable event). (R13)
    if (forceFullScan || reset) {
      await reconcileAll(d);
    } else {
      await reconcileDelta(d, delta);
      if (forceConfigScan) await reconcileLocalConfig(d);
    }
    await this.flushConfigReload();
    if (this.state.version !== before) this.log(`remote change → reconciled (v${before} → v${this.state.version})`);
    this.noteHistory(this.state.version, delta.history_floor, kept);
    this.settings.lastSyncedAt = Date.now(); void this.saveSettings(); // persist so "Last synced" survives a restart (the onBaseChanged snapshot ran earlier in this pass)
  }

  // Full reconcile with D0019 reset detection wired in — used by the CONNECT path (the initial
  // reconcile). CRITICAL (critique-R8 DI-H1): the connect reconcile is what actually resurrects
  // absent-without-tombstone files after a server reset, so detection+notify MUST run here, not only
  // on later polls (by the time a poll runs, the files are already re-pushed and nothing is "kept").
  private async reconcileFull(): Promise<void> {
    const kept: string[] = [];
    const d = this.deps();
    d.onKeptAbsent = (p) => kept.push(p);
    const resp = await reconcileAll(d);
    this.noteHistory(resp.version, resp.history_floor, kept);
  }

  // Per-vault key for the persisted history floor + last-version (D0019). Owner-qualified so a shared
  // vault and an own vault of the same name never share state.
  private historyFloorKey(): string {
    return `${this.settings.vaultOwner ?? ""}/${this.settings.vaultId ?? ""}`;
  }

  // Is this (version, floor) a deletion-history RESET vs what this device last synced? True if the
  // floor advanced past the stored floor (corrupt reindex / tombstone prune) OR the version rewound
  // below the stored last-version (a restore to an older snapshot). Both stores are persisted, so this
  // holds across a restart. Read-only (does not update the stores — noteHistory does that).
  private historyResetDetected(version: number, floor: number | undefined): boolean {
    const key = this.historyFloorKey();
    const sf = (this.settings.historyFloors ?? {})[key];
    const sv = (this.settings.lastVersions ?? {})[key];
    return (sf !== undefined && floor !== undefined && floor > sf)
        || (sv !== undefined && version < sv);
  }

  // Record the per-vault floor + last-version (persist only on change), and if a reset was detected
  // AND files were kept-and-pushed because absent-without-tombstone, surface ONE batched notice. Runs
  // after EVERY reconcile (connect + poll) and on the idle short-circuit (with empty `kept`).
  private noteHistory(version: number, floor: number | undefined, kept: string[]): void {
    const reset = kept.length > 0 && this.historyResetDetected(version, floor);
    const key = this.historyFloorKey();
    const floors = (this.settings.historyFloors ??= {});
    const versions = (this.settings.lastVersions ??= {});
    let changed = false;
    if (floor !== undefined && floors[key] !== floor) { floors[key] = floor; changed = true; }
    if (versions[key] !== version) { versions[key] = version; changed = true; }
    if (changed) void this.saveSettings();
    if (reset) {
      this.log(`server deletion history was reset — kept ${kept.length} local file(s) absent from the server: ${kept.slice(0, 50).join(", ")}${kept.length > 50 ? ` …(+${kept.length - 50} more)` : ""}`);
      new Notice(`SelfSync: the server's deletion history was reset. ${kept.length} file(s) on this device weren't on the server and were kept + re-uploaded. If any were deleted on another device, delete them here (full list in the sync log).`, 15000);
    }
  }

  // A "raw" adapter event for a hidden `.obsidian/` file (desktop). Filter to config paths we
  // sync, drop the echo of our own writes, then coalesce the burst and reconcile the changed
  // paths — so a plugin/theme/settings add/edit/remove syncs immediately, not on the next poll.
  private onRawConfigEvent(path: string) {
    if (!this.api || this.unloading) return;
    if (!path.startsWith(".obsidian/")) return;                    // notes are handled by TFile events
    if (!this.settings.configSync.enabled) return;
    if (!shouldSync(path, this.settings.configSync, this.selfFolderId())) return; // out of scope / self folder
    // Drop the echo of OUR OWN write — but one-shot: consume the marker as soon as it's seen so
    // a genuine external edit to the same path RIGHT AFTER ours isn't masked for the whole window
    // (reconciling a stray echo is a safe no-op; silently dropping a real change is not). (CO-6)
    const wrote = this.recentSelfWrites.get(path);
    if (wrote !== undefined) {
      this.recentSelfWrites.delete(path);
      if (Date.now() - wrote < SELF_WRITE_WINDOW_MS) return; // within the window: this is our echo
    }
    this.rawBuffer.add(path);
    if (this.rawDebounce !== undefined) window.clearTimeout(this.rawDebounce);
    this.rawDebounce = window.setTimeout(() => void this.flushRawConfig(), RAW_DEBOUNCE_MS);
  }

  // EFFECT: reconcile one path, then apply any live config reload it triggered. flushConfigReload
  // early-returns unless a `.obsidian/` file was actually written (pendingReload), so for a plain
  // note this is just the reconcile. THROWS on failure → engine offline + reconnect.
  private async doReconcilePath(path: string, size: number): Promise<void> {
    await reconcilePath(this.deps(), path, size);
    await this.flushConfigReload();
  }

  // Coalesced burst of raw config events → enqueue each changed path onto the ONE serial queue.
  // The engine drains + coalesces them (and drops them if not connected — the next connect's full
  // reconcile catches config too), and doReconcilePath applies the live reload.
  private flushRawConfig(): void {
    this.rawDebounce = undefined;
    const paths = [...this.rawBuffer]; this.rawBuffer.clear();
    if (this.unloading) return;
    for (const p of paths) this.engine.enqueue({ kind: "path", path: p, size: this.localSizeOf(p) });
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

  // Local vault events are just PRODUCERS now: enqueue a {path} and let the engine serialize,
  // coalesce, run, and recover. (The engine drops path events until connected — the next connect's
  // full reconcile catches anything edited while offline via base comparison.)
  private onLocalEvent(f: TAbstractFile) {
    if (f instanceof TFile) this.engine.enqueue({ kind: "path", path: f.path, size: f.stat.size });
  }
  private onLocalDelete(path: string) {
    this.engine.enqueue({ kind: "path", path, size: 0 });
  }
  private onLocalRename(file: TAbstractFile, oldPath: string) {
    if (!(file instanceof TFile)) return;
    this.engine.enqueue({ kind: "path", path: oldPath, size: 0 });     // old path removed
    this.engine.enqueue({ kind: "path", path: file.path, size: file.stat.size }); // new path created
  }

  // The persisted-data (data.json) schema version — bumped whenever the SHAPE of settings/base
  // changes, with a matching step in migratePersisted, so an old data.json is upgraded FORWARD
  // rather than silently mis-read (issueDataMigration). 1 = the current shape.
  private readonly dataSchemaVersion = 1;

  // Forward-migrate a loaded data.json to the current schema. A no-op today — v0/undefined → v1 is a
  // pure superset that DEFAULT_SETTINGS backfill already handles — but this is the SEAM: a future
  // shape change (e.g. a base-map key/hash format change) adds an `if (v < N) { …transform… }` step
  // here so upgraders migrate their data instead of the loader misreading or dropping it.
  private migratePersisted(data: any): any {
    if (!data || typeof data !== "object") return {};
    const v = typeof data.schemaVersion === "number" ? data.schemaVersion : 0;
    if (v < 1) { /* future: transform pre-v1 shapes here; v0→v1 is additive (handled by backfill) */ }
    return data;
  }

  async loadSettings() {
    // R12-CA3: a corrupt/truncated data.json (crash mid-save, hand-edit, or a newer-schema file a
    // rolled-back build can't parse) must NOT brick the plugin. Fall back to defaults + a clear
    // notice; the synced files on disk are untouched (worst case: an empty base → the next reconcile
    // re-syncs conservatively, never clobbering). Also harden each field against a non-array/non-object.
    let data: any = {};
    try { data = this.migratePersisted((await this.loadData()) ?? {}) ?? {}; }
    catch (e: any) { this.log(`WARNING: couldn't read saved settings/base (${e?.message ?? e}) — starting from defaults; your synced files are untouched`, true); }
    const s = (data && typeof data === "object" ? data.settings : undefined) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, s);
    // Fresh, fully-defaulted configSync object (never share the module constant, and
    // backfill any categories added since this vault last saved).
    this.settings.configSync = { ...DEFAULT_CONFIG_SYNC, ...(s.configSync ?? {}) };
    this.settings.configSync.pluginAllow = [...(s.configSync?.pluginAllow ?? [])]; // fresh array (CS2): never alias DEFAULT_CONFIG_SYNC's
    // Fresh array (never share the module constant's []) — the adjudication queue is mutated in place.
    this.settings.configConflicts = Array.isArray(s.configConflicts) ? [...s.configConflicts] : [];
    this.settings.noteConflicts = Array.isArray(s.noteConflicts) ? [...s.noteConflicts] : [];
    this.base = new BaseStore(data.base && typeof data.base === "object" ? data.base : {});
  }
  async saveSettings() { await this.persist(); }
  // CONC-1: SINGLE-FLIGHT persistence. reconcileAll fires `void persist()` once per setBase, so
  // dozens of saveData writes to the same data.json used to be in flight at once; on a store that
  // does tmp-write+rename (not internally serialized) they can land out of order, so an earlier
  // snapshot overwrites a later one and a base entry is LOST on disk — corrupting the next merge's
  // ancestor. Serialize instead: one writer at a time, and coalesce concurrent calls into a single
  // trailing write that re-snapshots the latest state, so the last write always reflects the newest base.
  private persisting = false;
  private persistPending = false;
  private async persist(): Promise<void> {
    if (this.persisting) { this.persistPending = true; return; }
    this.persisting = true;
    try {
      do {
        this.persistPending = false;
        // Snapshot INSIDE the loop so a coalesced trailing write captures the latest base/settings.
        try { await this.saveData({ schemaVersion: this.dataSchemaVersion, settings: this.settings, base: this.base.toJSON() }); }
        catch (e: any) { this.log(`WARNING: could not save settings/base: ${e?.message ?? e}`, true); }
      } while (this.persistPending);
    } finally { this.persisting = false; }
  }
}

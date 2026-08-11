import { App, Modal, Notice, Plugin, Platform, MarkdownView, TAbstractFile, TFile, TFolder, normalizePath, setIcon } from "obsidian";
import { HttpTransport, SharedVaultRef, SharePerm, ShareLinkInfo, VaultShares } from "./transport";
import { SyncState, VaultIo, ChunkCache, AppendHandle, SyncApi, fetchFileBytes } from "./sync";
import { sha256hex } from "./chunker";
import { classifyPushPull, lineDiff, stampsConverged, PushDirection, DiffLine, PluginPushPreview, FileChangeView, SideState } from "./pushpreview";
import { BaseStore, deriveNoteConflicts, isConflictCopy } from "./base";
import { walkConfigTree, WalkAdapter } from "./configwalk";
import { reconcileAll, reconcileDelta, reconcileLocalConfig, reconcilePath, switchTo, SwitchMode, ReconcileDeps, MAX_PULL_RETRIES, resolveConfigConflict, decideReconcileMode, applyHeldDeletions, keepHeldDeletions } from "./reconcile";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab, parseSettings } from "./settings";
import { SetupWizardModal } from "./setupwizard";
import { ConfigConflictModal } from "./configconflict";
import { NoteConflictModal } from "./noteconflict";
import { SwitchVaultModal } from "./vaultswitch";
import { RedeemShareLinkModal } from "./accountui";
import { encodeSetupLink } from "./connstr";
import { encodeShareLink, parseShareLink, redeemTargetError, resolveShareGrant } from "./sharelink";
import { Phase, light, isWsStale, effectivePhase } from "./syncstate";
import { transportTransition, TransportState, TransportEvent } from "./transportstate";
import { FileMeta } from "./protocol";
import { SyncEngine } from "./syncengine";
import { classifyConnectError, toConnErrorInfo, ConnError, linkPhase, Recovery, Endpoint, SyntheticKind, LinkKind, FailureKind, RecoveryKind } from "./connstate";
import { shouldSync, pluginIdOf, configSurfaceOf, adjudicateConfigConflict, pluginFilePaths, isSelfPluginId, isJunkFile, ConfigSurface, ConfigDirection, shouldNotifyConfigChange, changeSourceLabel, ChangeProvenance, SelfIdentity } from "./configsync";
import { vaultKeyMismatch, switchAlreadyApplied, resumeAction } from "./connectdecisions"; // pure connect-effect decisions (functional-decoupling D0036)
import { EMBEDDED_SIGNATURE, Signature, hashCheck, signatureVerdict, FAIL_CLOSED_MESSAGE, incompatibleMessage } from "./wiresignature"; // D0042 wire-contract compatibility
import { asSafeVaultPath, SafeVaultPath } from "./pathsafe";
import { LightDisplay, LightEvent, lightDisplayInit, nextLightDisplay } from "./statuslight";
import { androidModelFromUA, platformDisplayName, usableModel } from "./devicename";
import { Mount, primaryExcludes, validMounts } from "./mounts";
import { MountRuntime, MountPersist, mountKey, parseMountState } from "./mountengine";
import { MountScope, reconcileMountScopes } from "./mountsync";
import { aggregateStatus, Health, MountState } from "./mountfsm";


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
const CONFIG_ENUM_CONCURRENCY = 12; // max concurrent adapter.list/stat calls in the .obsidian walk (issueConfigWalkSlow)
const CONFIG_WALK_SLOW_MS = 1000;   // log the config-walk shape (folders/files/seconds) only when it's this slow
const CONFIG_SCAN_INTERVAL_MS = 30_000; // config-only re-hash cadence — the BACKSTOP for a config change
// that fires no UI event. Cheap because reconcileLocalConfig skips unchanged files by (size, mtime).
// The primary detector is event-driven: the `raw` FS event (desktop) + css-change/layout-change proxies
// (mobile) trigger the scan on demand; this timer just catches the rare change nothing signalled.
const CONFIG_EVENT_MIN_GAP_MS = 5_000; // rate-limit UI-event-triggered scans (layout-change fires on plain navigation too)

// A v4 UUID that NEVER throws — used for the per-device provenance id, minted on the connect path where a
// throw would break sync entirely (crit finding 3). Prefers crypto.randomUUID (Electron/modern WebView),
// falls back to crypto.getRandomValues (Android System WebView < 92 lacks randomUUID but has this), and
// finally to a non-crypto id (identity/display only — not a security token) so it can never take down connect.
function randomUuid(): string {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  try {
    if (c?.randomUUID) return c.randomUUID();
    if (c?.getRandomValues) {
      const b = c.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; // v4 + RFC-4122 variant
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
  } catch { /* fall through to the non-crypto id */ }
  return `dev-${Date.now().toString(36)}-${Math.floor(Math.random() * 0x100000000).toString(36)}`;
}
// The per-file sync cap is now the user-configurable setting `maxSyncMB` (default 200), resolved by
// maxSyncBytes(). NOTE the platform trade-off it exposes: mobile has no streamed I/O
// (ObsidianVaultIo.appendWrite is desktop-only), so a synced file is buffered whole in the WebView
// heap (~2× its size during fetch+concat) — a large value can OOM-crash the app. Desktop streams to
// disk, so it's safe higher. An over-cap file is SKIPPED, never deleted (the peer's copy is safe).
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
const MOUNT_FAILED_RETRY_MS = 5 * 60 * 1000; // a FAILED composed-vault mount auto-retries this long after failing (R4-F2)
const MOUNT_MOBILE_MAX_BYTES = 50 * 1024 * 1024; // on mobile a mount buffers whole files (no streamed writer) — cap to avoid a WebView OOM (R6-Med2); files over this are skipped + noticed, never buffered
// Debounce before the status light PAINTS "Syncing…" (issueStatusLightFlicker): a reconcile that settles
// (or has no pending transfer) faster than this never shows — the light holds its steady state, so a
// sub-second poll/check can't flit the light. Only a sustained, genuine transfer paints "Syncing…".
const SYNCING_SHOW_DELAY_MS = 600;
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

// A path in the Obsidian config/plugin tree.
function isConfigPath(p: string): boolean { return p === ".obsidian" || p.startsWith(".obsidian/"); }

class ObsidianVaultIo implements VaultIo {
  // Desktop-only streamed writer (Electron Node fs); left undefined on mobile so the
  // reconciler falls back to buffered writes there (Obsidian's adapter has no incremental
  // binary write). Assigned only when Node's require is actually available.
  appendWrite?: (path: string) => Promise<AppendHandle>;
  private lastCfgCount = -1; // last-logged config-scope size; log only on change (list() runs every reconcile)
  // `forMount` = this adapter backs a composed-vault MOUNT scope (wrapped by MountedIo), not the primary.
  // A mount io is DATA-ONLY and must NOT apply the primary's mount-point exclusion (that boundary is
  // primary-only — applying it here would drop the mount's OWN files, silently no-op'ing every mount write and
  // then delete-remote'ing the source, the A1 defect). Scoping to the mount subtree is MountedIo's job.
  constructor(private plugin: NewLiveSyncPlugin, private forMount = false) {
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
    // Parse into SafeVaultPath so the raw-fs join below can only be built from a checked path.
    const safe = asSafeVaultPath(path);
    if (!safe) throw new Error(`refusing to write an unsafe/traversing path: '${path}'`);
    const req = (window as unknown as { require: (m: string) => any }).require;
    const fs = req("fs");
    const nodePath = req("path");
    const adapter = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
    const base = adapter.getBasePath ? adapter.getBasePath() : (adapter.basePath ?? "");
    const abs = this.rawFsAbs(nodePath, base, safe);
    await fs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
    const tmp = abs + ".selfsync-part";
    const fh = await fs.promises.open(tmp, "w");
    return {
      append: async (bytes: Uint8Array) => { await fh.write(bytes); },
      close: async () => {
        // CONTRACT (issueStreamedPullMidEditLoss): this must NEVER throw AFTER the rename succeeds. The
        // streamed-pull seam writes a racing-edit conflict copy just before calling close(); applyPull
        // deliberately does NOT delete that copy if close() throws, because a post-rename throw would mean
        // `path` is already overwritten and the copy is the sole surviving edit. Everything after the rename
        // here is therefore best-effort + non-throwing (fsyncHandle swallows errors; onConfigWritten is pure).
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
  // BOUNDARY (D0039): a path under any composed-vault MOUNT POINT is EXCLUDED from the PRIMARY scope — it is
  // synced by that mount's own scope instead, so a mounted file never double-syncs to the primary vault. A
  // MOUNT io is data-only and does the OPPOSITE — it must accept its own mount-subtree files (MountedIo scopes
  // them) and never applies the mount-exclusion, else it would drop its own writes (A1).
  private passes(path: string): boolean {
    if (this.forMount) return !isConfigPath(path); // data-only; subtree scoping is MountedIo's job
    return !primaryExcludes(this.plugin.activeMounts(), path) // exclude only mounts actually in effect (N1)
      && shouldSync(path, this.plugin.settings.configSync, this.plugin.selfFolderId());
  }

  async list() {
    const m = new Map<string, { mtime: number; size: number; ctime?: number }>();
    // getFiles() returns notes/attachments only (never .obsidian); passes() is a
    // belt-and-suspenders guard. ctime feeds first-seed of a managed note's `created`.
    for (const f of this.plugin.app.vault.getFiles()) {
      if (this.passes(f.path)) m.set(f.path, { mtime: f.stat.mtime, size: f.stat.size, ctime: f.stat.ctime });
    }
    if (!this.forMount && this.plugin.settings.configSync.enabled) {
      // Enumerate the hidden .obsidian/ tree via a BOUNDED-PARALLEL walk (issueConfigWalkSlow): the old
      // recursion awaited every adapter.list/stat one at a time, so a plugin-heavy tree cost seconds on a
      // latency-bound (mobile) adapter — this runs the calls concurrently under a global cap. A dir that
      // can't be listed is skipped (NOT treated as empty — reconcile's per-file probe guards a false delete),
      // and logged so a cloud-drive placeholder / lock hiccup is diagnosable.
      const t0 = Date.now();
      const { entries, stats } = await walkConfigTree(
        ".obsidian",
        this.plugin.app.vault.adapter as unknown as WalkAdapter,
        (p) => this.passes(p),
        CONFIG_ENUM_CONCURRENCY,
        (dir, e: any) => this.plugin.log(`config enumeration couldn't list '${dir}' (${e?.message ?? e}) — files under it are left as-is, NOT treated as deleted`),
      );
      for (const [p, st] of entries) m.set(p, st);
      const ms = Date.now() - t0;
      const cfg = entries.size;
      // Log the scope only when it CHANGES — list() runs on every reconcile, so logging every time spams.
      if (cfg !== this.lastCfgCount) { this.plugin.log(`config sync on — syncing ${cfg} Obsidian settings file(s)`); this.lastCfgCount = cfg; }
      // Diagnostic: surface a SLOW config walk with its shape (folders/files/seconds) so a multi-second
      // scan is visible + attributable, and the parallelization's effect is measurable. Only when slow.
      if (ms >= CONFIG_WALK_SLOW_MS) this.plugin.log(`config scan: ${stats.dirs} folder(s) + ${stats.files} file(s) in ${(ms / 1000).toFixed(1)}s`);
    }
    return m;
  }

  async read(path: string): Promise<Uint8Array> {
    // R24 SEC: guard the READ sink too (R23 covered only write/remove). A traversing server-supplied
    // path — e.g. a tombstone `deletes:[{path:"../../../.ssh/id_rsa"}]` — resolves to a local read whose
    // `..` escapes the vault via the adapter; that read then feeds decide()→push, EXFILTRATING the
    // out-of-vault file to a malicious/compromised server. Fail loud (per-file isolated) so the read
    // never happens and decide() sees the file as absent.
    // R3-H2: a MOUNT io is data-only — refuse to READ a config path (a mount anchored under .obsidian must
    // never exfiltrate SelfSync's credential data.json or any config to the source). The write/remove/list
    // sinks + the config-segment rejection in validateMounts already block this; guarding read closes the
    // last (read→push) exfil vector as defense-in-depth. (No effect on the primary io — forMount is false.)
    if (this.forMount && !this.passes(path)) throw new Error(`mount io: refusing to read a non-data (config) path: '${path}'`);
    const safe = asSafeVaultPath(path);
    if (!safe) throw new Error(`refusing to read an unsafe/traversing path: '${path}'`);
    return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(normalizePath(safe)));
  }
  async exists(path: string): Promise<boolean> {
    if (this.forMount && !this.passes(path)) return false; // R3-H2: a mount io never probes config (data-only)
    // A traversing path is treated as "not present" — never probe outside the vault (R24 SEC).
    const safe = asSafeVaultPath(path);
    if (!safe) return false;
    return this.plugin.app.vault.adapter.exists(normalizePath(safe));
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    // R23 SEC: reject a traversing/absolute server-supplied path before touching the FS (see openAppend).
    const safe = asSafeVaultPath(path);
    if (!safe) throw new Error(`refusing to write an unsafe/traversing path: '${path}'`);
    if (!this.passes(path)) {
      // A synced config file this device hasn't opted into — dropped by design. Log it so
      // "plugins aren't syncing" is diagnosable: enable the matching category on THIS device.
      if (path.startsWith(".obsidian/")) this.plugin.log(`config write skipped — '${path}' isn't in this device's sync selection (enable the matching category here to receive it)`);
      return;
    }
    const p = normalizePath(safe);
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !(await this.plugin.app.vault.adapter.exists(dir))) await this.plugin.app.vault.adapter.mkdir(dir);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    // Embedded-timestamp: drive Obsidian's stored mtime/ctime (Dataview's file.mtime/ctime, and the real
    // FS mtime on desktop) from a managed note's embedded updated/created. Undefined for anything else.
    await this.plugin.app.vault.adapter.writeBinary(p, buf);
    // R23-DI: fsync the note (and its parent dir) BEFORE returning so it is durable before the caller
    // records base + persists data.json. Round 8 gave the ≥8 MiB STREAMED path this guarantee; the
    // buffered path (all small notes / config / conflict copies on desktop) lacked it, leaving the same
    // window: base persisted while the note sits in the page cache → on crash the note is absent but
    // base==remote → unguarded delete-remote fleet-wide. Best-effort, desktop-only (Obsidian's adapter
    // and mobile expose no fsync — mobile remains a documented residual).
    await this.fsyncDurable(safe);
    this.plugin.onConfigWritten(path); // best-effort live-reload of the affected surface
  }

  // The ONLY place a server-supplied path is turned into an absolute UNSANDBOXED-fs path (openAppend +
  // fsyncDurable — the two raw Node-fs sinks; read/exists/write/remove go through Obsidian's vault-scoped
  // adapter). Takes SafeVaultPath, not string, so the vault-escape guard PROVABLY ran before any `..` can
  // be joined onto the vault base — the type makes "forgot to check" a compile error at the danger point.
  private rawFsAbs(nodePath: { join: (...p: string[]) => string }, base: string, safe: SafeVaultPath): string {
    return nodePath.join(base, normalizePath(safe));
  }
  // Desktop-only best-effort fsync of a vault-relative file + its parent directory, mirroring the
  // server's atomic_write/write_mirror durability bar. No-op (silently) on mobile / when Node fs is
  // unavailable, and swallows errors — the file content is already written; this only upgrades its
  // durability, so a failure here must never abort the write.
  private async fsyncDurable(safe: SafeVaultPath): Promise<void> {
    const require = (window as unknown as { require?: (m: string) => any }).require;
    if (!Platform.isDesktop || !require) return;
    try {
      const fs = require("fs"); const nodePath = require("path");
      const adapter = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
      const base = adapter.getBasePath ? adapter.getBasePath() : (adapter.basePath ?? "");
      const abs = this.rawFsAbs(nodePath, base, safe);
      await fsyncHandle(() => fs.promises.open(abs, "r+")); // fsync the note contents
      await fsyncHandle(() => fs.promises.open(nodePath.dirname(abs))); // and its parent dir entry
    } catch { /* Node fs unavailable — mobile fallback, documented residual */ }
  }
  async remove(path: string): Promise<void> {
    // R23 SEC: never let a traversing server-supplied path drive a local delete outside the vault.
    const safe = asSafeVaultPath(path);
    if (!safe) throw new Error(`refusing to remove an unsafe/traversing path: '${path}'`);
    if (!this.passes(path)) return;
    this.plugin.markConfigSelfWrite(path); // suppress the "raw" echo of our own removal
    const p = normalizePath(safe);
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
      try { await navigator.clipboard.writeText(this.plugin.getLogText()); new Notice("SelfSync: sync log copied"); }
      catch { new Notice("SelfSync: copy failed — select the text manually"); }
    };
    const clearBtn = bar.createEl("button", { text: "Clear log" });
    clearBtn.onclick = () => { this.plugin.clearLogs(); pre.setText(this.plugin.getLogText()); new Notice("SelfSync: sync log cleared"); };
  }
  onClose() { this.contentEl.empty(); }
}

// The sync-server client the plugin talks to: the reconcile SyncApi plus the two transport extras
// main.ts uses directly. Narrowed to an interface (not the concrete HttpTransport) so tests can
// inject a fake via buildApi() — the seam that makes the orchestration wiring testable.
export type ApiClient = SyncApi & {
  connectWs(onChanged: () => void): WebSocket | null;
  status(): Promise<{ status: string; detail: string; version: number; apiVersion?: number; schemaHash?: string }>;
  schema(): Promise<Signature>; // D0042: the server's canonical wire-contract signature (GET /schema)
};

export default class NewLiveSyncPlugin extends Plugin {
  settings!: NewLiveSyncSettings;
  private api?: ApiClient;
  private ws?: WebSocket;
  private io!: VaultIo; // set in onload via buildIo() (injectable for tests)
  private state: SyncState = { version: 0 };
  private base = new BaseStore();
  private cache: ChunkCache = new Map();
  // --- composed vaults (D0039) ---
  // Live mount scopes (one per settings.mounts entry): each an ISOLATED MountRuntime (own base/state/guard) +
  // its FSM state. Empty ⇒ the whole subsystem is dormant (zero behaviour change). Rebuilt on connect.
  private mountScopes: MountScope[] = [];
  private mountIo?: VaultIo; // the shared data-only io mounts wrap (built lazily via buildMountIo)
  private mountReconciling = false; // re-entrancy guard: only one mount pass in flight at a time (B1 detach)
  private mountReconcilePending = false; // a reconcile was requested while one was in flight → re-run on release (R1-F1/F5)
  private mountScopesToken = "";     // the session token the current mount transports were built with (R1-F2 staleness)
  // Persisted per-mount own-base + cursor, keyed by mountKey — the per-mount analogue of the single `base`
  // key. Loaded in loadSettings, snapshotted into saveData, updated as each mount reconciles.
  private mountStateStore: Record<string, MountPersist> = {};
  // The session token, stashed when the primary transport is built, so a mount transport (same server+token,
  // the SOURCE vault) can be constructed without re-login.
  private sessionToken = "";

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
  // Files still PENDING transfer this reconcile pass, for the "N pending" text. 0/null when nothing is
  // outstanding. Only counts files that actually need syncing (not files examined), so it drives to 0.
  private syncPending = 0;
  // The status-light DISPLAY FSM (statuslight.ts) + its debounce timer + a repaint-dedupe key. Entering the
  // visible "syncing" state is debounced so a transient reconcile never flits the light (issueStatusLightFlicker).
  private lightDisplay: LightDisplay = lightDisplayInit();
  private lightTimer?: number;
  private lastLightKey = "";
  // Realtime WS channel lifecycle as an explicit FSM (transportstate.ts): offline/dialing/live/degraded —
  // replaces the old realtimeConnected bool + per-socket `opened` closure + scattered poll-cadence flips (crit R+1,
  // issueStateMachineOrphanedAndImplicit D1). `realtimeConnected` (state === "live") drives the status
  // light's realtime-vs-polling distinction so green "Fully synced" never shows over a dead socket.
  private transport: TransportState = "offline";
  get realtimeConnected(): boolean { return this.transport === "live"; } // public: the settings card reads it too, so its dot colour matches the ribbon (no green-over-polling divergence)
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
  // D0041: paths HELD this pass by the incoming bulk-delete confirmation, keyed by scope ("primary" or a
  // mountKey). Derived each pass (not persisted) — self-converges once the user picks Delete/Keep. The
  // settings review surface reads this; acceptBulkDeletions/keepBulkDeletions act on it.
  private pendingBulkDeletes = new Map<string, string[]>();
  private pullExhaustedNotified = new Set<string>();
  private setupOpen = false; // R11-#8: guard against stacking a new setup wizard every backoff tick
  private versionNoticeShown = false; // R12-PB6: toast a protocol-version mismatch once, not every retry
  private verifiedWireHash?: string; // D0042: a server schemaHash we've diffed-and-accepted this session — the cheap re-check
  private lastIssue?: string;               // human reason for the current non-idle state (shown on the card)
  getLastIssue(): string | undefined {
    // A blocked/lockedOut link carries the SPECIFIC actionable reason (sign-in rejected / version mismatch
    // / vault gone / locked out) — prefer it over the transient "retrying" fallback text.
    const link = this.engine?.linkState();
    // D0042: a wire-incompat block carries a SPECIFIC field/endpoint reason in lastIssue that the generic
    // blockedTip can't — prefer it (the whole point is telling the user WHAT is incompatible).
    if (link && link.kind === LinkKind.Blocked && link.reason === FailureKind.VersionMismatch && this.lastIssue) return this.lastIssue;
    if (link && (link.kind === LinkKind.Blocked || (link.kind === LinkKind.Retrying && link.recovery.kind === RecoveryKind.After))) return linkPhase(link).detail;
    return this.lastIssue;
  }

  // Injection seams (overridable in tests): the real Obsidian-backed io + HTTP transport, and the
  // two static auth calls. A test subclass returns in-memory fakes so the whole producer→engine→
  // effect→reconcile wiring runs without Obsidian or a server.
  protected buildIo(): VaultIo { return new ObsidianVaultIo(this); }
  // The data-only io a composed-vault MOUNT scope wraps (MountedIo over this) — NOT subject to the primary's
  // mount-exclusion, so the mount can read/write its own subtree (D0039; the A1 fix).
  protected buildMountIo(): VaultIo { return new ObsidianVaultIo(this, true); }
  protected buildApi(token: string): ApiClient {
    return new HttpTransport(this.settings.serverUrl, token, this.settings.vaultId || "default", this.settings.vaultOwner || "", this.deviceId(), this.deviceLabel());
  }
  protected async loginRemote(): Promise<string> {
    // Re-login for an ALREADY-set-up account (its password was set at setup, so must-change is cleared);
    // we only need the token here. Forced-change is handled once, in the setup wizard.
    return (await HttpTransport.login(this.settings.serverUrl, this.settings.username, this.settings.password)).token;
  }

  async onload() {
    await this.loadSettings();
    await this.ensureDeviceId(); // durably mint the provenance UUID before any commit can stamp it (crit finding 4)
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
      onPhase: (p) => { this.renderLight(p); },
      onError: (where, e: any) => this.log(`${where} FAILED: ${e?.message ?? e}`),
      // Classify a transport failure into a typed class the engine's LinkState transitions on. Injected
      // because it needs settings context (is a password stored → can we silently re-login vs. must the
      // user reconfigure). Pure once the context is supplied.
      classify: (e) => classifyConnectError(toConnErrorInfo(e, this.hasStoredPassword())),
      scheduleRecovery: (rec) => this.scheduleRecovery(rec),
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

    this.addCommand({ id: "setup", name: "Set up / reconfigure connection", callback: () => this.openSetup() });
    this.addCommand({ id: "switch-vault", name: "Switch vault", callback: () => new SwitchVaultModal(this.app, this).open() });
    this.addCommand({ id: "redeem", name: "Redeem a share link", callback: () => this.openRedeem() });
    this.addCommand({ id: "resolve-conflicts", name: "Resolve conflicts", callback: () => this.openConflicts() });
    // On-demand TEXT readout of sync state — on mobile the persistent indicator is an icon in the sidebar
    // drawer with no reachable tooltip, so a one-tap "what's the status?" in words is the accessible path.
    this.addCommand({ id: "status", name: "Sync status", callback: () => { const d = this.statusDisplay(this.engine.phase()); new Notice(`SelfSync: ${d.label}${d.detail ? ` — ${d.detail}` : ""}`); } });
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
    // Mobile suspends the app (freezing timers) when backgrounded, so a config change made just before
    // backgrounding — or on another device while this one slept — isn't caught until the next scan
    // tick. On resume, force a config re-scan immediately instead of waiting up to CONFIG_SCAN_INTERVAL_MS.
    if (typeof document !== "undefined") this.registerDomEvent(document, "visibilitychange", () => { if (document.visibilityState === "visible") this.onResume(); });
    // Event-driven config detection where the `raw` FS event is unreliable (mobile): Obsidian's UI events
    // are proxies for "config probably changed" — a theme/snippet/appearance edit fires css-change; a
    // plugin enable/disable (or pane change) fires layout-change. Each just TRIGGERS the cheap config
    // scan (which figures out the actual diff), so the common config edits sync near-instantly instead
    // of waiting for the periodic backstop. Rate-limited (layout-change also fires on plain navigation).
    this.registerEvent(this.app.workspace.on("css-change", () => this.scheduleConfigScan()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleConfigScan()));

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
    // view.addAction() header buttons are NOT auto-cleaned by Obsidian on unload (unlike the ribbon /
    // status-bar items, which are). Without this, every plugin RELOAD/UPDATE orphans this instance's
    // in-editor icon and the next instance adds another — stacking a row of stale, frozen-phase sync
    // icons in the note header (field: 6 icons after several updates). Removing them here makes add
    // idempotent across reloads: unload leaves nothing behind, so the next load shows exactly one.
    for (const el of this.editorActionEls) el.remove();
    this.editorActionEls.clear();
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
  // a conflict-copy file beside the note. Conflict state is DERIVED PURELY FROM THE VAULT — a conflict
  // IS an owned conflict-copy file (strict naming scheme, D-conflict-model) — so there is no cached
  // array to drift: the list, count, and modal are a pure projection and can never go stale, show
  // dual-truth, or reference a file that no longer exists. Deleting/resolving a copy simply drops it.
  listNoteConflicts(): { copy: string; original: string }[] {
    const paths = this.app.vault.getFiles().map((f) => f.path);
    const present = new Set(paths);
    // A genuine conflict copy always sits beside its original (we adopt the other version INTO the
    // original when spawning the copy). If the original is ABSENT, this isn't a live conflict — it's
    // an orphan copy (already resolved) or a user file that merely LOOKS like a copy; don't flag it,
    // and never offer a real note (whose "copy" doesn't exist) as a deletable version (critique F5).
    return deriveNoteConflicts(paths).filter((c) => present.has(c.original));
  }
  openNoteConflicts() { new NoteConflictModal(this.app, this).open(); }
  openRedeem() { new RedeemShareLinkModal(this.app, this).open(); }
  // One entry for "resolve conflicts" (command + any surfaced affordance): route to whichever kind is
  // pending — note conflicts first, else config; if neither, say so rather than opening an empty modal.
  openConflicts() {
    if (this.listNoteConflicts().length) return void new NoteConflictModal(this.app, this).open();
    if (this.getConfigConflicts().length) return void new ConfigConflictModal(this.app, this).open();
    new Notice("SelfSync: no conflicts to resolve — everything is in sync.");
  }
  // Text of a file for the conflict preview ("" if gone or unreadable).
  async readTextOrEmpty(path: string): Promise<string> {
    try { return new TextDecoder().decode(await this.io.read(path)); } catch { return ""; }
  }
  // Raw bytes of a file (null if gone/unreadable) — used by the conflict modal to compare content
  // WITHOUT a lossy UTF-8 round-trip, so a binary attachment is never mis-compared (critique F1).
  async readBytesOrNull(path: string): Promise<Uint8Array | null> {
    try { return await this.io.read(path); } catch { return null; }
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
      // Idempotent: if the copy is already gone (resolved elsewhere / on another device), there's
      // nothing to promote — treat as resolved rather than throwing (the derived list drops it).
      if (!(await this.io.exists?.(copy) ?? true)) return true;
      const bytes = await this.io.read(copy);
      // Re-check the stale-preview guard IMMEDIATELY before the write: the guard above and this read
      // both yield to the event loop, and the modal runs OUTSIDE the engine queue, so a reconcile
      // could have pulled a newer `original` in the gap — don't clobber it (critique F3; narrows the
      // window to this no-await span).
      if (previewedOther !== undefined && (await this.readTextOrEmpty(original)) !== previewedOther) {
        new Notice("SelfSync: that file changed since you opened this — review it again");
        return false;
      }
      await this.io.write(original, bytes);
      this.engine.enqueue({ kind: "path", path: original, size: bytes.byteLength });
    }
    await this.io.remove(copy); // io.remove is a no-op if the file is already gone (idempotent)
    this.engine.enqueue({ kind: "path", path: copy, size: 0 });
    // No cache to clear — the conflict was DERIVED from the copy file; deleting it clears the conflict.
    this.settingsRefresh?.(); this.statusListener?.();
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
  // Per-surface FIRST-CONTACT direction, set when the user turns a config surface on (see
  // setConfigSurface). Session-transient (in-memory): consumed by recordConfigConflict to auto-resolve
  // the surface's initial divergence in the chosen direction instead of prompting. A later concurrent
  // edit (which has a shared base) still prompts, so a lingering entry only ever governs a genuinely
  // NEW no-base file in that surface — where reusing the surface's chosen direction is the right intent.
  private pendingConfigDir = new Map<ConfigSurface, ConfigDirection>();
  markPendingConfigDir(surface: ConfigSurface, dir: ConfigDirection): void {
    // Read-only shares can only ever DOWNLOAD (we never push) — force it regardless of what was asked.
    this.pendingConfigDir.set(surface, this.settings.vaultReadOnly ? "download" : dir);
  }
  // Toggle a config surface on/off from the settings UI. Turning ON records the first-contact direction
  // (download/upload) so the initial divergence auto-resolves that way rather than prompting per file.
  async setConfigSurface(surface: ConfigSurface, on: boolean, dir?: ConfigDirection): Promise<void> {
    (this.settings.configSync as unknown as Record<string, boolean>)[surface] = on;
    if (on && dir) this.markPendingConfigDir(surface, dir);
    else this.pendingConfigDir.delete(surface);
    await this.applyConfigSyncChange();
  }

  // The Community surface's chosen first-contact direction (transient) — the DEFAULT for a newly-synced
  // plugin's own direction.
  communityConfigDir(): ConfigDirection | undefined { return this.pendingConfigDir.get("community"); }
  // Add/remove a community plugin from the sync allowlist. On add, record its first-contact direction
  // (defaulting to the Community surface's, else download; a read-only vault can only download).
  async setPluginSync(id: string, on: boolean, dir?: ConfigDirection): Promise<void> {
    const cs = this.settings.configSync;
    const set = new Set(cs.pluginAllow);
    if (on) set.add(id); else set.delete(id);
    cs.pluginAllow = [...set];
    if (on) (cs.pluginDir ??= {})[id] = this.settings.vaultReadOnly ? "download" : (dir ?? this.communityConfigDir() ?? "download");
    await this.applyConfigSyncChange();
  }
  // Deliberately force ONE synced plugin's files to a side NOW — the honest replacement for the old
  // "first-contact direction" dropdown, which was inert once the plugin had a shared base (it only ever
  // governed a no-base first contact). PUSH makes the server (and other devices) match THIS device;
  // PULL replaces this device's copy with the server's. Each is an authoritative overwrite of exactly
  // this plugin's folder (.obsidian/plugins/<id>/**), acting on the UNION of local+server files so a
  // file only one side has is added/removed accordingly. Reuses the tested per-path resolveConfigConflict.
  async pushPlugin(id: string): Promise<number> { return this.forcePlugin(id, "local"); }
  async pullPlugin(id: string): Promise<number> { return this.forcePlugin(id, "remote"); }
  private async forcePlugin(id: string, choice: "local" | "remote"): Promise<number> {
    if (!this.api) { new Notice("SelfSync: connect first, then push or pull a plugin"); return 0; }
    // Defense in depth: never push to a read-only share (the UI only offers Push on a read-write vault).
    if (choice === "local" && this.settings.vaultReadOnly) { new Notice("SelfSync: this is a read-only vault — you can only pull"); return 0; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) { new Notice(`SelfSync: '${id}' is not a valid plugin id`); return 0; }
    // HARD guard: never push/pull SelfSync's OWN folder — its data.json holds this device's server +
    // credentials, which must never sync. forcePlugin BYPASSES shouldSync, so it uses the SAME shared
    // self-exclusion (case-insensitive + LEGACY_SELF_IDS), not a weaker exact-case check (critique #1).
    if (isSelfPluginId(id, this.selfFolderId())) { new Notice("SelfSync: can't push or pull SelfSync itself"); return 0; }
    const d = this.deps();
    const local = [...(await d.io.list()).keys()];
    const server = (await d.api.changes(0)).upserts.map((f) => f.path);
    const paths = pluginFilePaths(local, server, id);
    const nm = this.getPluginDisplayName(id) || id;
    // Not atomic (each resolve re-bases its own path), so a mid-loop failure leaves a PARTIAL overwrite —
    // report it instead of swallowing the rejection (critique #2); the rest reconciles on the next sync.
    let done = 0;
    let failed: unknown = null;
    try { for (const p of paths) { await resolveConfigConflict(d, p, choice); done++; } }
    catch (e) { failed = e; }
    void this.persist(); // the base changed
    this.settingsRefresh?.();
    if (failed) {
      new Notice(`SelfSync: ${choice === "local" ? "push" : "pull"} of ${nm} stopped after ${done}/${paths.length} file(s): ${(failed as { message?: string })?.message ?? failed}. The rest will reconcile on the next sync — you can retry.`, 10000);
      return done;
    }
    new Notice(`SelfSync: ${choice === "local" ? "pushed" : "pulled"} ${nm} — ${paths.length} file${paths.length === 1 ? "" : "s"} ${choice === "local" ? "to the server" : "from the server"}.`, 7000);
    if (choice === "remote") new Notice("SelfSync: fully close and reopen Obsidian to load the updated plugin.", 8000);
    return done;
  }
  // Preview for the Push/Pull confirm (nPushPullPreview): classify what an authoritative Push/Pull will do
  // to each file of this plugin's folder + expose a LAZY per-file content diff — so the overwrite is an
  // INFORMED choice, not a blind one. Pure classification/diff live in pushpreview.ts; this only gathers the
  // local + server hashes they need. Read-only (hashes + on-demand fetches, never mutates); null if offline.
  // Uses the SAME union (pluginFilePaths) + hash basis (server FileMeta.hash vs local sha256, both whole-file
  // sha256 for un-normalized config) as forcePlugin, so the preview can't disagree with what Push/Pull does.
  async pluginPushPullPreview(id: string, direction: PushDirection): Promise<PluginPushPreview | null> {
    if (!this.api) { new Notice("SelfSync: connect first to preview a push or pull"); return null; }
    if (isSelfPluginId(id, this.selfFolderId())) return null; // never inspect SelfSync's own credential folder
    const d = this.deps();
    // SCOPED local walk (perf, owner-reported ~2s on mobile): only this plugin's folder, not the whole vault
    // + entire .obsidian tree. pluginFilePaths filters to the prefix anyway, so notes/other config are noise.
    const adapter = this.app.vault.adapter as unknown as WalkAdapter;
    const { entries: local } = await walkConfigTree(`.obsidian/plugins/${id}`, adapter, (p) => !isJunkFile(p), CONFIG_ENUM_CONCURRENCY, () => {});
    const serverMetas = new Map((await d.api.changes(0)).upserts.map((f) => [f.path, f] as const));
    const paths = pluginFilePaths([...local.keys()], [...serverMetas.keys()], id);
    // Memory bounds (crit finding 1): the real pull STREAMS big files to disk, so the preview must not slurp
    // them whole. Read a local file to hash ONLY when it's small AND same-size as the server's (the only case
    // where a hash tells us more than the size already does); a differing size already means "differs", and a
    // large file is left content-uncompared (→ conservatively an overwrite). Diffs are size-gated below too.
    const HASH_CAP = 1 << 20;       // 1 MiB — above this, don't read a file just to hash it
    const files: { path: string; local: SideState; server: SideState }[] = [];
    for (const p of paths) {
      const meta = serverMetas.get(p);
      const server: SideState = meta ? { present: true, hash: meta.hash } : { present: false };
      const lEntry = local.get(p);
      let localSide: SideState;
      if (!lEntry) {
        localSide = { present: false };
      } else if (meta && meta.size === lEntry.size && lEntry.size <= HASH_CAP) {
        // Ambiguous (same size, small): a hash resolves unchanged-vs-overwrite. An unreadable file matches
        // what the REAL action sees — push's readOrNull treats it as absent (→ delete), pull's applyPull
        // overwrites the existing file — so presence is direction-aware here.
        try { localSide = { present: true, hash: await sha256hex(await d.io.read(p)) }; }
        catch { localSide = direction === "push" ? { present: false } : { present: true }; }
      } else {
        // Different size (→ definitely differs) or large (→ don't read): present, content uncompared.
        localSide = { present: true };
      }
      files.push({ path: p, local: localSide, server });
    }
    // Enrich each change with the SERVER copy's provenance (nChangeAttribution) — WHO last wrote it + WHEN —
    // so a Push shows whose settings you're overwriting and a Pull shows whose you're adopting. Only where a
    // server copy exists (m present); a local-only file carries none.
    const changes: FileChangeView[] = classifyPushPull(files, direction).map((c) => {
      const m = serverMetas.get(c.path);
      return { ...c, author: m?.author, deviceName: m?.deviceName, mtime: m?.mtime };
    });
    const dev = this.deviceLabel();
    const DIFF_CAP = 512 << 10; // 512 KiB — above this, "Show diff" won't fetch/decode the file
    // A changed TEXT file's diff, loaded ON DEMAND (only when its row is expanded): old = the TARGET being
    // overwritten, new = the SOURCE winning. Size-gated before any fetch; non-utf8 → "binary".
    const loadDiff = async (path: string): Promise<DiffLine[] | "binary" | "too-large"> => {
      const meta = serverMetas.get(path);
      if (Math.max(local.get(path)?.size ?? 0, meta?.size ?? 0) > DIFF_CAP) return "too-large";
      const dec = (b: Uint8Array): string | null => { try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; } };
      const localText = local.has(path) ? dec(await d.io.read(path)) : "";
      const serverText = meta ? dec(await fetchFileBytes(d.api, d.cache, meta.chunks)) : "";
      if (localText === null || serverText === null) return "binary";
      const [oldT, newT] = direction === "push" ? [serverText, localText] : [localText, serverText];
      return lineDiff(oldT, newT) ?? "too-large";
    };
    return {
      direction,
      name: this.getPluginDisplayName(id) || id,
      fromLabel: direction === "push" ? `this device (${dev})` : "the server",
      toLabel: direction === "push" ? "the server + your other devices" : `this device (${dev})`,
      changes,
      loadDiff,
    };
  }

  // Instant, NETWORK-FREE grey-out signal (nPushPullPreview, owner-directed): is this plugin's folder already
  // CONVERGED (local == the last-synced base)? When true, both Push and Pull are no-ops (the server already
  // holds our content and we already hold the server's), so the settings UI greys the buttons — WITHOUT the
  // ~2s whole-vault-list + full-server-fetch the real preview needs. Compares the base's persisted (size,mtime)
  // stamps to a SCOPED local walk of just this folder; no hashing, no server call. Eventually-consistent: it
  // reflects the last sync (a not-yet-polled remote change auto-applies on the next poll anyway), and the
  // fresh accurate preview still runs on click. Conservative on ANY doubt (recorded conflict, unlistable
  // folder, missing stamp) → false, so a genuinely-actionable button is never wrongly greyed.
  async pluginSyncClean(id: string): Promise<boolean> {
    if (isSelfPluginId(id, this.selfFolderId())) return true; // SelfSync's own folder never pushes/pulls → always "grey"
    const prefix = `.obsidian/plugins/${id}/`;
    if (this.settings.configConflicts.some((p) => p.startsWith(prefix))) return false; // a recorded divergence → actionable
    const base = this.base.paths().filter((p) => p.startsWith(prefix))
      .map((p) => { const e = this.base.get(p); return { path: p, size: e?.size, mtime: e?.mtime }; });
    const adapter = this.app.vault.adapter as unknown as WalkAdapter;
    let local: Map<string, { mtime: number; size: number }>;
    try {
      const { entries } = await walkConfigTree(`.obsidian/plugins/${id}`, adapter, (p) => !isJunkFile(p), CONFIG_ENUM_CONCURRENCY, (_dir, e) => { throw e; });
      local = entries;
    } catch { return false; } // can't inspect the folder → keep the buttons live (safe)
    return stampsConverged(base, local);
  }

  // Community-plugin ids the SERVER holds (from the last full reconcile) — lets the settings UI offer
  // plugins this device hasn't installed yet, so a fresh vault can adopt an existing vault's plugin set.
  private serverPluginIds = new Set<string>();
  private serverPluginAuthors = new Map<string, string | undefined>(); // id -> main.js committer (who wrote the code)
  getServerPluginIds(): string[] { return [...this.serverPluginIds]; }
  private setServerPlugins(plugins: { id: string; author?: string }[]): void {
    const self = this.selfFolderId();
    const next = new Set<string>();
    const authors = new Map<string, string | undefined>();
    for (const { id, author } of plugins) { if (id && id !== self) { next.add(id); authors.set(id, author); } }
    this.serverPluginAuthors = authors; // always refresh (author can change even when the id set doesn't)
    if (next.size === this.serverPluginIds.size && [...next].every((id) => this.serverPluginIds.has(id))) return; // id set unchanged
    this.serverPluginIds = next;
    this.settingsRefresh?.(); // a newly-discovered server plugin should appear in the list
  }
  // Best-effort DISPLAY NAME for a synced-but-not-yet-loaded plugin (issuePluginSyncFolderIdNotName):
  // Obsidian's app.plugins.manifests only has INSTALLED (loaded-at-startup) plugins, so an ADOPTED plugin
  // whose files synced to disk but hasn't been loaded yet showed its folder id. Its manifest.json IS on
  // disk (synced), so read the real "name" from there — cached; returns undefined until the async read
  // resolves (then re-renders the settings). A not-on-disk id (not adopted) keeps the folder id, which is
  // honest there. `null` = looked up, no name (don't re-read).
  private pluginNameCache = new Map<string, string | null>();
  getPluginDisplayName(id: string): string | undefined {
    const cached = this.pluginNameCache.get(id);
    if (cached !== undefined) return cached ?? undefined;
    this.pluginNameCache.set(id, null); // mark looked-up so we don't stack reads on every render
    void (async () => {
      try {
        const name = (JSON.parse(await this.app.vault.adapter.read(`.obsidian/plugins/${id}/manifest.json`)) as { name?: unknown }).name;
        if (typeof name === "string" && name) { this.pluginNameCache.set(id, name); this.settingsRefresh?.(); }
      } catch { /* not on disk (not adopted / not yet downloaded) → keep the folder id */ }
    })();
    return undefined;
  }
  // Adopt EVERY community plugin the server holds (the fresh-vault bootstrap) — download-only for the
  // ones not installed here (they pull + install). Community surface must be on for these to sync.
  async installAllServerPlugins(): Promise<void> {
    for (const id of this.serverPluginIds) await this.setPluginSync(id, true, "download");
  }

  // --- plugin-sync AUTOPILOT (nPluginSyncAutopilot) --------------------------------------------------
  // Peer-added server plugins NOT auto-adopted — they await your explicit approval. id -> the account that
  // added them. Rebuilt each autopilot pass; surfaced persistently in settings + a one-time toast each.
  private pendingPeerPlugins = new Map<string, string>();
  private peerPluginToasted = new Set<string>();
  private autopilotBusy = false;
  getPendingPeerPlugins(): { id: string; author: string }[] { return [...this.pendingPeerPlugins].map(([id, author]) => ({ id, author })); }

  // Set-and-forget: auto-sync YOUR OWN new plugins everywhere; a plugin added by ANOTHER PERSON never
  // auto-adopts (it waits for approval). No-op unless the setting is on + the community surface is on.
  // Idempotent (only adds plugins not already synced) + re-entrancy-guarded; applyConfigSyncChange just
  // persists + enqueues a reconcile, so the next pass finds nothing new and stops. Runs on each full
  // reconcile (onRemotePlugins) + when the settings tab renders.
  async runPluginAutopilot(): Promise<void> {
    if (!this.settings.autoSyncNewPlugins || !this.api || this.autopilotBusy) return;
    const cs = this.settings.configSync;
    if (!cs.community) return; // the community surface must be on for any plugin to sync
    this.autopilotBusy = true;
    try {
      const self = this.selfFolderId();
      const allow = new Set(cs.pluginAllow);
      const before = allow.size;
      const seen = new Set(this.settings.autopilotSeen ?? []); // ids already observed → NOT re-added (respects un-ticks)
      const pm = (this.app as unknown as { plugins?: { manifests?: Record<string, unknown> } }).plugins;
      const installedIds = Object.keys(pm?.manifests ?? {}).filter((id) => !isSelfPluginId(id, self));
      const serverIds = [...this.serverPluginIds].filter((id) => !isSelfPluginId(id, self));
      // (a) LOCAL: a plugin installed HERE, not synced, and NEW (never observed) → auto-add (it's yours).
      for (const id of installedIds) {
        if (!allow.has(id) && !seen.has(id)) { allow.add(id); (cs.pluginDir ??= {})[id] = this.settings.vaultReadOnly ? "download" : "upload"; }
      }
      // (b) SERVER: classify every not-yet-adopted plugin. YOURS (manifest author == you, or unknown on your
      // own PRIVATE vault) → auto-adopt IF new. ANOTHER PERSON's → never auto-adopt; it's added to the
      // persistent approval list (rebuilt EVERY pass, seen or not, so an unapproved peer plugin never
      // disappears) + a one-time toast. Author is server-authenticated, so a device rename can't fake it.
      // Re-derive vault privacy FRESH (like the hot-load gate) before the unknown-author→own decision, so a
      // vault that became shared out-of-band can't misclassify a peer's plugin as yours. Only when it matters:
      // an un-adopted server plugin whose code has NO recorded author (the only case vaultIsPrivate decides).
      if (serverIds.some((id) => !allow.has(id) && !this.serverPluginAuthors.get(id))) await this.refreshVaultPrivacy();
      const pending = new Map<string, string>();
      for (const id of serverIds) {
        if (allow.has(id)) continue;
        const author = this.serverPluginAuthors.get(id); // the main.js committer (who wrote the code), from the manifest — no fetch
        const mine = author === this.settings.username || (!author && this.vaultIsPrivate);
        if (mine) {
          if (!seen.has(id)) { allow.add(id); (cs.pluginDir ??= {})[id] = "download"; }
          seen.add(id); // observed as mine → won't re-adopt after an un-tick
        } else {
          pending.set(id, author ?? "someone else");
          // NOT marked seen (F4): if its code later becomes yours, it should auto-adopt then. Toast once.
          if (!this.peerPluginToasted.has(id)) {
            this.peerPluginToasted.add(id);
            new Notice(`SelfSync: ${author ?? "someone else"} added the plugin '${this.getPluginDisplayName(id) || id}' — approve it in Settings to use it here.`, 10000);
          }
        }
      }
      this.pendingPeerPlugins = pending;
      // Mark every LOCAL plugin observed this pass as seen so an un-tick sticks (peer-pending ids are left
      // un-seen above so a later ownership flip can still auto-adopt).
      for (const id of installedIds) seen.add(id);
      this.settings.autopilotSeen = [...seen];
      if (allow.size !== before) {
        cs.pluginAllow = [...allow];
        await this.applyConfigSyncChange(); // persist + enqueue a reconcile to sync the newly-allowed plugins
      } else {
        await this.saveSettings(); // persist the observed set even when nothing was added
      }
      this.settingsRefresh?.();
    } finally { this.autopilotBusy = false; }
  }
  // Explicit PURGE (issuePluginSyncStaleServerState): a DELIBERATE, user-initiated removal of ONE plugin's
  // files from the server, so a plugin you stopped using no longer lingers in the sync. This is NOT the
  // passive-disable path (the grow-only enabled-list is deliberately untouched, so this can never cascade
  // into 'all my plugins vanished'); it's a bounded, one-plugin delete-remote the user asks for. Also drops
  // the id from THIS device's allowlist (so it stops re-pushing) + the server-plugins view. Returns the
  // count deleted. Note: if ANOTHER device still actively syncs the plugin, it can re-push it (honest — that
  // device wants it); a fleet-wide tombstone was deliberately NOT chosen (would change the catastrophe-proof
  // merge). Local installed copy is untouched.
  async removePluginFromServer(id: string): Promise<number> {
    if (!this.api) { new Notice("SelfSync: connect first, then remove a plugin from the server"); return 0; }
    // S3 (2026-08-02): `id` is a single plugin-folder SEGMENT and (via pluginIdOf) is server/peer-influenced.
    // Validate it before it builds a delete prefix, so a crafted id (`..`, a slash, empty) can never widen the
    // deletion beyond one plugin folder. A real Obsidian plugin id starts alphanumeric and has no separators.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) { new Notice(`SelfSync: '${id}' is not a valid plugin id`); return 0; }
    const api = this.api;
    const manifest = await api.changes(0);
    const prefix = `.obsidian/plugins/${id}/`;
    const paths = manifest.upserts.map((f) => f.path).filter((p) => p.startsWith(prefix));
    for (const p of paths) { await api.deleteFile(p); this.base.delete(p); } // explicit gesture → not subject to the passive bulk-delete guard
    const cs = this.settings.configSync;
    cs.pluginAllow = cs.pluginAllow.filter((x) => x !== id); // stop THIS device re-pushing it
    if (cs.pluginDir) delete cs.pluginDir[id];
    this.serverPluginIds.delete(id); // drop from the synced-plugins view immediately
    void this.persist(); // the base changed (entries dropped)
    await this.saveSettings();
    this.settingsRefresh?.();
    return paths.length;
  }

  private recordConfigConflict(path: string, reason: string): void {
    // First-contact divergence for a surface the user just enabled with an explicit direction →
    // auto-resolve that way (adopt synced / keep this device's) instead of queuing a human prompt.
    // A community-plugin path uses its OWN per-plugin direction when set, else the surface's.
    const surface = configSurfaceOf(path);
    let dir = surface ? this.pendingConfigDir.get(surface) : undefined;
    const pid = pluginIdOf(path);
    if (pid) { const pd = this.settings.configSync.pluginDir?.[pid]; if (pd) dir = pd; }
    if (dir && this.settings.vaultReadOnly) dir = "download"; // read-only can only ever download
    // Explicit, enumerated adjudication (D3): auto-resolve this way, or queue for the human — never both.
    const adj = adjudicateConfigConflict(reason, surface, dir);
    if (adj.kind === "auto") {
      void resolveConfigConflict(this.deps(), path, adj.choice); // reuses the tested adjudication apply
      this.log(`config first-contact for '${path}': ${adj.choice === "remote" ? "adopted the synced copy" : "kept this device's"} (chosen when enabling ${surface} sync)`);
      return;
    }
    if (this.settings.configConflicts.includes(path)) return; // already queued for the human
    this.settings.configConflicts.push(path);
    void this.saveSettings();
    this.log(`config differs across devices: '${path}' (${reason}) — kept as-is on each device; resolve in Settings → Conflicts`, true);
    this.settingsRefresh?.(); this.statusListener?.();
  }
  // C2 guard fired for a path (server manifest empty while we hold it in history — refused to
  // delete). Log each path, but COALESCE the toast: a bulk empty-manifest read (e.g. a transient
  // during a vault switch) trips this for many files at once, and 13 alarming toasts read like a
  // failure when nothing is wrong. One calm summary per burst instead; detail stays in the log.
  // The DEFAULT deps.onGuard — used by the single-path EVENT route (reconcilePath), whose retained
  // empty-manifest C2 guard can hold one file. LOG-only: the reviewable D0041 flow (with the toast) is driven
  // by the full/delta passes via setPendingBulk, so this must NOT claim a review that doesn't exist (R11-F3).
  private noteGuard(path: string): void {
    this.log(`held '${path}' — the server manifest looked empty, so it wasn't deleted (a full scan will re-evaluate it)`);
  }

  // Files present on the server that this device is set NOT to sync (a config surface is off, or a
  // community plugin isn't in the allowlist). These are NOT pending work — they'll never transfer until
  // the user opts in — so we report them separately (answering "what's it trying to process?" and "how
  // do I sync a plugin to this vault?"). Logged only when the set CHANGES, so a poll can't spam it.
  private declinedSig = "";
  private noteDeclined(paths: string[]): void {
    const sig = paths.slice().sort().join("|");
    if (sig === this.declinedSig) return;
    this.declinedSig = sig;
    const plugins = new Set<string>(); let files = 0;
    for (const p of paths) { const id = pluginIdOf(p); if (id) plugins.add(id); else files++; }
    const parts: string[] = [];
    if (plugins.size) parts.push(`${plugins.size} community plugin${plugins.size === 1 ? "" : "s"} (${[...plugins].slice(0, 6).join(", ")}${plugins.size > 6 ? "…" : ""})`);
    if (files) parts.push(`${files} config file${files === 1 ? "" : "s"}`);
    this.log(`${parts.join(" and ")} on the server ${paths.length === 1 ? "is" : "are"} NOT in this device's sync selection — turn them on in Settings → Obsidian configuration (tick the plugins under “Synced community plugins”) to sync them here. These are not counted as pending.`, false);
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
        this.openSetup(); // guarded against stacking by setupOpen
        throw new ConnError("session expired — please re-enter your password in setup", { synthetic: SyntheticKind.SessionExpired, wasLogin: false, endpoint: Endpoint.Other });
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

  // A server auth rejection (401) — the reactive signal that replaces the proactive probe. Reads the TYPED
  // ConnError's status (the message string carries the server body "unauthorized", NOT "HTTP 401", so the
  // old /HTTP 401/ regex never matched a real 401 — the bug that made a rejected sign-in loop). A legacy
  // fallback regex stays for any non-ConnError path.
  private isAuthError(e: unknown): boolean {
    if (e instanceof ConnError) return e.info.status === 401;
    return /HTTP 401/.test(e instanceof Error ? e.message : String(e));
  }
  // Can we silently re-login? Only if a password is actually stored on this device (token-only ⇒ no).
  private hasStoredPassword(): boolean { return this.settings.storePassword && !!this.settings.password; }

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

  // A reconcile EFFECT hits the API directly (unlike doConnect, which re-logs-in once on a 401 BEFORE it
  // reconciles). So a routine token expiry DURING a connected session — on the poll/delta path — used to go
  // straight to the classifier and strand the user in a false "sign-in rejected — check your password"
  // block for up to the 600s self-heal reprobe (permanently on a WS-less client): the inverse of the
  // auth-storm the FSM fixed. Re-run the effect ONCE after a single silent re-login when we CAN (a password
  // is stored); a second 401 — or no stored password to renew with — propagates to classify → the correct
  // blocked / re-auth state. Rebuilds `this.api` on the fresh token so the retry uses it. (fix ② 2026-08-01)
  private async withSyncRelogin<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      if (!this.isAuthError(e) || !this.hasStoredPassword()) throw e;
      this.log("sync token rejected mid-session — re-logging in once");
      this.settings.authToken = undefined;
      const t = await this.freshLogin();
      this.api = this.buildApi(t);
      return await fn();
    }
  }

  // Unbind this vault (keep local files); return to the unconfigured state.
  async disconnect() {
    this.settings.vaultId = "";
    this.lastIssue = undefined; // F2: clear the transient reason too (the engine resets LinkState) — a
    await this.saveSettings();  // user-initiated disconnect is not an error state to keep reporting
    this.engine.enqueue({ kind: "disconnect" }); // → teardown (stops timers + closes ws), state off
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
  // FORK: copy the CURRENT vault's local content into a NEW vault you own, and switch this device to it
  // (the original is untouched). Especially useful on a read-only shared vault — it yields your own
  // editable copy. Reuses the tested primitives: create the empty vault, then switch to it in UPLOAD
  // mode (push everything local into it). Owner is cleared + read-only false → the fork is yours to edit.
  async forkVault(name: string): Promise<void> {
    await this.createRemoteVault(name);
    await this.switchToVault(name, "upload", "", false);
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
  // D0037: shareVault (grantee-username) retired — access is granted by redeeming a share link.
  // unshareVault (revoke) stays: a redeemed link mints the same grant, revoked the same way.
  async unshareVault(vault: string, grantee: string): Promise<void> {
    await this.withAuth((t) => HttpTransport.shareDelete(this.settings.serverUrl, t, vault, grantee));
    await this.refreshVaultPrivacy();
  }
  // D0023 capability share-links. Create returns the full selfsync-share:// link to hand out (Copy).
  async createShareLink(vault: string, perm: SharePerm, label = "", ttlSecs?: number): Promise<string> {
    const linkToken = await this.withAuth((t) => HttpTransport.createShareLink(this.settings.serverUrl, t, vault, perm, label, ttlSecs));
    await this.refreshVaultPrivacy();
    return encodeShareLink({ server: this.settings.serverUrl, token: linkToken });
  }
  listShareLinks(): Promise<ShareLinkInfo[]> {
    return this.withAuth((t) => HttpTransport.listShareLinks(this.settings.serverUrl, t));
  }
  async revokeShareLink(id: string): Promise<void> {
    await this.withAuth((t) => HttpTransport.revokeShareLink(this.settings.serverUrl, t, id));
    await this.refreshVaultPrivacy();
  }
  // SECURITY GATE for hot-loading synced plugins: a plugin's code arriving via sync is only safe to
  // auto-execute (loadManifests + enablePlugin, no restart) when NO ONE ELSE can write to this vault — i.e.
  // it is OUR OWN vault (not shared TO us) AND has no readWrite grant or link to anyone. Otherwise a peer /
  // shared-vault owner could push malicious main.js that runs on this device (the RCE the restart barrier
  // prevents). Fail-safe: any doubt / error ⇒ NOT private ⇒ keep the restart gate. Refreshed on connect +
  // whenever a share changes.
  private vaultIsPrivate = false;
  async refreshVaultPrivacy(): Promise<void> {
    if (this.settings.vaultOwner) { this.vaultIsPrivate = false; return; } // a vault shared TO us — never hot-load
    try {
      const mine = (await this.myVaultShares()).find((v) => v.vault === this.settings.vaultId);
      const hasRwGrant = !!mine?.grants.some((g) => g.perm === "readWrite");
      const hasRwLink = (await this.listShareLinks()).some((l) => l.vault === this.settings.vaultId && l.perm === "readWrite");
      this.vaultIsPrivate = !hasRwGrant && !hasRwLink;
    } catch { this.vaultIsPrivate = false; } // fail SAFE: on any doubt, keep the restart gate
  }
  // Redeem a pasted share-link: it must be for the server this device is configured against (the token
  // is server-specific; cross-server redemption needs an account there first). Binds a grant to this
  // account and returns {owner,vault,perm} so the caller can offer to switch to the shared vault.
  async redeemShareLink(link: string): Promise<SharedVaultRef> {
    const { server, token } = parseShareLink(link);
    const err = redeemTargetError(server, this.settings.serverUrl); // guards not-set-up + wrong-server
    if (err) throw new Error(err);
    return this.withAuth((t) => HttpTransport.redeemShareLink(this.settings.serverUrl, t, token));
  }

  // Single entry point for "I have a share link". If this device is already signed in to the link's
  // server, redeem now and tell the user to Switch to it (they keep their current vault). Otherwise the
  // link IS the onboarding: open the setup wizard in redeem mode (server prefilled from the link) so it
  // walks the user through sign-in and then redeems + adopts the shared vault automatically.
  async startRedeem(link: string): Promise<void> {
    let server: string;
    try { server = parseShareLink(link).server; } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); return; }
    if (redeemTargetError(server, this.settings.serverUrl)) {
      new SetupWizardModal(this.app, this, { shareLink: link }).open();
      return;
    }
    try {
      const ref = await this.redeemShareLink(link);
      // Redeem only ADDS the grant — the user still has to switch this device to it. Don't leave that
      // second step to a toast they might miss; open the Switch modal (the redeemed vault is in its
      // "Shared with you" list) so the flow reads to completion, matching the wizard's auto-adopt path.
      new Notice(`SelfSync: added ${ref.owner}/${ref.vault} (${ref.perm === "readWrite" ? "read-write" : "read-only"}) — choose it below to sync this device to it.`, 8000);
      new SwitchVaultModal(this.app, this).open();
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`, 9000); }
  }
  // Grantee leaves/declines a shared vault — drops THIS account's own access. If we're currently
  // syncing it, stop (the grant is gone; further sync would 403) and leave local files in place.
  async leaveSharedVault(owner: string, vault: string): Promise<void> {
    await this.withAuth((t) => HttpTransport.leaveShare(this.settings.serverUrl, t, owner, vault));
    if (this.settings.vaultOwner === owner && this.settings.vaultId === vault) await this.disconnect();
  }

  private shareRevokedNotified = false;
  // Re-derive our access to a vault shared BY someone else from the server's authoritative grant list,
  // making the cached vaultOwner/vaultReadOnly a pure projection of the server rather than a copy frozen
  // at redeem time (see resolveShareGrant). Runs on every connect BEFORE the first reconcile, so a
  // read↔write change takes effect immediately and a revoked grant stops us before a push would 403.
  // Own vaults short-circuit with no extra call. Throws on revocation → offline with a clear, actionable
  // card message; recovers automatically if the owner re-grants (the next connect re-checks).
  private async refreshShareGrant(token: string): Promise<void> {
    if (!this.settings.vaultOwner) return;
    const grants = await HttpTransport.listShared(this.settings.serverUrl, token);
    const g = resolveShareGrant(grants, this.settings.vaultOwner, this.settings.vaultId);
    if (g.status === "revoked") {
      this.lastIssue = `The owner removed your access to ${this.settings.vaultOwner}/${this.settings.vaultId}. Your local copy is untouched — Switch to another vault, or Leave this one, in Settings.`;
      this.log(this.lastIssue, !this.shareRevokedNotified); // toast once per revocation episode, not every backoff retry
      this.shareRevokedNotified = true;
      throw new Error("share access revoked");
    }
    this.shareRevokedNotified = false;
    if (g.status === "active" && g.readOnly !== Boolean(this.settings.vaultReadOnly)) {
      this.settings.vaultReadOnly = g.readOnly;
      await this.saveSettings();
      this.log(`share permission updated: ${this.settings.vaultOwner}/${this.settings.vaultId} is now ${g.readOnly ? "read-only" : "read-write"}`);
    }
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

  // Provenance (author/device) of each pending config change, recorded by reconcile as the remote change
  // is applied (deps.onRemoteConfig) and consumed by flushConfigReload to decide — purely by SOURCE — whether
  // a reload notice fires. Keyed by the same paths as pendingReload; cleared alongside it.
  private configProvenance = new Map<string, ChangeProvenance>();
  recordIncomingConfig(path: string, meta: FileMeta) {
    this.configProvenance.set(path, { author: meta.author, deviceId: meta.deviceId, deviceName: meta.deviceName });
  }
  // This device's identity for the source-of-change decision (account + stable UUID).
  private selfIdentity(): SelfIdentity { return { user: this.settings.username, deviceId: this.deviceId() }; }
  // The provenance of the first change among `paths` whose SOURCE should notify (per the notify mode), or
  // null if every change was your own (→ stay silent / log). Drives the actionable "<who> changed …" notice.
  // A path with no recorded provenance is treated as unknown-author → notify (conservative).
  private notifiableConfigSource(paths: string[]): ChangeProvenance | null {
    const self = this.selfIdentity();
    const mode = this.settings.configChangeNotify;
    for (const p of paths) {
      const prov = this.configProvenance.get(p) ?? {};
      if (shouldNotifyConfigChange(prov, self, mode)) return prov;
    }
    return null;
  }

  async flushConfigReload(): Promise<void> {
    if (this.pendingReload.size === 0) return;
    const paths = [...this.pendingReload];
    this.pendingReload.clear();

    // SECURITY (Round-6 SEC): config that arrives via SYNC can carry UNTRUSTED, executable content.
    // A share peer — OR the owner of a vault shared with you — can commit community-plugin CODE
    // (.obsidian/plugins/<id>/main.js) or theme/snippet CSS (exfil/phishing via Obsidian's un-CSP'd
    // renderer). The base rule stays: surface a reload notice; the user applies changes explicitly.
    // NARROW EXCEPTION (owner-accepted, scoped): on a PROVABLY-PRIVATE vault — OUR OWN vault with NO
    // readWrite grant/link to anyone (refreshVaultPrivacy, fail-safe) — sync-delivered plugin code is OUR
    // OWN, so a newly-arrived plugin is hot-loaded live (applyPluginCodeChange) to remove the restart
    // friction. Any shared / shareable vault (a peer could push code) keeps the restart trust-barrier, as
    // does an update to an already-running plugin; CSS is handled separately below (Obsidian DOES hot-reload
    // an enabled snippet/theme, so it gets a trust warning on a shared vault, not the restart barrier). Non-code, non-CSS
    // config (e.g. a plugin's data.json) is already on disk and read on next load.
    // Partition the batch by surface so each notice's SOURCE is looked up over ONLY its own paths — a mixed
    // flush (your plugin edit + a peer's CSS) must never attribute one surface's change to the other's author
    // (crit finding 2). pluginPaths drive the code notice; cssPaths the CSS notice; corePaths the core notice.
    const cssPaths = paths.filter((p) => /(^|\/)appearance\.json$/.test(p) || p.includes("/themes/") || p.includes("/snippets/"));
    const pluginPaths = paths.filter((p) => { const id = pluginIdOf(p); return !!id && id !== this.selfFolderId(); });
    const corePaths = paths.filter((p) => /(app|core-plugins|community-plugins|hotkeys)\.json$/.test(p));
    const pluginIds = new Set<string>(pluginPaths.map((p) => pluginIdOf(p)).filter((id): id is string => !!id));

    // SOURCE-DRIVEN notices (D-provenance): a reload notice fires ONLY when the change came from a source
    // that should notify (another person, or — in userDevice mode — another of your devices), NEVER based on
    // whether the vault is shared. A change you made yourself is silent (logged). The wording names WHO.
    if (pluginIds.size > 0) {
      await this.applyPluginCodeChange(pluginIds, pluginPaths);
    } else if (cssPaths.length) {
      // Synced theme/snippet CSS is executable-adjacent — Obsidian hot-reloads an ENABLED snippet/theme LIVE,
      // and CSS in the un-CSP'd renderer can hide/spoof content or exfil via `background:url(...)`. So when a
      // DIFFERENT source changed it, warn to review; your own CSS change is silent.
      const src = this.notifiableConfigSource(cssPaths);
      if (src) new Notice(`SelfSync: ${changeSourceLabel(src, this.selfIdentity())} changed your synced theme/snippet CSS — Obsidian may apply it LIVE. Review it (Settings → Appearance) and remove anything from a source you don't trust.`, 15000);
      else this.log(`applied your synced theme/snippet CSS (${cssPaths.length} file(s))`);
    } else if (corePaths.length) {
      const src = this.notifiableConfigSource(corePaths);
      if (src) new Notice(`SelfSync: ${changeSourceLabel(src, this.selfIdentity())} changed synced core settings — fully close and reopen Obsidian to apply them.`);
      else this.log(`applied synced core settings (${corePaths.length} file(s))`);
    } else {
      this.log(`applied synced config (${paths.length} file(s))`);
    }
    // Consume ALL provenance recorded this pass — not just the flushed paths — so a race-aborted pull's
    // recorded-but-unwritten entry can't leak or later misattribute a same-path write (crit finding 5).
    this.configProvenance.clear();
  }

  // A synced change to community-plugin CODE. TWO ORTHOGONAL concerns:
  //  1. SECURITY (auto-execution): on a PROVABLY-PRIVATE vault (own + unshared — refreshVaultPrivacy) a
  //     NEWLY-ARRIVED plugin is our OWN code, hot-loaded LIVE (loadManifests + enablePlugin, no restart).
  //     Any shared/shareable vault, an UPDATE to a RUNNING plugin, a hot-load failure, or a missing API keeps
  //     the R14 restart trust-barrier. This gate is UNCHANGED — it governs whether we auto-run code, not
  //     whether we notify.
  //  2. NOTIFICATION (source-driven, D-provenance): the notice fires ONLY when the change's SOURCE should
  //     notify (another person, or another of your devices in userDevice mode) — never based on vault privacy.
  //     Your own change is silent (logged). `paths` carries the changed files so we can attribute the source.
  private async applyPluginCodeChange(ids: Set<string>, paths: string[]): Promise<void> {
    const pm = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown>; loadManifests?: () => Promise<void>; enablePlugin?: (id: string) => Promise<unknown> } }).plugins;
    const isLoaded = (id: string) => !!pm?.plugins?.[id];
    const hotLoaded: string[] = [];
    const needRestart: string[] = [...ids].filter(isLoaded); // an update to a RUNNING plugin → reload needed to re-execute
    const newlyArrived = [...ids].filter((id) => !isLoaded(id));
    // SECURITY (fix ① 2026-08-01): re-derive the private-vault gate FRESH here, at the moment of decision.
    // `vaultIsPrivate` is a CACHED field (refreshed on connect + this device's own share mutations), and the
    // hot-load path must NOT ride a stale value — a stale `true` is an RCE bypass of the R14 restart barrier:
    // it can be left over from a previous (private) vault after a switch to a shared one, or predate an
    // out-of-band readWrite grant on this vault (the delta/poll path that reaches here never refreshed it).
    // Re-checking now — only when a plugin actually ARRIVED (rare) — makes the gate current on EVERY entry
    // path; a shared or now-shareable vault re-derives `false` (fail-safe) and keeps the restart barrier.
    if (newlyArrived.length && pm?.loadManifests && pm?.enablePlugin) await this.refreshVaultPrivacy();
    if (this.vaultIsPrivate && newlyArrived.length && pm?.loadManifests && pm?.enablePlugin) {
      try {
        await pm.loadManifests(); // register the newly-arrived manifest(s) so enablePlugin can find them
        for (const id of newlyArrived) {
          try { await pm.enablePlugin(id); hotLoaded.push(id); }
          catch (e) { this.log(`hot-load of '${id}' failed (${e instanceof Error ? e.message : e}) — restart to activate`); needRestart.push(id); }
        }
      } catch { needRestart.push(...newlyArrived); }
    } else {
      needRestart.push(...newlyArrived); // gated (shared/untrusted vault) or no API → the restart trust-barrier stays
    }
    const src = this.notifiableConfigSource(paths); // null ⇒ your own change ⇒ stay silent (log only)
    const who = src ? changeSourceLabel(src, this.selfIdentity()) : "";
    if (hotLoaded.length) {
      this.settingsRefresh?.();
      if (src) new Notice(`SelfSync: ${who} added ${hotLoaded.length} synced plugin(s) — now active here, no restart needed.`);
      else this.log(`activated ${hotLoaded.length} synced plugin(s) — no restart needed`);
    }
    if (needRestart.length) {
      const names = [...new Set(needRestart)].sort().join(", ");
      // Actionable + source-named when it wasn't you; a plain log line when it was your own change.
      if (src) new Notice(`SelfSync: ${who} changed community-plugin CODE — ${names}. It is executable code, NOT active until you fully close and reopen Obsidian; do so only if you trust the source.`, 15000);
      else this.log(`synced plugin code updated (${names}) — fully close and reopen Obsidian to load it`);
    }
  }

  // The status light is a pure function of the FSM phase (see syncstate.ts). It drives
  // the one platform indicator, any opt-in editor indicators, and (if the settings tab is
  // open) its live status card — all from a single source of truth, never diverging.
  // "12 pending" while a reconcile pass has files left to transfer, else "" — appended to "Syncing…".
  syncProgressText(): string {
    return this.syncPending > 0 ? `${this.syncPending} pending` : "";
  }
  // User-facing status = a PURE projection of the FSM Phase (+ the pending count / realtime / read-only
  // facts). It reads NO persisted setting and NO loose flag: a vault switch and a mobile resume are
  // TRANSIENTS that show as the normal connecting/syncing/idle projection — so the card can NEVER latch a
  // stale label (the "Switching vault… applying your choice" that stuck on a persisted pendingSwitch even
  // while fully synced — field bug 2026-08-02). The dot COLOUR comes from syncstate.light(phase); this maps
  // the SAME phase to the card's label+detail, so the two never diverge.
  statusDisplay(phase: Phase): { label: string; detail: string } {
    switch (phase) {
      // A shown "syncing" always has real transfer work (effectivePhase collapses a 0-pending check to
      // idle), so the detail is the pending count — never "checking for changes" (a transition, not a state).
      case "syncing":    return { label: "Syncing…", detail: this.syncPending > 0 ? `${this.syncPending} pending` : "" };
      case "idle":       return this.settings.vaultReadOnly
        // Read-only vault: Obsidian still lets you EDIT, but those edits never upload — so a plain green
        // "Fully synced" is a mode error (it implies your changes are safe on the server). Say so.
        ? { label: "Synced (read-only)", detail: "your edits stay on this device" }
        : { label: this.realtimeConnected ? "Fully synced" : "Synced (polling)", detail: "" };
      case "connecting": return { label: "Connecting…", detail: this.connectStage || "" }; // the live sub-phase (signing in / checking the server / fetching changes / scanning / reconciling)
      // A down link, decomposed by the connection FSM. `retrying` = transient backoff; `lockedOut` / `blocked`
      // carry their SPECIFIC reason (429 wait, or sign-in rejected / version mismatch / vault gone …) from
      // the LinkState — no more one-size "offline".
      case "retrying":   return { label: "Reconnecting…", detail: "" };
      case "lockedOut":  return { label: linkPhase(this.engine.linkState()).detail, detail: "" };
      case "blocked":    return { label: linkPhase(this.engine.linkState()).detail, detail: "" };
      case "off":        return { label: "Not connected", detail: "" };
    }
  }
  // The status light's SHOWABLE phase: a `syncing` reconcile with nothing queued to transfer (syncPending
  // <= 0) is a CHECK, not a state — so it collapses to `idle` and never paints "Syncing…". Only a genuine
  // transfer (syncPending > 0) is a real syncing phase; the debounce below then also suppresses a sub-second
  // one. Together these kill the "Fully synced" ⇄ "Syncing… checking for changes" flitter (issueStatusLightFlicker).
  private effectiveLightPhase(): Phase {
    const primary = effectivePhase(this.engine.phase(), this.syncPending);
    // R4-F1: fold composed-vault mount health into the ONE status light. Only ESCALATE a RESTING primary
    // (idle/off) so a silently offline/failed mount isn't hidden behind green "Fully synced"; a real primary
    // problem (syncing/connecting/retrying/blocked) already shows + dominates, and the mount note still rides
    // the tooltip via paintLight. A mount problem maps to the same attention visual the primary uses.
    if (primary === "idle" || primary === "off") {
      const ms = this.mountStatusSummary();
      if (ms?.health === "error") return "blocked";
      if (ms) return "retrying"; // offline / diverged → attention
    }
    return primary;
  }
  // The folded phase the LIGHT shows (primary + mount health) — exposed so the settings Status hero paints the
  // SAME phase as the ribbon, instead of a primary-only phase that hides a down mount (R10-F1).
  lightPhase(): Phase { return this.effectiveLightPhase(); }
  // Coalesced settings re-render for MOUNT state changes (R10-F2): a mount pass fires onEvent several times;
  // debounce so the per-mount rows refresh live without a re-render per event (scroll is preserved by display).
  private mountUiTimer?: number;
  private bumpMountUi(): void {
    if (this.mountUiTimer !== undefined || !this.settingsRefresh) return;
    this.mountUiTimer = window.setTimeout(() => { this.mountUiTimer = undefined; this.settingsRefresh?.(); }, 400);
  }
  // The render ENTRY POINT (all callers route here): feed the effective phase into the debounced display
  // FSM. `_p` is accepted for the legacy callers that pass engine.phase() but is ignored — the FSM +
  // effectiveLightPhase are the single source of what's shown.
  private renderLight(_p?: Phase) { this.dispatchLight({ kind: "phase", phase: this.effectiveLightPhase() }); }
  // Drive the display FSM (statuslight.ts) and apply its debounce-timer effects, then paint whatever it
  // says is currently shown. Entering `syncing` arms the timer (keeps the steady state visible); the timer
  // emits `settle`, which commits to `syncing` only if it's still pending — so a transient never paints.
  private dispatchLight(e: LightEvent): void {
    const act = nextLightDisplay(this.lightDisplay, e);
    this.lightDisplay = act.state;
    if (act.disarm && this.lightTimer !== undefined) { window.clearTimeout(this.lightTimer); this.lightTimer = undefined; }
    if (act.arm) this.lightTimer = window.setTimeout(() => { this.lightTimer = undefined; this.dispatchLight({ kind: "settle" }); }, SYNCING_SHOW_DELAY_MS);
    this.paintLight(this.lightDisplay.shown);
  }
  private paintLight(phase: Phase) {
    const spec = light(phase, "", this.realtimeConnected); // COLOUR source
    const disp = this.statusDisplay(phase);
    const base = disp.detail ? `${disp.label} ${disp.detail}` : disp.label;
    // R4-F1: surface a composed-vault mount PROBLEM in the tooltip (always), so a failed/offline mount is
    // discoverable even when the light's short label reflects the primary.
    const ms = this.mountStatusSummary();
    const tip = ms ? `${base} · ${ms.health === "error" ? "a mount failed" : ms.health === "offline" ? "a mount is offline" : "a mount needs review"} (${ms.reason})` : base;
    // Vary the GLYPH with state too, so it isn't conveyed by color alone (colorblind users). idle is a
    // RESTING state → a STEADY glyph (a lock for read-only, else a check), NEVER the spinner — a healthy
    // polling device must not sit at a permanent spinner (that state-vs-motion collision trains alarm
    // habituation). The spinner (refresh-cw) is reserved for the ACTIVE states (connecting / syncing).
    const glyph = phase === "idle" ? (this.settings.vaultReadOnly ? "lock" : "check")
      : (phase === "retrying" || phase === "blocked" || phase === "lockedOut") ? "alert-triangle" // a down link (any reason)
      : phase === "off" ? "circle-slash"
      : "refresh-cw"; // connecting / syncing = active
    // Repaint-dedupe: if the computed light is identical to what's already on screen, don't touch the DOM.
    // Kills any residual flash from repeated identical renders (e.g. idle re-rendered on every poll settle).
    const key = `${phase}|${spec.color}|${spec.label}|${tip}|${glyph}`;
    if (key === this.lastLightKey) return;
    this.lastLightKey = key;
    if (this.statusEl) {
      this.statusEl.empty();
      const dot = this.statusEl.createSpan({ text: "●" });
      dot.setAttribute("style", `color:${spec.color};margin-right:4px;`);
      this.statusEl.createSpan({ text: spec.label });
      this.statusEl.setAttribute("aria-label", `SelfSync — ${tip}`);
    }
    if (this.ribbonEl) {
      this.ribbonEl.style.color = spec.color; // SVG uses currentColor -> tints the icon
      setIcon(this.ribbonEl, glyph);
      this.ribbonEl.setAttribute("aria-label", `SelfSync — ${tip}`);
    }
    for (const el of this.editorActionEls) {
      if (!el.isConnected) { this.editorActionEls.delete(el); continue; } // view closed — prune
      el.style.color = spec.color;
      setIcon(el, glyph);
      el.setAttribute("aria-label", `SelfSync — ${tip}`);
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
  // The status card + every statusText consumer use the SAME collapsed projection as the ribbon light, so a
  // resting 0-pending reconcile never "hangs on syncing" on the card while the light shows idle (regression).
  statusText() { return effectivePhase(this.engine.phase(), this.syncPending); }

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
  // A STABLE per-device UUID — the unforgeable identity for change provenance ("did ANOTHER device write
  // this?"). Persisted per-device (settings never sync) and INDEPENDENT of deviceLabel: renaming a device
  // can't change its id, so a rename can never impersonate another device to dodge a peer-change notification
  // (the property the owner asked for). Minted at load (ensureDeviceId, awaited-persisted) so it's durable
  // before any commit stamps it; this getter is a safe fallback that also persists a first-use mint.
  deviceId(): string {
    if (!this.settings.deviceId) {
      this.settings.deviceId = randomUuid();
      void this.saveSettings();
    }
    return this.settings.deviceId;
  }
  // Mint + DURABLY persist the device UUID if absent — called on load BEFORE the first commit, so a crash
  // right after minting can't leave a device that re-mints a NEW id each session (which, in userDevice mode,
  // would make its own edits look like a different device forever — crit finding 4). Awaited, unlike the
  // lazy getter's fire-and-forget.
  private async ensureDeviceId(): Promise<void> {
    if (!this.settings.deviceId) { this.settings.deviceId = randomUuid(); await this.saveSettings(); }
  }
  // Per-device per-file sync cap in bytes, from settings.maxSyncMB (default 200). Clamped to a sane
  // floor so a bad/zero value can't silently skip everything.
  private maxSyncBytes(): number {
    const mb = this.settings.maxSyncMB;
    return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_SETTINGS.maxSyncMB) * 1024 * 1024;
  }
  // The timestamp-ignore key patterns when the feature is on, else [] → no frontmatter masking (EOL/BOM
  // normalization in content identity stays on regardless). SelfSync never WRITES these keys.
  ignorePatterns(): string[] {
    return this.settings.ignoreTimestampChanges ? this.settings.ignoredTimestampKeys : [];
  }
  // All vault folder paths, for the excluded-folders autocomplete.
  getAllFolders(): string[] {
    const v = this.app.vault as unknown as { getAllFolders?: () => { path: string }[] };
    if (typeof v.getAllFolders === "function") return v.getAllFolders().map((f) => f.path).filter((p) => !!p);
    return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path).filter((p) => !!p);
  }
  async setExcludedFolders(list: string[]): Promise<void> {
    this.settings.excludedFolders = [...new Set(list)].sort();
    await this.saveSettings();
    this.settingsRefresh?.();
  }

  private deps(): ReconcileDeps {
    return {
      api: this.api!, io: this.io, base: this.base, cache: this.cache, state: this.state,
      device: this.deviceLabel(),
      ignorePatterns: this.ignorePatterns(),
      excludedFolders: this.settings.excludedFolders,
      // Live (size, mtime) for a single path — the scan-skip hint the cosmetic override stamps so a
      // timestamp/EOL-only note isn't re-hashed every pass. Notes only (getAbstractFileByPath).
      // INVARIANT (issueScanSkipHintNotPersisted): mtime here MUST come from the SAME source as list()'s
      // mtime (TFile.stat.mtime, main.ts list()) — now that the stamp is PERSISTED, a divergent source
      // (e.g. adapter.stat vs TFile.stat, different rounding) could make a reloaded stamp falsely match and
      // skip a changed file. Keep both on TFile.stat.mtime.
      statOf: (p) => { const f = this.app.vault.getAbstractFileByPath(p); return f instanceof TFile ? { size: f.stat.size, mtime: f.stat.mtime } : undefined; },
      readOnly: this.settings.vaultReadOnly,
      maxSyncBytes: this.maxSyncBytes(), // per-device cap (settings.maxSyncMB); mobile buffers in RAM, so raise with care
      // Same selective-sync gate the io uses: a filtered `.obsidian/` path is skipped in
      // reconcile too, so a device that opted out never records a base for it (no phantom delete).
      // Plus the D0039 mount BOUNDARY: a mount-point path is excluded from the primary scope (synced by its
      // own mount scope) — the load-bearing invariant that a mounted file never double-syncs to the primary.
      // Uses activeMounts() (the validated in-effect set) so exclusion and scope-building agree (N1).
      accepts: (p) => !primaryExcludes(this.activeMounts(), p) && shouldSync(p, this.settings.configSync, this.selfFolderId()),
      localSizeOf: (p) => this.localSizeOf(p), // O(1) size for the incremental (RS-3) size gate
      onReadOnly: (p) => this.log(`read-only shared vault: local change to '${p}' won't sync`),
      onProgress: (pending) => {
        if (pending === this.syncPending) return; // only refresh the UI when the count actually changes
        this.syncPending = Math.max(0, pending);
        if (this.syncPending > 0) this.engine.beginReconcile(); // real transfers in flight → escalate a connecting/idle state to "Syncing…"
        this.renderLight(this.engine.phase());
        this.statusListener?.(); // refresh the settings status row if open
      },
      // The conflict copy file IS the record (derived from the vault) — just log + refresh the count.
      onConflict: (p, c) => { this.log(`conflict on ${p} → kept your copy as ${c}`, true); this.settingsRefresh?.(); this.statusListener?.(); },
      onConfigConflict: (p, reason) => this.recordConfigConflict(p, reason),
      onConfigResolved: (p) => this.clearConfigConflict(p),
      onRemoteConfig: (p, meta) => this.recordIncomingConfig(p, meta), // record who/which-device for the source-driven reload notice

      onFileError: (p, e) => this.log(`couldn't sync '${p}': ${e instanceof Error ? e.message : String(e)} — skipped it, other files continue`),
      onDeclined: (paths) => this.noteDeclined(paths),
      onRemotePlugins: (plugins) => { this.setServerPlugins(plugins); void this.runPluginAutopilot().catch((e) => this.log(`plugin autopilot: ${e instanceof Error ? e.message : e}`)); }, // auto-sync own new plugins, gate peers
      onBaseChanged: () => { void this.persist(); },
      onGuard: (p) => this.noteGuard(p),
      bulkDeleteStrategy: this.settings.bulkDeleteStrategy, // D0041: user-configurable incoming bulk-delete confirmation
      bulkDeleteThreshold: this.settings.bulkDeleteThreshold,
      retryBudget: this.pullRetries, // R18: bound re-download of a permanently-corrupt server file
      onPullExhausted: (p) => {
        if (this.pullExhaustedNotified.has(p)) return; // once per path per session
        this.pullExhaustedNotified.add(p);
        this.log(`'${p}' can't be downloaded — the server's copy failed its integrity check ${MAX_PULL_RETRIES} times (corrupt / bit-rotted). It needs a server reindex; other files keep syncing.`, true);
      },
      onSkip: (p, bytes) => {
        if (this.skipNotified.has(p)) { this.log(`skipped '${p}' — too large to sync`); return; } // notice once/session
        this.skipNotified.add(p);
        const cap = this.maxSyncBytes();
        this.log(`skipped '${p}' — ${Math.round(bytes / 1048576)} MB, over this device's ${Math.round(cap / 1048576)} MB sync limit (raise it in settings${this.io.appendWrite ? "" : "; larger files also sync on desktop"})`, true);
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
  isVaultGone(): boolean { const l = this.engine?.linkState(); return !!l && l.kind === LinkKind.Blocked && l.reason === FailureKind.VaultGone; }

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
  // Connect sub-phase surfacing (L-5). "Connecting…" spans several network round-trips — sign-in → server
  // check → remote-manifest fetch → local scan → reconcile — that used to log NOTHING between them, so a
  // slow phase (e.g. a 30s-timeout-bound status() or a big manifest fetch) read as hung with zero insight.
  // setConnectStage names the current sub-phase: shown as the "Connecting…" DETAIL (card/tooltip) AND logged
  // with cumulative elapsed, so a stall is both visible and timed. Gated on `connecting` so a poll/remote
  // reconcile (which also fires onStage) never logs or paints a stage.
  private connecting = false;
  private connectStartedAt = 0;
  private connectStage = "";
  private setConnectStage(stage: string): void {
    if (!this.connecting) return;
    this.connectStage = stage;
    this.log(`connect: ${stage} (+${((Date.now() - this.connectStartedAt) / 1000).toFixed(1)}s)`);
    this.renderLight(); // repaint the "Connecting…" detail (paintLight's dedupe key includes the tip)
  }

  private async doConnect(): Promise<void> {
    this.lastIssue = undefined;
    this.connecting = true; this.connectStartedAt = Date.now(); this.connectStage = "";
    // crit-round (sync F4): a connect means the realtime socket is not (yet) live. Reset the flag up
    // front so the status light can't briefly show green "Fully synced" during connect→idle before the
    // new socket's open handler fires (the close handler's `this.ws !== ws` early-return can otherwise
    // leave it stale-true after a non-socket failure).
    this.transport = "offline"; // realtimeConnected is a computed getter (=== "live"); reset the FSM state directly
    // A connect is happening now — cancel any pending backoff timer so it can't later fire a
    // redundant {connect} after this one succeeds.
    if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    try {
      this.log(`connecting to ${this.settings.serverUrl} as '${this.settings.username}'`);
      this.setConnectStage("signing in");
      await this.establishSession();      // token + a healthy, version-COMPATIBLE server + a fresh share grant (throws otherwise)
      await this.resolveAndApplySwitch(); // apply a pending vault switch (or the D0047 safe-merge), else a full reconcile — drives the fetching/scanning/reconciling stages via onStage
      this.setConnectStage("finishing up");
      await this.finishConnect();         // live config + WS + poll + reset backoff + stamp the base key / privacy gate
    } catch (e: any) {
      // The connection FSM now owns the failure TAXONOMY + its user-facing label: the engine classifies
      // this error (engine.classify → LinkState), and getLastIssue/statusDisplay read the LinkState for a
      // blocked/lockedOut reason (sign-in rejected / version mismatch / vault gone / locked out …). Here we
      // set only the TRANSIENT fallback text (shown while `retrying`, when the link isn't blocked); the
      // vaultGone/session-expired/version cases are carried on the typed error, not a parallel bool/regex.
      // F3: a SYNTHETIC failure (serverDegraded's 'run reindex', a version mismatch) already set a specific,
      // actionable lastIssue before throwing its typed ConnError — don't overwrite it with the generic
      // transient text (serverDegraded -> Retrying{Slow} reads lastIssue, so the clobber hid the reindex
      // instruction behind 'Reconnecting…'). Only stamp the generic fallback for a real network/HTTP error.
      if (!(e instanceof ConnError && e.info.synthetic !== undefined)) {
        this.lastIssue = `Can't reach the server (${e?.message ?? e}). Retrying…`;
      }
      throw e; // → engine.failWith: classify + advance LinkState + schedule the class-appropriate recovery
    } finally {
      this.connecting = false; this.connectStage = ""; // leave "connecting" → the stage detail is no longer shown (phase moves to idle/reconciling)
    }
  }

  // Phase 1 of the connect: establish an authenticated, healthy, version-COMPATIBLE session, or THROW.
  private async establishSession(): Promise<void> {
    // Clear the ref BEFORE the awaits below: the close we just triggered fires asynchronously, and the close
    // handler only suppresses a superseded socket via the `this.ws !== ws` check. Leaving this.ws pointing at
    // the closing socket during the await would let its close enqueue a spurious {rews} that re-dials on top
    // of this connect. (Round-6 CONC)
    this.ws?.close(); this.ws = undefined;
    let activeToken = await this.acquireToken();
    this.api = this.buildApi(activeToken);
    this.sessionToken = activeToken; // stash so a mount transport (same server+token, source vault) can be built without re-login
    this.setConnectStage("checking the server"); // status() is the first authed round-trip (30s timeout) — a common stall point
    // Never reconcile against a degraded server: a corrupt index 503s all sync ops, and acting on the
    // resulting empty manifest could delete local files. Surface the operator action. status() is the first
    // authed call; if the stored token was rejected (401), re-login ONCE and rebuild the transport (reactive
    // auth — no proactive validation probe). A still-failing auth then throws → the engine backs off + retries.
    let health;
    try { health = await this.api.status(); }
    catch (e) {
      if (!this.isAuthError(e)) throw e;
      this.log("token rejected — re-logging in");
      this.settings.authToken = undefined;
      activeToken = await this.freshLogin();
      this.api = this.buildApi(activeToken);
      this.sessionToken = activeToken;
      health = await this.api.status();
    }
    // Wire-contract compatibility (D0042): refuse to sync unless the server's wire signature is compatible
    // with the one THIS build was compiled against — replacing the old single-integer version handshake. A
    // self-hoster auto-updates the plugin (BRAT) independently of the server, so a clear, SPECIFIC reason
    // beats an undiagnosable malformed-response retry loop, and the vault is untouched. Fails CLOSED when the
    // server advertises no signature (older server / a proxy that strips it) — never sync an unconfirmable contract.
    const compat = await this.checkWireCompat(health.schemaHash);
    if (!compat.ok) {
      this.lastIssue = compat.message;
      // R12-PB6: toast ONCE per mismatch episode, not on every ~30s backoff retry (the card keeps showing it).
      this.log(this.lastIssue, !this.versionNoticeShown);
      this.versionNoticeShown = true;
      throw new ConnError(compat.detail, { synthetic: SyntheticKind.VersionMismatch, wasLogin: false, endpoint: Endpoint.Other });
    }
    this.versionNoticeShown = false; // compatible → reset so a later mismatch toasts again
    if (health.status !== "ready") {
      this.lastIssue = `This vault's data on the server is damaged and can't sync safely. Someone with server access needs to repair it (run “reindex” on the server). Not syncing until then.`;
      this.log(this.lastIssue);
      throw new ConnError("server vault not ready (reindex needed)", { synthetic: SyntheticKind.ServerDegraded, wasLogin: false, endpoint: Endpoint.Other });
    }
    // If this is a vault shared TO us, re-derive our permission from the server's grant so the cached
    // vaultOwner/vaultReadOnly can't be stale (owner flipped read↔write, or revoked us).
    this.setConnectStage("checking your access");
    await this.refreshShareGrant(activeToken);
  }

  // D0042 wire-contract compatibility decision (imperative shell over the pure hashCheck/diff cores). Cheap
  // path: a schemaHash already verified this session → compatible (a string compare). Otherwise fetch the
  // server's /schema and diff it directionally against EMBEDDED_SIGNATURE — a BREAKING delta refuses with the
  // specific reason(s); additive-only proceeds (and caches the hash). Fails CLOSED on an absent/unfetchable
  // signature. `serverHash` comes from status().schemaHash (or a mount source's).
  private async checkWireCompat(serverHash: string | undefined): Promise<{ ok: true } | { ok: false; message: string; detail: string }> {
    const hc = hashCheck(serverHash, this.verifiedWireHash);
    if (hc.kind === "compatible") return { ok: true };
    if (hc.kind === "failClosed") return { ok: false, message: FAIL_CLOSED_MESSAGE, detail: "server advertises no wire signature" };
    // needsDiff — fetch the server's full signature and classify the differences.
    let serverSig: Signature;
    try { serverSig = await this.api!.schema(); }
    catch { return { ok: false, message: FAIL_CLOSED_MESSAGE, detail: "wire signature unavailable or malformed" }; }
    const verdict = signatureVerdict(EMBEDDED_SIGNATURE, serverSig);
    if (verdict.ok) { this.verifiedWireHash = serverHash; return { ok: true }; }
    return { ok: false, message: incompatibleMessage(verdict.reasons), detail: `incompatible wire contract: ${verdict.reasons.join("; ")}` };
  }

  // Phase 2: apply the vault-switch RESOLUTION for this connect (force a safe merge-switch on a FOREIGN base
  // per D0047, drop an already-applied switch to avoid re-clobber), then run the switch or a full reconcile.
  // The initial reconcile does NOT optimistically show "Syncing…" (removed markReconciling) — it stays
  // "Connecting…" and escalates only on real transfer work, so a failing switch never fakes "Synced".
  private async resolveAndApplySwitch(): Promise<void> {
    // CONC#5: clear pendingSwitch ONLY AFTER switchTo fully succeeds — clearing up-front let a mid-switch
    // failure downgrade an authoritative overwrite into a plain merge that could conflict-copy or resurrect.
    // D0047 GUARD (vault-change-skips-transition): the persisted base belongs to a specific owner/vaultId. If
    // it doesn't match the vault we're about to sync — ANY path changed the vault without switchTo — the base
    // is FOREIGN and a plain reconcile could silently overwrite local files (decide()'s B===L→pull, no
    // conflict-copy). Force a safe merge-switch (clears the stale base + unions; nothing lost), unless a switch
    // is already pending.
    if (!this.settings.pendingSwitch && this.settings.baseVaultKey && this.base.paths().length) {
      const stored = this.settings.baseVaultKey;
      // fix ③ (pure `vaultKeyMismatch`): the key is SERVER-qualified (`host|owner/vault`) so a repoint at a
      // DIFFERENT server with the SAME vault name is detected; an OLD server-blind stored key (no `|`) is
      // grandfathered to the CURRENT server so an upgrade doesn't force a spurious merge; a genuine change trips.
      if (vaultKeyMismatch(stored, this.vaultIdentityKey(), this.historyFloorKey())) {
        this.log(`base belonged to '${stored}' but now syncing '${this.vaultIdentityKey()}' — clearing the stale base (safe merge)`, true);
        // V2 (2026-08-02): don't merge SILENTLY — a union across two vaults is a real (if non-destructive)
        // change the user should see; the merge is still the safe default (nothing lost).
        new Notice("SelfSync: this vault changed since the last sync on this device — merging safely so nothing is lost.", 9000);
        this.settings.pendingSwitch = "merge";
      }
    }
    // ALREADY-APPLIED GUARD (critique 2026-08-02): a persisted pendingSwitch clears only after switchTo
    // RETURNS; if its reconcile is killed mid-flight on mobile it never clears, and every reconnect RE-RUNS it
    // — for an authoritative resolution that RE-CLOBBERS local edits. Once the base already belongs to the
    // TARGET vault the switch has taken effect; clear it and reconcile normally. (A not-yet-applied switch —
    // base still the OLD vault — still replays, preserving R12-CA1.)
    if (switchAlreadyApplied(this.settings.pendingSwitch, this.settings.baseVaultKey, this.vaultIdentityKey(), this.base.paths().length > 0)) {
      this.log(`vault switch '${this.settings.pendingSwitch}' already applied (base belongs to the target) — clearing, syncing normally`, true);
      this.settings.pendingSwitch = undefined; await this.saveSettings();
    }
    const switchMode = this.settings.pendingSwitch;
    // DIAGNOSTIC: a switch that RE-RUNS every connect (switchTo keeps getting interrupted before it returns AND
    // the base never reaches the target) logs here each time — making a genuinely-stuck switch visible.
    if (switchMode) this.log(`applying vault switch resolution '${switchMode}' (persisted pendingSwitch)`);
    if (switchMode) { await switchTo(this.deps(), switchMode); this.settings.pendingSwitch = undefined; await this.saveSettings(); this.log(`vault switch '${switchMode}' complete — pendingSwitch cleared`); }
    else await this.reconcileFull(); // D0019: full reconcile WITH reset detection + notify (DI-H1)
  }

  // Phase 3: the connection is established + the initial reconcile is done — apply live config, open the WS +
  // poll loop, reset the backoff, and stamp the durable facts (the server-qualified base key for the D0047
  // guard, the last-synced time, and a re-evaluation of the hot-load privacy gate).
  private async finishConnect(): Promise<void> {
    await this.flushConfigReload();
    this.lastConfigScanAt = Date.now(); this.lastFullScanAt = Date.now(); // this reconcile was a full, config-aware pass — start both scan windows now
    this.spinUpWs();
    this.startPolling();
    this.backoff = 3000;
    this.lastIssue = undefined; // a connected LinkState (engine) is the source of truth for "no issue"
    this.settings.baseVaultKey = this.vaultIdentityKey(); // stamp the (server-qualified) vault this base belongs to (D0047 guard, fix ③)
    this.settings.lastSyncedAt = Date.now(); void this.saveSettings();
    void this.refreshVaultPrivacy(); // re-evaluate the hot-load security gate (own + unshared?) each connect
    this.log(`connected @ v${this.state.version}`); // status bar/ribbon show it — no toast
  }

  // EFFECT (teardown): stop timers + close the socket. Called on disconnect/unload by the engine.
  private doTeardown(): void {
    if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    if (this.pollTimer !== undefined) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
    if (this.wsLivenessTimer !== undefined) { window.clearInterval(this.wsLivenessTimer); this.wsLivenessTimer = undefined; }
    this.ws?.close(); this.ws = undefined;
    this.transport = "offline"; // torn down → no realtime channel (realtimeConnected getter reads false)
    this.mountScopes = []; // composed vaults (D0039): drop live mount scopes so a reconnect rebuilds them (their persisted base/cursor survive in mountStateStore)
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
    // Half-open liveness (crit-round residual): bump on ANY frame — the server's app heartbeat or a
    // real change poke — so a silent (half-open) socket is detectable. Additive to the transport's own
    // onmessage handler (which only reacts to type:"changed").
    this.lastWsActivity = Date.now();
    this.applyTransport("dial", ws); // socket created, not yet open → dialing (poll upshifts to active)
    ws.addEventListener("message", () => { this.lastWsActivity = Date.now(); });
    this.startWsLiveness(ws);
    ws.addEventListener("open", () => {
      if (this.unloading || !this.api || this.ws !== ws) return; // superseded/torn down (issueWsSupersededOpenError)
      this.log("ws channel open (instant sync)");
      this.lastWsActivity = Date.now();
      this.applyTransport("opened", ws); // → live: realtime health + downshift the poll to a slow backstop (Finding 3a)
    });
    // GUARD the error handler too (issueWsSupersededOpenError): a late `error` from a SUPERSEDED old socket
    // (racing the abort supersession triggers) would otherwise applyTransport("errored") and degrade the
    // CURRENT live socket → false "Synced (polling)" + the poll pinned to 4s until the next socket cycle. The
    // FSM's design (transportstate.ts) requires ALL socket events to honor the identity check — close + the
    // liveness tick already do; open/error must match.
    ws.addEventListener("error", () => {
      if (this.unloading || !this.api || this.ws !== ws) return; // superseded/torn down
      this.log("ws unavailable — polling fallback active");
      this.applyTransport("errored", ws);
    });
    ws.addEventListener("close", () => {
      if (this.unloading || !this.api || this.ws !== ws) return; // superseded/torn down
      // The FSM owns the recovery fork (R11-#7): a close of a socket that had opened → a DELAYED re-dial
      // (don't hammer a flapping server; the 4s poll keeps catching remote changes); one that never opened
      // → a full backed-off reconnect (likely a bad/expired token). See transportstate.ts.
      this.applyTransport("closed", ws);
    });
    return ws;
  }

  // Drive the WS-lifecycle FSM (transportstate.ts) and APPLY the effects it returns. This centralizes what
  // used to be scattered realtimeConnected/`opened`/poll-cadence writes across four socket listeners; the
  // transitions are pure + exhaustively unit-tested (transportstate.test.ts), so only effect application
  // lives here. `ws` is the socket the event came from — used only to guard the DELAYED re-dial against a
  // socket that was superseded in the meantime (identity check, not FSM state).
  private applyTransport(e: TransportEvent, ws?: WebSocket): void {
    const { state, effects } = transportTransition(this.transport, e);
    this.transport = state;
    this.renderLight(this.engine.phase()); // light reflects realtime health (realtimeConnected === state==="live")
    if (effects.poll) this.startPolling(effects.poll === "idle" ? POLL_IDLE_MS : POLL_ACTIVE_MS);
    if (effects.redial === "delayed" && ws) {
      window.setTimeout(() => { if (!this.unloading && this.api && this.ws === ws) this.engine.enqueue({ kind: "rews" }); }, 2000);
    }
    if (effects.redial === "now") this.engine.enqueue({ kind: "rews" });
    if (effects.reconnect) this.engine.enqueue({ kind: "connect" });
  }

  // Detect a HALF-OPEN socket (crit-round residual): the browser hides protocol ping/pong from JS, so a
  // socket whose TCP has silently died still reads as "open" and the light would stay green with the poll
  // downshifted. The server heartbeats every ~30s; if we see no frame within WS_STALE_MS, the `staleTick`
  // transition drops realtime health, upshifts the poll, and re-dials (idempotent on the queue).
  private startWsLiveness(ws: WebSocket): void {
    if (this.wsLivenessTimer !== undefined) window.clearInterval(this.wsLivenessTimer);
    this.wsLivenessTimer = window.setInterval(() => {
      if (this.unloading || this.ws !== ws || this.transport !== "live") return;
      if (isWsStale(this.lastWsActivity, Date.now(), WS_STALE_MS)) {
        this.log("ws silent past the liveness deadline — treating as half-open, re-dialing");
        this.lastWsActivity = Date.now();   // don't re-fire every tick until the re-dial settles
        this.applyTransport("staleTick", ws);
      }
    }, WS_LIVENESS_CHECK_MS);
  }

  // EFFECT: re-establish ONLY the WS socket (no token re-acquire, no reconcile). Rejects if it
  // can't open, so the engine escalates to a full {connect}.
  private async doRews(): Promise<void> {
    if (!this.spinUpWs()) throw new Error("ws could not be opened");
  }

  // Arm the recovery the connection FSM's CLASS dictates (D-connfsm): a transient uses the equal-jitter
  // backoff (base/2 + random·base/2, capped 30s — disperses a fleet after a server restart); a lockedOut
  // waits the server's Retry-After window; a serverDegraded/unknown uses a slow fixed cadence; a BLOCKED
  // class (auth/version/vault) arms only a SLOW self-heal re-probe (~10m) — so a transient server-side
  // cause recovers WITHOUT the user, but we NEVER tight-loop (the field bug) and NEVER dead-end. Each fires
  // one {connect}. Stops the poll while down (the connect restarts it) so the two don't retry in parallel.
  private scheduleRecovery(rec: Recovery): void {
    if (this.reconnectTimer !== undefined || this.unloading) return;
    if (this.pollTimer !== undefined) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
    let delay: number;
    switch (rec.kind) {
      case RecoveryKind.Backoff: {
        const base = this.backoff;
        delay = Math.round(base / 2 + Math.random() * (base / 2));
        this.backoff = Math.min(base * 2, 30000);
        this.log(`retrying in ${Math.round(delay / 1000)}s`);
        break;
      }
      case RecoveryKind.After:
        delay = Math.max(1, rec.secs) * 1000;
        this.log(`locked out — retrying in ${Math.max(1, Math.round(rec.secs / 60))}m`);
        break;
      case RecoveryKind.Slow:
        delay = Math.max(1, rec.secs) * 1000;
        this.log(`server not ready — retrying in ${Math.round(rec.secs)}s`);
        break;
      case RecoveryKind.AwaitUser:
        delay = Math.max(60, rec.reprobeSecs) * 1000; // quiet self-heal probe; the status card shows the reason + a Reconnect action
        break;
    }
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; this.engine.enqueue({ kind: "connect" }); }, delay);
  }

  // The 4s safety-net poll is now just an event SOURCE: it enqueues {remote}; the engine serializes
  // it and doReconcileAll does the cheap incremental check, so an idle poll stays one tiny request.
  private startPolling(intervalMs: number = POLL_ACTIVE_MS): void {
    // Never (re)arm the poll during/after teardown. `unload` is handled synchronously and can run
    // while a connect() is suspended at an await (e.g. the refreshShareGrant round-trip); without this
    // guard the resuming connect would install a fresh interval that outlives teardown and pins the
    // plugin instance — one leaked timer per disable/re-enable cycle (critique F4, matches spinUpWs).
    if (this.unloading) return;
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => this.engine.enqueue({ kind: "remote" }), intervalMs);
  }

  // EFFECT: reconcile against the server (a remote poke or a poll tick). Cheap incremental check
  // first — an idle poll does one tiny changes() request and returns; a full reconcile runs only
  // when the version advanced or a periodic config scan is due. THROWS on failure → the engine goes
  // offline and schedules the backoff reconnect. (No applying/remoteDirty here: a poke arriving
  // mid-reconcile is just another queued {remote} the engine runs next — CONC-R3#3/R4#1 for free.)
  // @audit r2 2026-07-18 — FIXED (correctness): lastConfigScanAt/lastFullScanAt were stamped to `now`
  // BEFORE the awaited reconcile, so a mid-scan throw left the window marked "done" and the retry never
  // re-armed it — correctness leaned on doConnect re-stamping on recovery. Moved the stamps to AFTER the
  // awaited scan succeeds, so a failure leaves the window still due. (The idle-poll early-return is only
  // reached when NOT forced, so it correctly stamps nothing.)
  // @audit-hash sha256:a29e1be4f50e47d3
  private doReconcileAll(): Promise<void> {
    return this.withSyncRelogin(() => this.reconcileAllOnce()); // fix ②: a mid-session token expiry self-heals once
  }
  private async reconcileAllOnce(): Promise<void> {
    if (!this.api) throw new Error("not connected");
    // Local CONFIG edits fire no reliable event (mobile has no `raw` watcher) → a CONFIG-ONLY re-hash
    // runs at most every CONFIG_SCAN_INTERVAL_MS (cheap: only `.obsidian/` files). A missed local NOTE
    // edit is caught by a WHOLE-VAULT pass on the slower FULL_SCAN_INTERVAL_MS cadence. (R13)
    const now = Date.now();
    const forceConfigScan = this.settings.configSync.enabled && now - this.lastConfigScanAt >= CONFIG_SCAN_INTERVAL_MS;
    const forceFullScan = now - this.lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
    const delta = await this.api.changes(this.state.version);
    // D0019 (critique-R8): detect a server DELETION-HISTORY RESET from the PERSISTED per-vault floor +
    // last-version (both survive a restart, unlike the ephemeral state.version). A reset routes to the
    // FULL reconcile so every local file is visited + kept-and-collected, and noteHistory notifies.
    const reset = this.historyResetDetected(delta.version, delta.history_floor);
    // Short-circuit an idle poll (nothing changed AND no reset) — but still RECORD the floor/version
    // first (noteHistory), so an idle vault tracks them and a LATER reset stays detectable (a pure
    // tombstone-prune bumps the floor without any delta). No reconcile ran, so nothing was kept.
    const noChange = delta.upserts.length === 0 && delta.deletes.length === 0 && delta.version === this.state.version;
    const mode = decideReconcileMode({ forceConfigScan, forceFullScan, reset, noChange }); // pure scan-mode decision
    if (mode === "noop") {
      this.noteHistory(delta.version, delta.history_floor, []);
      void this.reconcileMounts(); // R6-Med1: mounts are POLL-driven — run them even when the PRIMARY is idle, so a source change pulls on the ~60s poll cadence (D0040) instead of waiting for a primary change / the 15-min full scan / a reconnect
      return;
    }
    const before = this.state.version;
    const kept: string[] = [];
    const held: string[] = []; // D0041: incoming deletions held for confirmation this pass
    const d = this.deps();
    d.onKeptAbsent = (p) => kept.push(p); // always collect; noteHistory decides whether to notify
    d.onGuard = (p) => held.push(p); // D0041: collect held deletions this pass (the toast fires from setPendingBulk on growth)
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
    if (mode === "full") {
      await reconcileAll(d);
    } else {
      await reconcileDelta(d, delta);
      if (mode === "delta+config") await reconcileLocalConfig(d);
    }
    // Mark the scan windows done ONLY now that the awaited scan actually completed — a mid-scan throw
    // above leaves them due so the next poll re-arms (rather than trusting doConnect to re-stamp). (@audit r2)
    if (forceConfigScan) this.lastConfigScanAt = now;
    if (forceFullScan) this.lastFullScanAt = now;
    await this.flushConfigReload();
    if (this.state.version !== before) this.log(`remote change → reconciled (v${before} → v${this.state.version})`);
    this.noteHistory(this.state.version, delta.history_floor, kept);
    this.setPendingBulk("primary", held, mode === "full"); // D0041: a full pass is authoritative (replace); a delta only adds (union)
    this.settings.lastSyncedAt = Date.now(); void this.saveSettings(); // persist so "Last synced" survives a restart (the onBaseChanged snapshot ran earlier in this pass)
    void this.reconcileMounts(); // composed vaults (D0039): poll each mount after the primary pass — DETACHED (B1), re-entrancy-guarded, fail-isolated
  }

  // Full reconcile with D0019 reset detection wired in — used by the CONNECT path (the initial
  // reconcile). CRITICAL (critique-R8 DI-H1): the connect reconcile is what actually resurrects
  // absent-without-tombstone files after a server reset, so detection+notify MUST run here, not only
  // on later polls (by the time a poll runs, the files are already re-pushed and nothing is "kept").
  private async reconcileFull(): Promise<void> {
    const kept: string[] = [];
    const held: string[] = []; // D0041
    const d = this.deps();
    d.onKeptAbsent = (p) => kept.push(p);
    d.onGuard = (p) => held.push(p);
    d.onStage = (s) => this.setConnectStage(s); // drive the connect sub-phase (no-op off the connect path — setConnectStage gates on `connecting`)
    const resp = await reconcileAll(d);
    this.noteHistory(resp.version, resp.history_floor, kept);
    this.setPendingBulk("primary", held, true); // reconcileFull is always a full pass → authoritative
    void this.reconcileMounts(); // composed vaults (D0039): initial full pass per mount — DETACHED (B1) so a hung mount never stalls the primary engine queue; fail-isolated internally
  }
  // D0041: record a scope's held incoming deletions + refresh the review surface. R11-F1: a FULL pass saw the
  // whole scope, so its held set is AUTHORITATIVE → replace (drops now-resolved paths). A DELTA pass only
  // re-examined changed paths + advances the cursor PAST the held tombstones, so it can only ADD (union) —
  // never clear a pending review it didn't re-examine (else an unrelated poll would silently wipe it). The
  // review therefore PERSISTS until the user acts (Accept/Keep) or a full scan confirms it's resolved.
  private setPendingBulk(scope: string, held: string[], authoritative: boolean): void {
    const cur = this.pendingBulkDeletes.get(scope) ?? [];
    const next = authoritative ? held : [...new Set([...cur, ...held])];
    if (next.length) this.pendingBulkDeletes.set(scope, next); else this.pendingBulkDeletes.delete(scope);
    if (next.length !== cur.length) { this.settingsRefresh?.(); this.statusListener?.(); this.renderLight(); }
    if (next.length > cur.length) this.toastBulkHeld(); // toast ONLY when the set grew — no re-nag on a re-hold of the same paths
  }
  private toastBulkHeld(): void {
    const n = [...this.pendingBulkDeletes.values()].reduce((s, a) => s + a.length, 0);
    if (n > 0) this.log(`${n} incoming deletion${n === 1 ? "" : "s"} awaiting your confirmation (Settings → SelfSync → Conflicts)`, true);
  }
  // The ReconcileDeps for a scope key ("primary" or a mountKey) — used to apply/keep held deletions on the
  // right base + io.
  private depsForScope(scope: string): ReconcileDeps | undefined {
    if (scope === "primary") return this.deps();
    return this.mountScopes.find((x) => x.runtime.key === scope)?.runtime.deps();
  }
  // --- D0041 review surface (read by the settings Conflicts section) ---
  // One group per scope with held incoming deletions: { scope key, human label, count }.
  pendingBulkDeletions(): { scope: string; label: string; count: number }[] {
    const out: { scope: string; label: string; count: number }[] = [];
    for (const [scope, paths] of this.pendingBulkDeletes) {
      if (!paths.length) continue;
      const label = scope === "primary" ? "this vault" : (this.mounts().find((m) => mountKey(m) === scope)?.mountPoint ?? "a mount");
      out.push({ scope, label, count: paths.length });
    }
    return out;
  }
  bulkDeletionPaths(scope: string): string[] { return [...(this.pendingBulkDeletes.get(scope) ?? [])]; }
  // R11-F6: after mutating a MOUNT scope's base in place, snapshot it back into mountStateStore BEFORE
  // persist(), so a crash right after Accept/Keep can't leave the persisted mount base disagreeing with disk.
  private refreshMountPersist(scope: string): void {
    if (scope === "primary") return;
    const s = this.mountScopes.find((x) => x.runtime.key === scope);
    if (s) this.mountStateStore[scope] = s.runtime.toPersist();
  }
  // Accept = perform the held deletions (remove local + drop base → gone everywhere, matching the tombstone).
  async acceptBulkDeletions(scope: string): Promise<void> {
    const paths = this.pendingBulkDeletes.get(scope);
    if (!paths?.length) return;
    const d = this.depsForScope(scope);
    if (!d) { new Notice("SelfSync: reconnecting — try that again in a moment."); return; } // R11-F7: scope not live (e.g. mid-reconnect)
    await applyHeldDeletions(d, paths);
    this.pendingBulkDeletes.delete(scope);
    this.refreshMountPersist(scope);
    await this.persist(); this.settingsRefresh?.(); this.statusListener?.(); this.renderLight();
    this.log(`applied ${paths.length} held deletion${paths.length === 1 ? "" : "s"} for ${scope === "primary" ? "this vault" : "a mount"}`);
  }
  // Keep = drop the base ancestor so the scope re-pushes (writable) / keeps-local (read-only). R11-F2: a
  // plain poll wouldn't re-visit these (their tombstones are behind the cursor), so FORCE a full pass — reset
  // the primary full-scan clock, or flag the mount scope — else the "re-syncing them" promise wouldn't happen
  // until the next 15-min full scan.
  async keepBulkDeletions(scope: string): Promise<void> {
    const paths = this.pendingBulkDeletes.get(scope);
    if (!paths?.length) return;
    const d = this.depsForScope(scope);
    if (!d) { new Notice("SelfSync: reconnecting — try that again in a moment."); return; }
    keepHeldDeletions(d, paths);
    this.pendingBulkDeletes.delete(scope);
    this.refreshMountPersist(scope);
    await this.persist(); this.settingsRefresh?.(); this.statusListener?.(); this.renderLight();
    if (scope === "primary") { this.lastFullScanAt = 0; this.engine.enqueue({ kind: "remote" }); } // force a full pass → re-push the base-less files
    else { const s = this.mountScopes.find((x) => x.runtime.key === scope); if (s) s.forceFull = true; void this.reconcileMounts(); }
    this.log(`kept ${paths.length} file${paths.length === 1 ? "" : "s"} the ${scope === "primary" ? "server" : "source"} deleted — re-syncing them`);
  }

  // ---- composed vaults (D0039): the per-mount sync subsystem (dormant when settings.mounts is empty) ----
  mounts(): Mount[] { return this.settings.mounts ?? []; } // public: the settings UI reads the raw configured set
  // The mounts actually IN EFFECT — the raw set only if it's valid (no overlapping/nested/duplicate mount
  // points), else empty. The SAME set MUST drive both the primary-scope exclusion (passes/accepts) AND
  // scope-building, so a bad set can't leave a folder excluded-from-primary yet handled-by-no-mount (N1). A
  // hand-edited invalid set → activeMounts() empty → the primary keeps syncing those folders (safe), nothing
  // mounted, until the set is fixed.
  activeMounts(): Mount[] {
    // The valid, non-overlapping SUBSET (R5-MED-3: one bad hand-edited mount drops only itself, not all — a
    // full-set deactivation would re-absorb the good mounts' folders into the primary and upload their
    // source-derived content there). Also EXCLUDE a mount of the CURRENT primary vault (R5-LOW-3: after a
    // switchToVault onto a mount's source, that mount is self-referential → auto-dormant).
    const po = this.settings.vaultOwner ?? "", pv = this.settings.vaultId ?? "";
    return validMounts(this.mounts()).filter((m) => !(m.source.owner === po && m.source.vaultId === pv));
  }
  // A transport bound to a mount's SOURCE vault (same server + session token; a different owner/vault). The
  // source is on the SAME server (cross-server mounts are out of scope, D0039), so the session token authorizes
  // it. Returns null if there's no session yet (never mid-connect).
  private buildMountApi(mount: Mount): ApiClient | null {
    if (!this.sessionToken) return null;
    return new HttpTransport(this.settings.serverUrl, this.sessionToken, mount.source.vaultId, mount.source.owner, this.deviceId(), this.deviceLabel());
  }
  // (Re)build the live mount scopes from settings.mounts, PRESERVING an existing scope's FSM state + runtime
  // (so a poll-cycle rebuild doesn't reset a live mount) and dropping scopes whose mount was removed. A new
  // mount restores its own persisted base + cursor from mountStateStore. A mount whose source transport can't
  // be built yet is skipped this pass.
  private rebuildMountScopes(): void {
    // Runtime overlap/dedupe guard (A2/C3): settings.mounts can be hand-edited past the UI's validation, so
    // activeMounts() = the valid, non-overlapping, non-self SUBSET (R5-MED-3: a single bad entry drops only
    // itself, not the good mounts — dropping all would re-absorb their folders into the primary). The primary
    // exclusion (passes/accepts) uses the SAME activeMounts() set, so the two scopes stay provably disjoint (N1).
    const want = this.activeMounts();
    if (want.length < this.mounts().length) this.log(`composed vaults: ${this.mounts().length - want.length} mount(s) ignored (invalid, overlapping, .obsidian-anchored, or the current primary vault) — the rest are active`);
    this.mountIo ??= this.buildMountIo();
    // R1-F2: mount source transports capture the session token by value. If the token rotated (a reactive-401
    // relogin), every preserved scope would 401 forever. Drop all existing scopes so they rebuild with the
    // fresh token; their own base+cursor survive in mountStateStore, so a rebuild resumes, not restarts.
    if (this.mountScopesToken !== this.sessionToken) { this.mountScopes = []; this.mountScopesToken = this.sessionToken; }
    const byKey = new Map(this.mountScopes.map((s) => [s.runtime.key, s]));
    const seen = new Set<string>();
    const next: MountScope[] = [];
    for (const mount of want) {
      const key = mountKey(mount);
      if (seen.has(key)) continue; // dedupe identical entries (C3)
      seen.add(key);
      const existing = byKey.get(key);
      if (existing) { next.push(existing); continue; } // keep live state + cursor across a rebuild
      const sourceApi = this.buildMountApi(mount);
      if (!sourceApi) continue; // no session yet — try again next connect
      const runtime = new MountRuntime(mount, {
        io: this.mountIo, sourceApi, cache: this.cache, device: this.deviceLabel(),
        restore: this.mountStateStore[key],
        // R6-Med2: on mobile the mount has no streamed writer, so a large file buffers whole (×concurrency) →
        // OOM. Cap the MOUNT's size gate below the (desktop-default) user setting on mobile; a bigger file is
        // skipped + noticed (onSkip), never buffered. Desktop keeps the user's setting.
        maxSyncBytes: Platform.isMobile ? Math.min(this.maxSyncBytes(), MOUNT_MOBILE_MAX_BYTES) : this.maxSyncBytes(),
        ignorePatterns: this.ignorePatterns(), // R5-LOW-2: apply the user's timestamp-ignore rules inside mounts too
        bulkDeleteStrategy: this.settings.bulkDeleteStrategy, // D0041: the global incoming bulk-delete confirmation applies to mounts too
        bulkDeleteThreshold: this.settings.bulkDeleteThreshold,
        // R4-F4 + R7-F1: hold the mount OFFLINE unless the SOURCE is both READY and on a COMPATIBLE protocol
        // version — the same guard the primary connect applies. sessionToken is set even after a version-
        // mismatched primary connect, so without this a mount could poll a protocol-incompatible source (shape
        // validation catches structural wire changes but not a semantic one — a hash/chunk-encoding change).
        sourceReady: async () => { const h = await sourceApi.status(); return h.status === "ready" && (await this.checkWireCompat(h.schemaHash)).ok; }, // D0042: same-server source shares the primary's verified signature (cheap)
        callbacks: {
          onFileError: (p, e: any) => this.log(`mount ${mount.mountPoint}: '${p}' failed (${e?.message ?? e})`),
          onConflict: (p) => this.log(`mount ${mount.mountPoint}: conflict copy created for '${p}' — your version is kept alongside the source's`),
          // R4-F3: a permanently-corrupt source copy (fails its integrity check every pull) and a too-large
          // file were silently missing from the composed folder — surface both, as the primary does.
          onPullExhausted: (p) => this.log(`mount ${mount.mountPoint}: can't download '${p}' from the source (repeated failures — likely a corrupt server copy); it's missing from this folder`, true),
          onSkip: (p, bytes) => this.log(`mount ${mount.mountPoint}: skipped '${p}' (${Math.round(bytes / 1048576)} MB — over this device's size limit); it's missing from this folder`),
          // R2-F2: surface a refused bulk delete (e.g. the source subtree looks empty) so a stalled mount is
          // visible, not silent — we never auto-delete on an empty/suspicious manifest.
          onGuard: (p) => this.log(`mount ${mount.mountPoint}: refused a suspicious bulk delete near '${p}' — not deleting local copies; remove + re-add the mount if the source folder was intentionally emptied`, true),
          // R2-F3: surface a file kept/restored because it was absent from the source with no deletion record
          // (a sync mount could otherwise re-upload a peer's deletion silently). Full D0019 reset-detection for
          // mounts is a tracked follow-up (issueMountResetDetection).
          onKeptAbsent: (p) => this.log(`mount ${mount.mountPoint}: kept '${p}' — absent from the source with no deletion record (not treating it as deleted)`, true),
        },
      });
      next.push({ runtime, state: "detached", fails: 0 });
    }
    this.mountScopes = next;
  }
  // Drive every mount one cycle after the primary pass, fully FAIL-ISOLATED: any error in the whole subsystem
  // is caught here so a mount problem can NEVER break the primary sync. Persists each mount's own base+cursor
  // as it changes and refreshes the status projection. No-op (near-zero cost) when no mounts are configured.
  private async reconcileMounts(): Promise<void> {
    // Re-entrancy guard (B1): never overlap mount passes / pile up on a hung mount. Residual (N3, accepted): a
    // pathological source api that never settles leaves this true → the mount subsystem goes dormant. Not
    // reachable via the real HttpTransport (REQUEST_TIMEOUT_MS bounds every request, so pollMount always
    // settles); strictly better than the pre-fix behaviour, which hung the PRIMARY.
    // R1-F1/F5: a request that arrives while a pass is running isn't dropped — it's DEFERRED and re-run on
    // release, so an add/reconnect during an in-flight pass is never silently lost.
    if (this.mountReconciling) { this.mountReconcilePending = true; return; }
    this.mountReconciling = true;
    try {
      if (this.mounts().length === 0) { if (this.mountScopes.length) { this.mountScopes = []; this.renderLight(); } return; }
      // R1-F1: rebuild EVERY pass (not just initial/empty) — rebuildMountScopes preserves live scopes by key and
      // adds/drops to match the configured set, so a mount added or removed in steady state is picked up here.
      this.rebuildMountScopes();
      if (this.mountScopes.length === 0) return; // couldn't build (no session) — nothing to do
      // R4-F2: a FAILED mount auto-recovers — after a backoff since it failed, reset it to detached so this
      // pass re-mounts it (a source that was reindexing/offline comes back without a manual reconnect).
      for (const s of this.mountScopes) if (s.state === "failed" && s.failedAt && Date.now() - s.failedAt >= MOUNT_FAILED_RETRY_MS) { s.state = "detached"; s.fails = 0; s.failedAt = undefined; }
      await reconcileMountScopes(this.mountScopes, {
        onEvent: (scope) => {
          if (!this.mountScopes.includes(scope)) return; // removed mid-pass (C1): don't resurrect the state we just deleted
          if (scope.state === "failed") { if (!scope.failedAt) scope.failedAt = Date.now(); } else scope.failedAt = undefined; // stamp/clear the backoff clock (R4-F2)
          this.mountStateStore[scope.runtime.key] = scope.runtime.toPersist();
          void this.persist(); // durably keep each mount's own base+cursor (single-flight coalesced)
          this.renderLight(); // fold the mount health into the indicator (+ the live Status hero via statusListener)
          this.bumpMountUi(); // refresh the per-mount rows live too (R10-F2, debounced)
        },
        onError: (scope, e: any) => this.log(`mount ${scope.runtime.mount.mountPoint} sync error (${e?.message ?? e}) — ${scope.state}`),
        onHeld: (scope, paths, authoritative) => { if (this.mountScopes.includes(scope)) this.setPendingBulk(scope.runtime.key, paths, authoritative); }, // D0041: record the mount's held incoming deletions for review

      // R1-F3/F4: skip a scope that was removed (no longer in mountScopes) or that we're unloading BEFORE driving
      // it, so a just-removed mount's disk isn't mutated and no write happens during teardown.
      }, (scope) => !this.unloading && this.mountScopes.includes(scope));
    } catch (e: any) {
      this.log(`mount subsystem error (${e?.message ?? e}) — primary sync unaffected`); // never rethrow: isolate from the primary
    } finally {
      this.mountReconciling = false;
      if (this.mountReconcilePending && !this.unloading) { this.mountReconcilePending = false; void this.reconcileMounts(); } // run the deferred request (R1-F1/F5)
    }
  }
  // The worst mount HEALTH + a human reason, or null when no mount is unhealthy (so the primary light shows
  // unchanged). The settings status card + the light fold read this.
  mountStatusSummary(): { health: Health; reason: string } | null {
    if (this.mountScopes.length === 0) return null;
    const agg = aggregateStatus("idle", this.mountScopes.map((s) => ({ label: s.runtime.mount.mountPoint, state: s.state })));
    // Only a PROBLEM (failed/offline/diverged) is worth surfacing on the light + card — a busy/ok/idle mount
    // isn't an alert (R4-F1).
    return (agg.health === "error" || agg.health === "offline" || agg.health === "diverged") ? agg : null;
  }
  // The live FSM state per configured mount, keyed by mountKey (a configured-but-not-yet-built mount reads
  // "detached"). The settings section renders this as each mount's status.
  mountStates(): Record<string, MountState> {
    const out: Record<string, MountState> = {};
    for (const m of this.mounts()) out[mountKey(m)] = "detached";
    for (const s of this.mountScopes) out[s.runtime.key] = s.state;
    return out;
  }
  // Add a mount (settings UI): persist it, then build + start it now if connected (else it builds on the next
  // connect). activeMounts() re-validates the whole set, so an add that would overlap simply doesn't take.
  async addMount(m: Mount): Promise<void> {
    this.settings.mounts = [...this.mounts(), m];
    await this.saveSettings();
    void this.reconcileMounts();
    this.log(`composed vaults: added mount ${m.mountPoint} ← ${m.source.owner ? m.source.owner + "/" : ""}${m.source.vaultId}${m.source.sourcePath ? "/" + m.source.sourcePath : ""} (${m.direction})`);
  }
  // Remove a mount (settings UI). NON-DESTRUCTIVE (D0039 default): the local files under the mount point are
  // KEPT as normal notes — activeMounts() no longer excludes that folder, so the PRIMARY scope now owns them
  // and syncs them to the primary vault. Its own base/cursor are dropped; nothing on disk is deleted.
  async removeMount(m: Mount): Promise<void> {
    const key = mountKey(m);
    // R1-F3: mark the scope unmounting FIRST — an in-flight detached pass re-checks state per scope and will
    // skip it (no disk mutation for a mount being removed) even though it still holds the pre-filter array.
    const live = this.mountScopes.find((s) => s.runtime.key === key);
    if (live) live.state = "unmounting";
    this.settings.mounts = this.mounts().filter((x) => mountKey(x) !== key);
    this.mountScopes = this.mountScopes.filter((s) => s.runtime.key !== key);
    delete this.mountStateStore[key];
    this.pendingBulkDeletes.delete(key); // D0041: drop any held-deletion review for a removed mount
    await this.saveSettings();
    this.log(`composed vaults: removed mount ${m.mountPoint} — its files are kept as normal notes in this vault`);
  }

  // Per-vault key for the persisted history floor + last-version (D0019). Owner-qualified so a shared
  // vault and an own vault of the same name never share state.
  private historyFloorKey(): string {
    return `${this.settings.vaultOwner ?? ""}/${this.settings.vaultId ?? ""}`;
  }
  // Normalized server host — part of the vault IDENTITY so the SAME owner/vault NAME on a DIFFERENT server is
  // a DIFFERENT vault (two servers trivially both host owner=""/vault="notes"; a server-blind key let one
  // overwrite the other's local files on a repoint — fix ③). Host only (scheme/port aside) stays stable
  // across an http/https or trailing-slash edit. (fix ③ 2026-08-01)
  private serverHost(): string {
    try { return new URL(this.settings.serverUrl).host.toLowerCase(); }
    catch { return (this.settings.serverUrl ?? "").toLowerCase(); }
  }
  // The D0047 guard's vault-identity key: server-qualified `host|owner/vault`. The `|` delimiter can occur
  // in neither a host (URL.host = alnum/dot/colon/hyphen) nor a vault name (lowercase/digits/dots/dash/
  // underscore), so an OLD (pre-fix-③, server-blind `owner/vault`) stored key — which lacks it — is
  // recognizable and grandfathered by the guard rather than forcing a spurious merge on upgrade.
  private vaultIdentityKey(): string {
    return `${this.serverHost()}|${this.settings.vaultOwner ?? ""}/${this.settings.vaultId ?? ""}`;
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
  // App returned to the foreground (mobile). Force a config re-scan on the next reconcile and kick one
  // now, so a config change that happened while suspended (here or on another device) syncs promptly
  // instead of waiting for the periodic tick. Cheap: the scan skips unchanged files by (size, mtime).
  private onResume() {
    if (this.unloading) return;
    // MOBILE (field 2026-08-02): a background suspend PAUSES the backoff reconnect timer (window.setTimeout),
    // and a `remote` event is DROPPED while disconnected (the engine ignores work until connected). So a
    // connection that failed/backed-off while suspended would NOT promptly re-attempt on resume — it looked
    // stuck with "nothing indicating it's rechecking". If we're disconnected, cancel the stale (paused)
    // backoff timer and re-attempt NOW (network/DNS is back on the foreground), and LOG it so the recheck is
    // visible. If connected, just re-assess (reconcile). ("off" = user-disconnected → leave it alone.)
    if (resumeAction(this.engine.getState()) === "connect") {
      if (this.reconnectTimer !== undefined) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
      this.log("app resumed — re-checking the connection");
      this.engine.enqueue({ kind: "connect" });
    } else {
      this.engine.enqueue({ kind: "remote" }); // connected → reconcile now rather than at the next poll tick
    }
    if (this.settings.configSync.enabled) this.lastConfigScanAt = 0; // also force a config re-scan
  }

  private lastConfigEventScanAt = 0;
  private configScanTimer?: number;
  // Trigger a config scan from a UI-event proxy (css-change / layout-change), COALESCED + RATE-LIMITED:
  // the first event fires promptly (wait ≈ 0); a burst (a plugin toggle emits several events) collapses
  // to one (a pending timer swallows the rest); steady navigation can't scan more than ~once per
  // CONFIG_EVENT_MIN_GAP_MS. The scan itself is cheap (skips unchanged files by size+mtime), so the
  // trigger needn't know WHAT changed — it just makes the scan due and kicks a reconcile.
  private scheduleConfigScan() {
    if (this.unloading || !this.settings.configSync.enabled || this.configScanTimer !== undefined) return;
    const wait = Math.max(0, CONFIG_EVENT_MIN_GAP_MS - (Date.now() - this.lastConfigEventScanAt));
    this.configScanTimer = window.setTimeout(() => {
      this.configScanTimer = undefined;
      if (this.unloading) return;
      this.lastConfigEventScanAt = Date.now();
      this.lastConfigScanAt = 0;               // config scan now due
      this.engine.enqueue({ kind: "remote" }); // run a reconcile now
    }, wait);
  }

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
  private doReconcilePath(path: string, size: number): Promise<void> {
    return this.withSyncRelogin(() => this.reconcilePathOnce(path, size)); // fix ②: a mid-session token expiry self-heals once
  }
  private async reconcilePathOnce(path: string, size: number): Promise<void> {
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
    // Parse-don't-validate at the persistence boundary: parseSettings hardens every field + freshens each
    // nested collection (see settings.ts). loadSettings owns only the read + the separate BaseStore.
    this.settings = parseSettings(s);
    // noteConflicts array retired (D-conflict-model): note conflicts are now derived from the vault.
    this.base = new BaseStore(data.base && typeof data.base === "object" ? data.base : {});
    // Composed vaults (D0039): each mount's OWN persisted base + cursor, keyed by mountKey (the per-mount
    // analogue of the single `base`). VALIDATED at the boundary (B2) — a malformed entry is dropped so hostile
    // input (non-numeric cursor, garbage base) can never reach the reconcile engine; that mount starts fresh.
    this.mountStateStore = parseMountState(data.mountState);
    // R8-F1: GARBAGE-COLLECT orphaned per-mount state. Only removeMount prunes a key in-session, so a mount
    // whose identity changed OUTSIDE the UI (a hand-edited sourcePath/mountPoint → new mountKey, a future
    // edit-in-place flow, or an old-format key after a mountKey-shape change) would strand a full base snapshot
    // (hash + note text) in data.json forever → monotonic bloat, worst on mobile. Keep only keys that match a
    // CURRENTLY-CONFIGURED mount (this.mounts(), not activeMounts — a temporarily invalid/overlapping entry
    // keeps its base until fixed). A dropped key just re-first-contacts (non-destructive: preserveLocalFirstContact).
    const liveKeys = new Set(this.mounts().map(mountKey));
    for (const k of Object.keys(this.mountStateStore)) if (!liveKeys.has(k)) delete this.mountStateStore[k];
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
        try { await this.saveData({ schemaVersion: this.dataSchemaVersion, settings: this.settings, base: this.base.toJSON(), mountState: this.mountStateStore }); }
        catch (e: any) { this.log(`WARNING: could not save settings/base: ${e?.message ?? e}`, true); }
      } while (this.persistPending);
    } finally { this.persisting = false; }
  }
}

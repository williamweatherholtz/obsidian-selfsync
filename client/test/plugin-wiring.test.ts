import { describe, it, expect, beforeEach, afterEach } from "vitest";
// "obsidian" is aliased to test/obsidian-stub.ts (see vitest.config.ts).
import NewLiveSyncPlugin, { ApiClient } from "../src/main";
import { VaultIo, SyncApi } from "../src/sync";
import { CLIENT_API_VERSION, FileMeta } from "../src/protocol";
import { ConnError, Endpoint } from "../src/connstate";
import { EMBEDDED_SIGNATURE, Signature } from "../src/wiresignature";
import { TFile } from "obsidian";
import { mountKey as mountKeyOf } from "../src/mountengine";
import { __notices } from "./obsidian-stub"; // Notice-message record (same module instance as the "obsidian" alias)

// In-memory VaultIo (enough for reconcile to run).
function memIo(seed: Record<string, string> = {}): VaultIo {
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(seed)) files.set(k, new TextEncoder().encode(v));
  return {
    async list() { const m = new Map<string, { mtime: number; size: number }>(); for (const [k, b] of files) m.set(k, { mtime: 0, size: b.length }); return m; },
    async read(p) { const b = files.get(p); if (!b) throw new Error("ENOENT " + p); return b; },
    async write(p, b) { files.set(p, b.slice()); },
    async remove(p) { files.delete(p); },
  };
}

// A spy ApiClient: records method calls, returns benign canned data, and exposes the WS onChanged
// callback so a test can simulate a server poke. Backed by no real server.
function spyApi() {
  const calls: Record<string, any[][]> = {};
  const rec = (name: string, args: any[]) => { (calls[name] ??= []).push(args); };
  let failChanges = false;
  let changesError: string | null = null; // D0021: settable custom error (e.g. an HTTP 404) from changes()
  let changesResp: any = { version: 0, upserts: [], deletes: [] }; // D0019: settable so a test can advance history_floor / rewind version
  let wsOnChanged: (() => void) | null = null;
  const wsSockets: any[] = []; // each fake WS connectWs() hands out, so a test can fire open/error/close on a superseded one
  // Default to the client's version — a real current server ALWAYS advertises api_version, and the
  // client now fails CLOSED on an absent/mismatched one (R12-PB2). Tests override for the mismatch case.
  let statusApiVersion: number | undefined = CLIENT_API_VERSION;
  let failStatusAuthTimes = 0;                 // number of leading status() calls that 401
  let failChangesAuthTimes = 0;                // number of leading changes() calls that 401 (a MID-SESSION token expiry on the poll path)
  let failStatus404 = false;                   // vault-gone: the status probe 404s (typed ConnError, endpoint=vaultStatus)
  let statusHealth = "ready";                  // server vault health reported by status() ("error" => degraded/reindex-needed)
  // D0042: a real current server advertises schemaHash + serves /schema; the client fails CLOSED on an absent
  // hash and refuses on a breaking signature diff. Default to a compatible pair (own embedded signature).
  let statusSchemaHash: string | undefined = "sha256:test-compat";
  let schemaSig: Signature = EMBEDDED_SIGNATURE;
  let schemaBodyHash: string | undefined; // undefined => /schema self-declares statusSchemaHash (they match); set to simulate F1 skew
  const api: ApiClient & {
    __calls: typeof calls; __poke: () => void; __failChanges: (v: boolean) => void;
    __setApiVersion: (v: number | undefined) => void; __failStatusAuth: (n: number) => void;
    __setChanges: (r: any) => void;
    __failChangesWith: (msg: string) => void;
    __failChangesAuth: (n: number) => void;
    __failStatus404: () => void;
    __setStatusHealth: (s: string) => void;
    __setSchemaHash: (v: string | undefined) => void;
    __setSchema: (s: Signature) => void;
    __setSchemaBodyHash: (v: string | undefined) => void;
    __wsSockets: any[];
  } = {
    __calls: calls,
    __poke: () => wsOnChanged?.(),
    __failChanges: (v) => { failChanges = v; },
    __setApiVersion: (v) => { statusApiVersion = v; },
    __failStatusAuth: (n) => { failStatusAuthTimes = n; },
    __setChanges: (r: any) => { changesResp = r; },
    __failChangesWith: (msg: string) => { changesError = msg; },
    __failChangesAuth: (n: number) => { failChangesAuthTimes = n; },
    __failStatus404: () => { failStatus404 = true; },
    __setStatusHealth: (s: string) => { statusHealth = s; },
    __setSchemaHash: (v) => { statusSchemaHash = v; },
    __setSchema: (s) => { schemaSig = s; },
    __setSchemaBodyHash: (v) => { schemaBodyHash = v; },
    async status() {
      rec("status", []);
      if (failStatusAuthTimes > 0) { failStatusAuthTimes--; throw new Error("status: HTTP 401"); }
      if (failStatus404) throw new ConnError("not found", { status: 404, endpoint: Endpoint.VaultStatus, wasLogin: false }); // vault gone (status probe)
      return { status: statusHealth, detail: "", version: 0, apiVersion: statusApiVersion, schemaHash: statusSchemaHash };
    },
    async schema() { rec("schema", []); return { hash: schemaBodyHash ?? statusSchemaHash ?? "sha256:test-compat", signature: schemaSig }; },
    async changes(since) { rec("changes", [since]); if (failChangesAuthTimes > 0) { failChangesAuthTimes--; throw new ConnError("unauthorized", { status: 401, endpoint: Endpoint.Other, wasLogin: false }); } if (changesError) throw new Error(changesError); if (failChanges) throw new Error("server down"); return changesResp; },
    async fileMeta(p) { rec("fileMeta", [p]); return null; },
    async missing(h) { rec("missing", [h]); return h; },
    async getChunk(h) { rec("getChunk", [h]); return new Uint8Array(0); },
    async putChunk(h, b) { rec("putChunk", [h, b]); },
    async commit(r) { rec("commit", [r]); return { ...r, version: 1 } as FileMeta; },
    async deleteFile(p) { rec("deleteFile", [p]); },
    connectWs(onChanged) {
      rec("connectWs", []); wsOnChanged = onChanged;
      const listeners: Record<string, Function[]> = {};
      const ws = {
        addEventListener(type: string, cb: Function) { (listeners[type] ??= []).push(cb); },
        close() {},
        __fire(type: string) { for (const cb of [...(listeners[type] ?? [])]) cb(); }, // test hook: dispatch a WS event
      };
      wsSockets.push(ws);
      return ws as unknown as WebSocket;
    },
    __wsSockets: wsSockets,
  };
  return api;
}

// A test plugin that injects the in-memory io + spy api + stubbed auth (no Obsidian, no server).
class TestPlugin extends NewLiveSyncPlugin {
  api_ = spyApi();
  io_ = memIo();
  loginCount = 0;
  protected buildIo() { return this.io_; }
  protected buildApi() { return this.api_; }
  protected loginRemote() { this.loginCount++; return Promise.resolve("test-token"); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

function makeApp() {
  const events: Record<string, Function[]> = {};
  const app: any = {
    vault: {
      on: (name: string, cb: Function) => { (events[name] ??= []).push(cb); return {}; },
      getAbstractFileByPath: (p: string) => { const f = new TFile(); f.path = p; return f; },
      adapter: {},
    },
    workspace: {
      onLayoutReady: (cb: Function) => cb(), // fire immediately so onload connects
      on: (name: string, cb: Function) => { (events[name] ??= []).push(cb); return {}; }, // capture so fire() can trigger UI events
      getActiveViewOfType: () => null,
      trigger: () => {},
    },
  };
  const fire = (name: string, ...args: any[]) => (events[name] ?? []).forEach((cb) => cb(...args));
  return { app, fire };
}

async function bootPlugin(configured = true, opts: { preOnload?: (p: TestPlugin) => void; settings?: Record<string, unknown> } = {}) {
  const { app, fire } = makeApp();
  const p = new TestPlugin(app, { id: "obsidian-selfsync", dir: ".obsidian/plugins/obsidian-selfsync" } as any);
  // Pre-seed configured settings via loadData so onLayoutReady connects instead of opening setup.
  (p as any)._data = configured ? { settings: { serverUrl: "http://x", username: "u", password: "p", vaultId: "default", ...(opts.settings ?? {}) } } : {};
  opts.preOnload?.(p); // configure the spy api before onload triggers the connect
  await p.onload();
  await flush(); // let the connect effect settle
  return { p, fire, api: p.api_ };
}

// Track EVERY window timer a test schedules so afterEach can force-clear any the plugin's onunload
// missed — a leaked reconnect-backoff setTimeout or poll setInterval would otherwise fire during a
// LATER test (real Node timers persist across tests) and mutate its state. That cross-test leak is the
// root cause of the intermittent "D0047 guard is SERVER-qualified" flake: a stray reconnect re-stamped
// baseVaultKey mid-assertion. (issuePluginWiringTimerLeak, D0047 — a correction becomes a guard.)
let liveTimers = new Set<any>();
beforeEach(() => {
  liveTimers = new Set();
  // main.ts uses window.setTimeout/setInterval; provide them in the node test env, tracking live ids.
  const track = (fn: (...a: any[]) => any, oneShot: boolean) => (cb: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
    const id = fn((...a: any[]) => { if (oneShot) liveTimers.delete(id); cb(...a); }, ms, ...rest);
    liveTimers.add(id);
    return id;
  };
  (globalThis as any).window = {
    setTimeout: track(setTimeout.bind(globalThis), true),
    clearTimeout: (id: any) => { liveTimers.delete(id); clearTimeout(id); },
    setInterval: track(setInterval.bind(globalThis), false),
    clearInterval: (id: any) => { liveTimers.delete(id); clearInterval(id); },
  };
});
afterEach(() => {
  // Force-clear anything a test left scheduled (Node's clearTimeout/clearInterval both accept a Timeout
  // handle, so clearing both ways is safe) — guarantees timer isolation between tests regardless of
  // whether every code path's onunload cleared its own timers.
  for (const id of liveTimers) { clearTimeout(id); clearInterval(id); }
  liveTimers.clear();
});

describe("plugin wiring — producers → engine → effects", () => {
  it("configured onload connects: status-checked, initial reconcile, WS opened, phase idle", async () => {
    const { p, api } = await bootPlugin();
    expect(api.__calls.status?.length).toBe(1);      // health-checked before reconciling
    expect(api.__calls.changes?.length ?? 0).toBeGreaterThanOrEqual(1); // initial reconcileAll
    expect(api.__calls.connectWs?.length).toBe(1);   // spun up the WS
    expect(p.statusText()).toBe("idle");
    p.onunload();
  });

  it("a SUPERSEDED WS socket's late open/error does NOT disturb the current live socket (issueWsSupersededOpenError)", async () => {
    const { p, api } = await bootPlugin();
    const ws1 = api.__wsSockets[0];
    ws1.__fire("open");                                   // ws1 opens → transport live
    expect(p.realtimeConnected).toBe(true);
    (p as any).spinUpWs();                                 // supersede: this.ws is now ws2 (ws1 closed + orphaned)
    const ws2 = api.__wsSockets[api.__wsSockets.length - 1];
    expect(ws2).not.toBe(ws1);
    ws2.__fire("open");                                    // ws2 opens → still live
    expect(p.realtimeConnected).toBe(true);
    // A LATE error from the SUPERSEDED ws1 (racing the abort) must be IGNORED — it must NOT degrade the
    // current live ws2 (which would give a false "Synced (polling)" + pin the poll to 4s). Fail-first:
    // without the this.ws!==ws guard on the error handler, this flips realtimeConnected to false.
    ws1.__fire("error");
    expect(p.realtimeConnected).toBe(true);
    ws1.__fire("open");                                    // a late open from the superseded socket is likewise ignored
    expect(p.realtimeConnected).toBe(true);
    p.onunload();
  });

  it("unconfigured onload does NOT connect (routes to setup)", async () => {
    const { p, api } = await bootPlugin(false);
    expect(api.__calls.status?.length ?? 0).toBe(0);
    expect(p.statusText()).toBe("off");
    p.onunload();
  });

  it("plugin autopilot: auto-syncs YOUR OWN new plugins (local + own-server), GATES a peer's for approval", async () => {
    const { p, api } = await bootPlugin(true, { settings: { autoSyncNewPlugins: true, configSync: { enabled: true, community: true, pluginAllow: [] } } });
    const anyp = p as any;
    // A plugin installed HERE, and two on the server: one YOU added (author "u" = this account), one a PEER added.
    (p.app as any).plugins = { manifests: { localplug: { id: "localplug" } }, plugins: {} };
    anyp.serverPluginIds = new Set(["mineplug", "peerplug"]);
    anyp.serverPluginAuthors = new Map([["mineplug", "u"], ["peerplug", "alice"]]); // main.js committer per plugin (from the manifest)
    anyp.vaultIsPrivate = false; // shared vault → the author decides own-vs-peer
    await anyp.runPluginAutopilot();
    const allow = p.settings.configSync.pluginAllow;
    expect(allow).toContain("localplug"); // installed here → auto-uploaded
    expect(allow).toContain("mineplug");  // your own server plugin → auto-adopted
    expect(allow).not.toContain("peerplug"); // a peer's → NOT adopted; awaits approval
    expect(anyp.getPendingPeerPlugins()).toEqual([{ id: "peerplug", author: "alice" }]);
    p.onunload();
  });

  it("plugin autopilot is a NO-OP when the setting is off (nothing auto-synced)", async () => {
    const { p } = await bootPlugin(true, { settings: { autoSyncNewPlugins: false, configSync: { enabled: true, community: true, pluginAllow: [] } } });
    const anyp = p as any;
    (p.app as any).plugins = { manifests: { localplug: { id: "localplug" } }, plugins: {} };
    anyp.serverPluginIds = new Set(["mineplug"]);
    await anyp.runPluginAutopilot();
    expect(p.settings.configSync.pluginAllow).toEqual([]); // opt-in: off → untouched
    p.onunload();
  });

  it("plugin autopilot respects an un-tick — a manually-removed plugin is NOT re-added on the next pass", async () => {
    const { p } = await bootPlugin(true, { settings: { autoSyncNewPlugins: true, configSync: { enabled: true, community: true, pluginAllow: [] } } });
    const anyp = p as any;
    (p.app as any).plugins = { manifests: { localplug: { id: "localplug" } }, plugins: {} };
    anyp.serverPluginIds = new Set();
    await anyp.runPluginAutopilot();
    expect(p.settings.configSync.pluginAllow).toContain("localplug"); // NEW → auto-added
    p.settings.configSync.pluginAllow = []; // user un-ticks it
    await anyp.runPluginAutopilot();
    expect(p.settings.configSync.pluginAllow).not.toContain("localplug"); // seen → NOT re-added (manual choice wins)
    p.onunload();
  });

  it("statusDisplay gives actionable status — a PURE projection of Phase (no setting/flag can latch a label)", async () => {
    const { p } = await bootPlugin();
    (p as any).syncPending = 3;
    expect(p.statusDisplay("syncing")).toEqual({ label: "Syncing…", detail: "3 pending" });
    // A syncing phase with nothing pending is a CHECK, not a state (issueStatusLightFlicker): no
    // "checking for changes" detail — and the light never even paints it (effectivePhase collapses it to idle).
    (p as any).syncPending = 0;
    expect(p.statusDisplay("syncing")).toEqual({ label: "Syncing…", detail: "" });
    (p as any).transport = "live"; // realtimeConnected is now a computed getter (transport === "live")
    expect(p.statusDisplay("idle").label).toBe("Fully synced");
    (p as any).transport = "offline";
    expect(p.statusDisplay("idle").label).toBe("Synced (polling)");
    // Read-only vault: idle must NOT read a plain green "Fully synced" (edits there never upload).
    (p as any).settings.vaultReadOnly = true;
    expect(p.statusDisplay("idle")).toEqual({ label: "Synced (read-only)", detail: "your edits stay on this device" });
    (p as any).settings.vaultReadOnly = false;
    // PURE PROJECTION (field bug 2026-08-02): a persisted pendingSwitch (a SETTING) must NOT change the
    // label — a switch is transient and shows as the normal syncing/idle projection, so it can't latch a
    // stale "Switching vault… applying your choice" while actually synced.
    (p as any).settings.pendingSwitch = "download";
    (p as any).syncPending = 2;
    expect(p.statusDisplay("syncing")).toEqual({ label: "Syncing…", detail: "2 pending" }); // NOT "Switching vault…"
    expect(p.statusDisplay("idle").label).toBe("Synced (polling)");                          // NOT "Switching vault…"
    (p as any).settings.pendingSwitch = undefined;
    p.onunload();
  });

  it("surfaces the live connect sub-phase as the 'Connecting…' detail, cleared after connect (L-5)", async () => {
    const { p } = await bootPlugin();
    // A COMPLETED connect leaves no stale stage → no detail latches under "Connecting…".
    expect(p.statusDisplay("connecting")).toEqual({ label: "Connecting…", detail: "" });
    // MID-connect the live sub-phase shows as the DETAIL; the label stays the pure FSM projection.
    (p as any).connectStage = "fetching changes from the server";
    expect(p.statusDisplay("connecting")).toEqual({ label: "Connecting…", detail: "fetching changes from the server" });
    p.onunload();
  });

  it("a config-related UI event (css-change) triggers a config scan — event-driven, not just polled", async () => {
    const { p, fire, api } = await bootPlugin(true, { settings: { configSync: { enabled: true } } });
    const before = api.__calls.changes?.length ?? 0;
    fire("css-change");   // theme/snippet/appearance edit proxy; first event schedules with ~0 delay
    await flush();
    expect(api.__calls.changes?.length ?? 0).toBeGreaterThan(before); // a reconcile (config scan) fired on the event
    p.onunload();
  });

  it("a config UI event does NOTHING when config sync is OFF (no needless scans)", async () => {
    const { p, fire, api } = await bootPlugin(); // configSync default OFF
    const before = api.__calls.changes?.length ?? 0;
    fire("layout-change");
    await flush();
    expect(api.__calls.changes?.length ?? 0).toBe(before); // gated on configSync.enabled
    p.onunload();
  });

  it("a local file modify → reconcilePath for that path (fileMeta probed)", async () => {
    const { p, fire, api } = await bootPlugin();
    const f = new TFile(); f.path = "note.md"; f.stat = { size: 3, mtime: 0, ctime: 0 };
    fire("modify", f);
    await flush();
    expect(api.__calls.fileMeta?.some((c) => c[0] === "note.md")).toBe(true);
    p.onunload();
  });

  // mountNudgeHardening F4: a user edit UNDER a live mount folder forces that mount's scope to run a full
  // local-scanning pass NOW (scope.forceFull) instead of waiting for the ~60s poll — the push-back nudge.
  // Drives the REAL onLocalEvent → nudgeMountForLocalPath wiring over the plugin (no live source transport
  // needed: a minimal fake scope stands in, and reconcileMounts is stubbed so nothing tries to run it).
  it("a local edit under a mount forces that mount's scope full (push nudge); an echo or an outside path does NOT", async () => {
    const { p, fire } = await bootPlugin();
    const anyp = p as any;
    const mount = { source: { owner: "will", vaultId: "asi", sourcePath: "" }, mountPoint: "Work/ASI", direction: "sync" };
    p.settings.mounts = [mount as any];
    const key = mountKeyOf(mount as any);
    const scope: any = { runtime: { key, mount }, state: "idle", fails: 0, forceFull: false };
    anyp.mountScopes = [scope];
    anyp.reconcileMounts = () => {}; // don't actually run the fake scope
    const edit = (path: string) => { const f = new TFile(); f.path = path; f.stat = { size: 1, mtime: 0, ctime: 0 }; fire("modify", f); };

    edit("Inbox/out.md");                 // outside every mount → primary owns it
    expect(scope.forceFull).toBe(false);
    edit("Work/ASI/note.md");             // a user edit under the mount → nudge
    expect(scope.forceFull).toBe(true);

    scope.forceFull = false;
    anyp.recentSelfWrites.set("Work/ASI/pulled.md", Date.now()); // mark as our own pull-write
    edit("Work/ASI/pulled.md");           // the echo of our write → NOT a user edit → no nudge
    expect(scope.forceFull).toBe(false);
    p.onunload();
  });

  // mountNudgeHardening F7: activeMounts() is memoized (it runs on every file event) and self-invalidates when
  // the mount set changes — the same result identity on repeat, a fresh compute after an edit.
  it("activeMounts() memoizes and invalidates on a mount-set change (F7)", async () => {
    const { p } = await bootPlugin();
    p.settings.mounts = [{ source: { owner: "will", vaultId: "asi", sourcePath: "" }, mountPoint: "Work/ASI", direction: "sync" } as any];
    const a = p.activeMounts();
    expect(a).toHaveLength(1);
    expect(p.activeMounts()).toBe(a);               // cache hit → same array reference (no recompute)
    p.settings.mounts = [...p.settings.mounts, { source: { owner: "will", vaultId: "asi", sourcePath: "Refs" }, mountPoint: "Docs", direction: "pull" } as any];
    const b = p.activeMounts();
    expect(b).not.toBe(a);                           // set changed → recomputed
    expect(b).toHaveLength(2);
    p.onunload();
  });

  // mountBaseFreshness R8-F4 (in-session): when the primary is ON a mount's source, that mount is self-
  // referentially dormant while the primary rewrites the same local folder → its persisted base goes stale.
  // The CENTRAL drop lives in rebuildMountScopes (reached by EVERY repoint via reconnect — switchToVault, the
  // setup wizard's direct-sets, a redeem — closing the F1 missed-cases + the F2 write-back race the critique
  // found). It drops only the self-ref mount's base and leaves unrelated mounts' bases intact.
  it("mountBaseFreshness: rebuildMountScopes drops the stale base of a mount whose source IS the primary; others untouched (R8-F4)", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    anyp.mountIo = {};                // skip buildMountIo (needs a real adapter)
    anyp.buildMountApi = () => null;  // don't build/poll real source transports in the test
    p.settings.vaultId = "shared-src"; p.settings.vaultOwner = undefined; // primary IS src's source
    const src = { source: { owner: "", vaultId: "shared-src", sourcePath: "" }, mountPoint: "Work/ASI", direction: "sync" };
    const other = { source: { owner: "", vaultId: "other-src", sourcePath: "" }, mountPoint: "Docs", direction: "pull" };
    p.settings.mounts = [src as any, other as any];
    const kSrc = mountKeyOf(src as any), kOther = mountKeyOf(other as any);
    anyp.mountStateStore[kSrc] = { base: { "a.md": { hash: "h", text: "", normHash: "n", size: 1, mtime: 1 } }, version: 3 };
    anyp.mountStateStore[kOther] = { base: { "b.md": { hash: "h2", text: "", normHash: "n2", size: 1, mtime: 1 } }, version: 2 };
    anyp.rebuildMountScopes();        // the central drop — reached by every repoint via reconnect
    expect(anyp.mountStateStore[kSrc]).toBeUndefined();  // self-ref → stale base dropped → reactivation re-first-contacts
    expect(anyp.mountStateStore[kOther]).toBeDefined();  // an unrelated mount is untouched
    p.onunload();
  });

  // mountBaseFreshness R8-F4 (cross-session): booting ALREADY ON a mount's source (switched onto it a prior
  // session, reopened here) must likewise drop that mount's stale persisted base at load.
  it("mountBaseFreshness: loading already on a mount's source drops that mount's stale base (cross-session)", async () => {
    const mount = { source: { owner: "", vaultId: "shared-src", sourcePath: "" }, mountPoint: "Work/ASI", direction: "sync" };
    const key = mountKeyOf(mount as any);
    const { p } = await bootPlugin(true, {
      settings: { vaultId: "shared-src", mounts: [mount] },
      preOnload: (pp) => { (pp as any)._data.mountState = { [key]: { base: { "a.md": { hash: "h", text: "", normHash: "n", size: 1, mtime: 1 } }, version: 5 } }; },
    });
    expect((p as any).mountStateStore[key]).toBeUndefined(); // dropped at load (we're on its source) → clean reactivation later
    p.onunload();
  });

  // mountLiveSubscription: each active mount gets its own live WS to its source vault so a source change syncs
  // promptly (not just on the ~60s poll). The subscription set is idempotent, pokes a mount reconcile on a
  // source change, and closes sockets for mounts that leave the active set. The server already authorizes a
  // shared-source Read subscription, so this is client-only.
  const liveMount = { source: { owner: "alice", vaultId: "shared", sourcePath: "" }, mountPoint: "Work/ASI", direction: "sync" };
  const liveScope = (p: any) => { const key = mountKeyOf(liveMount as any); (p as any).mountScopes = [{ runtime: { key, mount: liveMount }, state: "live", fails: 0 }]; return key; };

  it("mountLiveSubscription: opens a WS per HEALTHY active mount, pokes reconcile on a source change, closes on removal", async () => {
    const { p } = await bootPlugin();                 // connects → engine 'idle' → primaryLinkUp() true
    const anyp = p as any;
    const key = liveScope(p);
    let onChanged: (() => void) | null = null;
    let closed = false;
    const fakeWs: any = { addEventListener() {}, close() { closed = true; } };
    const connectWsCalls: Array<() => void> = [];
    anyp.buildMountApi = () => ({ connectWs: (cb: () => void) => { connectWsCalls.push(cb); onChanged = cb; return fakeWs; } });
    let reconcileMountsCalls = 0;
    anyp.reconcileMounts = async () => { reconcileMountsCalls++; };
    anyp.MOUNT_POKE_COALESCE_MS = 0;                  // fire the coalesced poke on the next tick (no debounce wait)

    anyp.syncMountSubscriptions([liveMount]);
    expect(connectWsCalls.length).toBe(1);            // one WS opened for the healthy active mount
    expect(anyp.mountSockets.get(key)).toBe(fakeWs);

    anyp.syncMountSubscriptions([liveMount]);         // idempotent — already subscribed → no second socket
    expect(connectWsCalls.length).toBe(1);

    onChanged!(); onChanged!(); onChanged!();          // a BURST of source-change notifications…
    await flush();
    expect(reconcileMountsCalls).toBe(1);             // …COALESCED into ONE reconcile pass (bulk-delete confirmation intact)

    anyp.syncMountSubscriptions([]);                  // the mount left the active set (removed/dormant)
    expect(closed).toBe(true);                        // its WS is closed…
    expect(anyp.mountSockets.has(key)).toBe(false);   // …and forgotten (reopens if it returns)
    p.onunload();
  });

  it("mountLiveSubscription: removeMount closes the mount's WS immediately (no leak) (5-pass review)", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    const key = liveScope(p);
    p.settings.mounts = [liveMount as any];
    let closed = false;
    anyp.buildMountApi = () => ({ connectWs: () => ({ addEventListener() {}, close() { closed = true; } }) });
    anyp.syncMountSubscriptions([liveMount]);
    expect(anyp.mountSockets.has(key)).toBe(true);
    await p.removeMount(liveMount as any);
    expect(closed).toBe(true);                        // closed on removal, not left dangling until an unrelated pass
    expect(anyp.mountSockets.has(key)).toBe(false);
    p.onunload();
  });

  it("mountLiveSubscription: a dropped mount socket (close/error) reopens on the next subscription sync", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    const key = liveScope(p);
    const listeners: Record<string, Array<() => void>> = {};
    const mkWs = () => ({ addEventListener: (t: string, cb: () => void) => { (listeners[t] ??= []).push(cb); }, close() {}, __fire: (t: string) => (listeners[t] ?? []).forEach((cb) => cb()) });
    let ws: any;
    anyp.buildMountApi = () => ({ connectWs: () => { ws = mkWs(); return ws; } });
    anyp.reconcileMounts = async () => {};

    anyp.syncMountSubscriptions([liveMount]);
    const first = ws;
    expect(anyp.mountSockets.get(key)).toBe(first);
    first.__fire("close");                            // the source WS dropped
    expect(anyp.mountSockets.has(key)).toBe(false);   // forgotten so the next sync reopens it
    anyp.syncMountSubscriptions([liveMount]);         // next poll cycle
    expect(anyp.mountSockets.get(key)).toBe(ws);      // a FRESH socket opened
    expect(ws).not.toBe(first);
    p.onunload();
  });

  // Critique F1/F3/F4: a subscription is gated on the PRIMARY link being up, the scope being HEALTHY, and
  // buildMountApi not throwing — no source WS opened (or held) otherwise.
  it("mountLiveSubscription: no socket when the primary link is DOWN, the scope is UNHEALTHY, or buildMountApi throws", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    const key = liveScope(p);
    let opens = 0;
    anyp.buildMountApi = () => ({ connectWs: () => { opens++; return { addEventListener() {}, close() {} }; } });
    anyp.reconcileMounts = async () => {};

    const realGetState = anyp.engine.getState.bind(anyp.engine); // post-boot: 'idle'
    // F1: primary link down (engine 'disconnected') → no socket even with a healthy scope.
    anyp.engine.getState = () => "disconnected";
    anyp.syncMountSubscriptions([liveMount]);
    expect(opens).toBe(0);
    expect(anyp.mountSockets.size).toBe(0);

    // Bring the link back (idle) but make the scope UNHEALTHY (offline) → still no socket (F3).
    anyp.engine.getState = realGetState;
    anyp.mountScopes = [{ runtime: { key, mount: liveMount }, state: "offline", fails: 1 }];
    anyp.syncMountSubscriptions([liveMount]);
    expect(opens).toBe(0);

    // Healthy scope + link up but buildMountApi THROWS (insecure remote) → caught, no crash, no socket (F4).
    liveScope(p);
    anyp.buildMountApi = () => { throw new Error("insecure remote"); };
    expect(() => anyp.syncMountSubscriptions([liveMount])).not.toThrow();
    expect(anyp.mountSockets.size).toBe(0);
    p.onunload();
  });

  it("a WS poke → a fresh reconcileAll (changes re-queried)", async () => {
    const { p, api } = await bootPlugin();
    const before = api.__calls.changes?.length ?? 0;
    api.__poke();       // simulate a server change notification
    await flush();
    expect((api.__calls.changes?.length ?? 0)).toBeGreaterThan(before);
    p.onunload();
  });

  it("D0019: a server history_floor advance is detected → full reconcile + the per-vault floor persists", async () => {
    const { p, api } = await bootPlugin();
    const changes0 = () => (api.__calls.changes ?? []).filter((c) => c[0] === 0).length;
    // First poke establishes the baseline floor (1) — stored, but NOT a reset (no prior floor).
    api.__setChanges({ version: 5, upserts: [], deletes: [], history_floor: 1 });
    api.__poke(); await flush();
    expect(p.settings.historyFloors?.["/default"]).toBe(1);
    // Now the server's deletion history was reset (floor 1 → 50, e.g. a corrupt-index reindex).
    const before0 = changes0();
    api.__setChanges({ version: 50, upserts: [], deletes: [], history_floor: 50 });
    api.__poke(); await flush();
    // Detected as a reset → routed to the FULL reconcile (which re-queries changes(0)), and the new
    // floor is persisted so it isn't re-flagged next poll.
    expect(changes0()).toBeGreaterThan(before0);
    expect(p.settings.historyFloors?.["/default"]).toBe(50);
    p.onunload();
  });

  it("orchestration: a raw config event syncs an in-scope path via the live pipeline, never the plugin's own folder", async () => {
    // Exercises the imperative raw-event config pipeline end to end (issueOrchestrationUntested):
    // raw event → security filter (scope + self-folder) → debounce/coalesce → engine → reconcilePath.
    const { p, fire, api } = await bootPlugin(true, { settings: { configSync: { enabled: true } } });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    fire("raw", ".obsidian/app.json");                                  // in-scope core config → should sync
    fire("raw", ".obsidian/plugins/obsidian-selfsync/data.json");       // OUR OWN plugin folder → must be filtered (credentials never leave)
    await wait(700); await flush();                                     // > RAW_DEBOUNCE_MS (600ms)
    const probed = (api.__calls.fileMeta ?? []).map((c) => c[0] as string);
    expect(probed).toContain(".obsidian/app.json");                     // the live pipeline reconciled it
    expect(probed.some((x) => x.includes("obsidian-selfsync"))).toBe(false); // self-folder never synced (SEC)
    p.onunload();
  });

  it("D0021: a vault-gone 404 on the status probe → blocked + isVaultGone (re-create-from-device prompt)", async () => {
    // The synced vault was deleted server-side: the connect health probe (vault-scope status) 404s. The
    // connection FSM classifies it vaultGone → a BLOCKED link (not a tight retry), and the plugin flags
    // vaultGone (read from the LinkState) so settings can offer 'Re-create this vault from this device'.
    const { p } = await bootPlugin(true, { preOnload: (pp) => pp.api_.__failStatus404() });
    expect(p.statusText()).toBe("blocked");
    expect(p.isVaultGone()).toBe(true);
    p.onunload();
  });

  it("a generic reconcile failure drives the engine to a retrying link (transient)", async () => {
    const { p, api } = await bootPlugin();
    api.__failChanges(true);
    api.__poke();       // triggers reconcileAll → changes() throws (a plain error → transient → retrying)
    await flush();
    expect(p.statusText()).toBe("retrying");
    p.onunload();
  });

  it("P2: applying a config-sync change kicks an immediate reconcile (not a ~2-min wait)", async () => {
    // The bug was that a config toggle only persisted, so it looked inert until the next config-scan
    // tick. applyConfigSyncChange() must force a scan NOW: a reconcile (changes()) runs right away.
    const { p, api } = await bootPlugin(true, { settings: { configSync: { enabled: true } } });
    const before = api.__calls.changes?.length ?? 0;
    p.settings.configSync.core = true;      // as flipping a category toggle would
    await p.applyConfigSyncChange();
    await flush();
    expect(api.__calls.changes?.length ?? 0).toBeGreaterThan(before);
    p.onunload();
  });

  it("unload projects the light off", async () => {
    const { p } = await bootPlugin();
    p.onunload();
    expect(p.statusText()).toBe("off");
  });

  it("REFUSES to sync on a BREAKING wire-signature mismatch (blocked, specific reason, never reconciles)", async () => {
    // D0042: the server's wire signature drops an endpoint the client requires → the directional diff finds a
    // BREAKING delta → doConnect throws BEFORE reconciling (no changes() call); the FSM classifies it
    // versionMismatch → a BLOCKED link (awaits an update, not a tight retry) with a SPECIFIC actionable reason.
    const breaking: Signature = JSON.parse(JSON.stringify(EMBEDDED_SIGNATURE));
    breaking.endpoints = breaking.endpoints.filter((e) => e !== "GET /api/v/:vault/status");
    const { p, api } = await bootPlugin(true, {
      preOnload: (tp) => { tp.api_.__setSchema(breaking); tp.api_.__setSchemaHash("sha256:breaking"); },
    });
    expect(p.statusText()).toBe("blocked");
    expect(api.__calls.changes?.length ?? 0).toBe(0); // never touched the vault data
    expect(p.getLastIssue()).toMatch(/incompatible|no longer exposes/i);
    p.onunload();
  });

  it("REFUSES to sync (fail CLOSED) against a server that advertises NO wire signature (too old)", async () => {
    // An older server sends no schemaHash → the client can't confirm compatibility → refuse, don't sync.
    const { p, api } = await bootPlugin(true, { preOnload: (tp) => tp.api_.__setSchemaHash(undefined) });
    expect(p.statusText()).toBe("blocked");
    expect(api.__calls.changes?.length ?? 0).toBe(0);
    expect(p.getLastIssue()).toMatch(/signature|update your server/i);
    p.onunload();
  });

  it("REFUSES when /schema's self-declared hash doesn't match the /status hash (F1 stale-cache skew)", async () => {
    // /status advertises the fresh hash; a cached/stale /schema declares a DIFFERENT hash → the client must
    // not trust (and diff) a signature the server isn't really running → refuse, never a false-compatible.
    const { p, api } = await bootPlugin(true, { preOnload: (tp) => tp.api_.__setSchemaBodyHash("sha256:stale-cached") });
    expect(p.statusText()).toBe("blocked");
    expect(api.__calls.changes?.length ?? 0).toBe(0);
    expect(p.getLastIssue()).toMatch(/verify|mid-upgrade|cache/i);
    p.onunload();
  });

  it("a stored token rejected with 401 on connect → re-logs in ONCE and connects", async () => {
    // Seed a stored token so acquireToken uses it optimistically (no probe); the first status()
    // 401s, so doConnect clears it, re-logins, and the retried status() succeeds → idle.
    const { p, api } = await bootPlugin(true, {
      settings: { authToken: "stale" },
      preOnload: (tp) => tp.api_.__failStatusAuth(1),
    });
    expect(p.loginCount).toBe(1);              // reactively re-logged in exactly once
    expect(api.__calls.status?.length).toBe(2); // failed once, retried once
    expect(p.statusText()).toBe("idle");
    p.onunload();
  });
});

// The modal ACTION bodies were previously exercised only against vi.fn() spies (the DOM tests assert
// "the button calls X(args)"; they never ran X). These drive the REAL main.ts methods over the
// in-memory io + spy api, so the actual promote/remove/switch/adjudicate logic is covered.
describe("real modal action bodies (not spies): resolveNoteConflict / switchToVault / forkVault / resolveConfigGroup", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);

  it("resolveNoteConflict 'mine' promotes the copy onto the original and removes the copy", async () => {
    const { p } = await bootPlugin();
    await p.io_.write("note.md", enc("OLD"));
    await p.io_.write("note (conflict).md", enc("NEW"));
    expect(await p.resolveNoteConflict("note (conflict).md", "note.md", "mine")).toBe(true);
    expect(dec(await p.io_.read("note.md"))).toBe("NEW"); // original now holds this device's content
    await expect(p.io_.read("note (conflict).md")).rejects.toThrow(); // copy removed
    p.onunload();
  });

  it("resolveNoteConflict 'theirs' keeps the original untouched and just removes the copy", async () => {
    const { p } = await bootPlugin();
    await p.io_.write("note.md", enc("OLD"));
    await p.io_.write("note (conflict).md", enc("NEW"));
    expect(await p.resolveNoteConflict("note (conflict).md", "note.md", "theirs")).toBe(true);
    expect(dec(await p.io_.read("note.md"))).toBe("OLD"); // original (the other side) kept
    await expect(p.io_.read("note (conflict).md")).rejects.toThrow();
    p.onunload();
  });

  it("resolveNoteConflict 'mine' with a STALE preview REFUSES — never clobbers the newer original", async () => {
    const { p } = await bootPlugin();
    await p.io_.write("note.md", enc("ACTUAL-NEWER")); // original moved on since the modal opened
    await p.io_.write("note (conflict).md", enc("MINE"));
    expect(await p.resolveNoteConflict("note (conflict).md", "note.md", "mine", "STALE-PREVIEW")).toBe(false);
    expect(dec(await p.io_.read("note.md"))).toBe("ACTUAL-NEWER"); // NOT clobbered
    expect(dec(await p.io_.read("note (conflict).md"))).toBe("MINE"); // copy kept for re-review
    p.onunload();
  });

  it("switchToVault records the one-time transition (vaultId/owner/readOnly/pendingSwitch) and reconnects", async () => {
    const { p, api } = await bootPlugin();
    const before = api.__calls.status?.length ?? 0;
    await p.switchToVault("other", "download");
    expect(p.settings.vaultId).toBe("other");
    expect(p.settings.vaultOwner).toBeUndefined(); // own vault
    expect(p.settings.vaultReadOnly).toBe(false);
    expect(p.settings.pendingSwitch).toBe("download"); // resolution persisted atomically with the vaultId
    expect(api.__calls.status?.length ?? 0).toBeGreaterThan(before); // reconnected to the new vault
    await p.switchToVault("shared", "merge", "alice", true); // a read-only shared vault
    expect(p.settings.vaultOwner).toBe("alice");
    expect(p.settings.vaultReadOnly).toBe(true);
    p.onunload();
  });

  it("D0047 guard: a FOREIGN base (vault changed without switchTo) forces a safe merge-switch, never a foreign-base reconcile", async () => {
    const { p } = await bootPlugin();
    await p.io_.write("note.md", enc("hi"));
    await p.reconnect(); await flush();                 // full reconcile pushes note.md → base populated; stamps baseVaultKey
    const key0 = "x|/" + p.settings.vaultId;            // server-qualified `host|owner/vault` (host x, own vault) — fix ③
    expect(p.settings.baseVaultKey).toBe(key0);         // the base is stamped with the vault it belongs to
    // Simulate the bug class: some path (e.g. the setup wizard's old behavior) changes the vault WITHOUT
    // going through switchTo — the base is now FOREIGN.
    p.settings.vaultId = "other";
    p.settings.pendingSwitch = undefined;
    await p.reconnect(); await flush();
    expect(p.settings.baseVaultKey).toBe("x|/other");   // guard fired → merge-switch connected → re-stamped
    expect(dec(await p.io_.read("note.md"))).toBe("hi"); // local file NOT silently clobbered by a foreign-base pull
    p.onunload();
  });

  // fix ③ (2026-08-01): the vault-identity key is SERVER-qualified, so repointing at a DIFFERENT server with
  // the SAME vault name is detected (a server-blind `owner/vault` key missed it → silent cross-server
  // overwrite). Two servers trivially both host owner=""/vault="default".
  it("D0047 guard is SERVER-qualified: a different server with the same vault name is a different vault", async () => {
    const { p } = await bootPlugin();
    await p.io_.write("note.md", enc("hi"));
    await p.reconnect(); await flush();
    expect(p.settings.baseVaultKey).toBe("x|/" + p.settings.vaultId); // host x
    p.settings.serverUrl = "http://otherhost";                       // repoint at a DIFFERENT server, SAME vault name
    p.settings.pendingSwitch = undefined;
    await p.reconnect(); await flush();
    expect(p.settings.baseVaultKey).toBe("otherhost|/" + p.settings.vaultId); // guard tripped → merge-switch → re-stamped to the new server
    expect(dec(await p.io_.read("note.md"))).toBe("hi");             // local NOT clobbered by server B's base
    p.onunload();
  });

  // fix ③: an OLD (pre-fix) server-blind key is grandfathered to the CURRENT server, so an upgrade doesn't
  // force a spurious merge for every existing user; it is silently upgraded to the server-qualified format.
  it("D0047 guard grandfathers an old server-blind base key (no spurious merge on upgrade)", async () => {
    const { p } = await bootPlugin();
    await p.io_.write("note.md", enc("hi"));
    await p.reconnect(); await flush();
    p.settings.baseVaultKey = "/" + p.settings.vaultId;              // simulate a pre-fix persisted key (no `|`), same server+vault
    p.settings.pendingSwitch = undefined;
    await p.reconnect(); await flush();
    expect(p.settings.baseVaultKey).toBe("x|/" + p.settings.vaultId); // recognized as the current vault → upgraded in place
    expect(dec(await p.io_.read("note.md"))).toBe("hi");
    p.onunload();
  });

  // fix ② (2026-08-01): a routine token expiry DURING a connected session (the poll/delta path hits the API
  // directly) self-heals with ONE silent re-login instead of stranding the user in a false "sign-in
  // rejected — check your password" block (the inverse of the auth-storm the FSM fixed).
  it("mid-session token expiry on the poll path silently re-logs-in ONCE (no false auth block)", async () => {
    const { p, api } = await bootPlugin(true, { settings: { storePassword: true, password: "p" } });
    const loginsAfterConnect = p.loginCount;
    api.__failChangesAuth(1);                            // the next changes() 401s once, then succeeds
    api.__poke();                                        // a server poke → delta reconcile hits the expired token
    await flush();
    expect(p.loginCount).toBe(loginsAfterConnect + 1);  // re-logged-in exactly once, transparently
    expect(p.statusText()).toBe("idle");                // recovered — NOT blocked in "check your password"
    p.onunload();
  });

  // Critique HIGH (2026-08-02): a persisted AUTHORITATIVE switch (download/upload) that lingered set — its
  // switchTo reconcile killed mid-flight before clearing — must NOT re-run every connect (each re-run
  // re-clobbers local edits). Once the base already belongs to the target vault, the switch has applied;
  // the guard clears it and reconciles normally instead of repeating the lossy overwrite.
  it("a lingering already-applied authoritative switch is cleared, NOT re-run (no re-clobber loop)", async () => {
    const { p } = await bootPlugin();
    await p.io_.write("note.md", enc("hi"));
    await p.reconnect(); await flush();                  // base populated + baseVaultKey stamped to THIS vault
    await p.io_.write("note.md", enc("CHANGED"));         // a local edit made after the switch had applied
    p.settings.pendingSwitch = "download";               // stuck take-remote resolution (a re-run would clobber)
    (p as any).logs.length = 0;                           // isolate this connect's log
    await p.reconnect(); await flush();
    expect(p.settings.pendingSwitch).toBeUndefined();     // the already-applied guard cleared it
    const logs = (p as any).logs as string[];
    expect(logs.some((l) => l.includes("already applied"))).toBe(true);                 // guard path taken…
    expect(logs.some((l) => l.includes("applying vault switch resolution"))).toBe(false); // …switchTo NOT re-run
    expect(dec(await p.io_.read("note.md"))).toBe("CHANGED"); // local edit survived — not re-clobbered
    p.onunload();
  });

  // Mobile field 2026-08-02: a background suspend pauses the backoff reconnect timer, and a `remote` event is
  // dropped while disconnected — so a failed connection didn't re-attempt on resume ("nothing indicates it's
  // rechecking"). onResume now kicks a fresh connect when disconnected.
  it("mobile resume RE-ATTEMPTS a failed connection (not a dropped remote)", async () => {
    const { p, api } = await bootPlugin();
    api.__failChanges(true);                              // the next reconcile fails → engine goes disconnected
    api.__poke(); await flush();
    expect((p as any).engine.getState()).toBe("disconnected");
    const statusBefore = api.__calls.status?.length ?? 0;
    api.__failChanges(false);                             // network/DNS back on the foreground
    (p as any).onResume();                                // app returned to foreground
    await flush();
    expect(api.__calls.status?.length ?? 0).toBeGreaterThan(statusBefore); // a fresh CONNECT was attempted (status re-probed)
    expect((p as any).engine.getState()).not.toBe("disconnected");         // recovered, not left stuck
    p.onunload();
  });

  // F2 (2026-08-02): a user-initiated disconnect resets LinkState, so getLastIssue/isVaultGone (which read
  // the LinkState directly) stop reporting a stale blocked reason after the user has already disconnected.
  it("disconnect resets LinkState — no stale vault-gone prompt after the user disconnects (F2)", async () => {
    const { p, api } = await bootPlugin();
    api.__failStatus404();                              // the status probe 404s → VaultGone → blocked
    await p.reconnect(); await flush();
    expect(p.isVaultGone()).toBe(true);                 // blocked{vaultGone}
    await p.disconnect(); await flush();
    expect(p.isVaultGone()).toBe(false);                // F2: the stale blocked reason is cleared
    expect(p.getLastIssue() ?? "").toBe("");            // and no leaked issue text
    p.onunload();
  });

  // F3 (2026-08-02): a synthetic serverDegraded failure sets a specific 'run reindex' message before
  // throwing; the generic outer catch must NOT overwrite it (it did → the card showed 'Reconnecting…').
  it("a serverDegraded (reindex-needed) message survives the generic catch (F3)", async () => {
    const { p, api } = await bootPlugin();
    api.__setStatusHealth("error");                     // status() not-ready → doConnect throws ServerDegraded synthetic
    await p.reconnect(); await flush();
    expect(p.getLastIssue() ?? "").toMatch(/reindex/i); // the actionable message survived (not clobbered)
    p.onunload();
  });

  it("removePluginFromServer purges ONLY that plugin's server files + drops it from the allowlist/view (explicit, bounded)", async () => {
    const { p, api } = await bootPlugin();
    const meta = (path: string) => ({ path, hash: path, size: 0, version: 1, chunks: [] as string[] });
    api.__setChanges({ version: 1, upserts: [
      meta(".obsidian/plugins/update-time-on-edit/main.js"),
      meta(".obsidian/plugins/update-time-on-edit/manifest.json"),
      meta(".obsidian/plugins/keepme/main.js"),
    ], deletes: [] });
    await p.reconnect(); await flush();                 // a FULL reconcile → onRemotePlugins populates the server-plugin view
    expect(p.getServerPluginIds()).toContain("update-time-on-edit");
    p.settings.configSync.pluginAllow = ["update-time-on-edit", "keepme"];
    const n = await p.removePluginFromServer("update-time-on-edit");
    expect(n).toBe(2);                                  // both of that plugin's files deleted
    const deleted = (api.__calls.deleteFile ?? []).map((a: any[]) => a[0]);
    expect(deleted).toContain(".obsidian/plugins/update-time-on-edit/main.js");
    expect(deleted).toContain(".obsidian/plugins/update-time-on-edit/manifest.json");
    expect(deleted).not.toContain(".obsidian/plugins/keepme/main.js"); // a DIFFERENT plugin is untouched (bounded to the one plugin)
    expect(p.settings.configSync.pluginAllow).toEqual(["keepme"]);     // dropped from THIS device's allowlist
    expect(p.getServerPluginIds()).not.toContain("update-time-on-edit"); // gone from the synced-plugins view
    p.onunload();
  });

  // S3 (2026-08-02): the plugin id is server/peer-influenced; a crafted id must never widen the delete
  // beyond one plugin folder. An invalid id is rejected before any deleteFile call.
  it("removePluginFromServer REJECTS a traversal / malformed plugin id (deletes nothing)", async () => {
    const { p, api } = await bootPlugin();
    api.__setChanges({ version: 1, upserts: [
      { path: ".obsidian/plugins/keepme/main.js", hash: "h", size: 0, version: 1, chunks: [] as string[] },
      { path: ".obsidian/app.json", hash: "h2", size: 0, version: 1, chunks: [] as string[] },
    ], deletes: [] });
    await p.reconnect(); await flush();
    for (const bad of ["..", "../evil", "a/b", "", "."]) {
      expect(await p.removePluginFromServer(bad)).toBe(0);          // rejected, no-op
    }
    expect(api.__calls.deleteFile ?? []).toHaveLength(0);           // NOTHING was deleted
    p.onunload();
  });

  // self-redeem bug: redeeming a share link for a vault YOU OWN stamps vaultOwner with your own username, and
  // the connect-time grant check then reports "revoked" (your own vault is never in /api/shared) and blocks ALL
  // sync. refreshShareGrant must SELF-HEAL: a vaultOwner === my own username is corrected to an owned vault.
  it("self-redeem self-heal: a vaultOwner matching my username (case-insensitive) → own, read-WRITE vault (never 'revoked')", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    p.settings.username = "Alice";           // as-typed (capitalized) — the server stores/returns it lowercased
    p.settings.vaultId = "notes";
    p.settings.vaultOwner = "alice";          // POISONED with the server-lowercased owner; case must NOT defeat the heal (F1)
    p.settings.vaultReadOnly = true;          // a read-only self-redeem also left this stale-true (F2)
    // The self-heal must short-circuit BEFORE HttpTransport.listShared (which would hit the real network and,
    // for an own vault, drive the false "revoked"): it clears vaultOwner + vaultReadOnly and returns cleanly.
    await expect(anyp.refreshShareGrant("tok")).resolves.toBeUndefined();
    expect(p.settings.vaultOwner).toBeUndefined();   // corrected to an OWN vault → syncs normally
    expect(p.settings.vaultReadOnly).toBe(false);    // …and read-WRITE, so pushes to your own vault aren't blocked
    expect(p.isOwnAccount("ALICE")).toBe(true);      // the predicate itself is case-insensitive both ways
    expect(p.isOwnAccount("bob")).toBe(false);
    expect(p.isOwnAccount("")).toBe(false);
  });

  it("refreshVaultPrivacy: own+unshared → private; a readWrite grant/link or a shared-TO-us vault → NOT private (fail-safe)", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    anyp.myVaultShares = async () => [{ vault: p.settings.vaultId, grants: [] }];
    anyp.listShareLinks = async () => [];
    await p.refreshVaultPrivacy();
    expect(anyp.vaultIsPrivate).toBe(true);                          // own + no shares → private → hot-load allowed
    anyp.myVaultShares = async () => [{ vault: p.settings.vaultId, grants: [{ grantee: "bob", perm: "readWrite" }] }];
    await p.refreshVaultPrivacy();
    expect(anyp.vaultIsPrivate).toBe(false);                         // a readWrite grantee CAN push code → NOT private
    anyp.myVaultShares = async () => [{ vault: p.settings.vaultId, grants: [] }];
    anyp.listShareLinks = async () => [{ id: "x", vault: p.settings.vaultId, perm: "readWrite", label: "", expires_at: null, redeemed_by: null }];
    await p.refreshVaultPrivacy();
    expect(anyp.vaultIsPrivate).toBe(false);                         // a readWrite share LINK too
    anyp.listShareLinks = async () => [];
    p.settings.vaultOwner = "alice";                                 // a vault shared TO us
    await p.refreshVaultPrivacy();
    expect(anyp.vaultIsPrivate).toBe(false);
    p.settings.vaultOwner = undefined;
    anyp.myVaultShares = async () => { throw new Error("net"); };    // any error → FAIL-SAFE
    await p.refreshVaultPrivacy();
    expect(anyp.vaultIsPrivate).toBe(false);
    p.onunload();
  });

  it("hot-load: a NEWLY-synced plugin on a private vault activates live; a running-update or a shared vault keeps the restart barrier", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    const enabled: string[] = [];
    (p.app as any).plugins = { plugins: { alreadyRunning: {} }, loadManifests: async () => {}, enablePlugin: async (id: string) => { enabled.push(id); } };
    anyp.myVaultShares = async () => [{ vault: p.settings.vaultId, grants: [] }]; // own + unshared → the fresh re-check derives PRIVATE
    anyp.listShareLinks = async () => [];
    await anyp.applyPluginCodeChange(new Set(["newplugin"]), [".obsidian/plugins/newplugin/main.js"]);
    expect(enabled).toContain("newplugin");                          // private + newly-arrived → hot-loaded, no restart
    enabled.length = 0;
    await anyp.applyPluginCodeChange(new Set(["alreadyRunning"]), [".obsidian/plugins/alreadyRunning/main.js"]);
    expect(enabled).not.toContain("alreadyRunning");                 // an update to a RUNNING plugin → restart, not hot-reload
    enabled.length = 0;
    anyp.myVaultShares = async () => [{ vault: p.settings.vaultId, grants: [{ grantee: "bob", perm: "readWrite" }] }]; // now shared: a rw peer can push code
    await anyp.applyPluginCodeChange(new Set(["fromapeer"]), [".obsidian/plugins/fromapeer/main.js"]);
    expect(enabled).not.toContain("fromapeer");                     // fresh re-check → NOT private → NEVER auto-execute (the RCE barrier)
    p.onunload();
  });

  // SOURCE-DRIVEN CSS notice (D-provenance): synced theme/snippet CSS gets a review warning ONLY when
  // ANOTHER PERSON changed it — decided by the change's author, NOT by whether the vault is shared. Your OWN
  // CSS change is silent, no matter the vault's sharing state.
  it("synced CSS from ANOTHER PERSON warns to review it; your OWN change is silent (source-driven, not vault-privacy)", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    p.settings.username = "will";
    // A PEER (alice) changed the CSS → warn to review, regardless of vault sharing state.
    __notices.length = 0;
    anyp.pendingReload = new Set([".obsidian/snippets/evil.css"]);
    anyp.configProvenance = new Map([[".obsidian/snippets/evil.css", { author: "alice", deviceId: "dev-Z", deviceName: "Alice-PC" }]]);
    await p.flushConfigReload();
    expect(__notices.some((m) => /don't trust|review it/i.test(m))).toBe(true);   // peer CSS → warned
    expect(__notices.some((m) => /alice/i.test(m))).toBe(true);                    // names WHO
    // YOUR OWN change (same account, this device) → completely silent (the whole point).
    __notices.length = 0;
    anyp.pendingReload = new Set([".obsidian/snippets/mine.css"]);
    anyp.configProvenance = new Map([[".obsidian/snippets/mine.css", { author: "will", deviceId: anyp.deviceId() }]]);
    await p.flushConfigReload();
    expect(__notices.length).toBe(0);                                             // own CSS → no notice at all
    p.onunload();
  });

  // fix ① (2026-08-01): the hot-load gate re-derives privacy FRESH at the decision point, so a
  // `vaultIsPrivate` left STALE-true (e.g. from a previous private vault after a switch, or predating an
  // out-of-band grant on the delta path — which never refreshed it) can't auto-execute a now-shared vault's
  // plugin code. Closes the RCE-barrier bypass the security critique found.
  it("hot-load re-checks privacy FRESH — a stale-true vaultIsPrivate does NOT auto-execute a now-shared vault's plugin (RCE gate)", async () => {
    const { p } = await bootPlugin();
    const anyp = p as any;
    const enabled: string[] = [];
    (p.app as any).plugins = { plugins: {}, loadManifests: async () => {}, enablePlugin: async (id: string) => { enabled.push(id); } };
    anyp.vaultIsPrivate = true;                                      // STALE: left over from a previous private vault
    anyp.myVaultShares = async () => [{ vault: p.settings.vaultId, grants: [{ grantee: "bob", perm: "readWrite" }] }]; // vault is NOW shared
    anyp.listShareLinks = async () => [];
    await anyp.applyPluginCodeChange(new Set(["peerplugin"]), [".obsidian/plugins/peerplugin/main.js"]);
    expect(enabled).not.toContain("peerplugin");                    // fresh re-derive vetoes the stale true → restart barrier holds
    expect(anyp.vaultIsPrivate).toBe(false);                        // and the cached field is corrected
    p.onunload();
  });

  it("forkVault creates the new vault then switches to it in UPLOAD mode (owner cleared, editable)", async () => {
    // Loopback serverUrl so the static HttpTransport.createVault passes the cleartext-remote guard.
    const { p } = await bootPlugin(true, { settings: { serverUrl: "http://127.0.0.1:8789" } });
    await p.forkVault("myfork");
    expect(p.settings.vaultId).toBe("myfork");
    expect(p.settings.pendingSwitch).toBe("upload"); // a fork pushes local content into the new vault
    expect(p.settings.vaultOwner).toBeUndefined(); // the fork is yours
    expect(p.settings.vaultReadOnly).toBe(false);
    p.onunload();
  });

  it("resolveConfigGroup adjudicates the given paths and clears ONLY them from the pending set", async () => {
    const { p } = await bootPlugin();
    p.settings.configConflicts = [".obsidian/app.json", ".obsidian/hotkeys.json"];
    await p.io_.write(".obsidian/app.json", enc("{}"));
    await p.resolveConfigGroup([".obsidian/app.json"], "local");
    expect(p.settings.configConflicts).toEqual([".obsidian/hotkeys.json"]); // only the resolved path removed
    p.onunload();
  });
});

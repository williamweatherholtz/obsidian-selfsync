import { describe, it, expect, beforeEach } from "vitest";
// "obsidian" is aliased to test/obsidian-stub.ts (see vitest.config.ts).
import NewLiveSyncPlugin, { ApiClient } from "../src/main";
import { VaultIo, SyncApi } from "../src/sync";
import { FileMeta } from "../src/protocol";
import { TFile } from "obsidian";

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
  let wsOnChanged: (() => void) | null = null;
  let statusApiVersion: number | undefined;   // undefined = omit apiVersion (legacy server)
  let failStatusAuthTimes = 0;                 // number of leading status() calls that 401
  const api: ApiClient & {
    __calls: typeof calls; __poke: () => void; __failChanges: (v: boolean) => void;
    __setApiVersion: (v: number | undefined) => void; __failStatusAuth: (n: number) => void;
  } = {
    __calls: calls,
    __poke: () => wsOnChanged?.(),
    __failChanges: (v) => { failChanges = v; },
    __setApiVersion: (v) => { statusApiVersion = v; },
    __failStatusAuth: (n) => { failStatusAuthTimes = n; },
    async status() {
      rec("status", []);
      if (failStatusAuthTimes > 0) { failStatusAuthTimes--; throw new Error("status: HTTP 401"); }
      return { status: "ready", detail: "", version: 0, apiVersion: statusApiVersion };
    },
    async changes(since) { rec("changes", [since]); if (failChanges) throw new Error("server down"); return { version: 0, upserts: [], deletes: [] }; },
    async fileMeta(p) { rec("fileMeta", [p]); return null; },
    async missing(h) { rec("missing", [h]); return h; },
    async getChunk(h) { rec("getChunk", [h]); return new Uint8Array(0); },
    async putChunk(h, b) { rec("putChunk", [h, b]); },
    async commit(r) { rec("commit", [r]); return { ...r, version: 1 } as FileMeta; },
    async deleteFile(p) { rec("deleteFile", [p]); },
    connectWs(onChanged) { rec("connectWs", []); wsOnChanged = onChanged; return { addEventListener() {}, close() {} } as unknown as WebSocket; },
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
      on: () => ({}),
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

beforeEach(() => {
  // main.ts uses window.setTimeout/setInterval; provide them in the node test env.
  (globalThis as any).window = { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis), setInterval: setInterval.bind(globalThis), clearInterval: clearInterval.bind(globalThis) };
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

  it("unconfigured onload does NOT connect (routes to setup)", async () => {
    const { p, api } = await bootPlugin(false);
    expect(api.__calls.status?.length ?? 0).toBe(0);
    expect(p.statusText()).toBe("off");
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

  it("a WS poke → a fresh reconcileAll (changes re-queried)", async () => {
    const { p, api } = await bootPlugin();
    const before = api.__calls.changes?.length ?? 0;
    api.__poke();       // simulate a server change notification
    await flush();
    expect((api.__calls.changes?.length ?? 0)).toBeGreaterThan(before);
    p.onunload();
  });

  it("a reconcile failure drives the engine offline", async () => {
    const { p, api } = await bootPlugin();
    api.__failChanges(true);
    api.__poke();       // triggers reconcileAll → changes() throws
    await flush();
    expect(p.statusText()).toBe("offline");
    p.onunload();
  });

  it("unload projects the light off", async () => {
    const { p } = await bootPlugin();
    p.onunload();
    expect(p.statusText()).toBe("off");
  });

  it("REFUSES to sync on a protocol-version mismatch (offline, clear reason, never reconciles)", async () => {
    // Server advertises a different apiVersion than the client speaks → doConnect must throw
    // BEFORE reconciling (no changes() call), go offline, and record an actionable reason.
    const { p, api } = await bootPlugin(true, { preOnload: (tp) => tp.api_.__setApiVersion(999) });
    expect(p.statusText()).toBe("offline");
    expect(api.__calls.changes?.length ?? 0).toBe(0); // never touched the vault data
    expect(p.getLastIssue()).toMatch(/version/i);
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

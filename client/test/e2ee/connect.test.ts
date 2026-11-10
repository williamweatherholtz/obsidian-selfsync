// E3a (5) (6): the connect flow over the keyring table of spec section 4.8, on the real plugin with an injected
// io and api (no Obsidian, no server). GET keyring is the first vault-scoped request, before status(); 200
// and 404 are consumed; every E2EE decision runs after the ready check; the four block reasons; the once-
// per-episode join latch; the pin wins over the server; the base key carries the tag only when encrypted.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import SelfSyncPlugin, { ApiClient } from "../../src/main";
import { VaultIo } from "../../src/sync";
import { ConnError, Endpoint, FailureKind, LinkKind } from "../../src/connstate";
import { EMBEDDED_SIGNATURE } from "../../src/wiresignature";
import { TFile } from "obsidian";
import { createKeyring } from "../../src/e2ee/keyring";
import { deriveSubkeys } from "../../src/e2ee/subkeys";
import { hex, b64 } from "../../src/e2ee/bytes";
import { setE2eeBuildEnabledForTests } from "../../src/e2ee/build";

const FAST = { m_kib: 64, t: 1, p: 1 };

function memIo(): VaultIo & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    async list() { const m = new Map<string, { mtime: number; size: number }>(); for (const [k, b] of files) m.set(k, { mtime: 0, size: b.length }); return m; },
    async read(p) { const b = files.get(p); if (!b) throw new Error("ENOENT " + p); return b; },
    async write(p, b) { files.set(p, b.slice()); },
    async remove(p) { files.delete(p); },
    files,
  };
}

type KeyringAnswer = { found: true; text: string } | { found: false } | { throw: ConnError };
function spyApi(keyringAnswer: KeyringAnswer, health = "ready") {
  const calls: string[] = [];
  let encrypted: boolean | undefined;
  let failKeyringAuthTimes = 0;
  const api: ApiClient & { calls: string[]; encrypted: () => boolean | undefined; failKeyringAuth: (n: number) => void; setAnswer: (a: KeyringAnswer) => void } = {
    calls, encrypted: () => encrypted, failKeyringAuth: (n) => { failKeyringAuthTimes = n; }, setAnswer: (a) => { keyringAnswer = a; },
    async keyring() {
      calls.push("keyring");
      if (failKeyringAuthTimes > 0) { failKeyringAuthTimes--; throw new ConnError("unauthorized", { status: 401, endpoint: Endpoint.Keyring, wasLogin: false }); }
      if ("throw" in keyringAnswer) throw keyringAnswer.throw;
      return keyringAnswer;
    },
    setEncrypted(on) { encrypted = on; },
    async status() { calls.push("status"); return { status: health, detail: health === "ready" ? "" : "rebuild aborted: no .keyring.json, see the server log", version: 0, apiVersion: 1, schemaHash: "sha256:test-compat" }; },
    async schema() { calls.push("schema"); return { hash: "sha256:test-compat", signature: EMBEDDED_SIGNATURE }; },
    async changes(since) { calls.push("changes"); return { version: 0, upserts: [], deletes: [] }; },
    async fileMeta() { return null; },
    async missing(h) { return h; },
    async getChunk() { return new Uint8Array(0); },
    async putChunk() {},
    async commit(r) { return { ...r, version: 1 } as any; },
    async deleteFile() {},
    connectWs() { calls.push("connectWs"); return { addEventListener() {}, close() {} } as unknown as WebSocket; },
  };
  return api;
}

class TestPlugin extends SelfSyncPlugin {
  api_!: ReturnType<typeof spyApi>;
  io_ = memIo();
  loginCount = 0;
  joinPrompts: string[] = [];
  protected buildIo() { return this.io_; }
  protected buildApi() { return this.api_; }
  protected loginRemote() { this.loginCount++; return Promise.resolve("test-token"); }
  protected openJoinPrompt(text: string) { this.joinPrompts.push(text); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

function makeApp() {
  const app: any = {
    vault: { on: () => ({}), getAbstractFileByPath: (p: string) => { const f = new TFile(); f.path = p; return f; }, getFiles: () => [], adapter: {} },
    workspace: { onLayoutReady: (cb: Function) => cb(), on: () => ({}), getActiveViewOfType: () => null, trigger: () => {} },
  };
  return app;
}

async function boot(api: ReturnType<typeof spyApi>, settings: Record<string, unknown> = {}) {
  const p = new TestPlugin(makeApp(), { id: "obsidian-selfsync", dir: ".obsidian/plugins/obsidian-selfsync" } as any);
  p.api_ = api;
  (p as any)._data = { settings: { serverUrl: "http://x", username: "u", password: "p", vaultId: "notes", ...settings } };
  await p.onload();
  await flush();
  return p;
}
const blockedReason = (p: TestPlugin) => { const l = (p as any).engine.linkState(); return l.kind === LinkKind.Blocked ? l.reason : undefined; };

let liveTimers = new Set<any>();
beforeEach(() => {
  liveTimers = new Set();
  const track = (fn: (...a: any[]) => any, oneShot: boolean) => (cb: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
    const id = fn((...a: any[]) => { if (oneShot) liveTimers.delete(id); cb(...a); }, ms, ...rest); liveTimers.add(id); return id;
  };
  (globalThis as any).window = {
    setTimeout: track(setTimeout.bind(globalThis), true), clearTimeout: (id: any) => { liveTimers.delete(id); clearTimeout(id); },
    setInterval: track(setInterval.bind(globalThis), false), clearInterval: (id: any) => { liveTimers.delete(id); clearInterval(id); },
  };
});
afterEach(() => { for (const id of liveTimers) { clearTimeout(id); clearInterval(id); } liveTimers.clear(); setE2eeBuildEnabledForTests(undefined); });

async function pinFor() {
  const { keyring, vk, vaultId } = await createKeyring("correct horse battery staple!", { kdf: FAST });
  const keys = await deriveSubkeys(vk, vaultId);
  return { text: JSON.stringify(keyring), pin: { e2eeVaultId: b64(vaultId), vk: hex(vk) }, tag: keys.tag, keyring };
}

describe("E3a (6) the connect flow over GET keyring", () => {
  it("unpinned + 404: a plaintext vault connects, keyring runs before status, no header, no tag in the base key", async () => {
    const api = spyApi({ found: false });
    const p = await boot(api);
    expect(api.calls.indexOf("keyring")).toBeLessThan(api.calls.indexOf("status"));
    expect(p.statusText()).toBe("idle");
    expect(api.encrypted()).toBe(false);
    expect(p.contentCodec().encrypted).toBe(false);
    expect(p.settings.baseVaultKey).toBe("x|/notes"); // byte-identical to the pre-E2EE key
    p.onunload();
  });

  it("unpinned + 200: blocks with E2eeJoinRequired after status and the wire check, prompts once per episode, pushes nothing", async () => {
    const { text } = await pinFor();
    const api = spyApi({ found: true, text });
    const p = await boot(api);
    expect(blockedReason(p)).toBe(FailureKind.E2eeJoinRequired);
    expect(api.calls.filter((c) => c === "status").length).toBe(1);
    expect(api.calls).not.toContain("changes");
    expect(p.joinPrompts).toEqual([text]);
    expect(p.getLastIssue()).toMatch(/end-to-end encrypted/);
    // a second connect in the same episode re-blocks without a second prompt
    await p.reconnect(); await flush();
    expect(blockedReason(p)).toBe(FailureKind.E2eeJoinRequired);
    expect(p.joinPrompts.length).toBe(1);
    // the server turns plaintext (404): the latch resets, and the next 200 prompts again
    api.setAnswer({ found: false }); await p.reconnect(); await flush();
    expect(p.statusText()).toBe("idle");
    api.setAnswer({ found: true, text }); await p.reconnect(); await flush();
    expect(p.joinPrompts.length).toBe(2);
    p.onunload();
  });

  it("unpinned + 200 with the define off: blocks with E2eeUnsupportedBuild and never prompts", async () => {
    setE2eeBuildEnabledForTests(false);
    const { text } = await pinFor();
    const p = await boot(spyApi({ found: true, text }));
    expect(blockedReason(p)).toBe(FailureKind.E2eeUnsupportedBuild);
    expect(p.joinPrompts).toEqual([]);
    expect(p.getLastIssue()).toMatch(/does not support encrypted vaults/);
    p.onunload();
  });

  it("a status of error wins over every keyring arm (the degraded path, with the server's detail)", async () => {
    const { text } = await pinFor();
    const p = await boot(spyApi({ found: true, text }, "error"));
    expect(blockedReason(p)).toBeUndefined();
    expect((p as any).engine.linkState().kind).toBe(LinkKind.Retrying);
    expect(p.getLastIssue()).toMatch(/needs an operator: rebuild aborted/);
    expect(p.joinPrompts).toEqual([]);
    p.onunload();
  });

  it("a 503 on GET keyring is the degraded state with the body verbatim; a 401 drives the one-shot re-login then keyring again", async () => {
    const body = "this vault is end-to-end encrypted but its .keyring.json is missing. Restore it.";
    const p = await boot(spyApi({ throw: new ConnError(body, { status: 503, endpoint: Endpoint.Keyring, wasLogin: false }) }));
    expect((p as any).engine.linkState().kind).toBe(LinkKind.Retrying);
    expect(p.getLastIssue()).toBe(body);
    p.onunload();
    const api = spyApi({ found: false }); api.failKeyringAuth(1);
    const q = await boot(api, { authToken: "stale" });
    expect(q.loginCount).toBe(1);
    expect(api.calls.filter((c) => c === "keyring").length).toBe(2);
    expect(q.statusText()).toBe("idle");
    q.onunload();
  });

  it("pinned + 404 then ready: blocks with E2eeKeyringMissing, never a plaintext push", async () => {
    const { pin } = await pinFor();
    const api = spyApi({ found: false });
    const p = await boot(api, { e2ee: { "x|/notes":pin } });
    expect(blockedReason(p)).toBe(FailureKind.E2eeKeyringMissing);
    expect(api.calls).not.toContain("changes");
    expect(api.encrypted()).toBeUndefined(); // the transport was built with the header on and never flipped
    p.onunload();
  });

  it("pinned + 200 with another vault_id, or an unparseable record: E2eeKeyringChanged with a named reason", async () => {
    const a = await pinFor(); const b = await pinFor();
    const p = await boot(spyApi({ found: true, text: b.text }), { e2ee: { "x|/notes":a.pin } });
    expect(blockedReason(p)).toBe(FailureKind.E2eeKeyringChanged);
    expect(p.getLastIssue()).toMatch(/different vault id/);
    p.onunload();
    const q = await boot(spyApi({ found: true, text: "{not json" }), { e2ee: { "x|/notes":a.pin } });
    expect(blockedReason(q)).toBe(FailureKind.E2eeKeyringChanged);
    expect(q.getLastIssue()).toMatch(/does not parse/);
    q.onunload();
  });

  it("pinned + 200 with the pinned vault_id: the codec is encrypted, the header is on, the base key carries the tag", async () => {
    const { text, pin, tag } = await pinFor();
    const api = spyApi({ found: true, text });
    const p = await boot(api, { e2ee: { "x|/notes":pin } });
    expect(p.statusText()).toBe("idle");
    expect(p.contentCodec().encrypted).toBe(true);
    expect(p.contentCodec().tag).toBe(tag);
    expect(api.encrypted()).toBe(true);
    expect(p.settings.baseVaultKey).toBe(`x|/notes|${tag}`);
    expect(api.calls).toContain("changes");
    // the pin store never holds the password, and the pin survives a parse round trip
    expect(JSON.stringify(p.settings)).not.toContain("correct horse");
    expect(p.e2eePin()).toEqual(pin);
    p.onunload();
  });

  it("a pinned device syncs regardless of the define", async () => {
    setE2eeBuildEnabledForTests(false);
    const { text, pin, tag } = await pinFor();
    const p = await boot(spyApi({ found: true, text }), { e2ee: { "x|/notes": pin } });
    expect(p.statusText()).toBe("idle");
    expect(p.contentCodec().encrypted).toBe(true);
    expect(p.contentCodec().tag).toBe(tag);
    p.onunload();
  });

  it("a pin for the same owner/vault name on ANOTHER host is not this host's pin", async () => {
    const { text, pin } = await pinFor();
    const p = await boot(spyApi({ found: true, text }), { e2ee: { "other.example|/notes": pin } });
    expect(blockedReason(p)).toBe(FailureKind.E2eeJoinRequired); // unpinned here: the join prompt, never the other host's key
    expect(p.e2eePin()).toBeUndefined();
    p.onunload();
  });

  it("the real buildApi builds the transport with the header on exactly when the vault is pinned", async () => {
    const { pin } = await pinFor();
    const p = await boot(spyApi({ found: false }));
    const real = Object.getPrototypeOf(TestPlugin.prototype).buildApi as (this: unknown, t: string) => { isEncrypted(): boolean };
    p.settings.serverUrl = "https://x.example"; // the real transport refuses a cleartext remote
    expect(real.call(p, "tok").isEncrypted()).toBe(false);
    p.settings.e2ee = { "x.example|/notes": pin };
    expect(real.call(p, "tok").isEncrypted()).toBe(true);
    p.onunload();
  });

  it("a block for a changed keyring leaves NO encrypted codec behind for a manual push", async () => {
    const a = await pinFor(); const b = await pinFor();
    const api = spyApi({ found: true, text: a.text });
    const p = await boot(api, { e2ee: { "x|/notes": a.pin } });
    expect(p.contentCodec().encrypted).toBe(true);
    api.setAnswer({ found: true, text: b.text }); await p.reconnect(); await flush();
    expect(blockedReason(p)).toBe(FailureKind.E2eeKeyringChanged);
    expect(p.contentCodec().encrypted).toBe(false);
    p.onunload();
  });

  it("Reconfigure ends the join-prompt episode", async () => {
    const { text } = await pinFor();
    const p = await boot(spyApi({ found: true, text }));
    expect(p.joinPrompts.length).toBe(1);
    (p as any).e2eeJoinPromptShown = true;
    p.openSetup(); (p as any).setupOpen = false; // the wizard opens (stubbed) and the latch resets
    expect((p as any).e2eeJoinPromptShown).toBe(false);
    p.onunload();
  });

  it("a same-id keyring with a foreign wrap does not change the codec (an enrolled device never unwraps on reconnect)", async () => {
    const { text, pin, tag, keyring } = await pinFor();
    const foreign = { ...keyring, wrap: { ...keyring.wrap, ct: b64(new Uint8Array(80)) }, check: "0".repeat(64) };
    const p = await boot(spyApi({ found: true, text: JSON.stringify(foreign) }), { e2ee: { "x|/notes":pin } });
    expect(p.statusText()).toBe("idle");
    expect(p.contentCodec().tag).toBe(tag);
    expect(text).not.toBe(JSON.stringify(foreign));
    p.onunload();
  });
});

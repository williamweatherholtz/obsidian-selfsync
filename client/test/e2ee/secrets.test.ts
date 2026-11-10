// E3a (8): a runtime capture. Create, join and a conflict-copy flow run with MARKER values for the password
// and the keys. Every log line, request body, error body, conflict-copy name and composition recipe is
// captured, and the markers appear nowhere: password, KEK, VK, k_wrap, k_check, k_iv, k_id. The keyring
// record itself (salt, check, wrapped blob) is the server's public text, and the codec tag is a cache
// namespace by design, so neither is a marker.
import { describe, it, expect, vi } from "vitest";
import { reconcileAll, ReconcileDeps } from "../../src/reconcile";
import { BaseStore, conflictCopyName } from "../../src/base";
import { SyncApi, VaultIo, ChunkCache, pushFile } from "../../src/sync";
import { ChangesResponse, CommitRequest, FileMeta } from "../../src/protocol";
import { E2eeCodec } from "../../src/e2ee/codec";
import { createKeyring, openKeyring } from "../../src/e2ee/keyring";
import { deriveSubkeys } from "../../src/e2ee/subkeys";
import { deriveKek, deriveWrapKeys } from "../../src/e2ee/kdf";
import { hex, fromB64, b64 } from "../../src/e2ee/bytes";
import { encodeCompositionRecipe } from "../../src/composition-recipe";

const enc = (s: string) => new TextEncoder().encode(s);
const FAST = { m_kib: 64, t: 1, p: 1 };
const PASSWORD = "MARKER-PASSWORD-xk7Qp9zW-never-logged";

function recordingServer(bodies: string[]) {
  const chunks = new Map<string, Uint8Array>(); const files = new Map<string, FileMeta>(); let version = 1;
  const api: SyncApi = {
    async changes(since) { bodies.push(`changes?since=${since}`); return { version, upserts: [...files.values()].filter((f) => f.version > since), deletes: [] } as ChangesResponse; },
    async fileMeta(p) { bodies.push(`meta?path=${p}`); return files.get(p) ?? null; },
    async missing(hs) { bodies.push(JSON.stringify({ hashes: hs })); return hs.filter((h) => !chunks.has(h)); },
    async getChunk(h) { bodies.push(`chunk/${h}`); return chunks.get(h)!; },
    async putChunk(h, b) { bodies.push(`PUT chunk/${h} ${b64(b)} ${hex(b)}`); chunks.set(h, b); },
    async commit(r: CommitRequest) { bodies.push(JSON.stringify(r)); const m: FileMeta = { ...r, version: ++version }; files.set(r.path, m); return m; },
    async deleteFile(p) { bodies.push(`DELETE ${p}`); files.delete(p); },
  };
  return api;
}
function fakeIo(seed: Record<string, string> = {}) {
  const m = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, enc(v)]));
  const io: VaultIo & { m: Map<string, Uint8Array> } = {
    m,
    async list() { const r = new Map<string, { mtime: number; size: number }>(); for (const k of m.keys()) r.set(k, { mtime: 0, size: m.get(k)!.length }); return r; },
    async read(p) { const b = m.get(p); if (!b) throw new Error("ENOENT"); return b; },
    async write(p, b) { m.set(p, b); },
    async remove(p) { m.delete(p); },
  };
  return io;
}

// The plugin-level surfaces: boot the real plugin (injected io and api, no Obsidian) through the keyring
// arms that write log lines and card text, and return every line it wrote plus getLastIssue. `vk` is a
// marker, and the keyring record is the server's public text (it holds no secret, but it rides the log
// capture too so a future leak of its wrapped blob into a line would show).
async function pluginSurfaces(markers: string[], keyringText: string): Promise<string[]> {
  const { default: SelfSyncPlugin } = await import("../../src/main");
  const { TFile } = await import("obsidian");
  const { ConnError, Endpoint } = await import("../../src/connstate");
  class P extends SelfSyncPlugin {
    answer: { found: true; text: string } | { found: false } = { found: false };
    files = new Map<string, Uint8Array>();
    protected buildIo() { const f = this.files; return { async list() { return new Map(); }, async read(p: string) { return f.get(p)!; }, async write(p: string, b: Uint8Array) { f.set(p, b); }, async remove(p: string) { f.delete(p); } }; }
    protected buildApi() {
      const a = this.answer;
      return {
        async keyring() { return a; }, setEncrypted() {},
        async status() { return { status: "ready", detail: "", version: 0, apiVersion: 1, schemaHash: "sha256:test-compat" }; },
        async schema() { return { hash: "sha256:test-compat", signature: (await import("../../src/wiresignature")).EMBEDDED_SIGNATURE }; },
        async changes() { return { version: 0, upserts: [], deletes: [] }; },
        async fileMeta() { return null; }, async missing(h: string[]) { return h; }, async getChunk() { return new Uint8Array(0); }, async putChunk() {},
        async commit(r: any) { return { ...r, version: 1 }; }, async deleteFile() {},
        connectWs() { return { addEventListener() {}, close() {} } as unknown as WebSocket; },
      } as any;
    }
    protected loginRemote() { return Promise.resolve("tok"); }
    protected openJoinPrompt(_t: string) { this.log("join prompt opened"); }
    surfaces(): string[] { return [...(this as any).logs, this.getLastIssue() ?? ""]; }
  }
  const app: any = {
    vault: { on: () => ({}), getAbstractFileByPath: (p: string) => { const f = new TFile(); f.path = p; return f; }, getFiles: () => [], adapter: {} },
    workspace: { onLayoutReady: (cb: Function) => cb(), on: () => ({}), getActiveViewOfType: () => null, trigger: () => {} },
  };
  (globalThis as any).window ??= { setTimeout, clearTimeout, setInterval, clearInterval };
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  const out: string[] = [];
  void ConnError; void Endpoint;
  // pinned with a vk MARKER, and a server record that does not parse
  const pinned = new P(app, { id: "obsidian-selfsync", dir: "x" } as any);
  pinned.answer = { found: true, text: "{not json " + keyringText.slice(0, 20) };
  (pinned as any)._data = { settings: { serverUrl: "http://x", username: "u", password: "p", vaultId: "notes", e2ee: { "x|/notes": { e2eeVaultId: "AAAAAAAAAAAAAAAAAAAAAA==", vk: markers[1] } } } };
  await pinned.onload(); await flush();
  out.push(...pinned.surfaces()); pinned.onunload();
  // unpinned, meets the real record: the join prompt
  const joiner = new P(app, { id: "obsidian-selfsync", dir: "x" } as any);
  joiner.answer = { found: true, text: keyringText };
  (joiner as any)._data = { settings: { serverUrl: "http://x", username: "u", password: "p", vaultId: "notes" } };
  await joiner.onload(); await flush();
  out.push(...joiner.surfaces()); joiner.onunload();
  if (!out.some((l) => l.includes("does not parse")) || !out.some((l) => l.includes("join prompt opened"))) throw new Error("the plugin surfaces did not run the two keyring arms");
  return out;
}

describe("E3a (8) secrets reach no log, body, name or recipe", () => {
  it("create, join, push, conflict copy and a recipe leak none of the markers", async () => {
    const logs: string[] = [];
    const spies = (["log", "debug", "warn", "error", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
    const bodies: string[] = [];
    const errors: string[] = [];
    try {
      // create
      const created = await createKeyring(PASSWORD, { kdf: FAST });
      const vaultId = created.vaultId;
      const kek = await deriveKek(PASSWORD, { alg: "argon2id", ...FAST, salt: fromB64(created.keyring.kdf.salt) });
      const { kWrap, kCheck } = deriveWrapKeys(kek, vaultId);
      const markers = [PASSWORD, hex(created.vk), hex(kek), hex(kWrap), hex(kCheck)];
      // join on a second device
      const opened = await openKeyring(PASSWORD, JSON.stringify(created.keyring));
      const keys = await deriveSubkeys(opened.vk, opened.vaultId);
      markers.push(hex(keys.kIv), hex(keys.kId), b64(created.vk), b64(keys.kId));
      // a wrong password on the way, so an error body is in the capture
      try { await openKeyring(PASSWORD + "typo", JSON.stringify(created.keyring)); } catch (e: any) { errors.push(String(e?.message ?? e)); }
      const codec = E2eeCodec.fromKeys(keys);
      // push from device A, then a divergent edit on device B with no common base: a conflict copy
      const api = recordingServer(bodies);
      const ioA = fakeIo({ "Notes/Plan.md": `the plan ${PASSWORD}\n` });
      await pushFile({ api, io: ioA, state: { version: 0 }, cache: new Map(), codec }, "Notes/Plan.md");
      const ioB = fakeIo({ "Notes/Plan.md": "a different plan\n" });
      const d: ReconcileDeps = { api, io: ioB, base: new BaseStore(), cache: new Map() as ChunkCache, state: { version: 0 }, device: "Dev", codec, onFileError: (_p, e: any) => errors.push(String(e?.message ?? e)), onConflict: (p, c) => logs.push(`conflict ${p} -> ${c}`) };
      await reconcileAll(d);
      const names = [...ioB.m.keys()];
      expect(names.some((n) => n.includes("(conflict"))).toBe(true);
      // the composition recipe carries mounts, never a pin: encode one beside the pin and confirm no key text rides it
      const recipe = encodeCompositionRecipe([{ source: { owner: "alice", vaultId: "notes", sourcePath: "Shared" }, mountPoint: "Shared", direction: "pull" } as any], "https://s.example", "me");
      logs.push(recipe);
      // a conflict-copy name built directly, with the identity tag
      logs.push(conflictCopyName("Notes/Plan.md", "Dev", new Date(), (await codec.fileIdentity("Notes/Plan.md", enc("x"))).slice(0, 6)));
      // the PLUGIN's own log ring and card text, through the real connect flow: a pinned device whose server
      // record does not parse (the error text is logged), and a join prompt on an unpinned one
      const pluginLogs = await pluginSurfaces(markers, JSON.stringify(created.keyring));
      logs.push(...pluginLogs);
      const capture = [...logs, ...bodies, ...errors, ...names].join("\n");
      for (const m of markers) expect(capture, `marker leaked: ${m.slice(0, 12)}…`).not.toContain(m);
      // the plaintext note body reached the server in no form either
      expect(bodies.join("\n")).not.toContain("the plan");
      expect(bodies.length).toBeGreaterThan(5);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

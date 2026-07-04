// Headless end-to-end test: drives TWO real sync clients (the actual sync.ts
// chunk engine + a Node HTTP transport + real files on disk) against the real
// server binary, and asserts create/edit/delete/binary/dedup propagation. No Obsidian.
//
// The server is either spawned from ../server/target/debug (build it first with
// `cargo build`) or, if SYNC_SERVER_URL is set (e.g. in docker-compose), targeted
// directly. If neither is available the suite skips rather than fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SyncApi, VaultIo, SyncState, ChunkCache } from "../src/sync";
import { ChangesResponse, CommitRequest, FileMeta } from "../src/protocol";
import { BaseStore } from "../src/base";
import { reconcileAll, ReconcileDeps } from "../src/reconcile";
import { shouldSync, DEFAULT_CONFIG_SYNC, ConfigSyncSelection } from "../src/configsync";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverBin = path.resolve(
  here, "../../server/target/debug/new-livesync-server" + (process.platform === "win32" ? ".exe" : "")
);
const externalUrl = process.env.SYNC_SERVER_URL;
const canRun = !!externalUrl || existsSync(serverBin);

/** Node HTTP transport (global fetch — server-to-server, no Obsidian CSP). Chunk API. */
class NodeTransport implements SyncApi {
  constructor(private base: string, private token: string, private vault = "default") {}
  static async login(base: string, u: string, p: string): Promise<string> {
    const r = await fetch(`${base}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    if (!r.ok) throw new Error(`login ${r.status}`);
    return ((await r.json()) as { token: string }).token;
  }
  static async createVault(base: string, token: string, name: string): Promise<void> {
    const r = await fetch(`${base}/api/vaults`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`createVault ${r.status}`);
  }
  static async listVaults(base: string, token: string): Promise<string[]> {
    const r = await fetch(`${base}/api/vaults`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`listVaults ${r.status}`);
    return ((await r.json()) as { vaults: string[] }).vaults;
  }
  private h() { return { authorization: `Bearer ${this.token}` }; }
  private v(suffix: string) { return `${this.base}/api/v/${encodeURIComponent(this.vault)}${suffix}`; }
  async changes(since: number): Promise<ChangesResponse> {
    const r = await fetch(this.v(`/changes?since=${since}`), { headers: this.h() });
    if (!r.ok) throw new Error(`changes ${r.status}`);
    return (await r.json()) as ChangesResponse;
  }
  async fileMeta(path: string): Promise<FileMeta | null> {
    const r = await fetch(this.v(`/meta?path=${encodeURIComponent(path)}`), { headers: this.h() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`meta ${r.status}`);
    return (await r.json()) as FileMeta;
  }
  async missing(hashes: string[]): Promise<string[]> {
    const r = await fetch(this.v("/chunks/missing"), {
      method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify({ hashes }),
    });
    if (!r.ok) throw new Error(`missing ${r.status}`);
    return ((await r.json()) as { missing: string[] }).missing;
  }
  async getChunk(hash: string): Promise<Uint8Array> {
    const r = await fetch(this.v(`/chunk/${hash}`), { headers: this.h() });
    if (!r.ok) throw new Error(`getChunk ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async putChunk(hash: string, bytes: Uint8Array): Promise<void> {
    const r = await fetch(this.v(`/chunk/${hash}`), { method: "PUT", headers: this.h(), body: new Blob([bytes as BlobPart]) });
    if (!r.ok) throw new Error(`putChunk ${r.status}`);
  }
  async commit(req: CommitRequest): Promise<FileMeta> {
    const r = await fetch(this.v("/commit"), {
      method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify(req),
    });
    if (!r.ok) throw new Error(`commit ${r.status}`);
    return (await r.json()) as FileMeta;
  }
  async deleteFile(p: string): Promise<void> {
    const r = await fetch(this.v(`/file?path=${encodeURIComponent(p)}`), { method: "DELETE", headers: this.h() });
    if (!r.ok && r.status !== 404) throw new Error(`delete ${r.status}`);
  }
}

/** Filesystem-backed binary VaultIo (mirrors the plugin's ObsidianVaultIo, on real fs). */
class FsVaultIo implements VaultIo {
  constructor(private root: string) {}
  private abs(p: string) { return path.join(this.root, p); }
  async list() {
    const m = new Map<string, { mtime: number; size: number }>();
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else { const rel = path.relative(this.root, full).split(path.sep).join("/"); const st = await fs.stat(full); m.set(rel, { mtime: st.mtimeMs, size: st.size }); }
      }
    };
    await walk(this.root).catch(() => {});
    return m;
  }
  async read(p: string): Promise<Uint8Array> { return new Uint8Array(await fs.readFile(this.abs(p))); }
  async write(p: string, bytes: Uint8Array): Promise<void> { await fs.mkdir(path.dirname(this.abs(p)), { recursive: true }); await fs.writeFile(this.abs(p), bytes); }
  async remove(p: string): Promise<void> { await fs.rm(this.abs(p), { force: true }); }
}

/** FsVaultIo + the selective-sync filter, mirroring how ObsidianVaultIo gates list/write. */
class FilteredFsVaultIo extends FsVaultIo {
  constructor(root: string, private sel: ConfigSyncSelection, private selfId: string) { super(root); }
  private passes(p: string) { return shouldSync(p, this.sel, this.selfId); }
  async list() { const m = await super.list(); for (const k of [...m.keys()]) if (!this.passes(k)) m.delete(k); return m; }
  async write(p: string, bytes: Uint8Array): Promise<void> { if (!this.passes(p)) return; return super.write(p, bytes); }
}

type Client = { io: FsVaultIo; api: NodeTransport; state: SyncState; known: Set<string>; cache: ChunkCache; base: BaseStore; device: string; root: string };

function dep(c: Client): ReconcileDeps {
  return { api: c.api, io: c.io, base: c.base, cache: c.cache, state: c.state, device: c.device, strategy: "auto-merge" };
}

async function connect(base: string, root: string, device = "Dev", vault = "default"): Promise<Client> {
  await fs.mkdir(root, { recursive: true });
  const token = await NodeTransport.login(base, "admin", "admin");
  const api = new NodeTransport(base, token, vault);
  const c: Client = { io: new FsVaultIo(root), api, state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device, root };
  await reconcileAll(dep(c));
  return c;
}
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const exists = (p: string) => fs.access(p).then(() => true, () => false);

let srv: ChildProcess | undefined;
let base = "";
let dataDir = "";

describe.skipIf(!canRun)("headless two-client E2E (real server + real chunk engine)", () => {
  beforeAll(async () => {
    if (externalUrl) { base = externalUrl; return; }
    dataDir = mkdtempSync(path.join(os.tmpdir(), "nls-e2e-data-"));
    srv = spawn(serverBin, [], {
      env: { ...process.env, DATA_ROOT: dataDir, BIND_ADDR: "127.0.0.1:0", SYNC_USER: "admin", SYNC_PASSWORD: "admin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not report a listening address in time")), 15000);
      const onData = (b: Buffer) => {
        const m = b.toString().match(/listening on (\S+)/);
        if (m) { clearTimeout(timer); resolve(`http://${m[1]}`); }
      };
      srv!.stderr!.on("data", onData);
      srv!.stdout!.on("data", onData);
    });
  }, 20000);

  afterAll(() => {
    srv?.kill();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("propagates create/edit/delete, a binary file, and dedups shared chunks", async () => {
    const a = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-A-")));
    const b = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-B-")));

    // Every scenario drives the REAL reconcile engine (reconcileAll) on both sides —
    // the same path production uses — against the real server.

    // S1 — text create in A propagates to B
    await a.io.write("n1.md", enc("hello from A"));
    await reconcileAll(dep(a)); // pushes
    await reconcileAll(dep(b)); // pulls
    expect(dec(await b.io.read("n1.md"))).toBe("hello from A");

    // S2 — edit in B propagates to A
    await b.io.write("n1.md", enc("edited in B"));
    await reconcileAll(dep(b));
    await reconcileAll(dep(a));
    expect(dec(await a.io.read("n1.md"))).toBe("edited in B");

    // S3 — binary file (non-UTF8 bytes) round-trips intact
    const bin = new Uint8Array(80000); for (let i = 0; i < bin.length; i++) bin[i] = (i * 37) & 0xff;
    await a.io.write("img.bin", bin);
    await reconcileAll(dep(a));
    await reconcileAll(dep(b));
    expect(await b.io.read("img.bin")).toEqual(bin);

    // S4 — dedup: identical content under a new path uploads ZERO new chunks
    const { chunk } = await import("../src/chunker");
    const csImg = await chunk(bin);
    expect(csImg.length).toBeGreaterThan(0);
    expect((await a.api.missing(csImg.map((c) => c.hash))).length).toBe(0);
    await a.io.write("img-copy.bin", bin);
    let uploads = 0; const realPut = a.api.putChunk.bind(a.api);
    a.api.putChunk = async (h, by) => { uploads++; return realPut(h, by); };
    await reconcileAll(dep(a)); // reconcile pushes img-copy via shared chunks
    expect(uploads).toBe(0);    // shared chunks -> zero new uploads
    a.api.putChunk = realPut;
    await reconcileAll(dep(b));
    expect(await b.io.read("img-copy.bin")).toEqual(bin);

    // S5 — delete in A propagates to B (engine: delete-remote on A, delete-local on B)
    await a.io.remove("n1.md");
    await reconcileAll(dep(a));
    await reconcileAll(dep(b));
    expect(await exists(path.join(b.root, "n1.md"))).toBe(false);

    // Bind mount is real truth (namespaced per user/vault: DATA_ROOT/<user>/<vault>/vault/…)
    if (dataDir) expect(await exists(path.join(dataDir, "admin", "default", "vault", "img.bin"))).toBe(true);

    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }, 30000);

  it("M3: three-way merges divergent Markdown and conflict-copies divergent binary (never clobbers)", async () => {
    const a = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-mA-")), "A");
    const b = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-mB-")), "B");

    // shared base on both sides
    await a.io.write("m.md", enc("l1\nl2\nl3\n"));
    await reconcileAll(dep(a)); await reconcileAll(dep(b));
    expect(dec(await b.io.read("m.md"))).toBe("l1\nl2\nl3\n");

    // diverge offline: A edits line 1, B edits line 3 (disjoint -> clean merge)
    await a.io.write("m.md", enc("L1\nl2\nl3\n"));
    await b.io.write("m.md", enc("l1\nl2\nL3\n"));
    await reconcileAll(dep(a));   // A pushes its change
    await reconcileAll(dep(b));   // B merges A's change with its own, pushes merged
    await reconcileAll(dep(a));   // A pulls the merged result
    const am = dec(await a.io.read("m.md"));
    expect(am).toContain("L1"); expect(am).toContain("L3");  // both edits survive

    // divergent BINARY -> conflict-copy on the second reconciler (both kept, nothing lost)
    const base1 = new Uint8Array(3000).map((_, i) => i & 0xff);
    await a.io.write("x.bin", base1);
    await reconcileAll(dep(a)); await reconcileAll(dep(b));
    await a.io.write("x.bin", base1.map((v) => v ^ 1));       // A changes it
    await b.io.write("x.bin", base1.map((v) => (v + 9) & 0xff)); // B changes it differently
    await reconcileAll(dep(a));   // A pushes
    await reconcileAll(dep(b));   // B: both changed, binary -> conflict-copy
    const bFiles = (await b.io.list());
    const conflictCopies = [...bFiles.keys()].filter((p) => p.includes("(conflict"));
    expect(conflictCopies.length).toBe(1);                    // B kept its own copy
    expect(await exists(path.join(b.root, "x.bin"))).toBe(true); // and has A's version canonically

    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }, 30000);

  it("M4: multiple vaults are isolated (a file in one vault never appears in another)", async () => {
    const token = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createVault(base, token, "work");
    // one client on `default`, one on `work` (same account)
    const d = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-def-")), "D", "default");
    const w = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-work-")), "W", "work");

    await w.io.write("secret.md", enc("work only"));
    await reconcileAll(dep(w));       // push into `work`
    await reconcileAll(dep(d));       // reconcile `default` — must NOT receive it

    expect(await exists(path.join(w.root, "secret.md"))).toBe(true);
    expect(await exists(path.join(d.root, "secret.md"))).toBe(false); // isolation

    rmSync(d.root, { recursive: true, force: true });
    rmSync(w.root, { recursive: true, force: true });
  }, 30000);

  it("M6: syncs opted-in config but NEVER SelfSync's own folder or opted-out theming", async () => {
    const SELF = "obsidian-selfsync";
    // Pin the selection this test exercises (independent of default changes): community
    // plugins ON (to prove they propagate), appearance OFF (to prove opt-out holds).
    const sel: ConfigSyncSelection = { ...DEFAULT_CONFIG_SYNC, enabled: true, community: true, appearance: false };
    const token = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createVault(base, token, "cfgsync");
    const build = async (tag: string, device: string): Promise<Client> => {
      const root = mkdtempSync(path.join(os.tmpdir(), tag));
      const api = new NodeTransport(base, token, "cfgsync");
      const c: Client = { io: new FilteredFsVaultIo(root, sel, SELF), api, state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device, root };
      await reconcileAll(dep(c));
      return c;
    };
    const a = await build("nls-cfgA-", "A");
    const b = await build("nls-cfgB-", "B");

    // A synced note + an opted-in plugin's config go through the filtered IO.
    await a.io.write("Note.md", enc("body"));
    await a.io.write(".obsidian/plugins/dataview/data.json", enc('{"n":1}'));
    // Obsidian (not us) writes appearance + SelfSync's own config to disk — simulate
    // with raw fs so the filter's job is purely to keep them from being UPLOADED.
    await fs.mkdir(path.join(a.root, ".obsidian", "plugins", SELF), { recursive: true });
    await fs.writeFile(path.join(a.root, ".obsidian", "appearance.json"), '{"theme":"moonstone"}');
    await fs.writeFile(path.join(a.root, ".obsidian", "plugins", SELF, "data.json"), '{"serverUrl":"http://A-only"}');

    await reconcileAll(dep(a));
    await reconcileAll(dep(b));

    // Opted-in surfaces propagate:
    expect(dec(await b.io.read("Note.md"))).toBe("body");
    expect(dec(await b.io.read(".obsidian/plugins/dataview/data.json"))).toBe('{"n":1}');
    // Opted-out theming stays on A only:
    expect(await exists(path.join(a.root, ".obsidian", "appearance.json"))).toBe(true);
    expect(await exists(path.join(b.root, ".obsidian", "appearance.json"))).toBe(false);
    // SECURITY: SelfSync's own config never left A (its server URL must not overwrite B):
    expect(await exists(path.join(a.root, ".obsidian", "plugins", SELF, "data.json"))).toBe(true);
    expect(await exists(path.join(b.root, ".obsidian", "plugins", SELF, "data.json"))).toBe(false);

    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }, 30000);

  it("goal#1: wizard data flow — health ping, login, create+list vault, then sync works", async () => {
    // /health reachability (what the wizard's Test-connection button checks)
    const health = await fetch(`${base}/health`).then((r) => r.status);
    expect(health).toBe(200);

    // account → vault, mirroring SetupWizardModal.finish()
    const token = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createVault(base, token, "wizardvault");
    const vaults = await NodeTransport.listVaults(base, token);
    expect(vaults).toContain("wizardvault");

    // and the newly-created vault actually syncs a file between two clients
    const a = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-wzA-")), "A", "wizardvault");
    const b = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-wzB-")), "B", "wizardvault");
    await a.io.write("hello.md", enc("hi from wizard vault"));
    await reconcileAll(dep(a));
    await reconcileAll(dep(b));
    expect(dec(await b.io.read("hello.md"))).toBe("hi from wizard vault");

    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }, 30000);

  // ======================================================================
  // Large coverage suite. Each test uses its OWN vault for isolation, two
  // clients A + B, and drives the real reconcile engine against the real
  // server. Helpers below build the A/B pair.
  // ======================================================================
  let vaultSeq = 0;
  const uniqVault = (tag: string) => `t-${tag}-${(vaultSeq++)}`;
  async function pair(tag: string): Promise<[Client, Client]> {
    const v = uniqVault(tag);
    const a = await connect(base, mkdtempSync(path.join(os.tmpdir(), `nls-${tag}A-`)), "A", v);
    const b = await connect(base, mkdtempSync(path.join(os.tmpdir(), `nls-${tag}B-`)), "B", v);
    return [a, b];
  }
  // A + B on a fresh vault, each using a FilteredFsVaultIo with the given selection.
  async function filteredPair(tag: string, sel: ConfigSyncSelection, selfId: string): Promise<[Client, Client]> {
    const v = uniqVault(tag);
    const token = await NodeTransport.login(base, "admin", "admin");
    const mk = async (dev: string): Promise<Client> => {
      const root = mkdtempSync(path.join(os.tmpdir(), `nls-${tag}${dev}-`));
      const c: Client = { io: new FilteredFsVaultIo(root, sel, selfId), api: new NodeTransport(base, token, v), state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device: dev, root };
      await reconcileAll(dep(c));
      return c;
    };
    return [await mk("A"), await mk("B")];
  }
  const clean = (...cs: Client[]) => cs.forEach((c) => rmSync(c.root, { recursive: true, force: true }));
  const push = (c: Client) => reconcileAll(dep(c)); // A→server
  const pullc = (c: Client) => reconcileAll(dep(c)); // server→B

  it("arbitrary nested directories round-trip at the same paths", async () => {
    const [a, b] = await pair("nested");
    const paths = ["top.md", "a/one.md", "a/b/two.md", "a/b/c/three.md", "deep/very/deeply/nested/dir/x.md", "folder with spaces/note (1).md"];
    for (const p of paths) await a.io.write(p, enc("content of " + p));
    await push(a); await pullc(b);
    for (const p of paths) expect(dec(await b.io.read(p))).toBe("content of " + p);
    clean(a, b);
  }, 30000);

  it("Unicode filenames and content round-trip byte-exact", async () => {
    const [a, b] = await pair("unicode");
    const cases: Array<[string, string]> = [
      ["文档/日本語のノート.md", "こんにちは 世界 🌍 — café, naïve, Zürich"],
      ["emoji/🚀 launch ☕.md", "mixed 🇯🇵🇺🇸 flags, math ∑∫≠, combining é vs é"],
      ["عربى/مذكرة.md", "نص عربي من اليمين إلى اليسار"],
      ["ru/Заметка.md", "Кириллица и специальные символы: № — «»"],
    ];
    for (const [p, body] of cases) await a.io.write(p, enc(body));
    await push(a); await pullc(b);
    for (const [p, body] of cases) expect(dec(await b.io.read(p))).toBe(body);
    clean(a, b);
  }, 30000);

  it("perf: 100 small files add + sync (measured)", async () => {
    const [a, b] = await pair("many");
    for (let i = 0; i < 100; i++) await a.io.write(`n/${i}.md`, enc(`file ${i}\n`.repeat(3)));
    const t0 = performance.now(); await push(a); const tPush = performance.now() - t0;
    const t1 = performance.now(); await pullc(b); const tPull = performance.now() - t1;
    // eslint-disable-next-line no-console
    console.log(`[perf] 100 small files — push ${tPush.toFixed(0)}ms, pull ${tPull.toFixed(0)}ms`);
    expect((await b.io.list()).size).toBe(100);
    expect(tPush).toBeLessThan(60000); expect(tPull).toBeLessThan(60000); // generous ceiling; catches catastrophic regressions
    clean(a, b);
  }, 120000);

  it("perf: one large (~5 MB) text file add + sync (measured)", async () => {
    const [a, b] = await pair("bigtext");
    const big = "The quick brown fox jumps over the lazy dog. 0123456789\n".repeat(95000); // ~5 MB
    await a.io.write("big.md", enc(big));
    const t0 = performance.now(); await push(a); const tPush = performance.now() - t0;
    const t1 = performance.now(); await pullc(b); const tPull = performance.now() - t1;
    // eslint-disable-next-line no-console
    console.log(`[perf] ~5MB text — push ${tPush.toFixed(0)}ms, pull ${tPull.toFixed(0)}ms`);
    expect(dec(await b.io.read("big.md"))).toBe(big);
    clean(a, b);
  }, 120000);

  it("large binary (~4 MB, non-UTF8, all-unique chunks) syncs byte-identical + dedups a copy", async () => {
    // NOTE: chunk transfer is currently SEQUENTIAL (pushFile puts each missing chunk /
    // fetchFileBytes gets each chunk one at a time). An all-unique-content blob is the
    // worst case: ~N/64KiB round-trips. 4 MB keeps the suite runnable; parallelizing
    // chunk transfer is logged as a perf follow-up (B11).
    const [a, b] = await pair("bigbin");
    const bin = new Uint8Array(4 * 1024 * 1024);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 2654435761) & 0xff; // non-trivial, non-UTF8
    await a.io.write("blob.bin", bin);
    await push(a); await pullc(b);
    expect(await b.io.read("blob.bin")).toEqual(bin);
    // an identical copy under a new name uploads ZERO new chunks (content-addressed dedup)
    await a.io.write("blob-copy.bin", bin);
    let uploads = 0; const realPut = a.api.putChunk.bind(a.api);
    a.api.putChunk = async (h, by) => { uploads++; return realPut(h, by); };
    await push(a); a.api.putChunk = realPut;
    expect(uploads).toBe(0);
    await pullc(b);
    expect(await b.io.read("blob-copy.bin")).toEqual(bin);
    clean(a, b);
  }, 180000);

  it("edit then REVERT propagates the reverted content", async () => {
    const [a, b] = await pair("revert");
    await a.io.write("r.md", enc("v1 original")); await push(a); await pullc(b);
    await a.io.write("r.md", enc("v2 edited"));   await push(a); await pullc(b);
    expect(dec(await b.io.read("r.md"))).toBe("v2 edited");
    await a.io.write("r.md", enc("v1 original")); await push(a); await pullc(b); // revert
    expect(dec(await b.io.read("r.md"))).toBe("v1 original");
    clean(a, b);
  }, 30000);

  it("sequential additional edits each propagate in order", async () => {
    const [a, b] = await pair("seq");
    for (const v of ["v1", "v1\nv2", "v1\nv2\nv3"]) { await a.io.write("s.md", enc(v)); await push(a); await pullc(b); expect(dec(await b.io.read("s.md"))).toBe(v); }
    clean(a, b);
  }, 30000);

  it("delete then RECREATE the same path with new content", async () => {
    const [a, b] = await pair("recreate");
    // A second file that stays, so deleting d.md never empties the vault (an empty
    // remote would trip the C2 data-loss guard — a distinct, intentional behavior
    // exercised by its own test below).
    await a.io.write("keep.md", enc("stays"));
    await a.io.write("d.md", enc("first life")); await push(a); await pullc(b);
    expect(dec(await b.io.read("d.md"))).toBe("first life");
    await a.io.remove("d.md"); await push(a); await pullc(b);
    expect(await exists(path.join(b.root, "d.md"))).toBe(false);
    await a.io.write("d.md", enc("second life")); await push(a); await pullc(b);
    expect(dec(await b.io.read("d.md"))).toBe("second life");
    clean(a, b);
  }, 30000);

  it("C2 guard: deleting the LAST file leaves the peer's copy intact (no bulk-delete on empty remote)", async () => {
    const [a, b] = await pair("c2edge");
    await a.io.write("only.md", enc("solo")); await push(a); await pullc(b);
    expect(dec(await b.io.read("only.md"))).toBe("solo");
    await a.io.remove("only.md"); await push(a); await pullc(b); // server now empty
    // B holds synced history but the manifest is empty → guard refuses the delete.
    expect(await exists(path.join(b.root, "only.md"))).toBe(true);
    clean(a, b);
  }, 30000);

  it("bidirectional edits on different files converge", async () => {
    const [a, b] = await pair("bidi");
    await a.io.write("fromA.md", enc("A wrote this")); await push(a);
    await b.io.write("fromB.md", enc("B wrote this")); await push(b);
    await pullc(a); await pullc(b);
    expect(dec(await a.io.read("fromB.md"))).toBe("B wrote this");
    expect(dec(await b.io.read("fromA.md"))).toBe("A wrote this");
    clean(a, b);
  }, 30000);

  // Every config-sync "dial": with ONLY that dial on, its file must appear on B; a
  // file from a DIFFERENT (off) dial must NOT. Excluded files are written via raw fs
  // (as Obsidian would) so the filter's job is purely to keep them off the wire.
  const DIALS: Array<{ dial: keyof ConfigSyncSelection; on: string; off: string }> = [
    { dial: "core",       on: ".obsidian/app.json",              off: ".obsidian/hotkeys.json" },
    { dial: "hotkeys",    on: ".obsidian/hotkeys.json",          off: ".obsidian/app.json" },
    { dial: "appearance", on: ".obsidian/appearance.json",       off: ".obsidian/hotkeys.json" },
    { dial: "snippets",   on: ".obsidian/snippets/custom.css",   off: ".obsidian/appearance.json" },
    { dial: "community",  on: ".obsidian/plugins/dataview/data.json", off: ".obsidian/appearance.json" },
  ];
  for (const { dial, on, off } of DIALS) {
    it(`config dial "${dial}": its file syncs; an off-dial file does not`, async () => {
      const SELF = "selfsync";
      const sel: ConfigSyncSelection = { ...DEFAULT_CONFIG_SYNC, enabled: true, core: false, hotkeys: false, appearance: false, snippets: false, community: false, [dial]: true } as ConfigSyncSelection;
      const [a, b] = await filteredPair(`dial-${dial}`, sel, SELF);
      await a.io.write(on, enc(`${dial} payload`));                 // opted-in → should sync
      await fs.mkdir(path.dirname(path.join(a.root, off)), { recursive: true });
      await fs.writeFile(path.join(a.root, off), "off-dial payload"); // raw fs → filter must keep it off the wire
      await push(a); await pullc(b);
      expect(dec(await b.io.read(on))).toBe(`${dial} payload`);      // the dial's file arrived
      expect(await exists(path.join(b.root, off))).toBe(false);       // the off-dial file did not
      clean(a, b);
    }, 30000);
  }

  it("SelfSync's own plugin folder never syncs (credentials stay local), even with community on", async () => {
    const SELF = "selfsync";
    const sel: ConfigSyncSelection = { ...DEFAULT_CONFIG_SYNC, enabled: true, community: true };
    const [a, b] = await filteredPair("selfexcl", sel, SELF);
    await fs.mkdir(path.join(a.root, ".obsidian", "plugins", SELF), { recursive: true });
    await fs.writeFile(path.join(a.root, ".obsidian", "plugins", SELF, "data.json"), '{"serverUrl":"http://A-secret","password":"hunter2"}');
    // a legit plugin alongside, to prove community sync IS working
    await a.io.write(".obsidian/plugins/dataview/data.json", enc('{"ok":1}'));
    await push(a); await pullc(b);
    expect(await exists(path.join(b.root, ".obsidian", "plugins", "dataview", "data.json"))).toBe(true);
    expect(await exists(path.join(b.root, ".obsidian", "plugins", SELF, "data.json"))).toBe(false);
    clean(a, b);
  }, 30000);
});

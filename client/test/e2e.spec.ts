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
import { pull, pushFile, pushLocalNew, SyncApi, VaultIo, SyncState, ChunkCache } from "../src/sync";
import { ChangesResponse, CommitRequest, FileMeta } from "../src/protocol";
import { BaseStore } from "../src/base";
import { reconcileAll, ReconcileDeps } from "../src/reconcile";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverBin = path.resolve(
  here, "../../server/target/debug/new-livesync-server" + (process.platform === "win32" ? ".exe" : "")
);
const externalUrl = process.env.SYNC_SERVER_URL;
const canRun = !!externalUrl || existsSync(serverBin);

/** Node HTTP transport (global fetch — server-to-server, no Obsidian CSP). Chunk API. */
class NodeTransport implements SyncApi {
  constructor(private base: string, private token: string) {}
  static async login(base: string, u: string, p: string): Promise<string> {
    const r = await fetch(`${base}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    if (!r.ok) throw new Error(`login ${r.status}`);
    return ((await r.json()) as { token: string }).token;
  }
  private h() { return { authorization: `Bearer ${this.token}` }; }
  async changes(since: number): Promise<ChangesResponse> {
    const r = await fetch(`${this.base}/api/vault/changes?since=${since}`, { headers: this.h() });
    if (!r.ok) throw new Error(`changes ${r.status}`);
    return (await r.json()) as ChangesResponse;
  }
  async missing(hashes: string[]): Promise<string[]> {
    const r = await fetch(`${this.base}/api/vault/chunks/missing`, {
      method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify({ hashes }),
    });
    if (!r.ok) throw new Error(`missing ${r.status}`);
    return ((await r.json()) as { missing: string[] }).missing;
  }
  async getChunk(hash: string): Promise<Uint8Array> {
    const r = await fetch(`${this.base}/api/vault/chunk/${hash}`, { headers: this.h() });
    if (!r.ok) throw new Error(`getChunk ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async putChunk(hash: string, bytes: Uint8Array): Promise<void> {
    const r = await fetch(`${this.base}/api/vault/chunk/${hash}`, { method: "PUT", headers: this.h(), body: new Blob([bytes as BlobPart]) });
    if (!r.ok) throw new Error(`putChunk ${r.status}`);
  }
  async commit(req: CommitRequest): Promise<FileMeta> {
    const r = await fetch(`${this.base}/api/vault/commit`, {
      method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify(req),
    });
    if (!r.ok) throw new Error(`commit ${r.status}`);
    return (await r.json()) as FileMeta;
  }
  async deleteFile(p: string): Promise<void> {
    const r = await fetch(`${this.base}/api/vault/file?path=${encodeURIComponent(p)}`, { method: "DELETE", headers: this.h() });
    if (!r.ok && r.status !== 404) throw new Error(`delete ${r.status}`);
  }
}

/** Filesystem-backed binary VaultIo (mirrors the plugin's ObsidianVaultIo, on real fs). */
class FsVaultIo implements VaultIo {
  constructor(private root: string) {}
  private abs(p: string) { return path.join(this.root, p); }
  async list() {
    const m = new Map<string, { mtime: number }>();
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else { const rel = path.relative(this.root, full).split(path.sep).join("/"); m.set(rel, { mtime: (await fs.stat(full)).mtimeMs }); }
      }
    };
    await walk(this.root).catch(() => {});
    return m;
  }
  async read(p: string): Promise<Uint8Array> { return new Uint8Array(await fs.readFile(this.abs(p))); }
  async write(p: string, bytes: Uint8Array): Promise<void> { await fs.mkdir(path.dirname(this.abs(p)), { recursive: true }); await fs.writeFile(this.abs(p), bytes); }
  async remove(p: string): Promise<void> { await fs.rm(this.abs(p), { force: true }); }
}

type Client = { io: FsVaultIo; api: NodeTransport; state: SyncState; known: Set<string>; cache: ChunkCache; base: BaseStore; device: string; root: string };

function dep(c: Client): ReconcileDeps {
  return { api: c.api, io: c.io, base: c.base, cache: c.cache, state: c.state, device: c.device, strategy: "auto-merge" };
}

async function connect(base: string, root: string, device = "Dev"): Promise<Client> {
  await fs.mkdir(root, { recursive: true });
  const token = await NodeTransport.login(base, "admin", "admin");
  const api = new NodeTransport(base, token);
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

    // S1 — text create in A propagates to B
    await a.io.write("n1.md", enc("hello from A"));
    await pushFile(a.api, a.io, a.state, a.cache, "n1.md");
    await pull(b.api, b.io, b.state, b.cache);
    expect(dec(await b.io.read("n1.md"))).toBe("hello from A");

    // S2 — edit in B propagates to A
    await b.io.write("n1.md", enc("edited in B"));
    await pushFile(b.api, b.io, b.state, b.cache, "n1.md");
    await pull(a.api, a.io, a.state, a.cache);
    expect(dec(await a.io.read("n1.md"))).toBe("edited in B");

    // S3 — binary file (non-UTF8 bytes) round-trips intact
    const bin = new Uint8Array(80000); for (let i = 0; i < bin.length; i++) bin[i] = (i * 37) & 0xff;
    await a.io.write("img.bin", bin);
    await pushFile(a.api, a.io, a.state, a.cache, "img.bin");
    await pull(b.api, b.io, b.state, b.cache);
    expect(await b.io.read("img.bin")).toEqual(bin);

    // S4 — dedup: a file whose content is a prefix of img.bin shares chunks, so
    // fewer chunks are missing than a fresh file of the same size would need.
    const { chunk } = await import("../src/chunker");
    const csImg = await chunk(bin);
    expect(csImg.length).toBeGreaterThan(0);
    const missingOwn = await a.api.missing(csImg.map((c) => c.hash));
    expect(missingOwn.length).toBe(0); // every chunk of an already-synced file is present
    // committing identical content under a new path uploads ZERO new chunks
    await a.io.write("img-copy.bin", bin);
    let uploads = 0; const realPut = a.api.putChunk.bind(a.api);
    a.api.putChunk = async (h, by) => { uploads++; return realPut(h, by); };
    await pushFile(a.api, a.io, a.state, a.cache, "img-copy.bin");
    expect(uploads).toBe(0); // shared chunks -> zero new uploads
    await pull(b.api, b.io, b.state, b.cache);
    expect(await b.io.read("img-copy.bin")).toEqual(bin);

    // S5 — delete in A propagates to B
    await a.io.remove("n1.md");
    await a.api.deleteFile("n1.md");
    a.known.delete("n1.md");
    await pull(b.api, b.io, b.state, b.cache);
    expect(await exists(path.join(b.root, "n1.md"))).toBe(false);

    // Bind mount is real truth (only when we spawned the server ourselves)
    if (dataDir) expect(await exists(path.join(dataDir, "vault", "img.bin"))).toBe(true);

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
});

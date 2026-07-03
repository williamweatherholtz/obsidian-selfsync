// Headless end-to-end test: drives TWO real sync clients (the actual sync.ts
// engine + a Node HTTP transport + real files on disk) against the real server
// binary, and asserts create/edit/delete/large-file propagation. No Obsidian.
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
import { pull, pushLocal, SyncApi, VaultIo, SyncState } from "../src/sync";
import { ChangesResponse, FileMeta } from "../src/protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverBin = path.resolve(
  here, "../../server/target/debug/new-livesync-server" + (process.platform === "win32" ? ".exe" : "")
);
const externalUrl = process.env.SYNC_SERVER_URL;
const canRun = !!externalUrl || existsSync(serverBin);

/** Node HTTP transport (global fetch — server-to-server, no Obsidian CSP). */
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
  async getFile(p: string): Promise<string> {
    const r = await fetch(`${this.base}/api/vault/file?path=${encodeURIComponent(p)}`, { headers: this.h() });
    if (!r.ok) throw new Error(`get ${r.status}`);
    return await r.text();
  }
  async putFile(p: string, data: string, mtime: number): Promise<FileMeta> {
    const r = await fetch(`${this.base}/api/vault/file?path=${encodeURIComponent(p)}`, {
      method: "PUT", headers: { ...this.h(), "X-Mtime": String(mtime) }, body: data,
    });
    if (!r.ok) throw new Error(`put ${r.status}`);
    return (await r.json()) as FileMeta;
  }
  async deleteFile(p: string): Promise<void> {
    const r = await fetch(`${this.base}/api/vault/file?path=${encodeURIComponent(p)}`, { method: "DELETE", headers: this.h() });
    if (!r.ok && r.status !== 404) throw new Error(`delete ${r.status}`);
  }
}

/** Filesystem-backed VaultIo (mirrors the plugin's ObsidianVaultIo, on real fs). */
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
  async read(p: string) { return fs.readFile(this.abs(p), "utf8"); }
  async write(p: string, data: string) { await fs.mkdir(path.dirname(this.abs(p)), { recursive: true }); await fs.writeFile(this.abs(p), data); }
  async remove(p: string) { await fs.rm(this.abs(p), { force: true }); }
}

type Client = { io: FsVaultIo; api: NodeTransport; state: SyncState; known: Set<string>; root: string };

async function connect(base: string, root: string): Promise<Client> {
  await fs.mkdir(root, { recursive: true });
  const token = await NodeTransport.login(base, "admin", "admin");
  const api = new NodeTransport(base, token);
  const io = new FsVaultIo(root);
  const state: SyncState = { version: 0 };
  await pull(api, io, state);
  const known = new Set((await api.changes(0)).upserts.map((m) => m.path));
  await pushLocal(api, io, state, known);
  return { io, api, state, known, root };
}
async function pushFile(c: Client, rel: string) {
  const data = await c.io.read(rel);
  const meta = await c.api.putFile(rel, data, Date.now());
  c.state.version = Math.max(c.state.version, meta.version);
  c.known.add(rel);
}
const exists = (p: string) => fs.access(p).then(() => true, () => false);

let srv: ChildProcess | undefined;
let base = "";
let dataDir = "";

describe.skipIf(!canRun)("headless two-client E2E (real server + real sync engine)", () => {
  beforeAll(async () => {
    if (externalUrl) { base = externalUrl; return; }
    dataDir = mkdtempSync(path.join(os.tmpdir(), "nls-e2e-data-"));
    srv = spawn(serverBin, [], {
      env: { ...process.env, DATA_ROOT: dataDir, BIND_ADDR: "127.0.0.1:0", SYNC_USER: "admin", SYNC_PASSWORD: "admin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not report a listening address in time")), 15000);
      // The server logs via eprintln! -> STDERR (both the "listening on" line and requests).
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

  it("propagates create, edit, delete, and a >2MB file between two clients", async () => {
    const dirA = mkdtempSync(path.join(os.tmpdir(), "nls-A-"));
    const dirB = mkdtempSync(path.join(os.tmpdir(), "nls-B-"));
    const a = await connect(base, dirA);
    const b = await connect(base, dirB);

    // S1 — create in A propagates to B
    await a.io.write("n1.md", "hello from A");
    await pushFile(a, "n1.md");
    await pull(b.api, b.io, b.state);
    expect(await b.io.read("n1.md")).toBe("hello from A");

    // S2 — edit in B propagates to A
    await b.io.write("n1.md", "edited in B");
    await pushFile(b, "n1.md");
    await pull(a.api, a.io, a.state);
    expect(await a.io.read("n1.md")).toBe("edited in B");

    // S3 — >2MB file (regression for the body-limit fix)
    const big = "x".repeat(3 * 1024 * 1024);
    await a.io.write("big.md", big);
    await pushFile(a, "big.md");
    await pull(b.api, b.io, b.state);
    expect((await fs.stat(path.join(dirB, "big.md"))).size).toBe(big.length);

    // S4 — delete in A propagates to B
    await fs.rm(path.join(dirA, "n1.md"));
    await a.api.deleteFile("n1.md");
    a.known.delete("n1.md");
    await pull(b.api, b.io, b.state);
    expect(await exists(path.join(dirB, "n1.md"))).toBe(false);

    // Bind mount is real truth (only when we spawned the server ourselves)
    if (dataDir) expect(await exists(path.join(dataDir, "vault", "big.md"))).toBe(true);

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }, 30000);
});

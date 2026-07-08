// Shared harness for the headless E2E specs: spawns the real server binary (or targets
// SYNC_SERVER_URL, e.g. in docker-compose) and drives real sync clients — the actual
// sync.ts chunk engine + a Node HTTP transport + real files on disk. No Obsidian.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SyncApi, VaultIo, SyncState, ChunkCache, AppendHandle } from "../src/sync";
import { ChangesResponse, CommitRequest, FileMeta } from "../src/protocol";
import { BaseStore } from "../src/base";
import { reconcileAll, ReconcileDeps } from "../src/reconcile";
import { shouldSync, ConfigSyncSelection } from "../src/configsync";

const here = path.dirname(fileURLToPath(import.meta.url));
export const serverBin = path.resolve(
  here, "../../server/target/debug/new-livesync-server" + (process.platform === "win32" ? ".exe" : "")
);
export const externalUrl = process.env.SYNC_SERVER_URL;
export const canRun = !!externalUrl || existsSync(serverBin);

/** Node HTTP transport (global fetch — server-to-server, no Obsidian CSP). Chunk API. */
export class NodeTransport implements SyncApi {
  // owner "" = own vault (/api/v/{vault}); set = a shared vault (/api/u/{owner}/{vault}).
  constructor(private base: string, private token: string, private vault = "default", private owner = "") {}
  static async login(base: string, u: string, p: string): Promise<string> {
    const r = await fetch(`${base}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u, password: p }),
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
  // Admin helpers (server-admin token) for cross-user sharing tests.
  static async createUser(base: string, adminToken: string, username: string, password: string): Promise<void> {
    const r = await fetch(`${base}/api/admin/users`, {
      method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ username, password }),
    });
    if (!r.ok) throw new Error(`createUser ${r.status}`);
  }
  // A vault owner grants a share on their own vault (owner-scoped; any owner may call).
  static async grant(base: string, ownerToken: string, vault: string, grantee: string, perm: "read" | "readWrite"): Promise<void> {
    const r = await fetch(`${base}/api/admin/shares`, {
      method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ vault, grantee, perm }),
    });
    if (!r.ok) throw new Error(`grant ${r.status}`);
  }
  private h() { return { authorization: `Bearer ${this.token}` }; }
  private v(suffix: string) {
    const scope = this.owner
      ? `/api/u/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.vault)}`
      : `/api/v/${encodeURIComponent(this.vault)}`;
    return `${this.base}${scope}${suffix}`;
  }
  async changes(since: number): Promise<ChangesResponse> {
    const r = await fetch(this.v(`/changes?since=${since}`), { headers: this.h() });
    if (!r.ok) throw new Error(`changes ${r.status}`);
    return (await r.json()) as ChangesResponse;
  }
  async fileMeta(p: string): Promise<FileMeta | null> {
    const r = await fetch(this.v(`/meta?path=${encodeURIComponent(p)}`), { headers: this.h() });
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
export class FsVaultIo implements VaultIo {
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
  // Streamed write (mirrors ObsidianVaultIo's desktop Node-fs path): append to a temp file, then rename.
  async appendWrite(p: string): Promise<AppendHandle> {
    const abs = this.abs(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + ".part";
    const fh = await fs.open(tmp, "w");
    return {
      append: async (bytes: Uint8Array) => { await fh.write(bytes); },
      close: async () => { await fh.sync(); await fh.close(); await fs.rename(tmp, abs); },
      abort: async () => { await fh.close().catch(() => {}); await fs.rm(tmp, { force: true }).catch(() => {}); },
    };
  }
}

/** FsVaultIo + the selective-sync filter, mirroring how ObsidianVaultIo gates list/write. */
export class FilteredFsVaultIo extends FsVaultIo {
  constructor(root: string, private sel: ConfigSyncSelection, private selfId: string) { super(root); }
  private passes(p: string) { return shouldSync(p, this.sel, this.selfId); }
  async list() { const m = await super.list(); for (const k of [...m.keys()]) if (!this.passes(k)) m.delete(k); return m; }
  async write(p: string, bytes: Uint8Array): Promise<void> { if (!this.passes(p)) return; return super.write(p, bytes); }
}

export type Client = { io: FsVaultIo; api: NodeTransport; state: SyncState; known: Set<string>; cache: ChunkCache; base: BaseStore; device: string; root: string };

export function dep(c: Client): ReconcileDeps {
  return { api: c.api, io: c.io, base: c.base, cache: c.cache, state: c.state, device: c.device };
}

export async function connect(base: string, root: string, device = "Dev", vault = "default"): Promise<Client> {
  await fs.mkdir(root, { recursive: true });
  const token = await NodeTransport.login(base, "admin", "admin");
  await NodeTransport.createVault(base, token, vault).catch(() => {}); // protocol-6: sync needs an existing vault (idempotent; 409 if it already exists)
  const api = new NodeTransport(base, token, vault);
  const c: Client = { io: new FsVaultIo(root), api, state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device, root };
  await reconcileAll(dep(c));
  return c;
}

export const enc = (s: string) => new TextEncoder().encode(s);
export const dec = (b: Uint8Array) => new TextDecoder().decode(b);
export const exists = (p: string) => fs.access(p).then(() => true, () => false);

export interface RunningServer { base: string; dataDir: string; stop: () => Promise<void>; }

// Spawn the server binary (or target SYNC_SERVER_URL) and resolve once it's listening.
export async function startServer(): Promise<RunningServer> {
  if (externalUrl) return { base: externalUrl, dataDir: "", stop: async () => {} };
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "nls-e2e-data-"));
  const srv = spawn(serverBin, [], {
    // ALLOW_WEAK_ADMIN=1: the throwaway test server deliberately uses admin/admin, so it must
    // opt past the SEC-2 default-credential boot guard (which refuses admin/admin otherwise).
    // ADMIN_BIND_ADDR=merge: keep the admin surface on the single ephemeral port (D0021 split
    // defaults to a separate admin port, which an ephemeral :0 public port can't derive sensibly).
    env: { ...process.env, DATA_ROOT: dataDir, BIND_ADDR: "127.0.0.1:0", SYNC_USER: "admin", SYNC_PASSWORD: "admin", ALLOW_WEAK_ADMIN: "1", ADMIN_BIND_ADDR: "merge" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not report a listening address in time")), 15000);
    const onData = (b: Buffer) => { const m = b.toString().match(/listening on (\S+)/); if (m) { clearTimeout(timer); resolve(`http://${m[1]}`); } };
    srv.stderr!.on("data", onData); srv.stdout!.on("data", onData);
  });
  return {
    base, dataDir,
    // Wait for the process to actually EXIT before removing dataDir: the server holds the per-vault
    // SQLite DB (+ WAL/SHM) open for its lifetime, so on Windows those files stay locked until the OS
    // reaps the killed process — an immediate rm would hit EPERM. Kill, await exit (with a timeout
    // fallback so the suite never hangs), then remove with retries as a backstop for handle-release lag.
    stop: async () => {
      await new Promise<void>((resolve) => {
        if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
        srv.once("exit", () => resolve());
        const t = setTimeout(resolve, 5000);
        if (typeof t.unref === "function") t.unref();
        try { srv.kill(); } catch { resolve(); /* already gone */ }
      });
      if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ } }
    },
  };
}

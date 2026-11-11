// E4 helpers for the real-server E2EE spec: a Node transport that speaks the E2EE wire (the header, GET
// keyring, the keyring create, the owner delete), a client whose reconcile runs over an E2eeCodec, a data
// volume grep, a tree snapshot for byte-identity, a counting wrapper for the dedup clause, a substituting
// wrapper for the cross-path clause, and a server spawn on a GIVEN data dir for the corrupt-index clause.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SyncApi } from "../src/sync";
import { ChangesResponse, CommitRequest, FileMeta } from "../src/protocol";
import { BaseStore } from "../src/base";
import { ReconcileDeps } from "../src/reconcile";
import { ContentCodec } from "../src/e2ee/codec";
import { serverBin, FsVaultIo, Client, dep, RunningServer } from "./e2e-helpers";

export const E2EE_SCOPE = (vault: string, owner = "") =>
  owner ? `/api/u/${encodeURIComponent(owner)}/${encodeURIComponent(vault)}` : `/api/v/${encodeURIComponent(vault)}`;

/** The plugin's wire for an encrypted vault: x-selfsync-e2ee: 1 on every vault-scoped request when `e2ee`. */
export class E2eeNodeTransport implements SyncApi {
  constructor(private base: string, private token: string, private vault: string, private owner = "", private e2ee = true) {}
  static async createVault(base: string, token: string, name: string, keyring?: string): Promise<void> {
    const r = await fetch(`${base}/api/vaults`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(keyring ? { name, keyring } : { name }),
    });
    if (!r.ok) throw new Error(`createVault ${r.status}`);
  }
  static async keyring(base: string, token: string, name: string, owner = ""): Promise<{ status: number; text: string }> {
    const r = await fetch(`${base}${E2EE_SCOPE(name, owner)}/keyring`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, text: await r.text() };
  }
  static async deleteVault(base: string, token: string, name: string): Promise<void> {
    const r = await fetch(`${base}/api/vault`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ vault: name }),
    });
    if (!r.ok) throw new Error(`deleteVault ${r.status}`);
  }
  private h(): Record<string, string> { return this.e2ee ? { authorization: `Bearer ${this.token}`, "x-selfsync-e2ee": "1" } : { authorization: `Bearer ${this.token}` }; }
  private v(suffix: string) { return `${this.base}${E2EE_SCOPE(this.vault, this.owner)}${suffix}`; }
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
    const r = await fetch(this.v("/chunks/missing"), { method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify({ hashes }) });
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
    if (!r.ok) throw new Error(`putChunk ${r.status}: ${await r.text()}`);
  }
  async commit(req: CommitRequest): Promise<FileMeta> {
    const r = await fetch(this.v("/commit"), { method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify(req) });
    if (!r.ok) throw new Error(`commit ${r.status}: ${await r.text()}`);
    return (await r.json()) as FileMeta;
  }
  async deleteFile(p: string): Promise<void> {
    const r = await fetch(this.v(`/file?path=${encodeURIComponent(p)}`), { method: "DELETE", headers: this.h() });
    if (!r.ok && r.status !== 404) throw new Error(`delete ${r.status}`);
  }
}

/** Counts chunk uploads (the dedup clause: a second upload of unchanged bytes uploads nothing). */
export class CountingApi implements SyncApi {
  puts = 0;
  constructor(private inner: SyncApi) {}
  changes(s: number) { return this.inner.changes(s); }
  fileMeta(p: string) { return this.inner.fileMeta(p); }
  missing(h: string[]) { return this.inner.missing(h); }
  getChunk(h: string) { return this.inner.getChunk(h); }
  async putChunk(h: string, b: Uint8Array) { this.puts++; return this.inner.putChunk(h, b); }
  commit(r: CommitRequest) { return this.inner.commit(r); }
  deleteFile(p: string) { return this.inner.deleteFile(p); }
}

/** Serves `from`'s committed row under the path `to` (the cross-path substitution clause). */
export class SubstitutingApi implements SyncApi {
  constructor(private inner: SyncApi, private from: string, private to: string) {}
  async changes(s: number): Promise<ChangesResponse> {
    const r = await this.inner.changes(s);
    const src = r.upserts.find((u) => u.path === this.from);
    if (!src) return r;
    return { ...r, upserts: r.upserts.filter((u) => u.path !== this.to).concat([{ ...src, path: this.to }]) };
  }
  async fileMeta(p: string): Promise<FileMeta | null> {
    if (p === this.to) { const src = await this.inner.fileMeta(this.from); return src ? { ...src, path: this.to } : null; }
    return this.inner.fileMeta(p);
  }
  missing(h: string[]) { return this.inner.missing(h); }
  getChunk(h: string) { return this.inner.getChunk(h); }
  putChunk(h: string, b: Uint8Array) { return this.inner.putChunk(h, b); }
  commit(r: CommitRequest) { return this.inner.commit(r); }
  deleteFile(p: string) { return this.inner.deleteFile(p); }
}

export type E2eeClient = Client & { codec?: ContentCodec };
export function mkE2eeClient(root: string, api: SyncApi, codec: ContentCodec | undefined, device: string): E2eeClient {
  return { io: new FsVaultIo(root), api: api as any, state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device, root, codec };
}
/** The reconcile deps of an encrypted client: the plugin's dep() plus the codec (D0104). */
export function edep(c: E2eeClient): ReconcileDeps { return { ...dep(c), codec: c.codec }; }

/** Every file under `dir` whose bytes hold `needle` (chunks, mirror files, the SQLite index, the sidecars alike). */
export async function grepTree(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const n = Buffer.from(needle);
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if ((await fs.readFile(full)).includes(n)) hits.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  await walk(dir);
  return hits.sort();
}

/** path -> hex bytes of every file under `dir` (byte-identity before and after). */
export async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else m.set(path.relative(dir, full).split(path.sep).join("/"), (await fs.readFile(full)).toString("hex"));
    }
  };
  await walk(dir);
  return m;
}

export interface RunningServerKeep extends RunningServer { stopKeepData: () => Promise<void> }

/** Spawn the server binary on a GIVEN data dir (a fresh temp dir when omitted); the corrupt-index clause restarts on the same dir. */
export async function startServerAt(dataDir = mkdtempSync(path.join(os.tmpdir(), "nls-e2ee-data-"))): Promise<RunningServerKeep> {
  const srv = spawn(serverBin, [], {
    env: { ...process.env, DATA_ROOT: dataDir, BIND_ADDR: "127.0.0.1:0", SYNC_USER: "admin", SYNC_PASSWORD: "admin", ALLOW_WEAK_ADMIN: "1", ADMIN_BIND_ADDR: "merge", LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not report a listening address in time")), 30000);
    const onData = (b: Buffer) => { const m = b.toString().match(/listening on (\S+)/); if (m) { clearTimeout(timer); resolve(`http://${m[1]}`); } };
    srv.stderr!.on("data", onData); srv.stdout!.on("data", onData);
  });
  const exit = () => new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
    srv.once("exit", () => resolve());
    const t = setTimeout(resolve, 5000); if (typeof t.unref === "function") t.unref();
    try { srv.kill(); } catch { resolve(); }
  });
  return {
    base, dataDir,
    stopKeepData: exit,
    stop: async () => { await exit(); try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch { /* best-effort */ } },
  };
}

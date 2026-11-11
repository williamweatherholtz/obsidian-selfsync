// E4 helpers for the real-server E2EE spec: the plugin's E2EE wire on the shared Node transport (the header,
// GET keyring, the keyring create, the owner delete), a client whose reconcile runs over an E2eeCodec, a
// data volume grep, a tree snapshot for byte-identity, and a counting wrapper for the dedup clause.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SyncApi } from "../src/sync";
import { CommitRequest, FileMeta } from "../src/protocol";
import { BaseStore } from "../src/base";
import { ReconcileDeps } from "../src/reconcile";
import { ContentCodec } from "../src/e2ee/codec";
import { NodeTransport, FsVaultIo, Client, dep } from "./e2e-helpers";

export const E2EE_SCOPE = (vault: string, owner = "") =>
  owner ? `/api/u/${encodeURIComponent(owner)}/${encodeURIComponent(vault)}` : `/api/v/${encodeURIComponent(vault)}`;

/** The shared Node transport plus the plugin's E2EE wire: x-selfsync-e2ee: 1 on every vault-scoped request when `e2ee`. */
export class E2eeNodeTransport extends NodeTransport {
  constructor(base: string, token: string, vault: string, owner = "", private e2ee = true) { super(base, token, vault, owner); }
  /** The server restarted on another port (the corrupt-index clause): point this transport at it. */
  rebase(base: string): void { this.base = base; }
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
  protected h(): Record<string, string> { return this.e2ee ? { ...super.h(), "x-selfsync-e2ee": "1" } : super.h(); }
  // The two writes carry the server's body in the error: a 422 names the cause (spec section 4.6).
  async putChunk(hash: string, bytes: Uint8Array): Promise<void> {
    const r = await fetch(this.v(`/chunk/${hash}`), { method: "PUT", headers: this.h(), body: new Blob([bytes as BlobPart]) });
    if (!r.ok) throw new Error(`putChunk ${r.status}: ${await r.text()}`);
  }
  async commit(req: CommitRequest): Promise<FileMeta> {
    const r = await fetch(this.v("/commit"), { method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify(req) });
    if (!r.ok) throw new Error(`commit ${r.status}: ${await r.text()}`);
    return (await r.json()) as FileMeta;
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

export type E2eeClient = Client & { codec?: ContentCodec };
export function mkE2eeClient(root: string, api: SyncApi, codec: ContentCodec | undefined, device: string): E2eeClient {
  return { io: new FsVaultIo(root), api: api as NodeTransport, state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device, root, codec };
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

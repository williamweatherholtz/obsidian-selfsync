import { requestUrl } from "obsidian";
import { ChangesResponse, CommitRequest, FileMeta } from "./protocol";
import { SyncApi } from "./sync";

// HTTP via Obsidian's `requestUrl` (bypasses the renderer CSP that breaks fetch).
// Sync ops are vault-scoped (/api/v/{vault}/…); account ops are static.
export class HttpTransport implements SyncApi {
  constructor(private baseUrl: string, private token: string, private vault: string) {}

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    const r = await requestUrl({
      url: `${baseUrl}/api/login`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password }), throw: false,
    });
    if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
    return (r.json as { token: string }).token;
  }

  static async register(baseUrl: string, username: string, password: string, invite = ""): Promise<void> {
    const r = await requestUrl({
      url: `${baseUrl}/api/register`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password, invite }), throw: false,
    });
    if (r.status !== 200) throw new Error(`register failed: HTTP ${r.status}`);
  }

  static async listVaults(baseUrl: string, token: string): Promise<string[]> {
    const r = await requestUrl({ url: `${baseUrl}/api/vaults`, method: "GET", headers: { authorization: `Bearer ${token}` }, throw: false });
    if (r.status !== 200) throw new Error(`vaults: HTTP ${r.status}`);
    return (r.json as { vaults: string[] }).vaults;
  }

  static async createVault(baseUrl: string, token: string, name: string): Promise<void> {
    const r = await requestUrl({
      url: `${baseUrl}/api/vaults`, method: "POST", contentType: "application/json",
      headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name }), throw: false,
    });
    if (r.status !== 200) throw new Error(`create vault: HTTP ${r.status}`);
  }

  private auth() { return { authorization: `Bearer ${this.token}` }; }
  private v(suffix: string): string { return `${this.baseUrl}/api/v/${encodeURIComponent(this.vault)}${suffix}`; }
  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async changes(since: number): Promise<ChangesResponse> {
    const r = await requestUrl({ url: this.v(`/changes?since=${since}`), method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`changes: HTTP ${r.status}`);
    return r.json as ChangesResponse;
  }
  async missing(hashes: string[]): Promise<string[]> {
    const r = await requestUrl({
      url: this.v("/chunks/missing"), method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify({ hashes }), throw: false,
    });
    if (r.status !== 200) throw new Error(`missing: HTTP ${r.status}`);
    return (r.json as { missing: string[] }).missing;
  }
  async getChunk(hash: string): Promise<Uint8Array> {
    const r = await requestUrl({ url: this.v(`/chunk/${hash}`), method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`getChunk: HTTP ${r.status}`);
    return new Uint8Array(r.arrayBuffer);
  }
  async putChunk(hash: string, bytes: Uint8Array): Promise<void> {
    const r = await requestUrl({ url: this.v(`/chunk/${hash}`), method: "PUT", headers: this.auth(), body: this.toArrayBuffer(bytes), throw: false });
    if (r.status !== 200) throw new Error(`putChunk: HTTP ${r.status}`);
  }
  async commit(req: CommitRequest): Promise<FileMeta> {
    const r = await requestUrl({
      url: this.v("/commit"), method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify(req), throw: false,
    });
    if (r.status !== 200) throw new Error(`commit: HTTP ${r.status}`);
    return r.json as FileMeta;
  }
  async deleteFile(path: string): Promise<void> {
    const r = await requestUrl({ url: this.v(`/file?path=${encodeURIComponent(path)}`), method: "DELETE", headers: this.auth(), throw: false });
    if (r.status !== 200 && r.status !== 404) throw new Error(`deleteFile: HTTP ${r.status}`);
  }

  connectWs(onChanged: () => void): WebSocket | null {
    try {
      const ws = new WebSocket(this.baseUrl.replace(/^http/, "ws") + `/api/ws?token=${this.token}&vault=${encodeURIComponent(this.vault)}`);
      ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === "changed") onChanged(); } catch {} };
      return ws;
    } catch {
      return null;
    }
  }
}

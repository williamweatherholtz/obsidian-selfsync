import { requestUrl } from "obsidian";
import { ChangesResponse, CommitRequest, FileMeta } from "./protocol";
import { SyncApi } from "./sync";

// HTTP via Obsidian's `requestUrl` (runs in Electron's main process / native on
// mobile) instead of the renderer's global `fetch`. The renderer's fetch is
// subject to Obsidian's CSP and fails cross-origin with "Failed to fetch";
// requestUrl bypasses that and works the same on desktop and mobile.
// Chunks move as raw bytes (ArrayBuffer); everything else is JSON.
export class HttpTransport implements SyncApi {
  constructor(private baseUrl: string, private token: string) {}

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    const r = await requestUrl({
      url: `${baseUrl}/api/login`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password }), throw: false,
    });
    if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
    return (r.json as { token: string }).token;
  }

  private auth() { return { authorization: `Bearer ${this.token}` }; }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async changes(since: number): Promise<ChangesResponse> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/changes?since=${since}`, method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`changes: HTTP ${r.status}`);
    return r.json as ChangesResponse;
  }

  async missing(hashes: string[]): Promise<string[]> {
    const r = await requestUrl({
      url: `${this.baseUrl}/api/vault/chunks/missing`, method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify({ hashes }), throw: false,
    });
    if (r.status !== 200) throw new Error(`missing: HTTP ${r.status}`);
    return (r.json as { missing: string[] }).missing;
  }

  async getChunk(hash: string): Promise<Uint8Array> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/chunk/${hash}`, method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`getChunk: HTTP ${r.status}`);
    return new Uint8Array(r.arrayBuffer);
  }

  async putChunk(hash: string, bytes: Uint8Array): Promise<void> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/chunk/${hash}`, method: "PUT", headers: this.auth(), body: this.toArrayBuffer(bytes), throw: false });
    if (r.status !== 200) throw new Error(`putChunk: HTTP ${r.status}`);
  }

  async commit(req: CommitRequest): Promise<FileMeta> {
    const r = await requestUrl({
      url: `${this.baseUrl}/api/vault/commit`, method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify(req), throw: false,
    });
    if (r.status !== 200) throw new Error(`commit: HTTP ${r.status}`);
    return r.json as FileMeta;
  }

  async deleteFile(path: string): Promise<void> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`, method: "DELETE", headers: this.auth(), throw: false });
    if (r.status !== 200 && r.status !== 404) throw new Error(`deleteFile: HTTP ${r.status}`);
  }

  // Best-effort real-time channel. The renderer WebSocket may be blocked by the
  // same CSP that blocks fetch; if so, the plugin's polling loop still propagates
  // changes (just not instantly). Returns null if construction throws.
  connectWs(onChanged: () => void): WebSocket | null {
    try {
      const ws = new WebSocket(this.baseUrl.replace(/^http/, "ws") + `/api/ws?token=${this.token}`);
      ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === "changed") onChanged(); } catch {} };
      return ws;
    } catch {
      return null;
    }
  }
}

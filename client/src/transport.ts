import { requestUrl } from "obsidian";
import { ChangesResponse, FileMeta } from "./protocol";
import { SyncApi } from "./sync";

// HTTP via Obsidian's `requestUrl` (runs in Electron's main process / native on
// mobile) instead of the renderer's global `fetch`. The renderer's fetch is
// subject to Obsidian's CSP and fails cross-origin with "Failed to fetch";
// requestUrl bypasses that and works the same on desktop and mobile.
export class HttpTransport implements SyncApi {
  constructor(private baseUrl: string, private token: string) {}

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    const r = await requestUrl({
      url: `${baseUrl}/api/login`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ username, password }),
      throw: false,
    });
    if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
    return (r.json as { token: string }).token;
  }

  private auth() { return { authorization: `Bearer ${this.token}` }; }

  async changes(since: number): Promise<ChangesResponse> {
    const r = await requestUrl({
      url: `${this.baseUrl}/api/vault/changes?since=${since}`,
      method: "GET", headers: this.auth(), throw: false,
    });
    if (r.status !== 200) throw new Error(`changes: HTTP ${r.status}`);
    return r.json as ChangesResponse;
  }

  async getFile(path: string): Promise<string> {
    const r = await requestUrl({
      url: `${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`,
      method: "GET", headers: this.auth(), throw: false,
    });
    if (r.status !== 200) throw new Error(`getFile: HTTP ${r.status}`);
    return r.text;
  }

  async putFile(path: string, data: string, mtime: number): Promise<FileMeta> {
    const r = await requestUrl({
      url: `${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`,
      method: "PUT", headers: { ...this.auth(), "X-Mtime": String(mtime) },
      body: data, throw: false,
    });
    if (r.status !== 200) throw new Error(`putFile: HTTP ${r.status}`);
    return r.json as FileMeta;
  }

  async deleteFile(path: string): Promise<void> {
    const r = await requestUrl({
      url: `${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`,
      method: "DELETE", headers: this.auth(), throw: false,
    });
    if (r.status !== 200 && r.status !== 404) throw new Error(`deleteFile: HTTP ${r.status}`);
  }

  // Best-effort real-time channel. The renderer WebSocket may be blocked by the
  // same CSP that blocks fetch; if so, the plugin's polling loop still propagates
  // changes (just not instantly). Returns null if construction throws.
  connectWs(onChanged: () => void): WebSocket | null {
    try {
      const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/api/ws?token=${this.token}`;
      const ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === "changed") onChanged(); } catch {} };
      return ws;
    } catch {
      return null;
    }
  }
}

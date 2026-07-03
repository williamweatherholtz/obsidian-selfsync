import { ChangesResponse, FileMeta } from "./protocol";
import { SyncApi } from "./sync";

export class HttpTransport implements SyncApi {
  constructor(private baseUrl: string, private token: string) {}

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    const r = await fetch(`${baseUrl}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) throw new Error(`login failed: ${r.status}`);
    return (await r.json()).token as string;
  }

  private auth() { return { authorization: `Bearer ${this.token}` }; }

  // NOTE: uses global fetch (desktop). A future mobile task should fall back to
  // Obsidian's `requestUrl` (bypasses CORS on mobile where fetch is restricted).
  async changes(since: number): Promise<ChangesResponse> {
    const r = await fetch(`${this.baseUrl}/api/vault/changes?since=${since}`, { headers: this.auth() });
    if (!r.ok) throw new Error(`changes: ${r.status}`);
    return await r.json();
  }
  async getFile(path: string): Promise<string> {
    const r = await fetch(`${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`, { headers: this.auth() });
    if (!r.ok) throw new Error(`getFile: ${r.status}`);
    return await r.text();
  }
  async putFile(path: string, data: string, mtime: number): Promise<FileMeta> {
    const r = await fetch(`${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`, {
      method: "PUT", headers: { ...this.auth(), "X-Mtime": String(mtime) }, body: data,
    });
    if (!r.ok) throw new Error(`putFile: ${r.status}`);
    return await r.json();
  }
  async deleteFile(path: string): Promise<void> {
    const r = await fetch(`${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`, {
      method: "DELETE", headers: this.auth(),
    });
    if (!r.ok && r.status !== 404) throw new Error(`deleteFile: ${r.status}`);
  }

  connectWs(onChanged: () => void): WebSocket {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/api/ws?token=${this.token}`;
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === "changed") onChanged(); } catch {} };
    return ws;
  }
}

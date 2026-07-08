import { requestUrl, RequestUrlResponse, RequestUrlParam } from "obsidian";
import { ChangesResponse, CommitConflictError, CommitRequest, FileMeta, StatusResponse, validateChanges, validateFileMeta, validateStatus } from "./protocol";
import { SyncApi } from "./sync";

// R11-HIGH: Obsidian's requestUrl has NO timeout, so a half-open/stalled connection (VPN drop,
// captive portal, dead NAT entry) hangs forever — and since the sync engine is serial, one hung
// request wedges ALL sync with no error and no recovery (the offline/backoff machinery only fires
// on a REJECTION). Race every request against a timeout so a stall becomes a normal rejection the
// engine already handles → offline → backoff → reconnect. (Can't abort the underlying request; the
// leaked promise just settles unobserved.)
const REQUEST_TIMEOUT_MS = 30_000;
function httpReq(params: RequestUrlParam): Promise<RequestUrlResponse> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("request timed out (no response) — treating as offline")), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([requestUrl(params), timeout]).finally(() => clearTimeout(timer)) as Promise<RequestUrlResponse>;
}

// A vault shared WITH the current account (owned by someone else on the server).
export type SharedVaultRef = { owner: string; vault: string; perm: "read" | "readWrite" };

// HTTP via Obsidian's `requestUrl` (bypasses the renderer CSP that breaks fetch).
// Sync ops are vault-scoped: your own vault → /api/v/{vault}/…; a vault shared by
// someone else → /api/u/{owner}/{vault}/… (owner given). Account ops are static.
export class HttpTransport implements SyncApi {
  // `owner` empty ⇒ your own vault (legacy /api/v route); set ⇒ a shared vault.
  constructor(private baseUrl: string, private token: string, private vault: string, private owner = "") {}

  // Lightweight reachability probe for the setup wizard's "Test connection" button.
  // Hits the unauthenticated /health endpoint; true iff the server answers 200 "ok".
  static async testConnection(baseUrl: string): Promise<boolean> {
    try {
      const r = await httpReq({ url: `${baseUrl.replace(/\/+$/, "")}/health`, method: "GET", throw: false });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    const r = await httpReq({
      url: `${baseUrl}/api/login`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password }), throw: false,
    });
    if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
    return (r.json as { token: string }).token;
  }

  static async register(baseUrl: string, username: string, password: string, invite = ""): Promise<void> {
    const r = await httpReq({
      url: `${baseUrl}/api/register`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password, invite }), throw: false,
    });
    if (r.status !== 200) throw new Error(`register failed: HTTP ${r.status}`);
  }

  static async listVaults(baseUrl: string, token: string): Promise<string[]> {
    const r = await httpReq({ url: `${baseUrl}/api/vaults`, method: "GET", headers: { authorization: `Bearer ${token}` }, throw: false });
    if (r.status !== 200) throw new Error(`vaults: HTTP ${r.status}`);
    return (r.json as { vaults: string[] }).vaults;
  }

  static async createVault(baseUrl: string, token: string, name: string): Promise<void> {
    const r = await httpReq({
      url: `${baseUrl}/api/vaults`, method: "POST", contentType: "application/json",
      headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name }), throw: false,
    });
    if (r.status !== 200) throw new Error(`create vault: HTTP ${r.status}`);
  }

  // Vaults shared WITH this account (owned by others) — the complement of listVaults.
  static async listShared(baseUrl: string, token: string): Promise<SharedVaultRef[]> {
    const r = await httpReq({ url: `${baseUrl}/api/shared`, method: "GET", headers: { authorization: `Bearer ${token}` }, throw: false });
    if (r.status !== 200) throw new Error(`shared: HTTP ${r.status}`);
    return r.json as SharedVaultRef[];
  }

  private auth() { return { authorization: `Bearer ${this.token}` }; }
  private v(suffix: string): string {
    const scope = this.owner
      ? `/api/u/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.vault)}`
      : `/api/v/${encodeURIComponent(this.vault)}`;
    return `${this.baseUrl}${scope}${suffix}`;
  }
  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  // Per-vault health. "error" means the server's index is corrupt and every sync op
  // will 503 until an operator reindexes — checked before reconciling so we surface a
  // clear reason rather than a bare "HTTP 503", and never act on a degraded manifest.
  async status(): Promise<StatusResponse> {
    const r = await httpReq({ url: this.v("/status"), method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`status: HTTP ${r.status}`);
    return validateStatus(r.json); // validates shape + maps snake_case api_version → apiVersion
  }

  async changes(since: number): Promise<ChangesResponse> {
    const r = await httpReq({ url: this.v(`/changes?since=${since}`), method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`changes: HTTP ${r.status}`);
    return validateChanges(r.json);
  }
  async fileMeta(path: string): Promise<FileMeta | null> {
    const r = await httpReq({ url: this.v(`/meta?path=${encodeURIComponent(path)}`), method: "GET", headers: this.auth(), throw: false });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`meta: HTTP ${r.status}`);
    return validateFileMeta(r.json);
  }
  async missing(hashes: string[]): Promise<string[]> {
    const r = await httpReq({
      url: this.v("/chunks/missing"), method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify({ hashes }), throw: false,
    });
    if (r.status !== 200) throw new Error(`missing: HTTP ${r.status}`);
    const m = (r.json as { missing?: unknown }).missing;
    if (!Array.isArray(m) || m.some((h) => typeof h !== "string")) throw new Error("missing: malformed response");
    return m as string[];
  }
  async getChunk(hash: string): Promise<Uint8Array> {
    const r = await httpReq({ url: this.v(`/chunk/${hash}`), method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`getChunk: HTTP ${r.status}`);
    return new Uint8Array(r.arrayBuffer);
  }
  async putChunk(hash: string, bytes: Uint8Array): Promise<void> {
    const r = await httpReq({ url: this.v(`/chunk/${hash}`), method: "PUT", headers: this.auth(), body: this.toArrayBuffer(bytes), throw: false });
    if (r.status !== 200) throw new Error(`putChunk: HTTP ${r.status}`);
  }
  async commit(req: CommitRequest): Promise<FileMeta> {
    // Wire the optional CAS base version as snake_case `expected_version` (omitted when unset,
    // so an authoritative overwrite carries no precondition and older servers ignore it).
    const body: Record<string, unknown> = {
      path: req.path, hash: req.hash, size: req.size, mtime: req.mtime, chunks: req.chunks,
    };
    if (req.expectedVersion !== undefined) body.expected_version = req.expectedVersion;
    const r = await httpReq({
      url: this.v("/commit"), method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify(body), throw: false,
    });
    // 409 = optimistic-concurrency conflict: the server advanced past our base. Signal it
    // distinctly so reconcile converges via merge on the next pass instead of clobbering.
    if (r.status === 409) throw new CommitConflictError(`commit conflict on '${req.path}' (server version advanced)`);
    // 404 = a referenced chunk was reclaimed (orphan-swept) between missing() and commit — the
    // dedup optimization thought it was present. Signal it as an isolatable/retryable condition (like
    // a CAS conflict) so the event path doesn't flap OFFLINE on a routine re-upload: the next
    // reconcile's pushFile recomputes missing() and re-uploads the gap, then commits. (R11-#4)
    if (r.status === 404) throw new CommitConflictError(`commit for '${req.path}' referenced a missing chunk (will re-upload)`);
    if (r.status !== 200) throw new Error(`commit: HTTP ${r.status}`);
    return validateFileMeta(r.json);
  }
  async deleteFile(path: string): Promise<void> {
    const r = await httpReq({ url: this.v(`/file?path=${encodeURIComponent(path)}`), method: "DELETE", headers: this.auth(), throw: false });
    if (r.status !== 200 && r.status !== 404) throw new Error(`deleteFile: HTTP ${r.status}`);
  }

  connectWs(onChanged: () => void): WebSocket | null {
    try {
      const ownerParam = this.owner ? `&owner=${encodeURIComponent(this.owner)}` : "";
      const url = this.baseUrl.replace(/^http/, "ws") + `/api/ws?vault=${encodeURIComponent(this.vault)}${ownerParam}`;
      // Pass the session token via the Sec-WebSocket-Protocol header (the WebSocket API's only
      // client-settable header) rather than the URL, so it never lands in server/proxy logs or
      // history. The server reads the `auth.<token>` entry and echoes back "selfsync.v1". (SEC-1)
      const ws = new WebSocket(url, ["selfsync.v1", `auth.${this.token}`]);
      ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === "changed") onChanged(); } catch {} };
      return ws;
    } catch {
      return null;
    }
  }
}

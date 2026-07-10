import { requestUrl, RequestUrlResponse, RequestUrlParam } from "obsidian";
import { ChangesResponse, CLIENT_API_VERSION, CommitConflictError, CommitRequest, FileMeta, StatusResponse, validateChanges, validateFileMeta, validateStatus } from "./protocol";
import { SyncApi } from "./sync";
import { isInsecureRemote } from "./connstr";

// A layered connection diagnosis: which link in the chain is broken, so the user gets an actionable
// reason instead of a silent "offline". Addresses the #1 sync-support complaint — failures that don't
// announce their cause. `layer` names the FIRST failing hop, checked in order.
export type DiagnosisLayer = "unreachable" | "version" | "auth" | "vault" | "degraded" | "ok";
export interface Diagnosis { ok: boolean; layer: DiagnosisLayer; detail: string }

// R11-HIGH: Obsidian's requestUrl has NO timeout, so a half-open/stalled connection (VPN drop,
// captive portal, dead NAT entry) hangs forever — and since the sync engine is serial, one hung
// request wedges ALL sync with no error and no recovery (the offline/backoff machinery only fires
// on a REJECTION). Race every request against a timeout so a stall becomes a normal rejection the
// engine already handles → offline → backoff → reconnect. (Can't abort the underlying request; the
// leaked promise just settles unobserved.)
const REQUEST_TIMEOUT_MS = 30_000;
function httpReq(params: RequestUrlParam): Promise<RequestUrlResponse> {
  // SC.3.13.8 (crit-round): CENTRALIZED cleartext-remote refusal. Every request — sync ops AND the
  // token-bearing account-management static calls (listVaults/createVault/changePassword/shares/…) —
  // goes through here, so none can transmit a bearer token or password over http:// to a remote host.
  // The per-call-site guards (constructor, login, register) stay for clearer early errors; this is the
  // backstop that makes the "whole channel" guarantee actually whole. Loopback http stays allowed.
  if (isInsecureRemote(params.url)) {
    return Promise.reject(new Error("Refusing to send a request over an unencrypted http:// connection to a remote server — use an https:// address."));
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("request timed out (no response) — treating as offline")), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([requestUrl(params), timeout]).finally(() => clearTimeout(timer)) as Promise<RequestUrlResponse>;
}

// A vault shared WITH the current account (owned by someone else on the server).
export type SharePerm = "read" | "readWrite";
export type SharedVaultRef = { owner: string; vault: string; perm: SharePerm };
// One of the caller's OWN vaults + who it's shared with (owner-scoped share management, sec#4).
export type VaultShares = { vault: string; grants: { grantee: string; perm: SharePerm }[] };

// HTTP via Obsidian's `requestUrl` (bypasses the renderer CSP that breaks fetch).
// Sync ops are vault-scoped: your own vault → /api/v/{vault}/…; a vault shared by
// someone else → /api/u/{owner}/{vault}/… (owner given). Account ops are static.
export class HttpTransport implements SyncApi {
  // `owner` empty ⇒ your own vault (legacy /api/v route); set ⇒ a shared vault.
  constructor(private baseUrl: string, private token: string, private vault: string, private owner = "") {
    // SEC-CMMC (SC.3.13.8, defense-in-depth): refuse the WHOLE data channel over cleartext http:// to a
    // remote host, not just login/register. Login already blocks establishing such a session, so this
    // only fires if a cleartext-remote baseUrl were somehow persisted — then every sync op refuses too,
    // rather than transmitting the bearer token + note content in the clear. Loopback http is allowed.
    if (isInsecureRemote(baseUrl)) {
      throw new Error("Refusing to sync over an unencrypted http:// connection to a remote server — use an https:// address.");
    }
  }

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

  // AC.3.1.9: the server's pre-auth system-use/consent banner (empty if none). The setup wizard shows
  // this before the user signs in. Best-effort; returns "" on any error.
  static async fetchBanner(baseUrl: string): Promise<string> {
    try {
      const r = await httpReq({ url: `${baseUrl.replace(/\/+$/, "")}/health`, method: "GET", throw: false });
      const b = (r.json as { banner?: unknown })?.banner;
      return typeof b === "string" ? b : "";
    } catch {
      return "";
    }
  }

  // Diagnose the connection layer-by-layer and return the FIRST thing that's wrong, with an
  // actionable message. Never throws — a diagnosis is exactly what you want when things are broken.
  // Checks: reachable (DNS/TLS/server) → protocol version → session auth → vault present → not degraded.
  static async diagnose(baseUrl: string, token?: string, vault?: string, owner?: string): Promise<Diagnosis> {
    const url = baseUrl.replace(/\/+$/, "");
    // 1) Reachable? /health is unauthenticated.
    let health: RequestUrlResponse;
    try {
      health = await httpReq({ url: `${url}/health`, method: "GET", throw: false });
    } catch {
      return { ok: false, layer: "unreachable", detail: "Can't reach the server. Check the URL, that it's running, and TLS/DNS. On a phone, use the server's https address, not localhost." };
    }
    if (health.status !== 200) {
      return { ok: false, layer: "unreachable", detail: `The server answered HTTP ${health.status} on /health — it may be starting up or misconfigured behind the reverse proxy.` };
    }
    // 2) Protocol version match?
    const serverVersion = (health.json as { apiVersion?: unknown })?.apiVersion;
    if (typeof serverVersion === "number" && serverVersion !== CLIENT_API_VERSION) {
      return { ok: false, layer: "version", detail: `Version mismatch: the server speaks protocol v${serverVersion}, this plugin speaks v${CLIENT_API_VERSION}. Update whichever is older so both match.` };
    }
    // 3) Session valid? Needs a token + a vault to probe an authenticated endpoint.
    if (!token) return { ok: false, layer: "auth", detail: "Reachable, but you're not signed in on this device. Open setup and sign in." };
    if (!vault) return { ok: true, layer: "ok", detail: "Server reachable and the protocol matches. No vault selected yet." };
    const scope = owner ? `/api/u/${encodeURIComponent(owner)}/${encodeURIComponent(vault)}` : `/api/v/${encodeURIComponent(vault)}`;
    let st: RequestUrlResponse;
    try {
      st = await httpReq({ url: `${url}${scope}/status`, method: "GET", headers: { authorization: `Bearer ${token}` }, throw: false });
    } catch {
      return { ok: false, layer: "unreachable", detail: "Reached /health but the sync endpoint timed out — a proxy may be dropping the connection." };
    }
    if (st.status === 401) return { ok: false, layer: "auth", detail: "Your saved session was rejected. Sign in again — your token may have expired or been revoked." };
    if (st.status === 404) return { ok: false, layer: "vault", detail: `The vault '${vault}'${owner ? ` owned by ${owner}` : ""} isn't on the server — it may have been deleted, or the share was revoked.` };
    if (st.status !== 200) return { ok: false, layer: "unreachable", detail: `The sync endpoint answered HTTP ${st.status}.` };
    // 4) Vault healthy (not a degraded/corrupt index)?
    const body = st.json as { status?: string };
    if (body?.status === "error") return { ok: false, layer: "degraded", detail: "The server's index for this vault needs repair — run a reindex from the admin page. Sync is paused so it won't act on a partial manifest." };
    return { ok: true, layer: "ok", detail: "All good: server reachable, protocol matches, signed in, and the vault is ready." };
  }

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    // SEC-AUTH: never send a password over plain http:// to a remote host — it (and the returned
    // bearer token, and everything after) would be interceptable. Refuse loudly; the fix is an
    // https:// URL (put the server behind a TLS reverse proxy). Loopback http is allowed (local dev).
    if (isInsecureRemote(baseUrl)) {
      throw new Error("Refusing to send your password over an unencrypted http:// connection to a remote server — anyone on the network could read it. Use an https:// address (put the server behind a TLS reverse proxy).");
    }
    const r = await httpReq({
      url: `${baseUrl}/api/login`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password }), throw: false,
    });
    if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
    return (r.json as { token: string }).token;
  }

  static async register(baseUrl: string, username: string, password: string, invite = ""): Promise<void> {
    if (isInsecureRemote(baseUrl)) {
      throw new Error("Refusing to send a new password over an unencrypted http:// connection to a remote server. Use an https:// address.");
    }
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

  // Self-service password change (R14 sec#2): verifies `current`, sets `newPassword`, REVOKES all
  // other sessions server-side, and returns a FRESH token for this device (the old token is now dead).
  static async changePassword(baseUrl: string, token: string, current: string, newPassword: string): Promise<string> {
    const r = await httpReq({
      url: `${baseUrl}/api/password`, method: "POST", contentType: "application/json",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ current, new_password: newPassword }), throw: false,
    });
    if (r.status === 401) throw new Error("current password is incorrect");
    if (r.status !== 200) throw new Error(`change password: HTTP ${r.status}`);
    return (r.json as { token: string }).token;
  }

  // Owner-scoped share management (R14 sec#4). Reachable on the public port now that the endpoints
  // are on the shared surface, so a user can manage THEIR OWN shares from the plugin (was admin-only).
  static async myVaults(baseUrl: string, token: string): Promise<VaultShares[]> {
    const r = await httpReq({ url: `${baseUrl}/api/admin/vaults`, method: "GET", headers: { authorization: `Bearer ${token}` }, throw: false });
    if (r.status !== 200) throw new Error(`my vaults: HTTP ${r.status}`);
    return r.json as VaultShares[];
  }
  static async shareCreate(baseUrl: string, token: string, vault: string, grantee: string, perm: SharePerm): Promise<void> {
    const r = await httpReq({
      url: `${baseUrl}/api/admin/shares`, method: "POST", contentType: "application/json",
      headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ vault, grantee, perm }), throw: false,
    });
    if (r.status !== 200) throw new Error((r.json as { error?: string })?.error ?? `share: HTTP ${r.status}`);
  }
  static async shareDelete(baseUrl: string, token: string, vault: string, grantee: string): Promise<void> {
    const r = await httpReq({
      url: `${baseUrl}/api/admin/shares`, method: "DELETE", contentType: "application/json",
      headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ vault, grantee }), throw: false,
    });
    if (r.status !== 200) throw new Error(`unshare: HTTP ${r.status}`);
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

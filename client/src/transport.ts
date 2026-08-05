import { requestUrl, RequestUrlResponse, RequestUrlParam } from "obsidian";
import { ChangesResponse, CLIENT_API_VERSION, CommitConflictError, CommitRequest, FileMeta, StatusResponse, validateChanges, validateFileMeta, validateStatus } from "./protocol";
import { SyncApi } from "./sync";
import { isInsecureRemote } from "./connstr";
import { ConnError, Endpoint } from "./connstate";

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
// A capability share-link's owner-facing metadata (never the token). `redeemed_by` = the account that
// consumed it (null while pending); `expires_at` = epoch secs (null if the owner opted out of expiry).
export type ShareLinkInfo = { id: string; vault: string; perm: SharePerm; label: string; expires_at: number | null; redeemed_by: string | null };

// Server error bodies are PLAIN TEXT (AppError renders as text, not JSON). RequestUrlResponse.json is
// a getter that JSON-parses .text and THROWS on non-JSON — so reading r.json on an error response
// surfaced a useless "…is not valid JSON" instead of the server's message ("invalid vault name", etc.).
// Read the raw .text instead, falling back to the status when the body is empty/huge.
function errText(r: RequestUrlResponse, fallback: string): string {
  const t = (r.text ?? "").trim();
  return t && t.length <= 300 ? t : fallback;
}

// RequestUrlResponse.json is a getter that JSON-parses .text and THROWS on a non-JSON body — and a
// reverse proxy / captive portal can answer 200 with an HTML error page. Read it defensively so a
// caller that must not throw on a bad body stays safe: returns undefined on an absent/invalid body.
function tryJson(r: RequestUrlResponse): unknown {
  try { return r.json; } catch { return undefined; }
}

// Parse the 429 Retry-After header (seconds). Obsidian lowercases response header keys, but accept both.
function retryAfterSecs(r: RequestUrlResponse): number | undefined {
  const h = (r.headers ?? {}) as Record<string, string>;
  const v = Number(h["retry-after"] ?? h["Retry-After"]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

// Mint a TYPED transport error at the throw site carrying the classifier's inputs (status / retry-after /
// which endpoint / was-it-a-login). The connection FSM reads these fields — never the message string,
// which the server body overwrites (a 401 arrives as "unauthorized", not "HTTP 401"). The message is still
// human-readable (errText) for logs.
function httpFail(r: RequestUrlResponse, tag: { endpoint: Endpoint; wasLogin?: boolean }, label: string): ConnError {
  return new ConnError(errText(r, `${label}: HTTP ${r.status}`), {
    status: r.status,
    retryAfterSecs: r.status === 429 ? retryAfterSecs(r) : undefined,
    wasLogin: !!tag.wasLogin,
    endpoint: tag.endpoint,
    bodyHint: (r.text ?? "").trim().slice(0, 300) || undefined,
  });
}

// Bearer auth header — was spelled out ~12x across the static account calls.
function bearer(token: string): Record<string, string> { return { authorization: `Bearer ${token}` }; }

// Strip trailing slashes so `${base}/api/…` never becomes `${base}//api/…`. Applied uniformly now —
// some endpoints normalized the base and others didn't, so a trailing-slash baseUrl behaved differently per call.
function normBase(url: string): string { return url.replace(/\/+$/, ""); }

// Shared request → 200-check → JSON parse for the many "200 ⇒ JSON" endpoints (the account + sync ops
// that had copy-pasted this shape with DRIFTING error surfacing — some threw the server's plain-text
// reason via errText, others a bare "HTTP n"). Uniformly surfaces errText on a non-200, and reads the
// body through tryJson (the .json getter throws on non-JSON). Endpoints with bespoke status semantics —
// fileMeta (404→null), commit (409/404), changePassword (401), deleteFile (404), the binary chunk ops —
// keep their own explicit handling and deliberately do NOT route through here.
async function apiJson<T>(params: RequestUrlParam, label: string, tag: { endpoint: Endpoint; wasLogin?: boolean } = { endpoint: Endpoint.Other }): Promise<T> {
  const r = await httpReq({ ...params, throw: false });
  if (r.status !== 200) throw httpFail(r, tag, label);
  return tryJson(r) as T;
}

// apiJson's contract for endpoints that return no body (just a 200-or-throw).
async function apiVoid(params: RequestUrlParam, label: string, tag: { endpoint: Endpoint; wasLogin?: boolean } = { endpoint: Endpoint.Other }): Promise<void> {
  const r = await httpReq({ ...params, throw: false });
  if (r.status !== 200) throw httpFail(r, tag, label);
}

// HTTP via Obsidian's `requestUrl` (bypasses the renderer CSP that breaks fetch).
// Sync ops are vault-scoped: your own vault → /api/v/{vault}/…; a vault shared by
// someone else → /api/u/{owner}/{vault}/… (owner given). Account ops are static.
export class HttpTransport implements SyncApi {
  // `owner` empty ⇒ your own vault (legacy /api/v route); set ⇒ a shared vault. `deviceId`/`deviceName`
  // are this device's change-provenance identity, stamped onto every commit (the server pairs them with
  // the authenticated user). Default "" ⇒ unattributed (older/injected transport in tests).
  constructor(private baseUrl: string, private token: string, private vault: string, private owner = "", private deviceId = "", private deviceName = "") {
    // SEC-CMMC (SC.3.13.8, defense-in-depth): refuse the WHOLE data channel over cleartext http:// to a
    // remote host, not just login/register. Login already blocks establishing such a session, so this
    // only fires if a cleartext-remote baseUrl were somehow persisted — then every sync op refuses too,
    // rather than transmitting the bearer token + note content in the clear. Loopback http is allowed.
    if (isInsecureRemote(baseUrl)) {
      throw new Error("Refusing to sync over an unencrypted http:// connection to a remote server — use an https:// address.");
    }
    this.baseUrl = normBase(this.baseUrl); // one consistent form for v() + connectWs (no `//api/…`)
  }

  // Lightweight reachability probe for the setup wizard's "Test connection" button.
  // Hits the unauthenticated /health endpoint; true iff the server answers 200 "ok".
  static async testConnection(baseUrl: string): Promise<boolean> {
    try {
      const r = await httpReq({ url: `${normBase(baseUrl)}/health`, method: "GET", throw: false });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  // AC.3.1.9: the server's pre-auth system-use/consent banner (empty if none). The setup wizard shows
  // this before the user signs in. Best-effort; returns "" on any error.
  static async fetchBanner(baseUrl: string): Promise<string> {
    try {
      const r = await httpReq({ url: `${normBase(baseUrl)}/health`, method: "GET", throw: false });
      const b = (tryJson(r) as { banner?: unknown } | undefined)?.banner;
      return typeof b === "string" ? b : "";
    } catch {
      return "";
    }
  }

  // Returns the session token AND whether the account must set a new password before use (IA.3.5.9 —
  // admin-created / reset accounts are gated: every route 403s until the password is changed). Callers
  // that see mustChange must run changePassword before any other authed call.
  static async login(baseUrl: string, username: string, password: string): Promise<{ token: string; mustChange: boolean }> {
    // SEC-AUTH: never send a password over plain http:// to a remote host — it (and the returned
    // bearer token, and everything after) would be interceptable. Refuse loudly; the fix is an
    // https:// URL (put the server behind a TLS reverse proxy). Loopback http is allowed (local dev).
    if (isInsecureRemote(baseUrl)) {
      throw new Error("Refusing to send your password over an unencrypted http:// connection to a remote server — anyone on the network could read it. Use an https:// address (put the server behind a TLS reverse proxy).");
    }
    const j = await apiJson<{ token: string; must_change_password?: boolean }>({
      url: `${normBase(baseUrl)}/api/login`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password }),
    }, "login", { endpoint: Endpoint.Login, wasLogin: true });
    return { token: j.token, mustChange: Boolean(j.must_change_password) };
  }

  static async register(baseUrl: string, username: string, password: string, invite = ""): Promise<void> {
    if (isInsecureRemote(baseUrl)) {
      throw new Error("Refusing to send a new password over an unencrypted http:// connection to a remote server. Use an https:// address.");
    }
    await apiVoid({
      url: `${normBase(baseUrl)}/api/register`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password, invite }),
    }, "register");
  }

  static async listVaults(baseUrl: string, token: string): Promise<string[]> {
    return (await apiJson<{ vaults: string[] }>({ url: `${normBase(baseUrl)}/api/vaults`, method: "GET", headers: bearer(token) }, "vaults")).vaults;
  }

  static async createVault(baseUrl: string, token: string, name: string): Promise<void> {
    await apiVoid({
      url: `${normBase(baseUrl)}/api/vaults`, method: "POST", contentType: "application/json",
      headers: bearer(token), body: JSON.stringify({ name }),
    }, "create vault");
  }

  // Vaults shared WITH this account (owned by others) — the complement of listVaults.
  static async listShared(baseUrl: string, token: string): Promise<SharedVaultRef[]> {
    return apiJson<SharedVaultRef[]>({ url: `${normBase(baseUrl)}/api/shared`, method: "GET", headers: bearer(token) }, "shared");
  }
  // Grantee leaves/declines a share — removes THIS account's own access to someone else's vault.
  static async leaveShare(baseUrl: string, token: string, owner: string, vault: string): Promise<void> {
    await apiVoid({
      url: `${normBase(baseUrl)}/api/shared`, method: "DELETE", contentType: "application/json",
      headers: bearer(token), body: JSON.stringify({ owner, vault }),
    }, "leave share");
  }

  // Self-service password change (R14 sec#2): verifies `current`, sets `newPassword`, REVOKES all
  // other sessions server-side, and returns a FRESH token for this device (the old token is now dead).
  static async changePassword(baseUrl: string, token: string, current: string, newPassword: string): Promise<string> {
    const r = await httpReq({
      url: `${normBase(baseUrl)}/api/password`, method: "POST", contentType: "application/json",
      headers: bearer(token),
      body: JSON.stringify({ current, new_password: newPassword }), throw: false,
    });
    if (r.status === 401) throw new Error("current password is incorrect"); // bespoke: 401 is a specific, actionable message
    if (r.status !== 200) throw new Error(errText(r, `change password: HTTP ${r.status}`));
    return (tryJson(r) as { token: string }).token;
  }

  // Owner-scoped share management (R14 sec#4). Reachable on the public port now that the endpoints
  // are on the shared surface, so a user can manage THEIR OWN shares from the plugin (was admin-only).
  static async myVaults(baseUrl: string, token: string): Promise<VaultShares[]> {
    return apiJson<VaultShares[]>({ url: `${normBase(baseUrl)}/api/admin/vaults`, method: "GET", headers: bearer(token) }, "my vaults");
  }
  // D0037: shareCreate (POST /api/admin/shares, grantee-username) was retired — sharing is link-based.
  // shareDelete (revoke) stays: a redeemed link mints the same D0008 grant, revoked the same way.
  static async shareDelete(baseUrl: string, token: string, vault: string, grantee: string): Promise<void> {
    await apiVoid({
      url: `${normBase(baseUrl)}/api/admin/shares`, method: "DELETE", contentType: "application/json",
      headers: bearer(token), body: JSON.stringify({ vault, grantee }),
    }, "unshare");
  }

  // D0023 capability share-links. createShareLink returns the opaque token (the plugin wraps it in a
  // selfsync-share:// link); redeemShareLink binds a grant to the caller and returns what they got.
  static async createShareLink(baseUrl: string, token: string, vault: string, perm: SharePerm, label = "", ttlSecs?: number): Promise<string> {
    return (await apiJson<{ token: string }>({
      url: `${normBase(baseUrl)}/api/share-links`, method: "POST", contentType: "application/json",
      headers: bearer(token), body: JSON.stringify({ vault, perm, label, ttl_secs: ttlSecs ?? null }),
    }, "share link")).token;
  }
  static async listShareLinks(baseUrl: string, token: string): Promise<ShareLinkInfo[]> {
    return apiJson<ShareLinkInfo[]>({ url: `${normBase(baseUrl)}/api/share-links`, method: "GET", headers: bearer(token) }, "share links");
  }
  static async revokeShareLink(baseUrl: string, token: string, id: string): Promise<void> {
    await apiVoid({ url: `${normBase(baseUrl)}/api/share-links/${encodeURIComponent(id)}`, method: "DELETE", headers: bearer(token) }, "revoke share link");
  }
  static async redeemShareLink(baseUrl: string, token: string, linkToken: string): Promise<SharedVaultRef> {
    return apiJson<SharedVaultRef>({
      url: `${normBase(baseUrl)}/api/share-redeem`, method: "POST", contentType: "application/json",
      headers: bearer(token), body: JSON.stringify({ token: linkToken }),
    }, "redeem");
  }
  // D0037 onboarding: redeem a vault share link AS a brand-new account, in one PUBLIC call (no prior
  // login). The valid single-use link authorizes account creation even under Closed registration
  // (link-as-invite). Returns the granted vault + a session token so the caller is signed in.
  static async redeemRegister(baseUrl: string, linkToken: string, username: string, password: string): Promise<SharedVaultRef & { token: string }> {
    if (isInsecureRemote(baseUrl)) {
      throw new Error("Refusing to send a new password over an unencrypted http:// connection to a remote server. Use an https:// address.");
    }
    return apiJson<SharedVaultRef & { token: string }>({
      url: `${normBase(baseUrl)}/api/share-redeem-register`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ token: linkToken, username, password }),
    }, "redeem & register");
  }

  private auth() { return bearer(this.token); }
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
    // validateStatus checks the shape + maps snake_case api_version → apiVersion (a malformed 200 throws there).
    return validateStatus(await apiJson<unknown>({ url: this.v("/status"), method: "GET", headers: this.auth() }, "status", { endpoint: Endpoint.VaultStatus }));
  }

  async changes(since: number): Promise<ChangesResponse> {
    return validateChanges(await apiJson<unknown>({ url: this.v(`/changes?since=${since}`), method: "GET", headers: this.auth() }, "changes"));
  }
  async fileMeta(path: string): Promise<FileMeta | null> {
    const r = await httpReq({ url: this.v(`/meta?path=${encodeURIComponent(path)}`), method: "GET", headers: this.auth(), throw: false });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`meta: HTTP ${r.status}`);
    return validateFileMeta(r.json);
  }
  async missing(hashes: string[]): Promise<string[]> {
    const m = (await apiJson<{ missing?: unknown }>({
      url: this.v("/chunks/missing"), method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify({ hashes }),
    }, "missing")).missing;
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
    // Provenance (snake_case on the wire): this device's stable UUID + friendly name. The transport's own
    // identity is the source of truth; a caller MAY override via the request (tests). Only sent when
    // present — an unconfigured device omits them and the server records the change as unknown-device.
    const did = req.deviceId ?? this.deviceId;
    const dname = req.deviceName ?? this.deviceName;
    if (did) body.device_id = did;
    if (dname) body.device_name = dname;
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
  async deleteFile(path: string, expectedVersion?: number): Promise<void> {
    // Optional CAS precondition (issueDeleteNoCasLostUpdate): a reconcile-driven delete-remote sends the
    // version it based the tombstone on so a stale delete can't silently supersede a newer concurrent
    // commit; an authoritative delete (user gesture / adjudication / switch) omits it. Snake_case to match
    // commit's wire field; older servers ignore the unknown query param (still always-wins there).
    const cas = expectedVersion !== undefined ? `&expected_version=${expectedVersion}` : "";
    const r = await httpReq({ url: this.v(`/file?path=${encodeURIComponent(path)}${cas}`), method: "DELETE", headers: this.auth(), throw: false });
    // 409 = the server advanced past our base (a concurrent edit). Signal it as a conflict — like commit —
    // so reconcile converges via edit-wins-pull on the next pass instead of losing the edit or looping.
    if (r.status === 409) throw new CommitConflictError(`delete conflict on '${path}' (server version advanced)`);
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

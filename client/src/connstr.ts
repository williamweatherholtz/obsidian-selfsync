// A shareable setup link for bootstrapping another device. Carries the server URL, the
// username, and (optionally) the vault to sync — never the password (there is no password
// field here by design; the new device still logs in / redeems its own credential).
export interface SetupLink { server: string; user: string; vault?: string; }

// A parsed, validated server origin with the cleartext-remote verdict computed ONCE at parse time rather
// than re-derived from a bare string at each call site (parse-don't-validate, issueBoolPredicatesNoRefined
// Type). `href` is the canonical origin (scheme + host[:port], no path/query/trailing slash); `insecure
// Remote` is true iff sending credentials here crosses the network in cleartext (see isInsecureRemote).
export interface ServerOrigin { href: string; insecureRemote: boolean; }

// Parse a server URL into its refined ServerOrigin (throws on a non-absolute / non-http(s) / malformed URL).
// The single parse boundary: normalizeServer and the transport read the verdict off the value instead of
// re-scanning the string.
export function parseServerOrigin(server: string): ServerOrigin {
  const u = new URL(server); // throws on a non-absolute / malformed URL
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Server must be an http(s) URL");
  }
  return { href: `${u.protocol}//${u.host}`, insecureRemote: urlIsInsecureRemote(u) };
}

// Canonical server origin: scheme + host(:port), no path/query/trailing slash.
export function normalizeServer(server: string): string {
  return parseServerOrigin(server).href;
}

// The single source of the cleartext-remote predicate + loopback allowlist, over an already-parsed URL.
// Shared by parseServerOrigin (origin strings) and isInsecureRemote (full request URLs) so the allowlist
// can never drift between the two.
function urlIsInsecureRemote(u: URL): boolean {
  if (u.protocol !== "http:") return false;             // https (or anything else) is fine
  const host = u.hostname.toLowerCase();
  return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost"));
}

// SEC-AUTH (audit): true if `server` would send credentials in CLEARTEXT to a REMOTE host — an
// http:// (not https) URL whose host is not loopback. On such a URL the password (on login) and the
// bearer token (on every request after) travel unencrypted and are trivially interceptable on any
// hop between the device and the server — the exact interception risk for an internet deployment.
// Loopback (localhost / 127.0.0.1 / ::1) over http is allowed: that's local dev or a same-host TLS
// reverse proxy, where nothing leaves the machine in cleartext. Kept as a string predicate for the
// centralized httpReq backstop, which screens FULL request URLs (not just origins).
export function isInsecureRemote(server: string): boolean {
  let u: URL;
  try { u = new URL(server); } catch { return false; } // malformed → normalizeServer will report it
  return urlIsInsecureRemote(u);
}

export function encodeSetupLink({ server, user, vault }: SetupLink): string {
  if (!user) throw new Error("username required");
  const p = new URLSearchParams({ server: normalizeServer(server), user });
  if (vault) p.set("vault", vault);
  return `selfsync://connect?${p.toString()}`;
}

export function parseSetupLink(str: string): SetupLink {
  const trimmed = str.trim();
  if (!trimmed.startsWith("selfsync://")) throw new Error("Not a SelfSync setup link");
  // Read the query params DIRECTLY — do NOT `new URL` on a scheme-swapped string. That produced
  // `https://connect?…`, a bare-label host that the Android WebView URL parser rejects ("Invalid URL").
  // URLSearchParams needs no host and decodes percent-encoding for us.
  const qi = trimmed.indexOf("?");
  const params = new URLSearchParams(qi >= 0 ? trimmed.slice(qi + 1) : "");
  const server = params.get("server") ?? "";
  const user = params.get("user") ?? "";
  const vault = params.get("vault") ?? undefined;
  if (!server || !user) throw new Error("Setup link is missing server or username");
  return { server: normalizeServer(server), user, ...(vault ? { vault } : {}) };
}

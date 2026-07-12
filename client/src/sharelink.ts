// Capability share-link codec (D0023). A share-link carries only the server + an opaque token — the
// permission and vault live server-side (a leaked read link can't be escalated). Mirrors the
// setup-link codec's custom-scheme + query-param shape so the plugin can route a pasted link.
import { normalizeServer } from "./connstr";

export interface ShareLink {
  server: string;
  token: string;
}

export function encodeShareLink({ server, token }: ShareLink): string {
  if (!token) throw new Error("token required");
  const p = new URLSearchParams({ server: normalizeServer(server), token });
  return `selfsync-share://redeem?${p.toString()}`;
}

export function parseShareLink(str: string): ShareLink {
  const trimmed = str.trim();
  if (!trimmed.startsWith("selfsync-share://")) throw new Error("Not a SelfSync share link");
  // Read the query params DIRECTLY (no `new URL` on a scheme-swapped string). The old approach —
  // `new URL(link.replace("selfsync-share://","https://"))` — produced `https://redeem?…`, whose host
  // is the bare label "redeem"; some engines (notably the Android WebView Obsidian mobile uses) throw
  // "Failed to construct 'URL': Invalid URL" on that. URLSearchParams needs no host and decodes for us.
  const qi = trimmed.indexOf("?");
  const params = new URLSearchParams(qi >= 0 ? trimmed.slice(qi + 1) : "");
  const server = params.get("server") ?? "";
  const token = params.get("token") ?? "";
  if (!server || !token) throw new Error("Share link is missing server or token");
  return { server: normalizeServer(server), token };
}

export function isShareLink(str: string): boolean {
  return str.trim().startsWith("selfsync-share://");
}

// The server's share table is the AUTHORITY for our access to a vault shared BY someone else. The
// client caches a projection of it (settings.vaultOwner / vaultReadOnly), but that projection was
// frozen at redeem time and would silently go stale if the owner later changed the permission
// (read↔readWrite) or revoked the grant. resolveShareGrant re-derives the current status from the
// server's grant list so `connect` can refresh the cache on every reconnect — the flag becomes a
// pure projection of the grant, never a copy that drifts. `owner` empty ⇒ we own the vault (nothing
// to re-check). Kept a PURE function (no I/O) so the decision is testable in isolation.
export type ShareGrantStatus =
  | { status: "notShared" }                  // own vault — no grant to check
  | { status: "revoked" }                    // shared to us, but the grant is gone (owner removed it)
  | { status: "active"; readOnly: boolean }; // grant present; readOnly reflects its CURRENT perm

export function resolveShareGrant(
  grants: readonly { owner: string; vault: string; perm: string }[],
  owner: string,
  vault: string,
): ShareGrantStatus {
  if (!owner) return { status: "notShared" };
  const ref = grants.find((g) => g.owner === owner && g.vault === vault);
  if (!ref) return { status: "revoked" };
  // Fail CLOSED for a security flag: treat the grant as read-only UNLESS it is explicitly readWrite.
  // An unexpected/renamed/malformed perm string must not silently confer write intent (critique F6).
  return { status: "active", readOnly: ref.perm !== "readWrite" };
}

// Precheck before redeeming on THIS device. Redeem is an AUTHENTICATED, server-specific call: it binds
// the shared vault to your account, so the device must be signed in to the SAME server the link points
// at. Returns an actionable message, or null if redeem can proceed. Guards the empty-serverUrl case so a
// not-set-up device gives clear guidance instead of a cryptic `new URL("")` "Invalid URL" crash.
export function redeemTargetError(linkServer: string, deviceServer: string): string | null {
  if (!deviceServer) return `Set up SelfSync and sign in to ${linkServer} first, then redeem this link.`;
  let a: string, b: string;
  try { a = normalizeServer(linkServer); b = normalizeServer(deviceServer); }
  catch { return "This share link's server address looks invalid."; }
  if (a !== b) return `This link is for ${a}, but you're signed in to ${b}. Set up SelfSync against ${a} first, then redeem.`;
  return null;
}

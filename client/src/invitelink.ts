// Account-creation ("invite") link codec (D0037). An invite link carries the server + a single-use
// invite token the operator issued — pasting it into setup lets a new user CREATE AN ACCOUNT on a
// server with registration CLOSED (it "just makes the first step": the account, no vault attached —
// contrast the vault share link, which also grants a share). Mirrors the share-link codec's
// custom-scheme + query-param shape so the setup wizard can route a pasted link.
import { normalizeServer } from "./connstr";

export interface InviteLink {
  server: string;
  token: string;
}

export function encodeInviteLink({ server, token }: InviteLink): string {
  if (!token) throw new Error("token required");
  const p = new URLSearchParams({ server: normalizeServer(server), token });
  return `selfsync-invite://register?${p.toString()}`;
}

export function parseInviteLink(str: string): InviteLink {
  const trimmed = str.trim();
  if (!trimmed.startsWith("selfsync-invite://")) throw new Error("Not a SelfSync invite link");
  // Read the query params directly (no `new URL` on a scheme-swapped string — some engines, notably the
  // Android WebView Obsidian mobile uses, throw on a bare "host" like "register"). Same shape as parseShareLink.
  const qi = trimmed.indexOf("?");
  const params = new URLSearchParams(qi >= 0 ? trimmed.slice(qi + 1) : "");
  const server = params.get("server") ?? "";
  const token = params.get("token") ?? "";
  if (!server || !token) throw new Error("Invite link is missing server or token");
  return { server: normalizeServer(server), token };
}

export function isInviteLink(str: string): boolean {
  return str.trim().startsWith("selfsync-invite://");
}

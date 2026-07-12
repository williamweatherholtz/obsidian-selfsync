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

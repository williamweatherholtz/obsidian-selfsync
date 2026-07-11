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
  // Swap the custom scheme for one the URL parser accepts, then read query params.
  const u = new URL(trimmed.replace(/^selfsync-share:\/\//, "https://"));
  const server = u.searchParams.get("server") ?? "";
  const token = u.searchParams.get("token") ?? "";
  if (!server || !token) throw new Error("Share link is missing server or token");
  return { server: normalizeServer(server), token };
}

export function isShareLink(str: string): boolean {
  return str.trim().startsWith("selfsync-share://");
}

// A shareable setup link for bootstrapping another device. Carries the server URL
// and username ONLY — never the password (there is no password field here by design).
export interface SetupLink { server: string; user: string; }

// Canonical server origin: scheme + host(:port), no path/query/trailing slash.
export function normalizeServer(server: string): string {
  const u = new URL(server); // throws on a non-absolute / malformed URL
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Server must be an http(s) URL");
  }
  return `${u.protocol}//${u.host}`;
}

export function encodeSetupLink({ server, user }: SetupLink): string {
  if (!user) throw new Error("username required");
  const p = new URLSearchParams({ server: normalizeServer(server), user });
  return `selfsync://connect?${p.toString()}`;
}

export function parseSetupLink(str: string): SetupLink {
  const trimmed = str.trim();
  if (!trimmed.startsWith("selfsync://")) throw new Error("Not a SelfSync setup link");
  // Swap the custom scheme for one the URL parser accepts, then read query params.
  const u = new URL(trimmed.replace(/^selfsync:\/\//, "https://"));
  const server = u.searchParams.get("server") ?? "";
  const user = u.searchParams.get("user") ?? "";
  if (!server || !user) throw new Error("Setup link is missing server or username");
  return { server: normalizeServer(server), user };
}

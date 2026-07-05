// A shareable setup link for bootstrapping another device. Carries the server URL, the
// username, and (optionally) the vault to sync — never the password (there is no password
// field here by design; the new device still logs in / redeems its own credential).
export interface SetupLink { server: string; user: string; vault?: string; }

// Canonical server origin: scheme + host(:port), no path/query/trailing slash.
export function normalizeServer(server: string): string {
  const u = new URL(server); // throws on a non-absolute / malformed URL
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Server must be an http(s) URL");
  }
  return `${u.protocol}//${u.host}`;
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
  // Swap the custom scheme for one the URL parser accepts, then read query params.
  const u = new URL(trimmed.replace(/^selfsync:\/\//, "https://"));
  const server = u.searchParams.get("server") ?? "";
  const user = u.searchParams.get("user") ?? "";
  const vault = u.searchParams.get("vault") ?? undefined;
  if (!server || !user) throw new Error("Setup link is missing server or username");
  return { server: normalizeServer(server), user, ...(vault ? { vault } : {}) };
}

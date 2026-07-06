// The wire-protocol / index-schema version this client speaks. It refuses to sync against a
// server advertising a DIFFERENT apiVersion (see main.ts doConnect), surfacing a clear "upgrade
// one of them" message rather than an undiagnosable malformed-response retry loop — the most
// likely real-world breakage for a self-hoster who auto-updates the plugin (BRAT) independently
// of the server. Bump in lockstep with the server's API_VERSION on any breaking wire/schema change.
export const CLIENT_API_VERSION = 1;

export interface FileMeta { path: string; hash: string; size: number; mtime: number; version: number; chunks: string[]; }
export interface Deletion { path: string; version: number; }
export interface ChangesResponse { version: number; upserts: FileMeta[]; deletes: Deletion[]; }
// `expectedVersion` (optional): the server file version this write was based on. Sent on
// reconcile-driven overwrites so the server can reject (409) a commit that would clobber an
// intervening change (optimistic concurrency). Omitted for authoritative overwrites (vault
// switch / user adjudication). Serialized as snake_case `expected_version` by the transport.
export interface CommitRequest { path: string; hash: string; size: number; mtime: number; chunks: string[]; expectedVersion?: number; }
export interface StatusResponse { status: string; detail: string; version: number; apiVersion?: number; }

// Thrown by the transport when a commit is rejected for a version conflict (HTTP 409). The
// reconcile layer lets it propagate to the per-file error handler and converges on the next
// pass (the remote advanced → a subsequent reconcile decides merge, never a silent clobber).
export class CommitConflictError extends Error {
  constructor(message = "commit conflict: server version advanced") { super(message); this.name = "CommitConflictError"; }
}

// PROTO-3: validate the SHAPE of every server response the client acts on before trusting it.
// A malformed/hostile response (chunks not string[], deletes not an array, version missing)
// otherwise reaches reconcile and could drive spurious local deletes or a corrupt rebuild.
// Reject loudly instead — a bad response fails the sync round, it never mutates the vault.
// (Pure, obsidian-free, so it is unit-testable in isolation from the transport.)
function asStr(v: unknown, f: string): string {
  if (typeof v !== "string") throw new Error(`malformed response: ${f} not a string`);
  return v;
}
function asNum(v: unknown, f: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`malformed response: ${f} not a number`);
  return v;
}
export function validateFileMeta(o: unknown): FileMeta {
  const m = o as Record<string, unknown>;
  if (!m || typeof m !== "object") throw new Error("malformed response: FileMeta not an object");
  asStr(m.path, "path"); asStr(m.hash, "hash"); asNum(m.size, "size"); asNum(m.version, "version");
  if (!Array.isArray(m.chunks) || m.chunks.some((c) => typeof c !== "string")) {
    throw new Error("malformed response: FileMeta.chunks not string[]");
  }
  return o as FileMeta;
}
export function validateChanges(o: unknown): ChangesResponse {
  const c = o as Record<string, unknown>;
  if (!c || typeof c !== "object") throw new Error("malformed response: ChangesResponse not an object");
  asNum(c.version, "version");
  if (!Array.isArray(c.upserts) || !Array.isArray(c.deletes)) {
    throw new Error("malformed response: upserts/deletes not arrays");
  }
  c.upserts.forEach(validateFileMeta);
  c.deletes.forEach((d) => { const x = d as Record<string, unknown>; asStr(x?.path, "delete.path"); asNum(x?.version, "delete.version"); });
  return o as ChangesResponse;
}

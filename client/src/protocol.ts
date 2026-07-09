// The wire-protocol / index-schema version this client speaks. It refuses to sync against a
// server advertising a DIFFERENT apiVersion (see main.ts doConnect), surfacing a clear "upgrade
// one of them" message rather than an undiagnosable malformed-response retry loop — the most
// likely real-world breakage for a self-hoster who auto-updates the plugin (BRAT) independently
// of the server. Bump in lockstep with the server's API_VERSION on any breaking wire/schema change.
export const CLIENT_API_VERSION = 1;

export interface FileMeta { path: string; hash: string; size: number; mtime: number; version: number; chunks: string[]; }
export interface Deletion { path: string; version: number; }
// history_floor (D0019): the version at/above which the server's DELETION history is complete
// (genesis = 1). A rebuild-from-disk reindex raises it, declaring the deletion history reset. When
// it advances past the floor this client last synced at (or the version rewinds), an absent-without-
// tombstone file is ambiguous, so the client stays conservative (keep + push) and surfaces a batched
// notice. Optional so an older server (no field) decodes as undefined → treated as genesis, never a
// false reset. See reconcile.onKeptAbsent + main's history-reset handling.
export interface ChangesResponse { version: number; upserts: FileMeta[]; deletes: Deletion[]; history_floor?: number; }
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
// Every numeric field the client acts on (version, size, delete.version, api_version) is a
// NON-NEGATIVE INTEGER on the wire. Enforce that, not just finiteness (R12-PB3): a fractional or
// negative `version` would otherwise become state.version and serialize into `?since=1.5`/`-1`,
// which the server can't parse → falls back to since=0 → the client re-runs a full whole-vault
// reconcile on every poll forever (cursor never converges).
function asNum(v: unknown, f: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`malformed response: ${f} not a non-negative integer`);
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
// R12-PB5: status() was the one consumed response NOT shape-validated — a garbage `{}` made
// `status` undefined and mis-fired the "vault damaged, run reindex" path (and fed the version gate
// an unvalidated object). Validate it and map snake_case api_version → camelCase apiVersion.
export function validateStatus(o: unknown): StatusResponse {
  const s = o as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("malformed response: StatusResponse not an object");
  asStr(s.status, "status"); asNum(s.version, "version");
  if (s.api_version !== undefined && s.api_version !== null) asNum(s.api_version, "api_version");
  return {
    status: s.status as string,
    detail: typeof s.detail === "string" ? s.detail : "",
    version: s.version as number,
    apiVersion: typeof s.api_version === "number" ? (s.api_version as number) : undefined,
  };
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
  // history_floor drives the deletion-history-reset path (keep-and-push); type-check it too (R23 LOW)
  // so a malformed/hostile value can't coerce through the `>` comparison — PROTO-3 validates the
  // shape of EVERY server field the client acts on, and this was the one that slipped through.
  if (c.history_floor !== undefined && c.history_floor !== null) asNum(c.history_floor, "history_floor");
  return o as ChangesResponse;
}

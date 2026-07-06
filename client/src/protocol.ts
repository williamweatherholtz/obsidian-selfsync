export interface FileMeta { path: string; hash: string; size: number; mtime: number; version: number; chunks: string[]; }
export interface Deletion { path: string; version: number; }
export interface ChangesResponse { version: number; upserts: FileMeta[]; deletes: Deletion[]; }
export interface CommitRequest { path: string; hash: string; size: number; mtime: number; chunks: string[]; }
export interface StatusResponse { status: string; detail: string; version: number; }

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

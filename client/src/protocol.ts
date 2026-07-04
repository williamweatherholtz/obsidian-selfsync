export interface FileMeta { path: string; hash: string; size: number; mtime: number; version: number; chunks: string[]; }
export interface Deletion { path: string; version: number; }
export interface ChangesResponse { version: number; upserts: FileMeta[]; deletes: Deletion[]; }
export interface CommitRequest { path: string; hash: string; size: number; mtime: number; chunks: string[]; }
export interface StatusResponse { status: string; detail: string; version: number; }

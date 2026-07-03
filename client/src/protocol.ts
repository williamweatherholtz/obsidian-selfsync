export interface FileMeta { path: string; hash: string; size: number; mtime: number; version: number; }
export interface Deletion { path: string; version: number; }
export interface ChangesResponse { version: number; upserts: FileMeta[]; deletes: Deletion[]; }

import { ChangesResponse, FileMeta } from "./protocol";

export interface VaultIo {
  list(): Promise<Map<string, { mtime: number }>>;
  read(path: string): Promise<string>;
  write(path: string, data: string, mtime: number): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface SyncApi {
  changes(since: number): Promise<ChangesResponse>;
  getFile(path: string): Promise<string>;
  putFile(path: string, data: string, mtime: number): Promise<FileMeta>;
  deleteFile(path: string): Promise<void>;
}

export type SyncState = { version: number };

export async function pull(api: SyncApi, io: VaultIo, state: SyncState): Promise<void> {
  const resp = await api.changes(state.version);
  for (const m of resp.upserts) {
    const data = await api.getFile(m.path);
    await io.write(m.path, data, m.mtime);
  }
  for (const d of resp.deletes) {
    await io.remove(d.path);
  }
  state.version = resp.version;
}

export async function pushLocal(
  api: SyncApi, io: VaultIo, state: SyncState, knownPaths: Set<string>
): Promise<void> {
  const local = await io.list();
  for (const [path, meta] of local) {
    if (knownPaths.has(path)) continue;
    const data = await io.read(path);
    const res = await api.putFile(path, data, meta.mtime);
    state.version = Math.max(state.version, res.version);
    knownPaths.add(path);
  }
}

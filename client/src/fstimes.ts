// Thin edge: the embedded timestamp drives filesystem times. Best-effort — this must NEVER throw into,
// block, or break content sync. mtime is settable on all desktop platforms; birthtime (creation time) is
// settable only on Windows/macOS (the caller omits setBirthtime elsewhere); POSIX ctime is never set.
export interface FsTimeApi {
  platform: "win" | "mac" | "linux" | "mobile";
  setMtime(path: string, epochMs: number): Promise<void>;
  setBirthtime?: (path: string, epochMs: number) => Promise<void>; // present only where settable
}

export async function driveFsTimes(api: FsTimeApi, path: string, updatedMs?: number, createdMs?: number): Promise<void> {
  try { if (updatedMs !== undefined) await api.setMtime(path, updatedMs); } catch { /* best-effort */ }
  try { if (createdMs !== undefined && api.setBirthtime) await api.setBirthtime(path, createdMs); } catch { /* best-effort */ }
}

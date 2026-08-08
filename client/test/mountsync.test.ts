import { describe, it, expect } from "vitest";
import { pollMount, reconcileMountScope, reconcileMountScopes, MountScope, MAX_MOUNT_FAILS } from "../src/mountsync";
import { MountRuntime, MountRuntimeCtx } from "../src/mountengine";
import { Mount } from "../src/mounts";
import { VaultIo, SyncApi, ChunkCache } from "../src/sync";
import { FileMeta, CommitRequest } from "../src/protocol";
import { chunk, sha256hex } from "../src/chunker";

const mk = (mountPoint: string, sourcePath = "", direction: "pull" | "sync" = "pull"): Mount =>
  ({ source: { owner: "will", vaultId: "asi", sourcePath }, mountPoint, direction });

// A faithful in-memory SOURCE server: chunks real bytes (real chunker + sha256), serves upserts + chunks so
// reconcileAll's integrity check (sha256hex(concat)===meta.hash) actually passes. Records pushes/deletes.
async function serveFile(chunks: Map<string, Uint8Array>, path: string, content: string, version: number): Promise<FileMeta> {
  const bytes = new TextEncoder().encode(content);
  const cs = await chunk(bytes);
  cs.forEach((c) => chunks.set(c.hash, c.bytes));
  return { path, hash: await sha256hex(bytes), size: bytes.length, mtime: 1000, version, chunks: cs.map((c) => c.hash) };
}
function sourceApi(upserts: FileMeta[], chunks: Map<string, Uint8Array>, version: number): SyncApi & { committed: CommitRequest[]; deleted: string[] } {
  const committed: CommitRequest[] = [], deleted: string[] = [];
  return {
    committed, deleted,
    changes: async (since: number) => ({ version, upserts: since === 0 ? upserts : [], deletes: [] }),
    fileMeta: async (p: string) => upserts.find((u) => u.path === p) ?? null,
    missing: async (hs: string[]) => hs.filter((h) => !chunks.has(h)),
    getChunk: async (h: string) => { const b = chunks.get(h); if (!b) throw new Error("no chunk " + h); return b; },
    putChunk: async (h: string, b: Uint8Array) => { chunks.set(h, b); },
    commit: async (req: CommitRequest) => { committed.push(req); return { ...req, version: version + 1 }; },
    deleteFile: async (p: string) => { deleted.push(p); },
  } as any;
}
// An in-memory local vault io.
function memIo(seed: Record<string, string> = {}): VaultIo & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>(Object.entries(seed).map(([p, c]) => [p, new TextEncoder().encode(c)]));
  return {
    files,
    list: async () => new Map([...files].map(([p, b]) => [p, { size: b.length, mtime: 1000 }])),
    read: async (p: string) => { const b = files.get(p); if (!b) throw new Error("enoent " + p); return b; },
    write: async (p: string, b: Uint8Array) => { files.set(p, b); },
    remove: async (p: string) => { files.delete(p); },
    exists: async (p: string) => files.has(p),
  } as any;
}
const ctx = (io: VaultIo, sourceApi: SyncApi, over: Partial<MountRuntimeCtx> = {}): MountRuntimeCtx =>
  ({ io, sourceApi, cache: new Map() as ChunkCache, device: "dev", ...over });
const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);

describe("pollMount / reconcileMountScopes — PULL (end-to-end via the real reconcile engine)", () => {
  it("pulls the source subtree into the local mount point, translating paths both sides", async () => {
    const chunks = new Map<string, Uint8Array>();
    const src = sourceApi([await serveFile(chunks, "Projects/notes/a.md", "hello", 1)], chunks, 1);
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "Projects", "pull"), ctx(io, src));
    const scope: MountScope = { runtime: rt, state: "detached", fails: 0 };
    await reconcileMountScopes([scope], {}, true); // initial connect pass
    expect(scope.state).toBe("live");
    expect(dec(io.files.get("Work/ASI/notes/a.md"))).toBe("hello"); // Projects/notes/a.md → Work/ASI/notes/a.md
    expect(rt.state.version).toBe(1); // the mount's OWN cursor advanced
    expect(src.committed).toEqual([]); // a pull mount NEVER writes the source
  });
  it("R2-F1: a PULL mount over a pre-existing DIFFERENT local file KEEPS the local as a conflict copy (no silent data loss)", async () => {
    const chunks = new Map<string, Uint8Array>();
    const src = sourceApi([await serveFile(chunks, "plan.md", "SOURCE VER", 1)], chunks, 1);
    const io = memIo({ "Work/ASI/plan.md": "LOCAL WORK" }); // the user already had notes here before mounting
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src));
    const scope: MountScope = { runtime: rt, state: "detached", fails: 0 };
    await reconcileMountScopes([scope], {}, true);
    expect(scope.state).toBe("live");
    expect(dec(io.files.get("Work/ASI/plan.md"))).toBe("SOURCE VER"); // source adopted at the canonical path
    const copy = [...io.files.keys()].find((p) => p.startsWith("Work/ASI/plan (conflict"));
    expect(copy).toBeTruthy();                              // the user's version preserved as a LOCAL conflict copy
    expect(dec(io.files.get(copy!))).toBe("LOCAL WORK");
    expect(src.committed).toEqual([]);                      // pull mount never wrote the source
  });
  it("a steady poll with no source change stays live and writes nothing", async () => {
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, sourceApi([], new Map(), 0)));
    const scope: MountScope = { runtime: rt, state: "live", fails: 0 };
    await reconcileMountScope(scope);
    expect(scope.state).toBe("live");
    expect(io.files.size).toBe(0);
  });
});

describe("reconcileMountScope — SYNC pushes a local-only file to the source (bidirectional)", () => {
  it("commits the local mount file to the translated source path", async () => {
    const chunks = new Map<string, Uint8Array>();
    const src = sourceApi([], chunks, 0);
    const io = memIo({ "Work/ASI/notes/local.md": "mine" });
    const rt = new MountRuntime(mk("Work/ASI", "Projects", "sync"), ctx(io, src));
    const scope: MountScope = { runtime: rt, state: "mounting", fails: 0 };
    await reconcileMountScope(scope);
    expect(scope.state).toBe("live");
    expect(src.committed.map((c) => c.path)).toEqual(["Projects/notes/local.md"]); // local → source, prefix-translated
  });
});

describe("fail-isolation + FSM driving", () => {
  const throwingApi = (): SyncApi => ({ ...sourceApi([], new Map(), 0), changes: async () => { throw new Error("network down"); } } as any);
  it("a source error marks the mount offline, then FAILED after MAX consecutive failures — never throws", async () => {
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(memIo(), throwingApi()));
    const scope: MountScope = { runtime: rt, state: "mounting", fails: 0 };
    for (let i = 1; i < MAX_MOUNT_FAILS; i++) { await reconcileMountScope(scope); expect(scope.state).toBe("offline"); }
    await reconcileMountScope(scope);
    expect(scope.state).toBe("failed");
  });
  it("recovers offline→live when the source comes back", async () => {
    const chunks = new Map<string, Uint8Array>();
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(memIo(), sourceApi([], chunks, 0)));
    const scope: MountScope = { runtime: rt, state: "offline", fails: 1 };
    await reconcileMountScope(scope);
    expect(scope.state).toBe("live");
    expect(scope.fails).toBe(0);
  });
  it("one broken mount never aborts another (fail-isolation across scopes)", async () => {
    const chunks = new Map<string, Uint8Array>();
    const good = new MountRuntime(mk("Good", "", "pull"), ctx(memIo(), sourceApi([await serveFile(chunks, "a.md", "x", 1)], chunks, 1)));
    const bad = new MountRuntime(mk("Bad", "", "pull"), ctx(memIo(), throwingApi()));
    const goodScope: MountScope = { runtime: good, state: "detached", fails: 0 };
    const badScope: MountScope = { runtime: bad, state: "detached", fails: 0 };
    await reconcileMountScopes([badScope, goodScope], {}, true); // bad first — must not stop good
    expect(badScope.state).toBe("offline");
    expect(goodScope.state).toBe("live");
    expect((good as any).base.get("a.md")).toBeDefined();
  });
  it("isLive predicate skips a removed / unloading scope BEFORE any reconcile touches disk (R1-F3/F4)", async () => {
    const chunks = new Map<string, Uint8Array>();
    const src = sourceApi([await serveFile(chunks, "a.md", "x", 1)], chunks, 1);
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src));
    const scope: MountScope = { runtime: rt, state: "detached", fails: 0 };
    await reconcileMountScopes([scope], {}, true, () => false); // not live → skipped
    expect(scope.state).toBe("detached"); // never even transitioned to mounting
    expect(io.files.size).toBe(0);         // nothing written to disk
  });
  it("skips detached / failed scopes (no work, no throw)", async () => {
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(memIo(), throwingApi()));
    for (const state of ["detached", "failed"] as const) {
      const scope: MountScope = { runtime: rt, state, fails: 0 };
      await reconcileMountScope(scope);
      expect(scope.state).toBe(state); // unchanged — never even touched the (throwing) api
    }
  });
});

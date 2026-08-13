import { describe, it, expect } from "vitest";
import { pollMount, reconcileMountScope, reconcileMountScopes, MountScope, MAX_MOUNT_FAILS } from "../src/mountsync";
import { MountRuntime, MountRuntimeCtx, parseMountState } from "../src/mountengine";
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
function memIo(seed: Record<string, string> = {}): VaultIo & { files: Map<string, Uint8Array>; folders: Set<string> } {
  const files = new Map<string, Uint8Array>(Object.entries(seed).map(([p, c]) => [p, new TextEncoder().encode(c)]));
  // Track folders EXPLICITLY, like Obsidian's real adapter: an EMPTY folder still exists (deleting all files
  // under a folder leaves the folder node) — the critique F1 case the old model masked.
  const folders = new Set<string>();
  const track = (p: string) => { const s = p.split("/"); for (let i = 1; i < s.length; i++) folders.add(s.slice(0, i).join("/")); };
  for (const p of files.keys()) track(p);
  return {
    files, folders,
    list: async () => new Map([...files].map(([p, b]) => [p, { size: b.length, mtime: 1000 }])),
    read: async (p: string) => { const b = files.get(p); if (!b) throw new Error("enoent " + p); return b; },
    write: async (p: string, b: Uint8Array) => { files.set(p, b); track(p); },
    remove: async (p: string) => { files.delete(p); }, // folder persists (Obsidian keeps empty folders)
    exists: async (p: string) => files.has(p) || folders.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/")),
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
    await reconcileMountScopes([scope], {}); // initial connect pass
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
    await reconcileMountScopes([scope], {});
    expect(scope.state).toBe("diverged");                  // R5-MED-1: a conflict copy surfaces as "Needs review", not a silent green
    expect(dec(io.files.get("Work/ASI/plan.md"))).toBe("SOURCE VER"); // source adopted at the canonical path
    const copy = [...io.files.keys()].find((p) => p.startsWith("Work/ASI/plan (conflict"));
    expect(copy).toBeTruthy();                              // the user's version preserved as a LOCAL conflict copy
    expect(dec(io.files.get(copy!))).toBe("LOCAL WORK");
    expect(src.committed).toEqual([]);                      // pull mount never wrote the source
    // a subsequent clean poll (no new conflict) clears diverged back to live
    await reconcileMountScope(scope);
    expect(scope.state).toBe("live");
  });
  it("R9-C: a source version REWIND (reindex) forces a full re-pull instead of trusting the stale cursor", async () => {
    const chunks = new Map<string, Uint8Array>();
    const src = sourceApi([await serveFile(chunks, "a.md", "x", 2)], chunks, 2); // source now reports version 2
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src, { restore: { base: {}, version: 5 } })); // our cursor is AHEAD (stale)
    await pollMount(rt); // changes(5) → {version:2, upserts:[]} (nothing "since" 5) — but version<cursor ⇒ reset ⇒ full reconcile
    expect(io.files.has("Work/ASI/a.md")).toBe(true); // re-pulled despite the empty incremental delta
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

describe("reconcileMountScope — SYNC pushes a LATER local edit only via a forceFull pass (issueMountRwPushBack)", () => {
  it("a live mount with an UNCHANGED source ignores a new local file on a plain poll, but a forceFull pass pushes it", async () => {
    const chunks = new Map<string, Uint8Array>();
    const src = sourceApi([], chunks, 3);                 // source has no subtree files, at version 3
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "Projects", "sync"), ctx(io, src));
    const scope: MountScope = { runtime: rt, state: "mounting", fails: 0 };
    await reconcileMountScope(scope);                     // establish: full pass, nothing to do → live
    expect(scope.state).toBe("live");
    expect(src.committed).toEqual([]);
    // The user now creates a file in the mount folder; the SOURCE has NOT changed.
    io.files.set("Work/ASI/note.md", new TextEncoder().encode("made locally"));
    // A plain live poll is SOURCE-driven → source unchanged → noop → the local file is NOT pushed (the bug).
    await reconcileMountScope(scope);
    expect(src.committed).toEqual([]);
    // The local-event nudge (main.ts nudgeMountForLocalPath) sets forceFull; THAT pass scans local + pushes it.
    scope.forceFull = true;
    await reconcileMountScope(scope);
    expect(src.committed.map((c) => c.path)).toEqual(["Projects/note.md"]);
  });
});

describe("reconcileMountScope — a MASS local deletion never wipes the source (issueMountFolderDeletedWipesSource / critique F1)", () => {
  // Establish a sync mount holding `n` files pulled from the source subfolder "notes".
  async function established(n: number): Promise<{ src: ReturnType<typeof sourceApi>; io: ReturnType<typeof memIo>; scope: MountScope }> {
    const chunks = new Map<string, Uint8Array>();
    const upserts: FileMeta[] = [];
    for (let i = 0; i < n; i++) upserts.push(await serveFile(chunks, `notes/n${i}.md`, `v${i}`, 1));
    const src = sourceApi(upserts, chunks, 1);
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "notes", "sync"), ctx(io, src));
    const scope: MountScope = { runtime: rt, state: "mounting", fails: 0 };
    await reconcileMountScope(scope);                          // full first pass → pulls all n
    expect(scope.state).toBe("live");
    expect(rt.baseNonEmpty()).toBe(true);
    return { src, io, scope };
  }

  it("deleting the whole mount FOLDER (node gone) → localGone, source untouched — any size", async () => {
    const { src, io, scope } = await established(3);
    io.files.clear(); io.folders.delete("Work/ASI");          // the folder node itself is removed
    scope.forceFull = true;
    await reconcileMountScope(scope);
    expect(scope.state).toBe("localGone");
    expect(src.deleted).toEqual([]);                          // CRITICAL: nothing deleted from the source
    expect(src.committed).toEqual([]);
    await reconcileMountScope(scope);                         // stays held on a later pass
    expect(scope.state).toBe("localGone");
    expect(src.deleted).toEqual([]);
  });

  it("deleting ALL the files but leaving the (empty) folder → still localGone (the critique F1 case)", async () => {
    const { src, io, scope } = await established(8);
    io.files.clear();                                         // folder "Work/ASI" PERSISTS (Obsidian keeps empty folders)
    expect(await io.exists!("Work/ASI")).toBe(true);          // the empty folder still exists — the F1 trap
    scope.forceFull = true;
    await reconcileMountScope(scope);
    expect(scope.state).toBe("localGone");
    expect(src.deleted).toEqual([]);                          // source NOT wiped despite the folder node surviving
  });

  it("deleting ALL files of a SMALL (<6) mount, folder remaining → still localGone (all-content-absent, finding 3)", async () => {
    const { src, io, scope } = await established(3);
    io.files.clear();                                        // folder "Work/ASI" persists; 3 of 3 absent
    expect(await io.exists!("Work/ASI")).toBe(true);
    scope.forceFull = true;
    await reconcileMountScope(scope);
    expect(scope.state).toBe("localGone");                   // caught by absent === base even below the floor
    expect(src.deleted).toEqual([]);
  });

  it("a source REWIND (reset) that escalates to a full pass is ALSO guarded — no source wipe (finding 1)", async () => {
    const { src, io, scope } = await established(8);
    scope.runtime.state.version = 99;                        // our cursor ahead of the source → the next poll reads as rewound
    io.files.clear();                                        // mass local deletion, folder remains
    scope.forceFull = false;                                 // NOT forceFull — the reset path escalates to a full pass internally
    await reconcileMountScope(scope);
    expect(scope.state).toBe("localGone");                   // the guard now lives inside pollMount → covers the reset route
    expect(src.deleted).toEqual([]);
  });

  it("Finding 5: a TRANSIENT empty/partial local list does NOT flag localGone — the guard re-probes via io.exists (issueMountDeleteGuardResiduals)", async () => {
    const { src, io, scope } = await established(8);          // 8 files pulled → base populated, files on disk
    const realList = io.list;
    io.list = async () => new Map();                          // adapter hiccup / mid-write: list() transiently returns EMPTY
    scope.forceFull = true;                                   // force a full pass → pollMount runs massLocalDeletion
    await reconcileMountScope(scope);
    expect(scope.state).not.toBe("localGone");                // io.exists still finds the files → re-probe rescues it → NOT flagged
    expect(src.deleted).toEqual([]);                          // and nothing deleted from the source
    io.list = realList;
  });

  it("Finding 5: a PARTIAL list (some files unlisted but present) stays below the floor via the re-probe", async () => {
    const { src, io, scope } = await established(8);
    const realList = io.list;
    // list() drops 6 of 8 (transiently), but they're still on disk (io.exists finds them) → only the 0 truly-gone
    // count, so the guard does NOT trip. Without the re-probe, 6 list-absent would meet the floor and spuriously flag.
    io.list = async () => new Map([...(await realList())].slice(0, 2));
    scope.forceFull = true;
    await reconcileMountScope(scope);
    expect(scope.state).not.toBe("localGone");
    expect(src.deleted).toEqual([]);
    io.list = realList;
  });

  it("a SMALL local deletion (below the bulk floor) still propagates exactly to the source (D0043)", async () => {
    const { src, io, scope } = await established(10);
    io.files.delete("Work/ASI/n0.md"); io.files.delete("Work/ASI/n1.md"); // 2 of 10 — well under the floor
    scope.forceFull = true;
    await reconcileMountScope(scope);
    expect(scope.state).not.toBe("localGone");
    expect(src.deleted.sort()).toEqual(["notes/n0.md", "notes/n1.md"]); // exact outgoing delete, no over-hold
  });

  it("a FRESH mount (empty base) whose folder doesn't exist yet still pulls — not mistaken for a deletion", async () => {
    const chunks = new Map<string, Uint8Array>();
    const src = sourceApi([await serveFile(chunks, "notes/a.md", "hi", 1)], chunks, 1);
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "notes", "sync"), ctx(io, src));
    const scope: MountScope = { runtime: rt, state: "mounting", fails: 0 };
    await reconcileMountScope(scope);
    expect(scope.state).toBe("live");                          // fresh → pulled, folder materialized
    expect([...io.files.keys()]).toContain("Work/ASI/a.md");
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
  it("R4-F4: a NOT-READY source holds the mount OFFLINE (never reconciles a degraded/partial manifest)", async () => {
    const chunks = new Map<string, Uint8Array>();
    const src = sourceApi([await serveFile(chunks, "a.md", "x", 1)], chunks, 1);
    const io = memIo();
    const notReady = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src, { sourceReady: async () => false }));
    const s1: MountScope = { runtime: notReady, state: "detached", fails: 0 };
    await reconcileMountScopes([s1], {});
    expect(s1.state).toBe("offline"); // held — not synced against a not-ready source
    expect(io.files.size).toBe(0);    // nothing pulled
    const ready = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src, { sourceReady: async () => true }));
    const s2: MountScope = { runtime: ready, state: "detached", fails: 0 };
    await reconcileMountScopes([s2], {});
    expect(s2.state).toBe("live");
    expect(io.files.has("Work/ASI/a.md")).toBe(true); // once ready, it pulls
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
    await reconcileMountScopes([badScope, goodScope], {}); // bad first — must not stop good
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
    await reconcileMountScopes([scope], {}, () => false); // not live → skipped
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

// D0019 (mountResetDetection, R2-F3): full source deletion-history reset detection for mounts — the per-mount
// analogue of the primary's historyResetDetected. A source that TRUNCATES its history (its history_floor
// advances past our cursor) drops the tombstones for files deleted before the new floor, so a DELTA poll
// silently misses those deletions. The mount must route a floor advance (like a version rewind) to a FULL
// reconcile, which re-scans and KEEPS absent-without-tombstone files (onKeptAbsent) instead of trusting the
// truncated delta. The floor is tracked per-mount so a LATER truncation stays detectable.
describe("pollMount — D0019 source history reset detection (mountResetDetection)", () => {
  // A source whose full manifest + version + floor can be mutated to simulate a history truncation.
  function resettableSource(chunks: Map<string, Uint8Array>, manifest: FileMeta[], version: number, floor?: number) {
    let ver = version, fl = floor, man = [...manifest], failFull = false;
    const committed: CommitRequest[] = [], deleted: string[] = [];
    return {
      committed, deleted,
      changes: async (since: number) => {
        if (since === 0 && failFull) throw new Error("source unavailable (simulated full-manifest failure)"); // makes reconcileAll throw
        return { version: ver, upserts: since === 0 ? [...man] : [], deletes: [], history_floor: fl };
      },
      fileMeta: async (p: string) => man.find((u) => u.path === p) ?? null,
      missing: async (hs: string[]) => hs.filter((h) => !chunks.has(h)),
      getChunk: async (h: string) => { const b = chunks.get(h); if (!b) throw new Error("no chunk " + h); return b; },
      putChunk: async (h: string, b: Uint8Array) => { chunks.set(h, b); },
      commit: async (req: CommitRequest) => { committed.push(req); return { ...req, version: ver + 1 }; },
      deleteFile: async (p: string) => { deleted.push(p); },
      __truncate: (newFloor: number, newManifest: FileMeta[]) => { fl = newFloor; man = newManifest; },
      __failFull: (v: boolean) => { failFull = v; },
    } as any;
  }

  it("a SOURCE history-floor advance routes an otherwise-idle poll to a FULL reconcile (keeps the absent-without-tombstone file)", async () => {
    const chunks = new Map<string, Uint8Array>();
    const a = await serveFile(chunks, "a.md", "hello", 1);
    const src = resettableSource(chunks, [a], 1, 2); // version 1, floor 2
    const io = memIo();
    const kept: string[] = [];
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src, { callbacks: { onKeptAbsent: (p) => kept.push(p) } }));
    const scope: MountScope = { runtime: rt, state: "detached", fails: 0 };
    await reconcileMountScopes([scope], {}); // first contact (full): pulls a.md, records floor 2
    expect(dec(io.files.get("Work/ASI/a.md"))).toBe("hello");
    expect(rt.historyFloor()).toBe(2);
    expect(kept).toEqual([]);

    // The source truncates its history: a.md was deleted and its tombstone dropped (floor 2 → 9); version
    // unchanged, no new delta. Without floor detection this poll is a NOOP and a.md lingers forever.
    src.__truncate(9, []);
    await reconcileMountScopes([scope], {}); // steady 'live' scope → would be a delta/noop but for the reset
    expect(kept.length).toBeGreaterThan(0);           // a FULL reconcile ran and surfaced the absent file
    expect(io.files.has("Work/ASI/a.md")).toBe(true); // kept (not silently deleted) — D0019 safe behavior
    expect(rt.historyFloor()).toBe(9);                // the new floor is recorded so it won't re-trigger
  });

  it("the FIRST floor observation is NOT a reset (just seeds it); an unchanged floor is a normal delta/noop", async () => {
    const chunks = new Map<string, Uint8Array>();
    const a = await serveFile(chunks, "a.md", "hello", 1);
    const src = resettableSource(chunks, [a], 1, 5); // floor present from the very first pass
    const io = memIo();
    const kept: string[] = [];
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src, { callbacks: { onKeptAbsent: (p) => kept.push(p) } }));
    const scope: MountScope = { runtime: rt, state: "detached", fails: 0 };
    await reconcileMountScopes([scope], {}); // first contact: floor 5 SEEDED, not treated as a reset
    expect(rt.historyFloor()).toBe(5);
    expect(io.files.has("Work/ASI/a.md")).toBe(true);
    // A steady poll with the SAME floor + no delta → noop, no spurious keep/rescan.
    await reconcileMountScopes([scope], {});
    expect(kept).toEqual([]);
  });

  it("the per-mount floor round-trips through toPersist/restore (a later truncation stays detectable across a rebuild)", async () => {
    const chunks = new Map<string, Uint8Array>();
    const a = await serveFile(chunks, "a.md", "hello", 1);
    const src = resettableSource(chunks, [a], 1, 4);
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src));
    await reconcileMountScopes([{ runtime: rt, state: "detached", fails: 0 }], {});
    const persisted = rt.toPersist();
    expect(persisted.historyFloor).toBe(4);
    // Rebuild from the persisted state → the floor is restored, so a truncation is still caught.
    const rt2 = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(memIo({ "Work/ASI/a.md": "hello" }), src, { restore: persisted } as any));
    expect(rt2.historyFloor()).toBe(4);
  });

  // Critique F1: the floor must advance only AFTER a successful reconcile — a failed reset pass must NOT spend
  // the one-shot signal (mounts have no periodic full-scan), so the full reconcile RE-FIRES next poll.
  it("a floor advance whose full reconcile FAILS does not spend the reset — it re-fires on recovery (F1)", async () => {
    const chunks = new Map<string, Uint8Array>();
    const a = await serveFile(chunks, "a.md", "hello", 1);
    const src = resettableSource(chunks, [a], 1, 2);
    const io = memIo();
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(io, src));
    const scope: MountScope = { runtime: rt, state: "detached", fails: 0 };
    await reconcileMountScopes([scope], {}); // first contact: floor 2
    expect(rt.historyFloor()).toBe(2);

    src.__truncate(9, []); src.__failFull(true); // source truncated (floor→9) AND its full manifest now errors
    await reconcileMountScopes([scope], {});     // reset detected → full reconcile → THROWS
    expect(scope.state).toBe("offline");         // routed to a transient retry
    expect(rt.historyFloor()).toBe(2);           // floor NOT advanced — the reset is still pending

    src.__failFull(false);                        // source recovers
    await reconcileMountScopes([scope], {});     // offline → forced full pass → reset re-handled, succeeds
    expect(rt.historyFloor()).toBe(9);           // NOW consumed
    expect(scope.state).toBe("live");
  });

  it("the floor is MONOTONIC — a lower reported floor is ignored, an undefined does not clobber (F3)", () => {
    const rt = new MountRuntime(mk("Work/ASI", "", "pull"), ctx(memIo(), sourceApi([], new Map(), 1)));
    rt.noteHistoryFloor(5); expect(rt.historyFloor()).toBe(5);
    rt.noteHistoryFloor(3); expect(rt.historyFloor()).toBe(5);        // lower → ignored (never arms a spurious later reset)
    rt.noteHistoryFloor(undefined); expect(rt.historyFloor()).toBe(5); // undefined → no clobber
    rt.noteHistoryFloor(8); expect(rt.historyFloor()).toBe(8);        // higher → raised
  });

  it("parseMountState drops a sub-genesis historyFloor (server genesis is 1) so it can't spuriously fire a reset (F4)", () => {
    expect(parseMountState({ k: { base: {}, version: 1, historyFloor: 0 } }).k.historyFloor).toBeUndefined();
    expect(parseMountState({ k: { base: {}, version: 1, historyFloor: -3 } }).k.historyFloor).toBeUndefined();
    expect(parseMountState({ k: { base: {}, version: 1, historyFloor: 3 } }).k.historyFloor).toBe(3);
    expect(parseMountState({ k: { base: {}, version: 1 } }).k.historyFloor).toBeUndefined(); // absent (old data.json) → undefined
  });
});

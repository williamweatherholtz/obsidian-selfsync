import { describe, it, expect } from "vitest";
import { MountRuntime, mountKey, MountRuntimeCtx, parseMountState } from "../src/mountengine";
import { mountTransition, mountHealth, foldHealth, aggregateStatus, MountState } from "../src/mountfsm";
import { Mount } from "../src/mounts";
import { BaseStore } from "../src/base";
import { VaultIo, SyncApi, ChunkCache } from "../src/sync";

const mk = (mountPoint: string, sourcePath = "", direction: "pull" | "sync" = "pull"): Mount =>
  ({ source: { owner: "will", vaultId: "asi", sourcePath }, mountPoint, direction });

const stubIo: VaultIo = { list: async () => new Map(), read: async () => new Uint8Array(), write: async () => {}, remove: async () => {} };
const stubApi: SyncApi = {
  changes: async () => ({ version: 0, upserts: [], deletes: [] }),
  fileMeta: async () => null, missing: async (h) => h, getChunk: async () => new Uint8Array(),
  putChunk: async () => {}, commit: async () => ({ path: "", hash: "", size: 0, mtime: 0, version: 0, chunks: [] }), deleteFile: async () => {},
};
const ctx = (over: Partial<MountRuntimeCtx> = {}): MountRuntimeCtx => ({ io: stubIo, sourceApi: stubApi, cache: new Map() as ChunkCache, device: "dev", ...over });

describe("mountKey — stable, collision-free per-mount identity", () => {
  it("encodes source vault + subfolder + local mount point (JSON, order-independent + stable)", () => {
    expect(mountKey(mk("Work/ASI", "Projects"))).toBe('["will","asi","Projects","Work/ASI"]');
    expect(mountKey(mk("Work/ASI", "Projects"))).toBe(mountKey(mk("Work/ASI", "Projects"))); // stable
    expect(mountKey(mk("Work/ASI", "Other"))).not.toBe(mountKey(mk("Work/ASI", "Projects")));
  });
  it("does NOT collide two DISTINCT mounts whose delimiter-joined form would tie (R3-M1)", () => {
    // Old `${sp}=>${mp}` scheme: {sp:"a", mp:"b=>c"} and {sp:"a=>b", mp:"c"} both → "…#a=>b=>c". JSON can't tie.
    expect(mountKey(mk("b=>c", "a"))).not.toBe(mountKey(mk("c", "a=>b")));
    expect(mountKey(mk("C#", ""))).not.toBe(mountKey(mk("", "C#"))); // '#' in a folder name (C#) doesn't collide
  });
});

describe("MountRuntime — STRUCTURAL isolation (issueMountBaseIsolation)", () => {
  it("always constructs its OWN base + state + guard + retry — never shares (a fresh mount starts at cursor 0, empty base)", () => {
    const rt = new MountRuntime(mk("Work/ASI", "Projects"), ctx());
    expect(rt.base).toBeInstanceOf(BaseStore);
    expect(rt.base.paths()).toEqual([]);
    expect(rt.state).toEqual({ version: 0 });
    // two runtimes over the same ctx get DISTINCT base/state objects (no shared mutable truth)
    const rt2 = new MountRuntime(mk("Refs", ""), ctx());
    expect(rt2.base).not.toBe(rt.base);
    expect(rt2.state).not.toBe(rt.state);
    expect(rt2.deleteGuard).not.toBe(rt.deleteGuard);
    rt.state.version = 42;
    expect(rt2.state.version).toBe(0); // mutating one never touches the other
  });
  it("resumes from persisted own base + cursor when given restore", () => {
    const rt = new MountRuntime(mk("Work/ASI", "Projects"), ctx({ restore: { base: { "notes/a.md": { hash: "H" } }, version: 7 } }));
    expect(rt.state.version).toBe(7);
    expect(rt.base.get("notes/a.md")).toEqual({ hash: "H" });
    expect(rt.toPersist()).toEqual({ base: { "notes/a.md": { hash: "H" } }, version: 7 });
  });
  it("deps() wires the mount's OWN base/state + the data-only accepts + the mounted io/api", () => {
    const rt = new MountRuntime(mk("Work/ASI", "Projects", "sync"), ctx());
    const d = rt.deps();
    expect(d.base).toBe(rt.base);
    expect(d.state).toBe(rt.state);
    expect(d.deleteGuard).toBe(rt.deleteGuard);
    expect(d.accepts!("notes/a.md")).toBe(true);
    expect(d.accepts!(".obsidian/x")).toBe(false); // data-only
  });
  it("a PULL mount is readOnly (pull-only reconcile path); a SYNC mount is not", () => {
    expect(new MountRuntime(mk("Work/ASI", "", "pull"), ctx()).deps().readOnly).toBe(true);
    expect(new MountRuntime(mk("Work/ASI", "", "sync"), ctx()).deps().readOnly).toBe(false);
  });
});

describe("parseMountState — validated persistence boundary (B2, hostile-input hardening)", () => {
  it("keeps well-formed entries, drops malformed ones (non-numeric version / non-object base / missing base / non-object)", () => {
    const parsed = parseMountState({
      k1: { base: { "notes/a.md": { hash: "H" } }, version: 3 },
      k2: { base: {}, version: "abc" },
      k3: { base: "garbage", version: 1 },
      k4: { version: 2 },
      k5: "nope",
      k6: { base: {}, version: -1 }, // negative cursor → drop
    });
    expect(Object.keys(parsed)).toEqual(["k1"]);
    expect(parsed.k1).toEqual({ base: { "notes/a.md": { hash: "H" } }, version: 3 });
  });
  it("filters garbage base entries within a kept mount — only valid {hash[,text]} records survive (no fabricated base paths / non-string merge ancestor)", () => {
    const parsed = parseMountState({ k: { base: { a: { hash: "H" }, b: "x", c: { size: 1 }, d: { hash: "H", text: 123 }, e: { hash: "H", text: "ok" } }, version: 0 } });
    expect(parsed.k.base).toEqual({ a: { hash: "H" }, e: { hash: "H", text: "ok" } }); // b/c/d dropped (no hash / bad hash / non-string text)
  });
  it("non-object → {}", () => { expect(parseMountState(undefined)).toEqual({}); expect(parseMountState("x")).toEqual({}); });
});

describe("mountTransition — pure lifecycle FSM", () => {
  it("happy path: detached→mounting→live→syncing→live", () => {
    let s: MountState = "detached";
    s = mountTransition(s, "mount"); expect(s).toBe("mounting");
    s = mountTransition(s, "mounted"); expect(s).toBe("live");
    s = mountTransition(s, "syncStart"); expect(s).toBe("syncing");
    s = mountTransition(s, "syncSettled"); expect(s).toBe("live");
  });
  it("offline resumes; diverged resolves; failed retries", () => {
    expect(mountTransition("live", "disconnect")).toBe("offline");
    expect(mountTransition("offline", "reconnect")).toBe("live");
    expect(mountTransition("syncing", "diverge")).toBe("diverged");
    expect(mountTransition("diverged", "resolved")).toBe("live");
    expect(mountTransition("failed", "retry")).toBe("mounting");
  });
  it("unmount + fail are accepted from any LIVE state but not from detached/unmounting", () => {
    for (const s of ["mounting", "live", "syncing", "diverged", "offline"] as MountState[]) {
      expect(mountTransition(s, "unmount")).toBe("unmounting");
      expect(mountTransition(s, "fail")).toBe("failed");
    }
    expect(mountTransition("detached", "unmount")).toBe("detached"); // nothing to tear down
    expect(mountTransition("unmounting", "fail")).toBe("unmounting"); // teardown wins
    expect(mountTransition("unmounting", "unmounted")).toBe("detached");
  });
  it("an undefined transition is a conservative NO-OP", () => {
    expect(mountTransition("live", "mounted")).toBe("live");
    expect(mountTransition("detached", "syncStart")).toBe("detached");
  });
});

describe("aggregate status fold — worst scope wins, never masked", () => {
  it("mountHealth maps each state to a severity band", () => {
    expect(mountHealth("failed")).toBe("error");
    expect(mountHealth("diverged")).toBe("diverged");
    expect(mountHealth("offline")).toBe("offline");
    expect(mountHealth("syncing")).toBe("busy");
    expect(mountHealth("live")).toBe("ok");
    expect(mountHealth("detached")).toBe("idle");
  });
  it("foldHealth returns the worst; empty ⇒ idle", () => {
    expect(foldHealth([])).toBe("idle");
    expect(foldHealth(["ok", "busy", "ok"])).toBe("busy");
    expect(foldHealth(["ok", "offline", "error"])).toBe("error");
  });
  it("aggregateStatus names the worst scope as the reason (a failing mount is not hidden by a healthy primary)", () => {
    expect(aggregateStatus("ok", [{ label: "Work/ASI", state: "live" }])).toEqual({ health: "ok", reason: "primary" });
    expect(aggregateStatus("ok", [{ label: "Work/ASI", state: "offline" }, { label: "Refs", state: "live" }]))
      .toEqual({ health: "offline", reason: "mount Work/ASI" });
    // a healthy mount never masks a primary problem
    expect(aggregateStatus("error", [{ label: "Work/ASI", state: "live" }])).toEqual({ health: "error", reason: "primary" });
  });
});

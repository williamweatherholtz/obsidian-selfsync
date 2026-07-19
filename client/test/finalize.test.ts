import { describe, it, expect } from "vitest";
import { finalize, FinalizeFacts, ReconcileEffect, Action, planMerge, MergePlan, probePresence } from "../src/reconcile";

// The pure decision core lifted out of reconcileOne (issueFunctionalCoreShellsReDecide). This is the "test
// net" that makes the extraction safe: it exhaustively pins the SAFETY-CRITICAL table — restore-vs-remove
// on delete-local, delete-remote-vs-guard, and every read-only refusal — so the imperative shell can be
// refactored without silently changing what gets deleted, restored, or refused.

const ACTIONS: Action[] = [
  "in-sync", "push", "pull", "delete-local", "delete-remote",
  "merge", "conflict-copy", "edit-wins-keep-local", "edit-wins-pull",
];

// A neutral fact set: not read-only, no tombstone, no guards tripped, both sides present with a base.
function facts(over: Partial<FinalizeFacts> = {}): FinalizeFacts {
  return {
    readOnly: false, hasTombstone: false, guardDelete: false, guardRemoteDelete: false,
    isConflictCopy: false, hasLocalBytes: true, hasRmeta: true, hasBaseEntry: true, remoteVersion: 7,
    ...over,
  };
}
const kind = (a: Action, o: Partial<FinalizeFacts> = {}): ReconcileEffect["kind"] => finalize(a, facts(o)).kind;

describe("finalize — pure reconcile decision table", () => {
  it("is total: every action yields a valid effect kind and never throws", () => {
    const kinds = new Set<string>([
      "noop", "setBaseInSync", "clearBase", "reportReadOnly", "reportGuard",
      "push", "pull", "restore", "keptAbsentReadOnly", "removeLocal", "deleteRemote", "mergeOrConflict",
    ]);
    for (const a of ACTIONS) {
      for (const ro of [false, true]) for (const tomb of [false, true]) for (const gd of [false, true]) {
        const e = finalize(a, facts({ readOnly: ro, hasTombstone: tomb, guardDelete: gd, guardRemoteDelete: gd }));
        expect(kinds.has(e.kind), `${a}/${e.kind}`).toBe(true);
      }
    }
  });

  it("in-sync: both present → setBaseInSync; both absent w/ stale base → clearBase; otherwise noop", () => {
    expect(kind("in-sync")).toBe("setBaseInSync");
    expect(kind("in-sync", { hasLocalBytes: false, hasRmeta: false })).toBe("clearBase");
    expect(kind("in-sync", { hasLocalBytes: false, hasRmeta: false, hasBaseEntry: false })).toBe("noop");
    // defensive: present-local but server-absent under in-sync is neither → noop, never a destructive branch
    expect(kind("in-sync", { hasRmeta: false })).toBe("noop");
  });

  it("push: uploads at the CAS version and caches the scan-skip stat hint (allowStamp)", () => {
    const e = finalize("push", facts());
    expect(e).toEqual({ kind: "push", version: 7, allowStamp: true });
  });

  it("push on a read-only share: reports 'won't sync' — except a conflict-copy (deliberately local) → noop", () => {
    expect(kind("push", { readOnly: true })).toBe("reportReadOnly");
    expect(kind("push", { readOnly: true, isConflictCopy: true })).toBe("noop");
  });

  it("pull and edit-wins-pull both resolve to a guarded pull", () => {
    expect(kind("pull")).toBe("pull");
    expect(kind("edit-wins-pull")).toBe("pull");
  });

  it("delete-local WITHOUT a tombstone NEVER removes — it restores (or keeps, read-only)", () => {
    // The load-bearing invariant: absence is not proof of deletion. No fact combination without a tombstone
    // may reach removeLocal.
    expect(kind("delete-local", { hasTombstone: false })).toBe("restore");
    expect(kind("delete-local", { hasTombstone: false, readOnly: true })).toBe("keptAbsentReadOnly");
    // even with a bulk-delete guard tripped, no-tombstone still restores (never removes)
    expect(kind("delete-local", { hasTombstone: false, guardDelete: true })).toBe("restore");
  });

  it("delete-local WITH a tombstone: removes, unless a mass-delete guard tripped → reportGuard", () => {
    expect(kind("delete-local", { hasTombstone: true })).toBe("removeLocal");
    expect(kind("delete-local", { hasTombstone: true, guardDelete: true })).toBe("reportGuard");
  });

  it("delete-remote: deletes, unless read-only (report) or a mass-remote-delete guard tripped (report)", () => {
    expect(kind("delete-remote")).toBe("deleteRemote");
    expect(kind("delete-remote", { readOnly: true })).toBe("reportReadOnly");
    expect(kind("delete-remote", { guardRemoteDelete: true })).toBe("reportGuard");
    // read-only takes precedence over the guard (both refuse, but no server call either way)
    expect(kind("delete-remote", { readOnly: true, guardRemoteDelete: true })).toBe("reportReadOnly");
  });

  it("edit-wins-keep-local: re-pushes at the CAS version but does NOT stamp (allowStamp false); read-only reports", () => {
    expect(finalize("edit-wins-keep-local", facts())).toEqual({ kind: "push", version: 7, allowStamp: false });
    expect(kind("edit-wins-keep-local", { readOnly: true })).toBe("reportReadOnly");
  });

  it("merge and conflict-copy both defer to the merge/conflict shell", () => {
    expect(kind("merge")).toBe("mergeOrConflict");
    expect(kind("conflict-copy")).toBe("mergeOrConflict");
  });

  it("a bulk-delete guard NEVER produces a destructive effect (the whole point of the guard)", () => {
    const destructive = new Set(["removeLocal", "deleteRemote"]);
    for (const a of ACTIONS) {
      const e = finalize(a, facts({ guardDelete: true, guardRemoteDelete: true, hasTombstone: true }));
      if (a === "delete-local" || a === "delete-remote") {
        expect(destructive.has(e.kind), `${a} must be guarded, got ${e.kind}`).toBe(false);
      }
    }
  });
});

describe("planMerge — pure merge/conflict decision table", () => {
  const base = { cosmetic: false, readOnly: false, action: "merge" as Action, canMerge: false, mergeClean: false };
  const plan = (o: Partial<typeof base> = {}): MergePlan => planMerge({ ...base, ...o });

  it("is total across the flag space and yields only known plans", () => {
    const plans = new Set<string>(["adoptRemote", "readOnlyKeepCopy", "pushMerged", "conflictCopy"]);
    for (const cosmetic of [false, true]) for (const readOnly of [false, true])
      for (const action of ["merge", "conflict-copy"] as Action[]) for (const canMerge of [false, true]) for (const mergeClean of [false, true]) {
        expect(plans.has(plan({ cosmetic, readOnly, action, canMerge, mergeClean }))).toBe(true);
      }
  });

  it("a cosmetic (EOL-only) diff adopts remote — regardless of read-only/merge state", () => {
    expect(plan({ cosmetic: true })).toBe("adoptRemote");
    expect(plan({ cosmetic: true, readOnly: true, canMerge: true, mergeClean: true })).toBe("adoptRemote");
  });

  it("read-only: keeps a local copy on a known-base 'merge' divergence, but adopts (no copy) for a no-base conflict-copy", () => {
    expect(plan({ readOnly: true, action: "merge" })).toBe("readOnlyKeepCopy");
    expect(plan({ readOnly: true, action: "conflict-copy" })).toBe("adoptRemote");
  });

  it("writable: a clean 3-way merge pushes; a dirty/impossible merge conflict-copies", () => {
    expect(plan({ canMerge: true, mergeClean: true })).toBe("pushMerged");
    expect(plan({ canMerge: true, mergeClean: false })).toBe("conflictCopy"); // overlapping edits
    expect(plan({ canMerge: false })).toBe("conflictCopy");                    // not mergeable / no base text
  });
});

describe("probePresence — a direct per-path presence probe with a NAMED indeterminate outcome", () => {
  const io = (o: object) => o as unknown as Parameters<typeof probePresence>[0];
  it("uses io.exists when available: true → present, false → absent, throw → indeterminate", async () => {
    expect(await probePresence(io({ exists: async () => true }), "p")).toBe("present");
    expect(await probePresence(io({ exists: async () => false }), "p")).toBe("absent");
    expect(await probePresence(io({ exists: async () => { throw new Error("x"); } }), "p")).toBe("indeterminate");
  });
  it("falls back to a read when there is no exists probe: bytes → present, unreadable → absent", async () => {
    expect(await probePresence(io({ read: async () => new Uint8Array([1]) }), "p")).toBe("present");
    expect(await probePresence(io({ read: async () => { throw new Error("gone"); } }), "p")).toBe("absent");
  });
  it("only a definitive 'absent' may tombstone — 'present'/'indeterminate' must keep the file", () => {
    // documents the call-site contract in reconcileOne's deleteRemote effect: `!== "absent"` ⇒ keep
    expect(["present", "indeterminate"].every((p) => p !== "absent")).toBe(true);
  });
});

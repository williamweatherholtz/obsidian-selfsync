import { describe, it, expect } from "vitest";
import {
  encodeCompositionRecipe, parseCompositionRecipe, isCompositionRecipe, recipeMountsFrom,
  planRecipeImport, mountFromPlanItem, RecipeReaderContext,
} from "../src/composition-recipe";
import { Mount } from "../src/mounts";

const mount = (owner: string, vaultId: string, sourcePath: string, mountPoint: string, direction: "pull" | "sync" = "pull"): Mount =>
  ({ source: { owner, vaultId, sourcePath }, mountPoint, direction });

describe("composition-recipe codec (nComposeRecipe)", () => {
  it("encodes then parses back the same mounts + server", () => {
    const mounts = [mount("", "asi", "Notes", "Work/ASI", "sync"), mount("alice", "team", "", "Team")];
    const str = encodeCompositionRecipe(mounts, "https://sync.example", "bob");
    expect(isCompositionRecipe(str)).toBe(true);
    const back = parseCompositionRecipe(str);
    expect(back.server).toBe("https://sync.example");
    // own-vault ("") is absolutized to the exporter's account so the recipe is unambiguous for a DIFFERENT reader
    expect(back.mounts).toEqual([
      mount("bob", "asi", "Notes", "Work/ASI", "sync"),
      mount("alice", "team", "", "Team"),
    ]);
  });

  it("carries NO credential — never a token/password/login", () => {
    const str = encodeCompositionRecipe([mount("", "v", "", "V")], "https://s", "bob");
    expect(str).not.toMatch(/token|password|passwd|secret|auth|login/i);
  });

  it("normalizes the server and requires an account", () => {
    expect(parseCompositionRecipe(encodeCompositionRecipe([mount("", "v", "", "V")], "https://s.example/", "bob")).server).toBe("https://s.example");
    expect(() => encodeCompositionRecipe([mount("", "v", "", "V")], "https://s", "")).toThrow(/Sign in first/);
    expect(() => encodeCompositionRecipe([], "https://s", "bob")).toThrow(/no active mounts/i);
  });

  it("rejects a non-recipe, malformed JSON, and an empty payload", () => {
    expect(() => parseCompositionRecipe("selfsync-share://redeem?server=https://s&token=t")).toThrow(/doesn't look like/i);
    expect(() => parseCompositionRecipe("https://evil.example")).toThrow(/doesn't look like/i);
    expect(() => parseCompositionRecipe("selfsync-recipe://import?server=https://s&mounts=%7Bnot-json")).toThrow(/malformed/i);
    expect(() => parseCompositionRecipe("selfsync-recipe://import?server=https://s&mounts=%5B%5D")).toThrow(/no valid mounts/i);
  });

  it("parse-don't-validate: drops malformed + empty-owner entries, normalizes folders, defaults pull", () => {
    const raw = [
      { owner: "bob", vaultId: "v", sourcePath: " Notes/ ", mountPoint: " Work/ASI. ", direction: "weird" }, // sanitized, bad dir → pull
      { owner: "", vaultId: "v", mountPoint: "X" },                 // empty owner → DROPPED (ambiguous, fail closed)
      { owner: "bob", vaultId: "", mountPoint: "X" },               // no source vault → dropped
      { owner: "bob", vaultId: "v", mountPoint: "" },               // root/blank mount point → dropped
      "not-an-object", 42, null,                                    // junk → dropped
    ];
    expect(recipeMountsFrom(raw)).toEqual([mount("bob", "v", "Notes", "Work/ASI", "pull")]);
  });

  it("recipeMountsFrom tolerates a non-array without throwing", () => {
    expect(recipeMountsFrom({})).toEqual([]);
    expect(recipeMountsFrom(null)).toEqual([]);
  });

  it("refuses a pathologically large recipe", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ owner: "bob", vaultId: "v" + i, mountPoint: "M" + i }));
    const str = "selfsync-recipe://import?server=https://s&mounts=" + encodeURIComponent(JSON.stringify(many));
    expect(() => parseCompositionRecipe(str)).toThrow(/unexpectedly large/i);
  });
});

describe("composition-recipe import planner (fail-closed reader-side)", () => {
  const ctx = (over: Partial<RecipeReaderContext> = {}): RecipeReaderContext => ({
    myAccount: "bob",
    primary: { owner: "", vaultId: "bobPrimary" },
    grants: [],
    existingMounts: [],
    ...over,
  });

  it("my OWN account's vault → ready, writable, owner collapses to \"\"", () => {
    const [p] = planRecipeImport([mount("bob", "asi", "Notes", "Work/ASI", "sync")], ctx());
    expect(p.status).toBe("ready");
    expect(p.writable).toBe(true);
    expect(p.localSource).toEqual({ owner: "", vaultId: "asi", sourcePath: "Notes" });
    expect(p.suggestedDirection).toBe("sync");
  });

  it("a FOREIGN source defaults to Pull even with a read-WRITE grant — the reader opts up, never the sharer", () => {
    // writable so Sync is OFFERABLE, but the sharer's `sync` is NOT auto-selected onto a shared vault (S2/H1)
    const rw = planRecipeImport([mount("alice", "team", "", "Team", "sync")], ctx({ grants: [{ owner: "alice", vault: "team", perm: "readWrite" }] }))[0];
    expect(rw.status).toBe("ready"); expect(rw.writable).toBe(true); expect(rw.suggestedDirection).toBe("pull");
    const ro = planRecipeImport([mount("alice", "team", "", "Team", "sync")], ctx({ grants: [{ owner: "alice", vault: "team", perm: "read" }] }))[0];
    expect(ro.status).toBe("ready"); expect(ro.writable).toBe(false); expect(ro.suggestedDirection).toBe("pull");
  });

  it("account comparison is case-insensitive (server lowercases usernames; client persists as-typed)", () => {
    // sharer typed "Alice"; her own vault is absolutized AND canonicalized to lowercase in the recipe
    expect(parseCompositionRecipe(encodeCompositionRecipe([mount("", "asi", "", "ASI")], "https://s", "Alice")).mounts[0].source.owner).toBe("alice");
    // a genuine grant (lowercase from the server) still matches a recipe owner of any case → ready, not noAccess
    const g = planRecipeImport([mount("Alice", "team", "", "Team")], ctx({ grants: [{ owner: "alice", vault: "team", perm: "readWrite" }] }))[0];
    expect(g.status).toBe("ready"); expect(g.localSource.owner).toBe("alice");
    // own-vault round-trip where the two devices' username case differs → still collapses to my own ("")
    const own = planRecipeImport([mount("Bob", "asi", "", "ASI")], ctx({ myAccount: "bob" }))[0];
    expect(own.status).toBe("ready"); expect(own.localSource.owner).toBe("");
  });

  it("a case/Unicode variant of an existing mount is still a duplicate (canonical path compare)", () => {
    const existing = [mount("", "asi", "Notes", "Work/ASI")];
    expect(planRecipeImport([mount("bob", "asi", "notes", "work/asi")], ctx({ existingMounts: existing }))[0].status).toBe("duplicate");
  });

  it("offline (grants unknown → empty) plans foreign sources as noAccess, never a false ready", () => {
    expect(planRecipeImport([mount("alice", "team", "", "Team", "sync")], ctx({ grants: [] }))[0].status).toBe("noAccess");
  });

  it("a foreign source with no grant → noAccess (never silently grabbed)", () => {
    expect(planRecipeImport([mount("carol", "x", "", "X")], ctx())[0].status).toBe("noAccess");
  });

  it("my current primary vault → selfPrimary (can't mount a vault into itself)", () => {
    const mine = planRecipeImport([mount("bob", "bobPrimary", "", "Self")], ctx())[0];
    expect(mine.status).toBe("selfPrimary");
    // and a SHARED primary (syncing someone else's vault as primary) is caught too
    const shared = planRecipeImport([mount("alice", "team", "", "Self")],
      ctx({ primary: { owner: "alice", vaultId: "team" }, grants: [{ owner: "alice", vault: "team", perm: "readWrite" }] }))[0];
    expect(shared.status).toBe("selfPrimary");
  });

  it("an identical existing mount → duplicate", () => {
    const existing = [mount("", "asi", "Notes", "Work/ASI")];
    expect(planRecipeImport([mount("bob", "asi", "Notes", "Work/ASI")], ctx({ existingMounts: existing }))[0].status).toBe("duplicate");
  });

  it("mountFromPlanItem localizes the owner and re-clamps direction fail-closed", () => {
    const roItem = planRecipeImport([mount("alice", "team", "", "Team", "sync")], ctx({ grants: [{ owner: "alice", vault: "team", perm: "read" }] }))[0];
    // even if the UI passed "sync", a non-writable source is clamped to pull
    expect(mountFromPlanItem(roItem, "MyTeam", "sync")).toEqual(mount("alice", "team", "", "MyTeam", "pull"));
    const ownItem = planRecipeImport([mount("bob", "asi", "Notes", "Work/ASI", "sync")], ctx())[0];
    expect(mountFromPlanItem(ownItem, "Work/ASI", "sync")).toEqual(mount("", "asi", "Notes", "Work/ASI", "sync"));
  });
});

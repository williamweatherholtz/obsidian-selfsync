// Comprehensive two-client integration matrix (real server binary + real chunk engine + real files).
// Complements e2e.spec.ts by targeting the dimensions that suite under-covers:
//   1. OFFLINE → RECONNECT (one side offline while the other creates/modifies/deletes)
//   2. CONCURRENT OFFLINE DIVERGENCE (both sides change while apart, then converge)
//   3. The INCREMENTAL DELTA path (reconcileDelta / poll) — production's steady-state, and the
//      R14 sync#1 cursor-hold-on-transient-failure fix — which e2e.spec only exercises via reconcileAll
//   4. SCALE extremes (many files, deep nesting, long/punctuated/Unicode paths)
//   5. PLUGINS (count, large main.js, add/remove propagation under the allowlist)
//
// Model (matches production, D0045/R13): a RECONNECT does a full reconcileAll; steady-state POLLS do
// an incremental reconcileDelta over changes(since cursor). Both are the real engine, same as the plugin.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  startServer, RunningServer, connect, dep, enc, dec, exists, canRun,
  NodeTransport, FilteredFsVaultIo, Client,
} from "./e2e-helpers";
import { reconcileAll, reconcileDelta } from "../src/reconcile";
import { BaseStore } from "../src/base";
import { DEFAULT_CONFIG_SYNC, ConfigSyncSelection } from "../src/configsync";

let server: RunningServer;
let base = "";

// A RECONNECT / initial sync = full reconcile (what doConnect does).
const reconnect = (c: Client) => reconcileAll(dep(c));
// A steady-state POLL = incremental delta over the cursor (what the poll timer does after R13).
async function poll(c: Client): Promise<void> {
  const delta = await c.api.changes(c.state.version);
  await reconcileDelta(dep(c), delta);
}

let vaultSeq = 0;
async function pair(tag: string): Promise<[Client, Client]> {
  const v = `im-${tag}-${vaultSeq++}`;
  const a = await connect(base, mkdtempSync(path.join(os.tmpdir(), `im-${tag}A-`)), "A", v);
  const b = await connect(base, mkdtempSync(path.join(os.tmpdir(), `im-${tag}B-`)), "B", v);
  return [a, b];
}
async function filteredPair(tag: string, sel: ConfigSyncSelection, selfId: string): Promise<[Client, Client]> {
  const v = `im-${tag}-${vaultSeq++}`;
  const token = await NodeTransport.login(base, "admin", "admin");
  await NodeTransport.createVault(base, token, v).catch(() => {});
  const mk = async (dev: string): Promise<Client> => {
    const root = mkdtempSync(path.join(os.tmpdir(), `im-${tag}${dev}-`));
    const c: Client = { io: new FilteredFsVaultIo(root, sel, selfId), api: new NodeTransport(base, token, v), state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device: dev, root };
    await reconcileAll(dep(c));
    return c;
  };
  return [await mk("A"), await mk("B")];
}
const clean = (...cs: Client[]) => cs.forEach((c) => rmSync(c.root, { recursive: true, force: true }));

beforeAll(async () => { server = await startServer(); base = server.base; }, 40000);
afterAll(async () => { await server?.stop(); });

describe.skipIf(!canRun)("integration matrix: offline/reconnect × ops × scale × plugins", () => {
  // ── 1. OFFLINE → RECONNECT (one side offline while the other changes) ────────────────
  it("offline peer receives create/modify/delete made while it was away (reconnect)", async () => {
    const [a, b] = await pair("off-recv");
    await a.io.write("keep.md", enc("anchor")); await a.io.write("doc.md", enc("v1"));
    await reconnect(a); await reconnect(b);
    expect(dec(await b.io.read("doc.md"))).toBe("v1");
    // B goes offline (stops syncing). A creates, modifies, deletes.
    await a.io.write("doc.md", enc("v2-edited"));   // modify
    await a.io.write("new.md", enc("brand new"));   // create
    await a.io.remove("doc.md"); // (then delete the modified one to test delete-after-modify)
    await a.io.write("doc.md", enc("v3-final"));    // recreate so we assert final content, not the delete
    await reconnect(a); // A pushes everything
    // B reconnects (full) and must converge to A's final state.
    await reconnect(b);
    expect(dec(await b.io.read("doc.md"))).toBe("v3-final");
    expect(dec(await b.io.read("new.md"))).toBe("brand new");
    clean(a, b);
  }, 30000);

  it("offline peer PUSHES its own offline create/modify/delete on reconnect", async () => {
    const [a, b] = await pair("off-push");
    await a.io.write("keep.md", enc("anchor")); await a.io.write("shared.md", enc("base"));
    await reconnect(a); await reconnect(b);
    // B offline: makes local changes with no connectivity.
    await b.io.write("bLocal.md", enc("made offline on B"));
    await b.io.write("shared.md", enc("B changed shared offline"));
    // B reconnects → pushes; A polls and receives.
    await reconnect(b);
    await poll(a);
    expect(dec(await a.io.read("bLocal.md"))).toBe("made offline on B");
    expect(dec(await a.io.read("shared.md"))).toBe("B changed shared offline");
    clean(a, b);
  }, 30000);

  it("a delete made while the peer was offline propagates on reconnect (tombstone)", async () => {
    const [a, b] = await pair("off-del");
    await a.io.write("keep.md", enc("anchor")); await a.io.write("gone.md", enc("doomed"));
    await reconnect(a); await reconnect(b);
    expect(await exists(path.join(b.root, "gone.md"))).toBe(true);
    // B offline; A deletes gone.md.
    await a.io.remove("gone.md"); await reconnect(a);
    // B reconnects → the tombstone propagates, gone.md removed locally (keep.md anchors the guard).
    await reconnect(b);
    expect(await exists(path.join(b.root, "gone.md"))).toBe(false);
    expect(await exists(path.join(b.root, "keep.md"))).toBe(true);
    clean(a, b);
  }, 30000);

  // ── 2. CONCURRENT OFFLINE DIVERGENCE (both change while apart) ───────────────────────
  it("both sides edit DIFFERENT files offline → converge with no loss", async () => {
    const [a, b] = await pair("div-diff");
    await a.io.write("keep.md", enc("anchor")); await reconnect(a); await reconnect(b);
    // Apart: A and B each create/edit their own files.
    await a.io.write("onlyA.md", enc("A offline work"));
    await b.io.write("onlyB.md", enc("B offline work"));
    // Reconnect order: A pushes, B reconnects (sees A + pushes its own), A polls.
    await reconnect(a); await reconnect(b); await poll(a);
    expect(dec(await a.io.read("onlyB.md"))).toBe("B offline work");
    expect(dec(await b.io.read("onlyA.md"))).toBe("A offline work");
    clean(a, b);
  }, 30000);

  it("both sides edit the SAME markdown offline (disjoint lines) → 3-way merge keeps both", async () => {
    const [a, b] = await pair("div-merge");
    await a.io.write("m.md", enc("l1\nl2\nl3\nl4\nl5\n")); await reconnect(a); await reconnect(b);
    // Apart: A edits line 1, B edits line 5.
    await a.io.write("m.md", enc("L1-by-A\nl2\nl3\nl4\nl5\n"));
    await b.io.write("m.md", enc("l1\nl2\nl3\nl4\nL5-by-B\n"));
    await reconnect(a);          // A pushes
    await reconnect(b);          // B merges A's change with its own, pushes merged
    await poll(a);               // A pulls merged
    const merged = dec(await a.io.read("m.md"));
    expect(merged).toContain("L1-by-A"); expect(merged).toContain("L5-by-B");
    // Both sides identical after convergence.
    expect(dec(await b.io.read("m.md"))).toBe(merged);
    clean(a, b);
  }, 30000);

  it("same-file divergent BINARY offline → conflict copy on the second reconciler (nothing lost)", async () => {
    const [a, b] = await pair("div-bin");
    const b0 = new Uint8Array(5000).map((_, i) => i & 0xff);
    await a.io.write("k.md", enc("anchor")); await a.io.write("x.bin", b0);
    await reconnect(a); await reconnect(b);
    await a.io.write("x.bin", b0.map((v) => v ^ 0x55));
    await b.io.write("x.bin", b0.map((v) => (v + 7) & 0xff));
    await reconnect(a); await reconnect(b);
    const copies = [...(await b.io.list()).keys()].filter((p) => p.includes("(conflict"));
    expect(copies.length).toBe(1);                               // B kept its own copy
    expect(await exists(path.join(b.root, "x.bin"))).toBe(true); // and holds A's canonically
    clean(a, b);
  }, 30000);

  // ── 3. INCREMENTAL DELTA path (steady-state poll) ────────────────────────────────────
  it("incremental delta PULL applies create/modify/delete on the receiver", async () => {
    // The sender pushes via a scan (full reconcile / event path — a delta poll only PULLS remote
    // changes, it doesn't scan local files); the RECEIVER converges via reconcileDelta (poll), which
    // is what this exercises. keep.md anchors the bulk-delete guard through the delete step.
    const [a, b] = await pair("delta");
    await a.io.write("keep.md", enc("anchor")); await reconnect(a); await reconnect(b);
    await a.io.write("d.md", enc("created")); await reconnect(a); await poll(b);   // create → delta pull
    expect(dec(await b.io.read("d.md"))).toBe("created");
    await a.io.write("d.md", enc("modified")); await reconnect(a); await poll(b);  // modify → delta pull
    expect(dec(await b.io.read("d.md"))).toBe("modified");
    await a.io.remove("d.md"); await reconnect(a); await poll(b);                  // delete → delta pull (tombstone)
    expect(await exists(path.join(b.root, "d.md"))).toBe(false);
    clean(a, b);
  }, 30000);

  it("many changes accumulated offline apply in a SINGLE delta poll on reconnect", async () => {
    const [a, b] = await pair("delta-batch");
    await a.io.write("keep.md", enc("anchor")); await reconnect(a); await reconnect(b);
    for (let i = 0; i < 40; i++) await a.io.write(`batch/${i}.md`, enc(`item ${i}`));
    await reconnect(a);                 // A pushes all 40
    await poll(b);                      // ONE incremental delta applies all 40 to B
    for (let i = 0; i < 40; i++) expect(dec(await b.io.read(`batch/${i}.md`))).toBe(`item ${i}`);
    clean(a, b);
  }, 60000);

  it("R14 sync#1: a transient pull failure is RETRIED by the next delta poll (not stranded)", async () => {
    const [a, b] = await pair("delta-retry");
    await a.io.write("keep.md", enc("anchor")); await reconnect(a); await reconnect(b);
    await a.io.write("flaky.md", enc("needs a retry")); await reconnect(a);
    // B's next poll transiently fails to fetch flaky.md's chunk.
    let fail = true;
    const realGet = b.api.getChunk.bind(b.api);
    b.api.getChunk = async (h: string) => { if (fail) throw new Error("transient 500"); return realGet(h); };
    await poll(b);                                            // flaky.md fails, isolated
    expect(await exists(path.join(b.root, "flaky.md"))).toBe(false); // not yet applied
    // Recover: a normal poll (NOT a full reconcile) must retry it — proving the cursor was held.
    fail = false;
    await poll(b);
    expect(dec(await b.io.read("flaky.md"))).toBe("needs a retry");
    b.api.getChunk = realGet;
    clean(a, b);
  }, 30000);

  // ── 3b. RENAME / MOVE (research issue #3: renames must not lose content or duplicate) ──
  it("rename: a file moved to a new path converges — old gone, new present, content intact, no duplicate", async () => {
    const [a, b] = await pair("rename");
    await a.io.write("keep.md", enc("anchor"));
    await a.io.write("old-name.md", enc("the content"));
    await reconnect(a); await reconnect(b);
    expect(dec(await b.io.read("old-name.md"))).toBe("the content");
    // Obsidian rename = remove old + create new. Content-addressed chunks persist, so the new path
    // dedups them (no re-upload, no content loss); the old path propagates as a tombstone.
    await a.io.remove("old-name.md");
    await a.io.write("new-name.md", enc("the content"));
    await reconnect(a); await poll(b);
    expect(await exists(path.join(b.root, "old-name.md"))).toBe(false);   // old path gone
    expect(dec(await b.io.read("new-name.md"))).toBe("the content");       // new path, content intact
    expect([...(await b.io.list()).keys()].sort()).toEqual(["keep.md", "new-name.md"]); // no duplicate
  });

  it("folder rename: every file under it moves, none lost (the LiveSync content-loss case)", async () => {
    const [a, b] = await pair("folder-rename");
    await a.io.write("keep.md", enc("anchor"));
    for (const n of ["a.md", "b.md", "sub/c.md"]) await a.io.write(`Old/${n}`, enc(`body ${n}`));
    await reconnect(a); await reconnect(b);
    expect(dec(await b.io.read("Old/sub/c.md"))).toBe("body sub/c.md");
    // Rename the folder = move each file from Old/ to New/.
    for (const n of ["a.md", "b.md", "sub/c.md"]) { await a.io.remove(`Old/${n}`); await a.io.write(`New/${n}`, enc(`body ${n}`)); }
    await reconnect(a); await poll(b);
    for (const n of ["a.md", "b.md", "sub/c.md"]) {
      expect(await exists(path.join(b.root, "Old", ...n.split("/")))).toBe(false); // old tree gone
      expect(dec(await b.io.read(`New/${n}`))).toBe(`body ${n}`);                   // all content preserved under New/
    }
  });

  // ── 4. SCALE extremes ────────────────────────────────────────────────────────────────
  it("scale: 500 files across nested dirs sync (delta), count matches", async () => {
    const [a, b] = await pair("scale500");
    for (let i = 0; i < 500; i++) await a.io.write(`s/${i % 10}/${i % 50}/f${i}.md`, enc(`n${i}`));
    await reconnect(a); await poll(b);
    const list = await b.io.list();
    expect(list.size).toBe(500);
    expect(dec(await b.io.read("s/9/49/f499.md"))).toBe("n499");
    clean(a, b);
  }, 120000);

  it("scale: very deep directory nesting round-trips at the same path", async () => {
    const [a, b] = await pair("deep");
    const deep = Array.from({ length: 14 }, (_, i) => `lvl${i}`).join("/") + "/leaf.md";
    await a.io.write("keep.md", enc("anchor")); await a.io.write(deep, enc("bottom of the well"));
    await reconnect(a); await poll(b);
    expect(dec(await b.io.read(deep))).toBe("bottom of the well");
    clean(a, b);
  }, 30000);

  it("filenames: punctuation, spaces, long names, and mixed Unicode all round-trip", async () => {
    const [a, b] = await pair("names");
    const names = [
      "keep.md",
      "a note (final) [v2] {draft} - copy.md",
      "under_score-and.dot.and space.md",
      "π≈3.14 & 50% off — 日本語 café.md",
      "emoji 🚀☕/nested 🇯🇵 note.md",
      "l".repeat(180) + ".md", // long (but under the 255 fs limit)
      // NB: trailing-space/dot path segments are intentionally NOT tested — the server's safe_rel_path
      // rejects them (portable-naming guard) and Windows strips them on disk, so they're unsupported by design.
    ];
    for (const n of names) await a.io.write(n, enc("body of " + n.slice(0, 10)));
    await reconnect(a); await poll(b);
    for (const n of names) expect(dec(await b.io.read(n))).toBe("body of " + n.slice(0, 10));
    clean(a, b);
  }, 60000);

  // ── 5. PLUGINS (count, size, add/remove) ─────────────────────────────────────────────
  it("plugins: MANY allowlisted plugin folders all propagate; a non-allowlisted one does not", async () => {
    const SELF = "selfsync";
    const allow = Array.from({ length: 20 }, (_, i) => `plugin${i}`);
    const sel: ConfigSyncSelection = { ...DEFAULT_CONFIG_SYNC, enabled: true, community: true, pluginAllow: allow };
    const [a, b] = await filteredPair("many-plugins", sel, SELF);
    await a.io.write("keep.md", enc("anchor"));
    for (const id of allow) {
      await a.io.write(`.obsidian/plugins/${id}/data.json`, enc(`{"id":"${id}"}`));
      await a.io.write(`.obsidian/plugins/${id}/main.js`, enc(`module.exports=${JSON.stringify(id)};`));
    }
    // A plugin NOT in the allowlist (written via raw fs) must stay local.
    await fs.mkdir(path.join(a.root, ".obsidian", "plugins", "notallowed"), { recursive: true });
    await fs.writeFile(path.join(a.root, ".obsidian", "plugins", "notallowed", "main.js"), "nope");
    await reconnect(a); await poll(b);
    for (const id of allow) {
      expect(dec(await b.io.read(`.obsidian/plugins/${id}/data.json`))).toBe(`{"id":"${id}"}`);
      expect(dec(await b.io.read(`.obsidian/plugins/${id}/main.js`))).toBe(`module.exports=${JSON.stringify(id)};`);
    }
    expect(await exists(path.join(b.root, ".obsidian", "plugins", "notallowed", "main.js"))).toBe(false);
    clean(a, b);
  }, 120000);

  it("plugins: a LARGE plugin main.js (~2 MB) propagates byte-exact", async () => {
    const SELF = "selfsync";
    const sel: ConfigSyncSelection = { ...DEFAULT_CONFIG_SYNC, enabled: true, community: true, pluginAllow: ["big"] };
    const [a, b] = await filteredPair("big-plugin", sel, SELF);
    await a.io.write("keep.md", enc("anchor"));
    const bigJs = enc("/*x*/" + "a".repeat(2 * 1024 * 1024) + "//end");
    await a.io.write(".obsidian/plugins/big/main.js", bigJs);
    await reconnect(a); await poll(b);
    expect(await b.io.read(".obsidian/plugins/big/main.js")).toEqual(bigJs);
    clean(a, b);
  }, 120000);

  it("plugins: removing a plugin on A propagates the removal to B (config auto-remove)", async () => {
    const SELF = "selfsync";
    const sel: ConfigSyncSelection = { ...DEFAULT_CONFIG_SYNC, enabled: true, community: true, pluginAllow: ["temp", "stay"] };
    const [a, b] = await filteredPair("plugin-rm", sel, SELF);
    await a.io.write("keep.md", enc("anchor"));
    await a.io.write(".obsidian/plugins/stay/main.js", enc("stays"));
    await a.io.write(".obsidian/plugins/temp/main.js", enc("goes away"));
    await reconnect(a); await poll(b);
    expect(await exists(path.join(b.root, ".obsidian", "plugins", "temp", "main.js"))).toBe(true);
    // Remove temp's file on A → the removal propagates.
    await a.io.remove(".obsidian/plugins/temp/main.js");
    await reconnect(a); await poll(b);
    expect(await exists(path.join(b.root, ".obsidian", "plugins", "temp", "main.js"))).toBe(false);
    expect(await exists(path.join(b.root, ".obsidian", "plugins", "stay", "main.js"))).toBe(true);
    clean(a, b);
  }, 60000);
});

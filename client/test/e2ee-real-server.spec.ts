// E4 (1) to (6): end-to-end encryption against the REAL server binary and the REAL reconcile engine, no
// Obsidian. The owner creates an encrypted vault, a second account joins it through a share link with the
// password, and they push, pull, three-way merge, produce a binary conflict copy, and sync a config change.
// They migrate a plaintext vault to an encrypted one under the same name and re-share it. The server data
// volume holds the plaintext markers nowhere. A client that synced the plaintext vault before the migration
// and sends no header gets 403, and its local vault is byte-identical. Dedup holds across devices. A corrupt
// index rebuilds from the mirror and the SAME two clients re-verify. A row the real server serves under
// another path is refused by the cid. The scenarios run in order and share state: vitest runs a file's tests
// sequentially, and (2) to (6) build on (1). Needs the local server binary: (5) corrupts its index on disk.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reconcileAll } from "../src/reconcile";
import { startServer, serverBin, NodeTransport, dep, dec, exists, RunningServer } from "./e2e-helpers";
import { E2eeNodeTransport, CountingApi, mkE2eeClient, edep, grepTree, snapshotTree, E2EE_SCOPE, E2eeClient } from "./e2ee-real-helpers";
import { createKeyring, openKeyring } from "../src/e2ee/keyring";
import { deriveSubkeys } from "../src/e2ee/subkeys";
import { E2eeCodec } from "../src/e2ee/codec";
import { ConnError, Endpoint, FailureKind, classifyConnectError, toConnErrorInfo, blockedTip, recoveryFor, RecoveryKind } from "../src/connstate";
import { FileMeta } from "../src/protocol";

const PASSWORD = "correct horse battery staple!";
const FAST = { m_kib: 64, t: 1, p: 1 }; // the KDF cost is not under test here (D0112 measures the shipped default on phones)
const MARKER = "PLAINTEXT-MARKER-7f3a9c";
const MARKER_NOTES = "PLAINTEXT-MARKER-notes-5b2e";

async function codecFor(keyringText: string): Promise<E2eeCodec> {
  const opened = await openKeyring(PASSWORD, keyringText);
  return E2eeCodec.fromKeys(await deriveSubkeys(opened.vk, opened.vaultId));
}
type Row = { path: string; hash: string; cid?: string; size: number; chunks: string[] };
async function rowsOf(base: string, tok: string, vault: string, owner = ""): Promise<Map<string, string>> {
  const r = await fetch(`${base}${E2EE_SCOPE(vault, owner)}/changes?since=0`, { headers: { authorization: `Bearer ${tok}`, "x-selfsync-e2ee": "1" } });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { upserts: Row[] };
  return new Map(j.upserts.map((u) => [u.path, `${u.hash}|${u.cid}|${u.size}|${u.chunks.join(",")}`]));
}
const files = async (c: E2eeClient) => [...(await c.io.list()).keys()].sort();

describe.skipIf(!existsSync(serverBin))("E4 end-to-end encryption against the real server", () => {
  let server: RunningServer; let base = "";
  const roots: string[] = [];
  let aliceTok = ""; let bobTok = "";
  let alice: E2eeClient; let bob: E2eeClient; let oldNotes: E2eeClient;
  let aliceApi: E2eeNodeTransport; let bobApi: E2eeNodeTransport;
  beforeAll(async () => { server = await startServer(); base = server.base; }, 30000);
  afterAll(async () => { await server?.stop(); for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  const root = (tag: string) => { const r = mkdtempSync(path.join(os.tmpdir(), `nls-e2ee-${tag}-`)); roots.push(r); return r; };

  it("(1) create, join through a share link, push, pull, merge, binary conflict, config change, migrate and re-share", async () => {
    const admin = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createUser(base, admin, "alice", "vaultpw12");
    await NodeTransport.createUser(base, admin, "bob", "vaultpw12");
    aliceTok = await NodeTransport.login(base, "alice", "vaultpw12");
    bobTok = await NodeTransport.login(base, "bob", "vaultpw12");

    // the owner creates the encrypted vault: POST with the keyring, then GET keyring echoes the bytes it was sent
    const created = await createKeyring(PASSWORD, { kdf: FAST });
    await E2eeNodeTransport.createVault(base, aliceTok, "secret", JSON.stringify(created.keyring));
    const kr = await E2eeNodeTransport.keyring(base, aliceTok, "secret");
    expect(kr.status).toBe(200);
    expect(kr.text).toBe(JSON.stringify(created.keyring));
    const aliceCodec = E2eeCodec.fromKeys(await deriveSubkeys(created.vk, created.vaultId));
    aliceApi = new E2eeNodeTransport(base, aliceTok, "secret");
    alice = mkE2eeClient(root("alice"), aliceApi, aliceCodec, "A");
    await fs.writeFile(path.join(alice.root, "Plan.md"), `line one ${MARKER}\nline two\nline three\n`);
    await fs.writeFile(path.join(alice.root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    await reconcileAll(edep(alice));

    // the second account joins through a share link WITH the password: its keyring is the owner's record
    const link = await NodeTransport.createShareLink(base, aliceTok, "secret", "readWrite");
    const ref = await NodeTransport.redeemShareLink(base, bobTok, link);
    expect(ref).toMatchObject({ owner: "alice", vault: "secret" });
    const bobKr = await E2eeNodeTransport.keyring(base, bobTok, "secret", "alice");
    expect(bobKr.status).toBe(200);
    const bobCodec = await codecFor(bobKr.text);
    expect(bobCodec.tag).toBe(aliceCodec.tag);
    bobApi = new E2eeNodeTransport(base, bobTok, "secret", "alice");
    bob = mkE2eeClient(root("bob"), bobApi, bobCodec, "B");
    await reconcileAll(edep(bob));
    expect(dec(await bob.io.read("Plan.md"))).toContain(MARKER);
    expect(await bob.io.read("img.png")).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

    // three-way merge: disjoint line edits on both sides
    await fs.writeFile(path.join(alice.root, "Plan.md"), `line one ${MARKER} (alice)\nline two\nline three\n`);
    await reconcileAll(edep(alice));
    await fs.writeFile(path.join(bob.root, "Plan.md"), `line one ${MARKER}\nline two\nline three (bob)\n`);
    await reconcileAll(edep(bob));
    await reconcileAll(edep(alice));
    const merged = dec(await alice.io.read("Plan.md"));
    expect(merged).toContain("(alice)"); expect(merged).toContain("(bob)");
    expect(dec(await bob.io.read("Plan.md"))).toBe(merged);

    // a divergent binary edit on both sides: a conflict copy, nothing lost
    await fs.writeFile(path.join(alice.root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]));
    await reconcileAll(edep(alice));
    await fs.writeFile(path.join(bob.root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 7, 7, 7]));
    await reconcileAll(edep(bob));
    expect((await files(bob)).some((n) => n.includes("(conflict"))).toBe(true);
    await reconcileAll(edep(alice));
    expect((await files(alice)).some((n) => n.includes("(conflict"))).toBe(true);

    // a config change rides the same channel
    await fs.mkdir(path.join(alice.root, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(alice.root, ".obsidian", "app.json"), `{"readableLineLength":false}`);
    await reconcileAll(edep(alice));
    await reconcileAll(edep(bob));
    expect(dec(await bob.io.read(".obsidian/app.json"))).toBe(`{"readableLineLength":false}`);

    // migrate a plaintext vault to an encrypted one under the same name, then re-share it. A second plaintext
    // client of that vault ("oldNotes", synced before the migration) is kept for clause (3).
    await NodeTransport.createVault(base, aliceTok, "notes");
    const plainNotes = mkE2eeClient(root("alice-notes"), new E2eeNodeTransport(base, aliceTok, "notes", "", false), undefined, "A");
    await fs.writeFile(path.join(plainNotes.root, "n.md"), `plain before migration ${MARKER_NOTES}\n`);
    await reconcileAll(dep(plainNotes));
    oldNotes = mkE2eeClient(root("old-notes"), new E2eeNodeTransport(base, aliceTok, "notes", "", false), undefined, "O");
    await reconcileAll(dep(oldNotes));
    expect(dec(await oldNotes.io.read("n.md"))).toContain(MARKER_NOTES);
    const oldLink = await NodeTransport.createShareLink(base, aliceTok, "notes", "read");
    await NodeTransport.redeemShareLink(base, bobTok, oldLink);
    await E2eeNodeTransport.deleteVault(base, aliceTok, "notes");
    expect((await E2eeNodeTransport.keyring(base, aliceTok, "notes")).status).toBe(404);
    const created2 = await createKeyring(PASSWORD, { kdf: FAST });
    await E2eeNodeTransport.createVault(base, aliceTok, "notes", JSON.stringify(created2.keyring));
    const notesCodec = E2eeCodec.fromKeys(await deriveSubkeys(created2.vk, created2.vaultId));
    const encNotes = mkE2eeClient(plainNotes.root, new E2eeNodeTransport(base, aliceTok, "notes"), notesCodec, "A");
    await reconcileAll(edep(encNotes));
    // the old grant is purged with the delete: bob must redeem a new link
    expect((await NodeTransport.listShared(base, bobTok)).some((s) => s.vault === "notes")).toBe(false);
    const newLink = await NodeTransport.createShareLink(base, aliceTok, "notes", "read");
    await NodeTransport.redeemShareLink(base, bobTok, newLink);
    const bobNotesKr = await E2eeNodeTransport.keyring(base, bobTok, "notes", "alice");
    expect(bobNotesKr.status).toBe(200);
    const bobNotes = mkE2eeClient(root("bob-notes"), new E2eeNodeTransport(base, bobTok, "notes", "alice"), await codecFor(bobNotesKr.text), "B");
    await reconcileAll({ ...edep(bobNotes), readOnly: true });
    expect(dec(await bobNotes.io.read("n.md"))).toContain("plain before migration");
  }, 120000);

  it("(2) the server data volume holds the plaintext markers nowhere: not a chunk, not a mirror file, not an index row", async () => {
    expect(await grepTree(server.dataDir, MARKER)).toEqual([]);
    expect(await grepTree(server.dataDir, MARKER_NOTES)).toEqual([]); // the migrated vault's plaintext left no residue
    // the grep sees plaintext when there is some: a control marker in a plaintext vault IS found
    const admin = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createVault(base, admin, "control").catch(() => {});
    const control = mkE2eeClient(root("control"), new E2eeNodeTransport(base, admin, "control", "", false), undefined, "C");
    await fs.writeFile(path.join(control.root, "c.md"), `CONTROL-MARKER-${MARKER}\n`);
    await reconcileAll(dep(control));
    expect((await grepTree(server.dataDir, `CONTROL-MARKER-${MARKER}`)).length).toBeGreaterThan(0);
    expect(await grepTree(server.dataDir, MARKER)).toEqual((await grepTree(server.dataDir, `CONTROL-MARKER-${MARKER}`)));
  }, 60000);

  it("(3) the client that synced the plaintext vault before the migration gets 403 without the header; it is Blocked with the removed-access text; its local vault is byte-identical", async () => {
    const before = await snapshotTree(oldNotes.root);
    const r = await fetch(`${base}${E2EE_SCOPE("notes")}/changes?since=0`, { headers: { authorization: `Bearer ${aliceTok}` } });
    expect(r.status).toBe(403);
    const body = await r.text();
    expect(body).toMatch(/end-to-end encrypted/);
    await expect(reconcileAll(dep(oldNotes))).rejects.toThrow(/403/);
    expect(await snapshotTree(oldNotes.root)).toEqual(before); // no deletion, no conflict copy, no rewrite
    // the plugin's classification of that body (unit-level on the real body; the status is the one observed above)
    const cls = classifyConnectError(toConnErrorInfo(new ConnError("changes: HTTP 403", { status: r.status, wasLogin: false, endpoint: Endpoint.Other, bodyHint: body }), false));
    expect(cls.kind).toBe(FailureKind.Forbidden);
    expect(recoveryFor(cls).kind).toBe(RecoveryKind.AwaitUser);
    expect(blockedTip(FailureKind.Forbidden)).toBe("Access to this vault was removed");
  }, 60000);

  it("(4) dedup: a second upload of the same bytes, same device or another device, reports zero missing chunks and uploads nothing", async () => {
    const codec = await codecFor((await E2eeNodeTransport.keyring(base, aliceTok, "secret")).text);
    const counting = new CountingApi(new E2eeNodeTransport(base, aliceTok, "secret"));
    const a = mkE2eeClient(root("dedup-a"), counting, codec, "D1");
    const bytes = "x".repeat(200_000);
    await fs.writeFile(path.join(a.root, "big.md"), bytes);
    await reconcileAll(edep(a));
    const meta = (await counting.fileMeta("big.md")) as FileMeta;
    expect(meta.chunks.length).toBeGreaterThan(0);
    const firstPuts = counting.puts;
    expect(firstPuts).toBeGreaterThan(0);
    expect(await counting.missing(meta.chunks)).toEqual([]);
    // a SECOND upload of the same bytes under another path (another cid, the same frames): zero uploads
    await fs.writeFile(path.join(a.root, "big2.md"), bytes);
    await reconcileAll(edep(a));
    expect(counting.puts).toBe(firstPuts);
    expect(((await counting.fileMeta("big2.md")) as FileMeta).chunks).toEqual(meta.chunks);
    // a second device with the same key and the same bytes under a third path: zero uploads from a cold cache
    const counting2 = new CountingApi(new E2eeNodeTransport(base, aliceTok, "secret"));
    const b = mkE2eeClient(root("dedup-b"), counting2, codec, "D2");
    await reconcileAll(edep(b));
    const pulledPuts = counting2.puts;
    await fs.writeFile(path.join(b.root, "big3.md"), bytes);
    await reconcileAll(edep(b));
    expect(counting2.puts).toBe(pulledPuts);
    expect(((await counting2.fileMeta("big3.md")) as FileMeta).chunks).toEqual(meta.chunks);
  }, 60000);

  it("(6) cross-path substitution: the real server serves one file's committed row under another path; the client refuses it by the cid and the local file is byte-identical", async () => {
    // a vault of its own, so the substituted row never reaches the clients of (5)
    const created = await createKeyring(PASSWORD, { kdf: FAST });
    await E2eeNodeTransport.createVault(base, aliceTok, "sub", JSON.stringify(created.keyring));
    const codec = E2eeCodec.fromKeys(await deriveSubkeys(created.vk, created.vaultId));
    const honest = new E2eeNodeTransport(base, aliceTok, "sub");
    const a = mkE2eeClient(root("sub-a"), honest, codec, "S");
    await fs.writeFile(path.join(a.root, "a.md"), "content of a\n");
    await fs.writeFile(path.join(a.root, "b.md"), "content of b\n");
    await reconcileAll(edep(a));
    const metaA = (await honest.fileMeta("a.md")) as FileMeta;
    const metaB = (await honest.fileMeta("b.md")) as FileMeta;
    expect(metaA.size).toBe(metaB.size); // equal sizes: the size check cannot be what refuses the row below
    expect(metaA.cid).not.toBe(metaB.cid);
    // the server accepts a.md's frames, hash, size and cid under the path b.md (it stores cid opaquely, spec section 4.6)
    const served = await honest.commit({ path: "b.md", hash: metaA.hash, size: metaA.size, mtime: Date.now(), chunks: metaA.chunks, cid: metaA.cid });
    expect(served.cid).toBe(metaA.cid);
    // a victim with its own b.md pulls: refused by the cid over (path, plaintext), the local file byte-identical
    const victim = mkE2eeClient(root("sub-v"), new E2eeNodeTransport(base, aliceTok, "sub"), codec, "V");
    await fs.writeFile(path.join(victim.root, "b.md"), "my own b\n");
    const before = await snapshotTree(victim.root);
    const errors: string[] = [];
    await reconcileAll({ ...edep(victim), onFileError: (p, e: any) => errors.push(`${p}: ${e?.message ?? e}`) });
    expect(dec(await victim.io.read("a.md"))).toBe("content of a\n");
    expect(errors.some((e) => /^b\.md: integrity check failed for 'b\.md': got [0-9a-f]{12}, expected [0-9a-f]{12}/.test(e))).toBe(true);
    expect((await snapshotTree(victim.root)).get("b.md")).toBe(before.get("b.md"));
    expect(await exists(path.join(victim.root, "b (conflict"))).toBe(false);
  }, 60000);

  it("(5) a corrupt index on the server rebuilds from the mirror, and the same two clients verify every file after the rebuild", async () => {
    const before = await rowsOf(base, aliceTok, "secret");
    expect(before.size).toBeGreaterThan(3);
    // bring both clients current and converged first ((4) pushed files since their last reconcile), then snapshot
    for (let i = 0; i < 2; i++) { await reconcileAll(edep(alice)); await reconcileAll(edep(bob)); }
    const aliceFiles = await files(alice); const bobFiles = await files(bob);
    expect(aliceFiles).toEqual(bobFiles);
    // stop the server, corrupt the index, restart on the same data dir: the open quarantines the index and rebuilds
    const dataDir = server.dataDir;
    await server.stopKeepData();
    const idx = path.join(dataDir, "alice", "secret", ".sync-index.db");
    expect(await exists(idx)).toBe(true);
    await fs.writeFile(idx, Buffer.from("not a database at all"));
    for (const extra of [".sync-index.db-wal", ".sync-index.db-shm"]) await fs.rm(path.join(dataDir, "alice", "secret", extra), { force: true });
    server = await startServer(dataDir); base = server.base;
    aliceApi.rebase(base); bobApi.rebase(base);
    aliceTok = await NodeTransport.login(base, "alice", "vaultpw12"); bobTok = await NodeTransport.login(base, "bob", "vaultpw12");
    // the first request opens the vault: the open quarantines the index (vault.rs quarantine_db) and rebuilds from
    // the mirror, and the rebuilt rows equal the committed rows (hash, cid, size, chunks)
    expect(await rowsOf(base, aliceTok, "secret")).toEqual(before);
    expect(await exists(idx + ".corrupt")).toBe(true);
    // the SAME two clients, cursors from before the rebuild, continue: every file verifies, nothing changes locally
    for (const c of [alice, bob]) {
      const errors: string[] = [];
      await reconcileAll({ ...edep(c), onFileError: (p, e: any) => errors.push(`${p}: ${e?.message ?? e}`) });
      expect(errors).toEqual([]);
    }
    expect(await files(alice)).toEqual(aliceFiles);
    expect(await files(bob)).toEqual(bobFiles);
    // a fresh device verifies every row from the rebuilt index through the cid check
    const fresh = mkE2eeClient(root("fresh"), new E2eeNodeTransport(base, bobTok, "secret", "alice"), bob.codec, "F");
    const errors: string[] = [];
    await reconcileAll({ ...edep(fresh), onFileError: (p, e: any) => errors.push(`${p}: ${e?.message ?? e}`) });
    expect(errors).toEqual([]);
    expect((await files(fresh)).length).toBe(before.size);
  }, 120000);
});

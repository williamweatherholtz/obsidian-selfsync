// E4 (1) to (6): end-to-end encryption against the REAL server binary and the REAL reconcile engine, no
// Obsidian. The owner creates an encrypted vault, a second account joins it through a share link with the
// password, and they push, pull, three-way merge, produce a binary conflict copy, and sync a config change.
// They migrate a plaintext vault to an encrypted one under the same name and re-share it. The server data
// volume holds the plaintext marker nowhere. A client without the header gets 403 and its local vault is
// byte-identical. Dedup holds. A corrupt index rebuilds from the mirror and both clients re-verify. A
// cross-path substitution is refused. Skips when the server binary is not built (CI requires it, D0026).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reconcileAll } from "../src/reconcile";
import { canRun, NodeTransport, dep, dec, enc, exists } from "./e2e-helpers";
import { E2eeNodeTransport, SubstitutingApi, CountingApi, mkE2eeClient, edep, grepTree, snapshotTree, startServerAt, E2EE_SCOPE, RunningServerKeep } from "./e2ee-real-helpers";
import { createKeyring, openKeyring } from "../src/e2ee/keyring";
import { deriveSubkeys } from "../src/e2ee/subkeys";
import { E2eeCodec } from "../src/e2ee/codec";
import { ConnError, Endpoint, FailureKind, classifyConnectError, toConnErrorInfo, blockedTip, recoveryFor, RecoveryKind } from "../src/connstate";

const PASSWORD = "correct horse battery staple!";
const FAST = { m_kib: 64, t: 1, p: 1 };
const MARKER = "PLAINTEXT-MARKER-7f3a9c";

async function codecFor(keyringText: string): Promise<E2eeCodec> {
  const opened = await openKeyring(PASSWORD, keyringText);
  return E2eeCodec.fromKeys(await deriveSubkeys(opened.vk, opened.vaultId));
}

describe.skipIf(!canRun)("E4 end-to-end encryption against the real server", () => {
  let server: RunningServerKeep; let base = "";
  const roots: string[] = [];
  beforeAll(async () => { server = await startServerAt(); base = server.base; }, 30000);
  afterAll(async () => { await server?.stop(); for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  const root = (tag: string) => { const r = mkdtempSync(path.join(os.tmpdir(), `nls-e2ee-${tag}-`)); roots.push(r); return r; };

  it("(1) create, join through a share link, push, pull, merge, binary conflict, config change, migrate and re-share", async () => {
    const admin = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createUser(base, admin, "alice", "vaultpw12");
    await NodeTransport.createUser(base, admin, "bob", "vaultpw12");
    const aliceTok = await NodeTransport.login(base, "alice", "vaultpw12");
    const bobTok = await NodeTransport.login(base, "bob", "vaultpw12");

    // the owner creates the encrypted vault: POST with the keyring, then GET keyring echoes the record
    const created = await createKeyring(PASSWORD, { kdf: FAST });
    await E2eeNodeTransport.createVault(base, aliceTok, "secret", JSON.stringify(created.keyring));
    const kr = await E2eeNodeTransport.keyring(base, aliceTok, "secret");
    expect(kr.status).toBe(200);
    expect(JSON.parse(kr.text).vault_id).toBe(created.keyring.vault_id);
    const aliceCodec = E2eeCodec.fromKeys(await deriveSubkeys(created.vk, created.vaultId));
    const alice = mkE2eeClient(root("alice"), new E2eeNodeTransport(base, aliceTok, "secret"), aliceCodec, "A");
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
    const bob = mkE2eeClient(root("bob"), new E2eeNodeTransport(base, bobTok, "secret", "alice"), bobCodec, "B");
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
    const bobFiles = [...(await bob.io.list()).keys()];
    expect(bobFiles.some((n) => n.includes("(conflict"))).toBe(true);
    await reconcileAll(edep(alice));
    expect([...(await alice.io.list()).keys()].some((n) => n.includes("(conflict"))).toBe(true);

    // a config change rides the same channel
    await fs.mkdir(path.join(alice.root, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(alice.root, ".obsidian", "app.json"), `{"readableLineLength":false}`);
    await reconcileAll(edep(alice));
    await reconcileAll(edep(bob));
    expect(dec(await bob.io.read(".obsidian/app.json"))).toBe(`{"readableLineLength":false}`);

    // migrate a plaintext vault to an encrypted one under the same name, then re-share it
    await NodeTransport.createVault(base, aliceTok, "notes");
    const plainNotes = mkE2eeClient(root("alice-notes"), new E2eeNodeTransport(base, aliceTok, "notes", "", false), undefined, "A");
    await fs.writeFile(path.join(plainNotes.root, "n.md"), "plain before migration\n");
    await reconcileAll(dep(plainNotes));
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
    expect(dec(await bobNotes.io.read("n.md"))).toBe("plain before migration\n");
  }, 120000);

  it("(2) the server data volume holds the plaintext marker nowhere: not a chunk, not a mirror file, not an index row", async () => {
    const hits = await grepTree(server.dataDir, MARKER);
    expect(hits).toEqual([]);
    // the grep sees plaintext when there is some: a control marker in a plaintext vault IS found
    const admin = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createVault(base, admin, "control").catch(() => {});
    const control = mkE2eeClient(root("control"), new E2eeNodeTransport(base, admin, "control", "", false), undefined, "C");
    await fs.writeFile(path.join(control.root, "c.md"), `CONTROL-MARKER-${MARKER}\n`);
    await reconcileAll(dep(control));
    expect((await grepTree(server.dataDir, `CONTROL-MARKER-${MARKER}`)).length).toBeGreaterThan(0);
    expect(await grepTree(server.dataDir, MARKER)).toEqual((await grepTree(server.dataDir, `CONTROL-MARKER-${MARKER}`)));
  }, 60000);

  it("(3) a client without the header gets 403 on changes; the link is Blocked with the removed-access text; the local vault is byte-identical", async () => {
    const aliceTok = await NodeTransport.login(base, "alice", "vaultpw12");
    const old = mkE2eeClient(root("old"), new E2eeNodeTransport(base, aliceTok, "secret", "", false), undefined, "O");
    await fs.writeFile(path.join(old.root, "local.md"), "untouched\n");
    const before = await snapshotTree(old.root);
    const r = await fetch(`${base}${E2EE_SCOPE("secret")}/changes?since=0`, { headers: { authorization: `Bearer ${aliceTok}` } });
    expect(r.status).toBe(403);
    const body = await r.text();
    expect(body).toMatch(/end-to-end encrypted/);
    expect(body).not.toMatch(/password change required/i);
    await expect(reconcileAll(dep(old))).rejects.toThrow(/403/);
    expect(await snapshotTree(old.root)).toEqual(before);
    // the plugin's classification of that 403: Blocked, the removed-access card text, no retry loop
    const cls = classifyConnectError(toConnErrorInfo(new ConnError("changes: HTTP 403", { status: 403, wasLogin: false, endpoint: Endpoint.Other, bodyHint: body }), false));
    expect(cls.kind).toBe(FailureKind.Forbidden);
    expect(recoveryFor(cls).kind).toBe(RecoveryKind.AwaitUser);
    expect(blockedTip(FailureKind.Forbidden)).toBe("Access to this vault was removed");
  }, 60000);

  it("(4) dedup: a second upload of an unchanged file reports zero missing chunks and uploads nothing", async () => {
    const aliceTok = await NodeTransport.login(base, "alice", "vaultpw12");
    const kr = await E2eeNodeTransport.keyring(base, aliceTok, "secret");
    const codec = await codecFor(kr.text);
    const counting = new CountingApi(new E2eeNodeTransport(base, aliceTok, "secret"));
    const a = mkE2eeClient(root("dedup-a"), counting, codec, "D1");
    await fs.writeFile(path.join(a.root, "big.md"), "x".repeat(200_000));
    await reconcileAll(edep(a));
    const meta = await counting.fileMeta("big.md");
    expect(meta?.chunks.length).toBeGreaterThan(0);
    expect(await counting.missing(meta!.chunks)).toEqual([]);
    const puts = counting.puts;
    await fs.utimes(path.join(a.root, "big.md"), new Date(), new Date()); // a touched mtime, same bytes
    await reconcileAll(edep(a));
    expect(counting.puts).toBe(puts);
    // a second device with the same key and the same bytes: the frames dedup too
    const b = mkE2eeClient(root("dedup-b"), new E2eeNodeTransport(base, aliceTok, "secret"), codec, "D2");
    await reconcileAll(edep(b));
    expect(dec(await b.io.read("big.md"))).toBe("x".repeat(200_000));
  }, 60000);

  it("(6) cross-path substitution: one file's committed row under another path is refused and the local file is byte-identical", async () => {
    const aliceTok = await NodeTransport.login(base, "alice", "vaultpw12");
    const kr = await E2eeNodeTransport.keyring(base, aliceTok, "secret");
    const codec = await codecFor(kr.text);
    const honest = new E2eeNodeTransport(base, aliceTok, "secret");
    const a = mkE2eeClient(root("sub-a"), honest, codec, "S");
    await fs.writeFile(path.join(a.root, "a.md"), "content of a\n");
    await fs.writeFile(path.join(a.root, "b.md"), "content of b\n");
    await reconcileAll(edep(a));
    const victim = mkE2eeClient(root("sub-v"), new SubstitutingApi(new E2eeNodeTransport(base, aliceTok, "secret"), "a.md", "b.md"), codec, "V");
    const errors: string[] = [];
    await reconcileAll({ ...edep(victim), onFileError: (p, e: any) => errors.push(`${p}: ${e?.message ?? e}`) });
    expect(dec(await victim.io.read("a.md"))).toBe("content of a\n");
    expect(await exists(path.join(victim.root, "b.md"))).toBe(false); // the substituted row never landed
    expect(errors.some((e) => e.startsWith("b.md:") && /integrity check failed/.test(e))).toBe(true); // the cid over (path, plaintext) differs
    // a victim that already holds b.md keeps it byte-identical
    await fs.writeFile(path.join(victim.root, "b.md"), "my own b\n");
    const before = await snapshotTree(victim.root);
    await reconcileAll({ ...edep(victim), onFileError: () => {} });
    expect(await snapshotTree(victim.root)).toEqual(before);
  }, 60000);

  it("(5) a corrupt index on the server rebuilds from the mirror, and both clients verify every file after the rebuild", async () => {
    const aliceTok0 = await NodeTransport.login(base, "alice", "vaultpw12");
    const kr = await E2eeNodeTransport.keyring(base, aliceTok0, "secret");
    const codec = await codecFor(kr.text);
    const before = await (async () => { const r = await fetch(`${base}${E2EE_SCOPE("secret")}/changes?since=0`, { headers: { authorization: `Bearer ${aliceTok0}`, "x-selfsync-e2ee": "1" } }); return (await r.json()) as { upserts: { path: string; cid?: string; hash: string }[] }; })();
    expect(before.upserts.length).toBeGreaterThan(2);
    // stop the server, corrupt the index, restart on the same data dir: the open quarantines and rebuilds
    const dataDir = server.dataDir;
    await server.stopKeepData();
    const idx = path.join(dataDir, "alice", "secret", ".sync-index.db");
    expect(await exists(idx)).toBe(true);
    await fs.writeFile(idx, Buffer.from("not a database at all"));
    for (const extra of [".sync-index.db-wal", ".sync-index.db-shm"]) await fs.rm(path.join(dataDir, "alice", "secret", extra), { force: true });
    server = await startServerAt(dataDir); base = server.base;
    const aliceTok = await NodeTransport.login(base, "alice", "vaultpw12");
    const bobTok = await NodeTransport.login(base, "bob", "vaultpw12");
    const after = await (async () => { const r = await fetch(`${base}${E2EE_SCOPE("secret")}/changes?since=0`, { headers: { authorization: `Bearer ${aliceTok}`, "x-selfsync-e2ee": "1" } }); expect(r.status).toBe(200); return (await r.json()) as { upserts: { path: string; cid?: string; hash: string }[] }; })();
    const rows = (u: { path: string; cid?: string; hash: string }[]) => new Map(u.map((x) => [x.path, `${x.hash}|${x.cid}`]));
    expect(rows(after.upserts)).toEqual(rows(before.upserts));
    // both clients pull every file through the cid check from the rebuilt index
    for (const [tag, tok, owner] of [["ra", aliceTok, ""], ["rb", bobTok, "alice"]] as const) {
      const c = mkE2eeClient(root(tag), new E2eeNodeTransport(base, tok, "secret", owner), codec, tag);
      const errors: string[] = [];
      await reconcileAll({ ...edep(c), onFileError: (p, e: any) => errors.push(`${p}: ${e?.message ?? e}`) });
      expect(errors).toEqual([]);
      expect([...(await c.io.list()).keys()].filter((p) => !p.startsWith(".obsidian/")).length).toBe(before.upserts.filter((u) => !u.path.startsWith(".obsidian/")).length);
      expect(dec(await c.io.read("a.md"))).toBe("content of a\n");
    }
    void enc;
  }, 120000);
});

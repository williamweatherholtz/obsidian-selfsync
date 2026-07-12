// Cross-user vault sharing, end to end through the REAL server + REAL reconcile engine
// (Phase 2 capstone). Verifies a read-write grantee syncs both ways, and a read-only
// grantee pulls but never pushes. Skips if the server binary isn't built.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BaseStore } from "../src/base";
import { reconcileAll, ReconcileDeps } from "../src/reconcile";
import { canRun, startServer, NodeTransport, FsVaultIo, Client, dep, dec, exists, RunningServer } from "./e2e-helpers";

function mkClient(root: string, api: NodeTransport): Client {
  return { io: new FsVaultIo(root), api, state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device: "Dev", root };
}
const ro = (c: Client): ReconcileDeps => ({ ...dep(c), readOnly: true });

describe.skipIf(!canRun)("cross-user vault sharing (E2E)", () => {
  let server: RunningServer; let base = "";
  const roots: string[] = [];
  beforeAll(async () => { server = await startServer(); base = server.base; }, 20000);
  afterAll(async () => { await server?.stop(); for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  const root = (tag: string) => { const r = mkdtempSync(path.join(os.tmpdir(), `nls-share-${tag}-`)); roots.push(r); return r; };

  it("read-write share syncs both ways; read-only pulls but never pushes", async () => {
    const admin = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createUser(base, admin, "alice", "vaultpw12");
    await NodeTransport.createUser(base, admin, "bob", "vaultpw12");
    await NodeTransport.createUser(base, admin, "carol", "vaultpw12");
    const aliceTok = await NodeTransport.login(base, "alice", "vaultpw12");
    await NodeTransport.createVault(base, aliceTok, "team");

    // alice writes a note in her own "team" vault and pushes it
    const alice = mkClient(root("alice"), new NodeTransport(base, aliceTok, "team"));
    await fs.writeFile(path.join(alice.root, "n.md"), "from alice");
    await reconcileAll(dep(alice));

    // alice shares "team" read-write with bob
    await NodeTransport.grant(base, aliceTok, "team", "bob", "readWrite");

    // bob syncs alice's shared vault (owner-qualified transport) and gets the note
    const bobTok = await NodeTransport.login(base, "bob", "vaultpw12");
    const bob = mkClient(root("bob"), new NodeTransport(base, bobTok, "team", "alice"));
    await reconcileAll(dep(bob));
    expect(dec(await bob.io.read("n.md"))).toBe("from alice");

    // bob (read-write) edits → alice sees it
    await fs.writeFile(path.join(bob.root, "n.md"), "edited by bob");
    await reconcileAll(dep(bob));
    await reconcileAll(dep(alice));
    expect(dec(await alice.io.read("n.md"))).toBe("edited by bob");

    // carol has a READ-ONLY share: she pulls the current content...
    await NodeTransport.grant(base, aliceTok, "team", "carol", "read");
    const carolTok = await NodeTransport.login(base, "carol", "vaultpw12");
    const carol = mkClient(root("carol"), new NodeTransport(base, carolTok, "team", "alice"));
    await reconcileAll(ro(carol));
    expect(dec(await carol.io.read("n.md"))).toBe("edited by bob");

    // ...but her local-only file is NOT pushed to the shared vault
    await fs.writeFile(path.join(carol.root, "carol-only.md"), "scratch");
    await reconcileAll(ro(carol));
    await reconcileAll(dep(alice)); // alice pulls again
    expect(await exists(path.join(alice.root, "carol-only.md"))).toBe(false);
  }, 60000);

  // Reproduces the REAL redeem-onboarding path end to end (the flow the 1.0.20–1.0.23 fixes touched):
  // an admin-created recipient is must-change-gated, must change its password, THEN redeems a share
  // LINK (not a direct grant) and gains cross-account access. Each earlier bug would have failed a
  // specific step here — the test that should have existed before shipping.
  it("must-change account → change password → redeem a share LINK → sync the shared vault", async () => {
    const admin = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createUser(base, admin, "owner1", "vaultpw12"); // ready-to-use owner
    await NodeTransport.createUserRaw(base, admin, "recip1", "Temp-1234"); // still must-change (admin-UI state)

    // 1) A fresh admin-created account is must-change gated: login SUCCEEDS but signals it, and a normal
    //    route 403s until the password is set. This is exactly the "vaults: HTTP 403" the wizard hit.
    const first = await NodeTransport.loginFull(base, "recip1", "Temp-1234");
    expect(first.mustChange).toBe(true);
    expect(await NodeTransport.rawStatus(base, first.token, "/api/vaults")).toBe(403);

    // 2) Change the password → fresh, un-gated token; must-change now clears.
    const freshTok = await NodeTransport.changePassword(base, first.token, "Temp-1234", "Recip-pass-1");
    expect(await NodeTransport.rawStatus(base, freshTok, "/api/vaults")).toBe(200);
    expect((await NodeTransport.loginFull(base, "recip1", "Recip-pass-1")).mustChange).toBe(false);

    // 3) owner1 puts a note in their vault and mints a read-write SHARE LINK.
    const ownerTok = await NodeTransport.login(base, "owner1", "vaultpw12");
    await NodeTransport.createVault(base, ownerTok, "mine");
    const owner = mkClient(root("owner1"), new NodeTransport(base, ownerTok, "mine"));
    await fs.writeFile(path.join(owner.root, "shared.md"), "hello from owner1");
    await reconcileAll(dep(owner));
    const linkToken = await NodeTransport.createShareLink(base, ownerTok, "mine", "readWrite");

    // 4) recip1 REDEEMS the link (binds a grant to their account) and it shows up in "shared with me".
    const redeemed = await NodeTransport.redeemShareLink(base, freshTok, linkToken);
    expect(redeemed).toMatchObject({ owner: "owner1", vault: "mine", perm: "readWrite" });
    const shared = await NodeTransport.listShared(base, freshTok);
    expect(shared.some((s) => s.owner === "owner1" && s.vault === "mine")).toBe(true);

    // 5) recip1 syncs the shared vault (owner-qualified) and gets the note — the whole point.
    const recip = mkClient(root("recip1"), new NodeTransport(base, freshTok, "mine", "owner1"));
    await reconcileAll(dep(recip));
    expect(dec(await recip.io.read("shared.md"))).toBe("hello from owner1");

    // 6) single-use: the same link can't be redeemed again.
    await expect(NodeTransport.redeemShareLink(base, freshTok, linkToken)).rejects.toThrow();

    // 7) the GRANTEE can leave/decline the share (remove their OWN access): before, the owner-qualified
    //    route is reachable (200); after leaving, it's forbidden (403) and it's gone from "shared with me".
    expect(await NodeTransport.rawSharedStatus(base, freshTok, "owner1", "mine")).toBe(200);
    await NodeTransport.leaveShare(base, freshTok, "owner1", "mine");
    expect(await NodeTransport.rawSharedStatus(base, freshTok, "owner1", "mine")).toBe(403);
    expect((await NodeTransport.listShared(base, freshTok)).some((s) => s.owner === "owner1")).toBe(false);
  }, 60000);
});

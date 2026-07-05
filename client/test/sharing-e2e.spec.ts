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
  afterAll(() => { server?.stop(); for (const r of roots) rmSync(r, { recursive: true, force: true }); });
  const root = (tag: string) => { const r = mkdtempSync(path.join(os.tmpdir(), `nls-share-${tag}-`)); roots.push(r); return r; };

  it("read-write share syncs both ways; read-only pulls but never pushes", async () => {
    const admin = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createUser(base, admin, "alice", "pw");
    await NodeTransport.createUser(base, admin, "bob", "pw");
    await NodeTransport.createUser(base, admin, "carol", "pw");
    const aliceTok = await NodeTransport.login(base, "alice", "pw");
    await NodeTransport.createVault(base, aliceTok, "team");

    // alice writes a note in her own "team" vault and pushes it
    const alice = mkClient(root("alice"), new NodeTransport(base, aliceTok, "team"));
    await fs.writeFile(path.join(alice.root, "n.md"), "from alice");
    await reconcileAll(dep(alice));

    // alice shares "team" read-write with bob
    await NodeTransport.grant(base, aliceTok, "team", "bob", "readWrite");

    // bob syncs alice's shared vault (owner-qualified transport) and gets the note
    const bobTok = await NodeTransport.login(base, "bob", "pw");
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
    const carolTok = await NodeTransport.login(base, "carol", "pw");
    const carol = mkClient(root("carol"), new NodeTransport(base, carolTok, "team", "alice"));
    await reconcileAll(ro(carol));
    expect(dec(await carol.io.read("n.md"))).toBe("edited by bob");

    // ...but her local-only file is NOT pushed to the shared vault
    await fs.writeFile(path.join(carol.root, "carol-only.md"), "scratch");
    await reconcileAll(ro(carol));
    await reconcileAll(dep(alice)); // alice pulls again
    expect(await exists(path.join(alice.root, "carol-only.md"))).toBe(false);
  }, 60000);
});

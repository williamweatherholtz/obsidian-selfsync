// STANDALONE config-sync permutation matrix — NOT run on each compile.
// The whole suite is gated behind the SELFSYNC_PERM env flag, so a normal
// `npx vitest run` skips it entirely. Run it on demand:
//
//   (build the server first: cd server && cargo build)
//   SELFSYNC_PERM=1 npx vitest run test/config-permutations.spec.ts
//   # or against a container:  SYNC_SERVER_URL=… SELFSYNC_PERM=1 npx vitest run test/config-permutations.spec.ts
//
// It exhaustively checks all 2^5 permutations of the five config-sync dials
// (core / hotkeys / appearance / snippets / community): first that shouldSync's
// decision matches the dial state for every combination (pure), then — end to end
// through the real server, two clients — that exactly the enabled categories'
// files actually TRACK to the other vault, off-dials don't, and SelfSync's own
// folder never does.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reconcileAll } from "../src/reconcile";
import { BaseStore } from "../src/base";
import { shouldSync, DEFAULT_CONFIG_SYNC, ConfigSyncSelection } from "../src/configsync";
import { canRun, startServer, NodeTransport, FilteredFsVaultIo, Client, dep, exists, RunningServer } from "./e2e-helpers";

const STANDALONE = !!process.env.SELFSYNC_PERM;
const SELF = "selfsync";

// The five dials, each with a representative file the dial gates.
const DIALS = ["core", "hotkeys", "appearance", "snippets", "community"] as const;
type Dial = typeof DIALS[number];
const CATS: Array<{ dial: Dial; path: string }> = [
  { dial: "core",       path: ".obsidian/app.json" },
  { dial: "hotkeys",    path: ".obsidian/hotkeys.json" },
  { dial: "appearance", path: ".obsidian/appearance.json" },
  { dial: "snippets",   path: ".obsidian/snippets/theme.css" },
  { dial: "community",  path: ".obsidian/plugins/dataview/data.json" },
];

// Build a selection from a 5-bit mask (config sync enabled; each bit = one dial).
function selForMask(m: number): ConfigSyncSelection {
  const s: ConfigSyncSelection = { ...DEFAULT_CONFIG_SYNC, enabled: true };
  DIALS.forEach((d, i) => { s[d] = Boolean(m & (1 << i)); });
  return s;
}
const bits = (m: number) => DIALS.map((d, i) => `${d}=${(m & (1 << i)) ? 1 : 0}`).join(" ");

describe.skipIf(!STANDALONE)("config-sync permutation matrix (standalone — set SELFSYNC_PERM=1)", () => {
  // ---- exhaustive PURE check: no server needed ----
  it("shouldSync matches the dial state for all 2^5 permutations", () => {
    for (let m = 0; m < 32; m++) {
      const sel = selForMask(m);
      for (const { dial, path: p } of CATS) {
        expect(shouldSync(p, sel, SELF), `combo[${bits(m)}] ${p}`).toBe(sel[dial]);
      }
      // invariants that hold in EVERY permutation:
      expect(shouldSync(`.obsidian/plugins/${SELF}/data.json`, sel, SELF), `combo[${bits(m)}] self folder`).toBe(false);
      expect(shouldSync(".obsidian/plugins/new-livesync/data.json", sel, SELF), `combo[${bits(m)}] legacy self`).toBe(false);
      expect(shouldSync(".obsidian/workspace.json", sel, SELF), `combo[${bits(m)}] unknown config`).toBe(false);
      expect(shouldSync("Note.md", sel, SELF), `combo[${bits(m)}] note`).toBe(true);
    }
    // config sync OFF entirely → nothing under .obsidian syncs, notes still do.
    const off: ConfigSyncSelection = { ...DEFAULT_CONFIG_SYNC, enabled: false };
    for (const { path: p } of CATS) expect(shouldSync(p, off, SELF)).toBe(false);
    expect(shouldSync("Note.md", off, SELF)).toBe(true);
  });

  // ---- end-to-end: every permutation actually TRACKS through the real server ----
  describe.skipIf(!canRun)("real two-client tracking per permutation", () => {
    let server: RunningServer; let base = "";
    beforeAll(async () => { server = await startServer(); base = server.base; }, 20000);
    afterAll(async () => { await server?.stop(); });

    async function writeRaw(root: string, rel: string, body: string) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), body);
    }
    async function buildPair(vault: string, sel: ConfigSyncSelection): Promise<[Client, Client]> {
      const token = await NodeTransport.login(base, "admin", "admin");
      const mk = async (dev: string): Promise<Client> => {
        const root = mkdtempSync(path.join(os.tmpdir(), `nls-perm-${vault}-${dev}-`));
        const c: Client = { io: new FilteredFsVaultIo(root, sel, SELF), api: new NodeTransport(base, token, vault), state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device: dev, root };
        await reconcileAll(dep(c));
        return c;
      };
      return [await mk("A"), await mk("B")];
    }

    it("all 32 dial permutations propagate exactly the enabled categories", async () => {
      for (let m = 0; m < 32; m++) {
        const sel = selForMask(m);
        const [a, b] = await buildPair(`perm-${m}`, sel);
        // Obsidian (not us) writes every category file + SelfSync's own config to disk;
        // the filter's only job is deciding what leaves the device.
        for (const { path: p } of CATS) await writeRaw(a.root, p, `payload`);
        await writeRaw(a.root, `.obsidian/plugins/${SELF}/data.json`, '{"serverUrl":"secret","password":"hunter2"}');
        await reconcileAll(dep(a)); // push what passes the filter
        await reconcileAll(dep(b)); // pull
        for (const { dial, path: p } of CATS) {
          const arrived = await exists(path.join(b.root, p));
          expect(arrived, `combo[${bits(m)}] — ${dial} should ${sel[dial] ? "" : "NOT "}sync`).toBe(sel[dial]);
        }
        expect(await exists(path.join(b.root, ".obsidian/plugins", SELF, "data.json")), `combo[${bits(m)}] — SelfSync's own folder must never sync`).toBe(false);
        rmSync(a.root, { recursive: true, force: true });
        rmSync(b.root, { recursive: true, force: true });
      }
    }, 300000);
  });
});

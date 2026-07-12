// PROPAGATION LATENCY: how long a single edit on device A takes to reach device B — measured as the
// TRANSFER round-trip (A push + B poll delta + B apply). This is the work cost; the end-to-end user
// latency is this PLUS the notify delay (≈instant on the realtime WebSocket, ≤ the poll interval when
// falling back). Run on a small AND a large vault to show the delta path is O(change), not O(vault).
import { describe, it, expect } from "vitest";
import { startServer, canRun, dep, enc, dec } from "../test/e2e-helpers";
import { reconcileAll, reconcileDelta, reconcilePath } from "../src/reconcile";
import { makeClient, genVault, percentile } from "./harness";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe.skipIf(!canRun)("PROPAGATION LATENCY — one edit, A → B round-trip (transfer cost)", () => {
  it("delta-path round-trip on a small and a large vault", async () => {
    const server = await startServer();
    const roots: string[] = [];
    const tmp = (tag: string) => { const r = mkdtempSync(path.join(os.tmpdir(), `perf-lat-${tag}-`)); roots.push(r); return r; };
    const rows: string[] = [];
    const ITER = 20;
    try {
      for (const baseNotes of [50, 3000]) {
        const vault = `lat-${baseNotes}`;
        const rootA = tmp("a"), rootB = tmp("b");
        await genVault(rootA, { notes: baseNotes, noteBytes: 1500 });
        const a = await makeClient(server.base, rootA, "A", vault); await reconcileAll(dep(a));
        const b = await makeClient(server.base, rootB, "B", vault); await reconcileAll(dep(b));
        const samples: number[] = [];
        for (let i = 0; i < ITER; i++) {
          const p = `notes/edit-${i}.md`;
          await a.io.write(p, enc(`edit ${i} payload`));
          const t0 = performance.now();
          await reconcilePath(dep(a), p);                      // A pushes just the edited file (the event path — O(change))
          const delta = await b.api.changes(b.state.version);  // B polls the delta
          await reconcileDelta(dep(b), delta);                 // B applies just the changed path
          samples.push(performance.now() - t0);
          expect(dec(await b.io.read(p))).toContain(`edit ${i}`); // it really arrived
        }
        samples.sort((x, y) => x - y);
        rows.push(`| ${baseNotes} notes | ${percentile(samples, 50).toFixed(0)} | ${percentile(samples, 95).toFixed(0)} | ${samples[samples.length - 1].toFixed(0)} |`);
      }
      console.log("\n### PROPAGATION LATENCY — single-edit A→B round-trip (transfer only; add notify delay for end-to-end)\n");
      console.log(`| baseline vault | p50 (ms) | p95 (ms) | max (ms) |  (n=${ITER})`);
      console.log("|---|--:|--:|--:|");
      for (const r of rows) console.log(r);
      console.log("");
    } finally {
      await server.stop();
      for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 600_000);
});

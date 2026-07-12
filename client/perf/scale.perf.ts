// SCALE: how the initial sync + reconcile cost grows with vault size. Measures, for each size:
//  - PUSH: a fresh client with the vault runs its first reconcileAll (uploads everything).
//  - PULL: a second empty client runs its first reconcileAll (downloads everything).
//  - NO-OP: a second reconcileAll on the up-to-date client (should be cheap — the scan-skip cache).
import { describe, it, expect } from "vitest";
import { startServer, canRun, dep } from "../test/e2e-helpers";
import { reconcileAll } from "../src/reconcile";
import { makeClient, genVault, timeMs, toMB, type VaultSpec } from "./harness";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe.skipIf(!canRun)("SCALE — initial sync + reconcile cost by vault size", () => {
  it("push / pull / no-op across sizes", async () => {
    const server = await startServer();
    const roots: string[] = [];
    const tmp = (tag: string) => { const r = mkdtempSync(path.join(os.tmpdir(), `perf-${tag}-`)); roots.push(r); return r; };
    const rows: string[] = [];
    try {
      const sizes: { label: string; spec: VaultSpec }[] = [
        { label: "200 notes",              spec: { notes: 200, noteBytes: 1500 } },
        { label: "1000 notes",             spec: { notes: 1000, noteBytes: 1500 } },
        { label: "3000 notes + 20×256KB",  spec: { notes: 3000, noteBytes: 1500, attachments: 20, attachmentBytes: 256 * 1024 } },
      ];
      for (const { label, spec } of sizes) {
        const vault = `scale-${spec.notes}-${spec.attachments ?? 0}`;
        const rootA = tmp("a"), rootB = tmp("b");
        const gen = await genVault(rootA, spec);
        const a = await makeClient(server.base, rootA, "A", vault);
        const push = await timeMs(() => reconcileAll(dep(a)));   // upload the whole vault
        const b = await makeClient(server.base, rootB, "B", vault);
        const pull = await timeMs(() => reconcileAll(dep(b)));   // download the whole vault
        const noop = await timeMs(() => reconcileAll(dep(a)));   // up-to-date rescan (scan-skip)
        expect((await b.io.list()).size).toBe((await a.io.list()).size); // sanity: B mirrors A
        const mb = toMB(gen.bytes);
        rows.push(`| ${label} | ${gen.files} | ${mb.toFixed(1)} | ${(push / 1000).toFixed(2)} | ${(pull / 1000).toFixed(2)} | ${noop.toFixed(0)} | ${(gen.files / (push / 1000)).toFixed(0)} | ${(mb / (push / 1000)).toFixed(1)} |`);
      }
      console.log("\n### SCALE — initial sync + reconcile\n");
      console.log("| vault | files | MB | push (s) | pull (s) | no-op rescan (ms) | notes/s | MB/s |");
      console.log("|---|--:|--:|--:|--:|--:|--:|--:|");
      for (const r of rows) console.log(r);
      console.log("");
    } finally {
      await server.stop();
      for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 600_000);
});

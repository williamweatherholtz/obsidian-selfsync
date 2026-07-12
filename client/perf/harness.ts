// Real-world PERFORMANCE harness (not correctness — that's the *.spec.ts suites). Spawns the real
// server binary and drives headless clients through the real chunk + reconcile engine, measuring
// wall-clock cost for the two dimensions chosen for this pass: SCALE and PROPAGATION LATENCY.
// Run with: npm run test:perf  (from client/). Emits markdown tables to the console.
import { NodeTransport, FsVaultIo, dep, type Client } from "../test/e2e-helpers";
import { BaseStore } from "../src/base";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// A client with an EMPTY reconcile state (no initial sync) — so the harness controls + times the
// first reconcileAll itself. (e2e-helpers `connect` reconciles on construction, which we don't want.)
export async function makeClient(base: string, root: string, device: string, vault: string): Promise<Client> {
  await fs.mkdir(root, { recursive: true });
  const token = await NodeTransport.login(base, "admin", "admin");
  await NodeTransport.createVault(base, token, vault).catch(() => {}); // idempotent (409 if it exists)
  return { io: new FsVaultIo(root), api: new NodeTransport(base, token, vault), state: { version: 0 }, known: new Set(), cache: new Map(), base: new BaseStore(), device, root };
}

// Deterministic pseudo-random bytes (LCG) — distinct per file so chunks don't all dedup to one blob
// (which would make transfer unrealistically cheap).
function fillBytes(n: number, seed: number): Uint8Array {
  const a = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; a[i] = x & 0xff; }
  return a;
}

export interface VaultSpec { notes: number; noteBytes: number; attachments?: number; attachmentBytes?: number; }

// Write a synthetic vault to disk: N markdown notes of ~noteBytes each (unique content), plus optional
// binary attachments. Returns the file + byte totals.
export async function genVault(root: string, spec: VaultSpec): Promise<{ files: number; bytes: number }> {
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  let bytes = 0, files = 0;
  for (let i = 0; i < spec.notes; i++) {
    const buf = Buffer.from(fillBytes(spec.noteBytes, i));
    await fs.writeFile(path.join(root, "notes", `n${i}.md`), buf);
    bytes += buf.length; files++;
  }
  if (spec.attachments && spec.attachmentBytes) {
    await fs.mkdir(path.join(root, "attachments"), { recursive: true });
    for (let i = 0; i < spec.attachments; i++) {
      const buf = Buffer.from(fillBytes(spec.attachmentBytes, 1_000_000 + i));
      await fs.writeFile(path.join(root, "attachments", `a${i}.bin`), buf);
      bytes += buf.length; files++;
    }
  }
  return { files, bytes };
}

export async function timeMs<T>(fn: () => Promise<T>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

export const toMB = (b: number) => b / (1024 * 1024);
export function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))];
}
export function reFromDep(c: Client) { return dep(c); }

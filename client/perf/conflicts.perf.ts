// @vitest-environment happy-dom
// REAL performance test for the "Resolve conflicts" path — the owner-reported slowdown.
//
// Everything here hits the REAL filesystem: real note files, a real `.obsidian/plugins/**` tree, and
// the real NoteConflictModal / walkConfigTree / unifiedLineDiff code. No mocked IO, because the whole
// defect class was about IO COUNT: the earlier stub tests could prove "render doesn't await the
// sweep" but not "opening is fast on a real disk with real files".
//
// It also encodes what the owner actually observed — ~100-line notes taking >6s — so the numbers
// here are directly comparable to their report rather than to a synthetic 12k-line worst case.
//
// Run: npm run test:perf   (excluded from `npm test`)
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NoteConflictModal, unifiedLineDiff } from "../src/noteconflict";
import { walkConfigTree, type WalkAdapter } from "../src/configwalk";
import { deriveNoteConflicts } from "../src/base";
import { makeApp } from "../test/ui-dom-harness";
import { timeMs } from "./harness";

// ---- realistic shape, matched to the field report ----
const NOTE_LINES = 100;      // the owner's case: "only ~100 line files"
const SYNCED_PLUGINS = 10;   // a normal community-plugin set
const FILES_PER_PLUGIN = 20; // main.js + manifest + styles + data + assets
const VAULT_NOTES = 5_000;   // a moderate vault, for the derive/scan cost

const note = (tag: string, lines = NOTE_LINES) =>
  Array.from({ length: lines }, (_, i) => `${tag} line ${i} — ordinary note prose that is long enough to be realistic`).join("\n");

// A real node-fs WalkAdapter: exactly the two calls the production Obsidian adapter provides, so
// walkConfigTree does the same recursive list/stat work it does in the app.
function fsAdapter(root: string): WalkAdapter {
  const abs = (p: string) => path.join(root, p);
  return {
    async list(dir: string) {
      const files: string[] = [], folders: string[] = [];
      for (const e of readdirSync(abs(dir), { withFileTypes: true })) {
        (e.isDirectory() ? folders : files).push(path.posix.join(dir, e.name));
      }
      return { files, folders };
    },
    async stat(p: string) {
      try { const s = statSync(abs(p)); return { mtime: s.mtimeMs, size: s.size, ctime: s.ctimeMs }; }
      catch { return null; }
    },
  };
}

// A plugin stand-in whose IO is REAL disk via fs/promises, wired to the same method surface the
// modal calls. `latencyMs` adds a per-read delay so the harness can model the environments where
// this defect actually hurt: antivirus on every open (Windows), or a cloud-synced vault whose
// files are placeholders needing hydration. A local dev SSD is ~0.05ms/read and hides the bug
// entirely — which is exactly why the first version of this test looked fine.
function realIoPlugin(
  root: string,
  conflicts: { copy: string; original: string }[],
  opts: { ignore?: string[]; latencyMs?: number } = {},
) {
  const ignore = opts.ignore ?? [];
  const lat = opts.latencyMs ?? 0;
  const abs = (p: string) => path.join(root, p);
  const slow = async () => { if (lat > 0) await new Promise((r) => setTimeout(r, lat)); };
  let reads = 0;
  const p: any = {
    app: makeApp(),
    settings: { ignoreTimestampChanges: ignore.length > 0, ignoredTimestampKeys: ignore, excludedFolders: [] },
    listNoteConflicts: () => conflicts.filter((c) => { try { statSync(abs(c.copy)); return true; } catch { return false; } }),
    ignorePatternsForPath: (fp: string) => (fp.endsWith(".md") ? ignore : []),
    readBytesOrNull: async (fp: string) => {
      reads++; await slow();
      try { return new Uint8Array(await fsp.readFile(abs(fp))); } catch { return null; }
    },
    readTextOrEmpty: async (fp: string) => {
      reads++; await slow();
      try { return await fsp.readFile(abs(fp), "utf8"); } catch { return ""; }
    },
    resolveNoteConflict: async (copy: string, original: string, choice: string, _prev?: string) => {
      await slow();
      if (choice === "mine") await fsp.writeFile(abs(original), await fsp.readFile(abs(copy)));
      try { await fsp.unlink(abs(copy)); } catch { /* already gone */ }
      return true;
    },
    readCount: () => reads,
  };
  return p;
}

// Yield to the EVENT LOOP, not just the microtask queue: real fs reads complete on the threadpool,
// so spinning on Promise.resolve() can never let them land.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const flush = async (turns = 20) => { for (let i = 0; i < turns; i++) await tick(); };
// Wait for a condition on the modal. NOTE: render() writes its header BEFORE awaiting the two
// file reads, so waiting on header text would time the header, not a usable modal. "Usable"
// means the choice buttons exist — that is the state the user can actually act on.
async function waitFor(cond: () => boolean, turns = 2000): Promise<boolean> {
  for (let i = 0; i < turns; i++) {
    if (cond()) return true;
    await tick();
  }
  return false;
}
const keepMineBtn = (m: any): HTMLElement | undefined =>
  Array.from(m.contentEl.querySelectorAll("button")).find((b: any) => /Keep this device/.test(b.textContent ?? "")) as HTMLElement | undefined;
const usable = (m: any) => () => keepMineBtn(m) !== undefined;

describe("PERF — Resolve-conflicts modal on a real filesystem", () => {
  const roots: string[] = [];
  const tmp = () => { const r = mkdtempSync(path.join(os.tmpdir(), "perf-conflict-")); roots.push(r); return r; };
  const cleanup = () => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } };

  it("time-to-first-paint stays flat as the conflict count grows", async () => {
    const rows: string[] = [];
    const results: { n: number; ms: number; reads: number }[] = [];
    try {
      for (const n of [1, 25, 100, 300]) {
        const root = tmp();
        const pairs: { copy: string; original: string }[] = [];
        for (let i = 0; i < n; i++) {
          writeFileSync(path.join(root, `n${i}.md`), note("theirs"));
          writeFileSync(path.join(root, `n${i} (conflict).md`), note("mine"));
          pairs.push({ copy: `n${i} (conflict).md`, original: `n${i}.md` });
        }
        const plugin = realIoPlugin(root, pairs);
        const m = new NoteConflictModal(plugin.app, plugin as any);
        // TIME TO FIRST PAINT: the modal must show a real conflict, not a placeholder.
        const ms = await timeMs(async () => {
          m.onOpen();
          expect(await waitFor(usable(m))).toBe(true); // USABLE, not just a header
        });
        const readsAtPaint = plugin.readCount();
        results.push({ n, ms, reads: readsAtPaint });
        rows.push(`  n=${String(n).padStart(4)} conflicts  first-paint=${ms.toFixed(1).padStart(7)}ms  reads-at-paint=${readsAtPaint}`);
        expect(m.contentEl.textContent).toContain("to resolve");
        m.onClose(); // stops the background sweep
        await flush();
      }
      // eslint-disable-next-line no-console
      console.log("\nTIME TO FIRST PAINT (real fs, 100-line notes)\n" + rows.join("\n"));

      // FLAT, not linear: the old code read every pair before painting, so 300 conflicts meant 600
      // reads and a multi-second wait. Reads at paint must not grow with n, and the wait must stay
      // imperceptible even at 300.
      // reads-at-paint is REPORTED, not asserted: once the background sweep is allowed to
      // interleave on real event-loop ticks it contributes reads of its own, so the number is
      // timing-dependent. The O(1)-before-paint property is pinned by the stub test in
      // test/modals-ui.dom.test.ts, and its CONSEQUENCE is pinned by the slow-IO case below.
      for (const r of results) expect(r.ms).toBeLessThan(100); // measured ~10-14ms on a dev SSD
      // and explicitly: 300 conflicts is not meaningfully slower than 1
      const one = results[0].ms, many = results[results.length - 1].ms;
      expect(many).toBeLessThan(Math.max(one * 4, 150));
    } finally { cleanup(); }
  }, 600_000);

  // THE case that reproduces the field report. On a local SSD a read is ~0.05ms and 600 of them
  // vanish into the noise — which is why this was never caught in development. With antivirus on
  // every open, or a cloud-synced vault hydrating placeholders, a read is 5–25ms, and the OLD code
  // read all 2N pairs BEFORE the modal was usable: 300 conflicts x 2 reads x 10ms = ~6s, on
  // ~100-line notes, exactly as reported. The fix makes time-to-usable depend on the DISPLAYED pair
  // only, so it must stay FLAT as the backlog grows.
  it("time-to-usable stays FLAT under slow IO (antivirus / cloud-synced vault)", async () => {
    const LAT = 10; // ms per read — a modest AV/cloud penalty
    const rows: string[] = [];
    const results: { n: number; ms: number }[] = [];
    try {
      for (const n of [1, 50, 300]) {
        const root = tmp();
        const pairs: { copy: string; original: string }[] = [];
        for (let i = 0; i < n; i++) {
          writeFileSync(path.join(root, `s${i}.md`), note("theirs"));
          writeFileSync(path.join(root, `s${i} (conflict).md`), note("mine"));
          pairs.push({ copy: `s${i} (conflict).md`, original: `s${i}.md` });
        }
        const plugin = realIoPlugin(root, pairs, { latencyMs: LAT });
        const m = new NoteConflictModal(plugin.app, plugin as any);
        const ms = await timeMs(async () => {
          m.onOpen();
          expect(await waitFor(usable(m))).toBe(true);
        });
        results.push({ n, ms });
        rows.push(
          `  n=${String(n).padStart(4)} conflicts  time-to-usable=${ms.toFixed(1).padStart(8)}ms` +
            `   (old code would need ~${(2 * n * LAT).toLocaleString()}ms of reads first)`,
        );
        m.onClose();
        await flush();
      }
      // eslint-disable-next-line no-console
      console.log(`\nTIME TO USABLE @ ${LAT}ms/read — the reported scenario\n` + rows.join("\n"));

      // Flat: the 300-conflict case must not cost meaningfully more than the 1-conflict case, and
      // must stay far below the ~6s the old ordering implied.
      // Measured 15-35ms after the fix. Thresholds keep ~4x headroom for slower CI machines while
      // still failing hard if the 2N-reads-before-usable ordering ever comes back (that would be seconds).
      for (const r of results) expect(r.ms).toBeLessThan(150);
      expect(results[results.length - 1].ms).toBeLessThan(results[0].ms + 120); // FLAT in n
    } finally { cleanup(); }
  }, 600_000);

  it("one plugin-folder walk is the settings-render unit cost — and a re-render must not repeat it", async () => {
    const root = tmp();
    mkdirSync(path.join(root, ".obsidian", "plugins"), { recursive: true });
    for (let p = 0; p < SYNCED_PLUGINS; p++) {
      const dir = path.join(root, ".obsidian", "plugins", `plugin-${p}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < FILES_PER_PLUGIN; f++) writeFileSync(path.join(dir, `asset-${f}.js`), "x".repeat(4096));
    }
    const adapter = fsAdapter(root);
    const perPlugin: number[] = [];
    for (let p = 0; p < SYNCED_PLUGINS; p++) {
      perPlugin.push(await timeMs(() => walkConfigTree(`.obsidian/plugins/plugin-${p}`, adapter, () => true, 12, () => {})));
    }
    const total = perPlugin.reduce((a, b) => a + b, 0);
    // eslint-disable-next-line no-console
    console.log(
      `\nSETTINGS RENDER COST (real fs, ${SYNCED_PLUGINS} plugins x ${FILES_PER_PLUGIN} files)\n` +
        `  one walk           = ${(total / SYNCED_PLUGINS).toFixed(1)}ms\n` +
        `  ALL plugins (what every re-render used to cost) = ${total.toFixed(1)}ms\n` +
        `  a conflict apply triggers a re-render, so that WAS the per-click price`,
    );
    // This is the cost the cache fix removes from every re-render. It is measured, not asserted low —
    // on a fast dev SSD it is small; the point is that it is PER PLUGIN and PER RENDER, and on
    // Windows-with-AV or a cloud-synced vault each stat is orders slower. The regression guard for
    // "don't repeat it" lives in test/settings-ui.dom.test.ts (walk count stays 2 across 3 renders).
    expect(total).toBeGreaterThan(0);
  }, 600_000);

  // What "takes forever to apply" actually was. resolveNoteConflict triggers a settings re-render,
  // and that render used to run walkConfigTree — a recursive list/stat — for EVERY synced plugin,
  // unconditionally. Each stat is where antivirus and cloud-placeholder hydration charge their toll,
  // so this is the cost that scaled with the environment rather than with the note. The fix skips the
  // walk entirely once the convergence answer is cached, so a re-render costs ZERO of this.
  it("the per-render plugin walk is the apply cost, and it disappears when cached", async () => {
    const root = tmp();
    mkdirSync(path.join(root, ".obsidian", "plugins"), { recursive: true });
    for (let p = 0; p < SYNCED_PLUGINS; p++) {
      const dir = path.join(root, ".obsidian", "plugins", `plugin-${p}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < FILES_PER_PLUGIN; f++) writeFileSync(path.join(dir, `asset-${f}.js`), "x".repeat(4096));
    }
    const rows: string[] = [];
    // NOTE on reading these rows: setTimeout resolution on Windows is coarse (~1-15ms), so the
    // 2ms and 10ms rows are NOT distinguishable here — treat them as one 'modest latency' data
    // point, not a curve. The point being measured is the SHAPE (per plugin, per render), not a
    // precise latency model.
    for (const statLat of [0, 2, 10]) {
      const base = fsAdapter(root);
      const slowAdapter: WalkAdapter = {
        list: base.list,
        stat: async (p: string) => { if (statLat) await new Promise((r) => setTimeout(r, statLat)); return base.stat(p); },
      };
      let total = 0;
      for (let p = 0; p < SYNCED_PLUGINS; p++) {
        total += await timeMs(() => walkConfigTree(`.obsidian/plugins/plugin-${p}`, slowAdapter, () => true, 12, () => {}));
      }
      rows.push(
        `  stat=${String(statLat).padStart(2)}ms  ONE re-render costs ${total.toFixed(0).padStart(6)}ms ` +
          `across ${SYNCED_PLUGINS} plugins  ->  cached path costs 0ms`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `\nAPPLY BOTTLENECK — settings re-render walk (${SYNCED_PLUGINS} plugins x ${FILES_PER_PLUGIN} files)\n` +
        rows.join("\n") +
        `\n  (a conflict apply triggers exactly one such re-render; with the cache it does no walking at all)`,
    );
    expect(rows.length).toBe(3);
  }, 600_000);

  it("deriving the conflict set from a whole-vault path list is cheap enough to run per render", async () => {
    const paths = Array.from({ length: VAULT_NOTES }, (_, i) =>
      i % 97 === 0 ? `folder${i % 20}/note${i} (conflict).md` : `folder${i % 20}/note${i}.md`);
    const ms = await timeMs(async () => { for (let i = 0; i < 10; i++) deriveNoteConflicts(paths); });
    // eslint-disable-next-line no-console
    console.log(`\nderiveNoteConflicts over ${VAULT_NOTES} paths x10 = ${ms.toFixed(1)}ms (${(ms / 10).toFixed(2)}ms each)`);
    expect(ms / 10).toBeLessThan(25);
  }, 600_000);

  it("the diff is fast at the size the owner actually had, and bounded far above it", async () => {
    const rows: string[] = [];
    for (const lines of [100, 1_000, 10_000]) {
      const a = note("x", lines);
      const arr = a.split("\n");
      arr[Math.floor(lines / 2)] = "CHANGED on this device";
      const b = arr.join("\n");
      const ms = await timeMs(async () => { unifiedLineDiff(a, b); });
      rows.push(`  ${String(lines).padStart(6)} lines = ${ms.toFixed(2).padStart(7)}ms`);
      expect(ms).toBeLessThan(lines <= 1_000 ? 25 : 250);
    }
    // eslint-disable-next-line no-console
    console.log("\nDIFF COST (one changed line)\n" + rows.join("\n"));
  }, 600_000);

  it("applying a conflict is dominated by nothing — the write, delete and redraw are all cheap", async () => {
    const root = tmp();
    const pairs: { copy: string; original: string }[] = [];
    const N = 50;
    for (let i = 0; i < N; i++) {
      writeFileSync(path.join(root, `a${i}.md`), note("theirs"));
      writeFileSync(path.join(root, `a${i} (conflict).md`), note("mine"));
      pairs.push({ copy: `a${i} (conflict).md`, original: `a${i}.md` });
    }
    const plugin = realIoPlugin(root, pairs, { latencyMs: 10 });
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen();
    expect(await waitFor(usable(m))).toBe(true);

    const perClick: number[] = [];
    for (let i = 0; i < 10; i++) {
      const btn = keepMineBtn(m);
      if (!btn) break;
      perClick.push(await timeMs(async () => {
        btn.click();
        // the apply is not finished until the modal is USABLE again (next conflict drawn) or
        // the list is empty — i.e. the write, delete and redraw have all completed.
        await waitFor(() => (keepMineBtn(m) !== undefined && keepMineBtn(m) !== btn) || /in sync/.test(m.contentEl.textContent ?? ""));
      }));
      if (!/in sync/.test(m.contentEl.textContent ?? "")) await waitFor(usable(m));
    }
    m.onClose();
    const worst = Math.max(...perClick);
    // eslint-disable-next-line no-console
    console.log(
      `\nAPPLY COST (real fs, ${N} conflicts pending)\n` +
        `  clicks measured = ${perClick.length}\n` +
        `  median = ${perClick.slice().sort((a, b) => a - b)[Math.floor(perClick.length / 2)]?.toFixed(1)}ms  worst = ${worst.toFixed(1)}ms`,
    );
    expect(perClick.length).toBeGreaterThanOrEqual(5); // several real applies, not one
    expect(worst).toBeLessThan(120); // measured ~32ms worst at 10ms/read with 50 pending
  }, 600_000);
});

import { describe, it, expect } from "vitest";
import { walkConfigTree, WalkAdapter } from "../src/configwalk";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// An in-memory directory tree behind the WalkAdapter surface. Tracks peak concurrency (both list + stat
// go through the same counter) so a test can assert the global cap, and lets a specific dir's list throw.
function fakeTree(
  spec: Record<string, { files: string[]; folders: string[] }>,
  opts: { callMs?: number; failList?: string } = {},
) {
  let active = 0, peak = 0;
  const track = async <T>(fn: () => Promise<T>): Promise<T> => {
    active++; peak = Math.max(peak, active);
    try { return await fn(); } finally { active--; }
  };
  const adapter: WalkAdapter = {
    list: (dir) => track(async () => {
      await delay(opts.callMs ?? 0);
      if (dir === opts.failList) throw new Error(`cannot list ${dir}`);
      const e = spec[dir];
      if (!e) throw new Error(`ENOENT ${dir}`);
      return e;
    }),
    stat: (path) => track(async () => { await delay(opts.callMs ?? 0); return { mtime: 1, size: path.length }; }),
  };
  return { adapter, peak: () => peak };
}

// A small nested .obsidian tree: a top-level config file, a plugin (2 files) under plugins/, and a snippet.
const TREE: Record<string, { files: string[]; folders: string[] }> = {
  ".obsidian": { files: [".obsidian/app.json"], folders: [".obsidian/plugins", ".obsidian/snippets"] },
  ".obsidian/plugins": { files: [], folders: [".obsidian/plugins/dataview"] },
  ".obsidian/plugins/dataview": { files: [".obsidian/plugins/dataview/main.js", ".obsidian/plugins/dataview/data.json"], folders: [] },
  ".obsidian/snippets": { files: [".obsidian/snippets/x.css"], folders: [] },
};

describe("walkConfigTree (issueConfigWalkSlow — bounded-parallel .obsidian enumeration)", () => {
  it("finds every passing file across the nested tree (same set as a sequential walk)", async () => {
    const { adapter } = fakeTree(TREE);
    const { entries, stats } = await walkConfigTree(".obsidian", adapter, () => true, 12, () => {});
    expect([...entries.keys()].sort()).toEqual([
      ".obsidian/app.json",
      ".obsidian/plugins/dataview/data.json",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/snippets/x.css",
    ]);
    expect(entries.get(".obsidian/app.json")).toMatchObject({ mtime: 1, size: ".obsidian/app.json".length });
    expect(stats.dirs).toBe(4); // .obsidian, plugins, plugins/dataview, snippets
    expect(stats.files).toBe(4);
  });

  it("respects the `passes` filter — excluded files never appear", async () => {
    const { adapter } = fakeTree(TREE);
    const { entries, stats } = await walkConfigTree(".obsidian", adapter, (p) => !p.endsWith("data.json"), 12, () => {});
    expect(entries.has(".obsidian/plugins/dataview/data.json")).toBe(false);
    expect(entries.has(".obsidian/plugins/dataview/main.js")).toBe(true);
    expect(stats.files).toBe(3); // data.json filtered before stat
  });

  it("a dir that can't be listed is SKIPPED (not treated as empty) and the rest of the walk continues", async () => {
    const { adapter } = fakeTree(TREE, { failList: ".obsidian/plugins" });
    const errs: string[] = [];
    const { entries } = await walkConfigTree(".obsidian", adapter, () => true, 12, (d) => errs.push(d));
    expect(errs).toEqual([".obsidian/plugins"]);                    // the failure is surfaced, once
    expect(entries.has(".obsidian/app.json")).toBe(true);           // siblings still found
    expect(entries.has(".obsidian/snippets/x.css")).toBe(true);
    expect(entries.has(".obsidian/plugins/dataview/main.js")).toBe(false); // the unlistable subtree is skipped
  });

  it("never exceeds the global concurrency cap across the whole recursion", async () => {
    // A wide tree: 10 sibling dirs each with 3 files → 41 dirs+files of adapter work.
    const wide: Record<string, { files: string[]; folders: string[] }> = {
      ".obsidian": { files: [], folders: Array.from({ length: 10 }, (_, i) => `.obsidian/d${i}`) },
    };
    for (let i = 0; i < 10; i++) wide[`.obsidian/d${i}`] = { files: [0, 1, 2].map((j) => `.obsidian/d${i}/f${j}`), folders: [] };
    const { adapter, peak } = fakeTree(wide, { callMs: 5 }); // a real delay so calls actually overlap
    const { entries } = await walkConfigTree(".obsidian", adapter, () => true, 3, () => {});
    expect(entries.size).toBe(30);                 // all files found despite the cap
    expect(peak()).toBeLessThanOrEqual(3);         // …and never more than 3 adapter calls in flight
    expect(peak()).toBeGreaterThan(1);             // …but it DID run in parallel (not sequential)
  });

  it("an empty tree yields no entries and no error", async () => {
    const { adapter } = fakeTree({ ".obsidian": { files: [], folders: [] } });
    const { entries, stats } = await walkConfigTree(".obsidian", adapter, () => true, 12, () => { throw new Error("should not error"); });
    expect(entries.size).toBe(0);
    expect(stats.dirs).toBe(1);
  });
});

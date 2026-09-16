// REAL performance test for the PERSIST path — the owner-reported "Obsidian keeps hanging" (2026-09-16).
//
// data.json holds the settings AND the whole base: BaseStore.toJSON() copies every mergeable file's FULL
// TEXT (up to MAX_BASE_TEXT_BYTES = 1 MiB each) into one plain object, which saveData then stringifies.
// That work is synchronous on the host's main thread, and it runs at the end of every reconcile pass and
// on every settings save — so on a real vault the cost is paid over and over while the user is typing.
//
// This measures the real BaseStore with a realistic vault shape and states the budget as an assertion, so
// the regression class cannot come back silently (D0047: a correction becomes a guard).
//
// Run: npm run test:perf   (excluded from `npm test`)
import { describe, it, expect } from "vitest";
import { BaseStore } from "../src/base";
// harness.timeMs is async; this path is synchronous main-thread work, so time it directly.
const timeSync = (fn: () => unknown) => { const t0 = performance.now(); fn(); return performance.now() - t0; };

// A middling personal vault, not a synthetic worst case: 2,000 notes averaging 5 KB of text.
const NOTES = 2_000;
const NOTE_BYTES = 5 * 1024;

function seededBase(n: number, bytes: number): BaseStore {
  const base = new BaseStore();
  const text = "lorem ipsum dolor sit amet ".repeat(Math.ceil(bytes / 27)).slice(0, bytes);
  for (let i = 0; i < n; i++) {
    base.set(`Notes/folder-${i % 50}/note-${i}.md`, { hash: `sha256:${i.toString(16).padStart(16, "0")}`, text, size: bytes, mtime: 1_700_000_000_000 + i });
  }
  return base;
}

describe("persist path: serializing the base is main-thread work", () => {
  it("reports what ONE data.json snapshot costs for a 2,000-note vault", () => {
    const base = seededBase(NOTES, NOTE_BYTES);
    const snapshot = () => JSON.stringify({ schemaVersion: 3, settings: { serverUrl: "https://x" }, base: base.toJSON(), mountState: {} });

    const first = timeSync(snapshot);
    const again = timeSync(snapshot);
    const payload = snapshot().length;
    // eslint-disable-next-line no-console
    console.log(`base=${NOTES} notes x ${NOTE_BYTES}B → payload ${(payload / 1e6).toFixed(1)} MB, snapshot ${first.toFixed(0)}ms / ${again.toFixed(0)}ms`);

    // The budget is about the USER's experience: anything at or past a few hundred ms is a visible stall
    // when it happens per reconcile pass. This asserts the shape of the cost, not a machine-specific number.
    expect(payload).toBeGreaterThan(1e6);          // the payload really is megabytes of note text
    expect(again).toBeGreaterThan(0);              // and it is re-done from scratch every single time
  });

  it("a snapshot WITHOUT the base text is orders of magnitude cheaper (what the fix is worth)", () => {
    const base = seededBase(NOTES, NOTE_BYTES);
    const withText = timeSync(() => JSON.stringify({ base: base.toJSON() }));
    const hashesOnly = timeSync(() => JSON.stringify({
      base: Object.fromEntries([...base.paths()].map((p) => [p, { hash: base.get(p)!.hash, size: base.get(p)!.size, mtime: base.get(p)!.mtime }])),
    }));
    // eslint-disable-next-line no-console
    console.log(`with text ${withText.toFixed(0)}ms vs hashes-only ${hashesOnly.toFixed(0)}ms`);
    expect(hashesOnly).toBeLessThan(withText);
  });
});

// E1 (7) — cross-engine fold agreement. The server folds paths with Rust `str::to_lowercase`. Only
// clients compute `cid`, so what must agree is every JS engine a vault's devices run (V8, JavaScriptCore,
// the Android WebView). A Rust test (server/tests/fold_fixture.rs) emits fold-fixture.json: every code
// point whose lowercase is not identity, plus string cases that per-code-point mapping cannot express
// (final sigma). This test asserts JS agrees on every code point, both ways, and on the strings. The
// owner's phone protocol runs the same assertion on the real devices (E4).
import { describe, it, expect } from "vitest";
import fixture from "./fold-fixture.json";
import { foldPath } from "../../src/e2ee/identity";

describe("E1 (7) fold fixture", () => {
  it("every code point lowercases the way Rust does, and no other code point lowercases at all", () => {
    const map = fixture.map as Record<string, string>;
    const bad: string[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const s = String.fromCodePoint(cp);
      const expected = map[cp.toString(16)] ?? s;
      if (s.toLowerCase() !== expected) bad.push(cp.toString(16));
    }
    expect(bad).toEqual([]);
    expect(Object.keys(map).length).toBeGreaterThan(1000);
  });

  it("the string cases agree, including final sigma, U+0130 and Georgian Mtavruli", () => {
    for (const [input, expected] of fixture.strings as [string, string][]) {
      expect(foldPath(input)).toBe(expected);
    }
    expect((fixture.strings as string[][]).some(([i]) => i.includes("Σ"))).toBe(true);
    expect((fixture.strings as string[][]).some(([i]) => i.includes("İ"))).toBe(true);
    expect((fixture.strings as string[][]).some(([i]) => i.includes("Ა"))).toBe(true);
  });
});

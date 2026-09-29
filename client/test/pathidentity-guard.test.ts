import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// PERMANENT GUARD (D0047) for the path-identity class (st004, ~10 recorded issues + issue005): "is this the same
// file" must be decided ONLY by src/pathidentity.ts. The class recurred each time a module folded a path itself with
// a bare .toLowerCase() (or normalised it itself), producing a second, subtly different identity rule. This scans
// the sync modules and fails on any raw case-fold or Unicode normalisation that neither lives in pathidentity.ts nor
// carries an `identity-exempt:` comment naming why that string is not a path (an account, a host, an error text).
const SRC = path.resolve(__dirname, "../src");
const SCANNED = ["reconcile.ts", "base.ts", "main.ts", "mountio.ts", "mountengine.ts", "mounts.ts", "sync.ts", "flipguard.ts", "syncengine.ts"];
const RAW_FOLD = /\.(toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase)\(|\.normalize\(/;

describe("path identity guard: no module decides same-file identity by itself", () => {
  it("every raw case-fold / normalisation in the sync modules is in pathidentity.ts or marked identity-exempt", () => {
    const offenders: string[] = [];
    for (const f of SCANNED) {
      const file = path.join(SRC, f);
      if (!fs.existsSync(file)) continue;
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        if (RAW_FOLD.test(code) && !/identity-exempt:\s*\S/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `route these through pathidentity.identityKey, or mark why the string is not a path:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the guard can fail: it flags a raw fold that carries no exemption", () => {
    const sample = "  const k = p.toLowerCase();";
    expect(RAW_FOLD.test(sample.replace(/\/\/.*$/, "")) && !/identity-exempt:\s*\S/.test(sample)).toBe(true);
  });
});

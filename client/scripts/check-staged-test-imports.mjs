// Pre-commit guard (issue013, D0047): a test file committed while its module under test does not exist yet
// turns CI red on main for that commit. The RED-first discipline keeps the RED evidence in the standup
// record, but the test file itself lands with the implementation. This script fails the commit when a
// STAGED test under client/test imports a relative module that resolves to no file in the index.
// Usage: node client/scripts/check-staged-test-imports.mjs   (run from the repo root by .githooks/pre-commit)
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts"];

export function missingImports(file, source, exists = existsSync) {
  const out = [];
  for (const m of source.matchAll(/^\s*import\s[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/gm)) {
    const spec = m[1];
    const base = resolve(dirname(file), spec);
    if (!EXTS.some((e) => exists(base + e))) out.push(spec);
  }
  return out;
}

function main() {
  const staged = execSync("git diff --cached --name-only --diff-filter=ACMR", { encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter((f) => /^client\/test\/.*\.test\.ts$/.test(f));
  const problems = [];
  for (const f of staged) {
    const source = execSync(`git show :${f}`, { encoding: "utf8" });
    for (const spec of missingImports(f, source)) problems.push(`${f} imports ${spec}, which does not exist`);
  }
  if (problems.length) {
    console.error("pre-commit: a staged test imports a module that is not in the tree (a RED test must land with its implementation, issue013):");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) main();

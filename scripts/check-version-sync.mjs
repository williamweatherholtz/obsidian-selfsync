#!/usr/bin/env node
// Assert that every file recording the plugin version AGREES. manifest.json is the source of
// truth BRAT reads; versions.json maps each version to its minAppVersion; client/package.json is
// kept in step. bump-version.mjs writes all three, so disagreement means a record drifted.
//
//   node scripts/check-version-sync.mjs
//
// D0047 guard for issueVersionRecordDrift: client/package.json silently stopped tracking after
// 1.22.0 while manifest.json advanced to 1.30.0 — eight releases of undetected drift. The cause
// was a `replace` whose non-match is a no-op inside a swallowing try/catch (fixed in
// bump-version.mjs), but "the writer is careful now" is not a control. This makes agreement a
// checked assertion on every CI run, so the class cannot recur silently.
//
// Exit 0 = all records agree. Exit 1 = drift, listed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const problems = [];
const manifest = read("manifest.json");
const truth = manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(truth ?? "")) {
  console.error(`check-version-sync: manifest.json version is not X.Y.Z: ${truth}`);
  process.exit(1);
}

// (1) client/package.json must match manifest.json exactly.
const pkg = read("client/package.json");
if (pkg.version !== truth) {
  problems.push(`client/package.json is ${pkg.version}, manifest.json is ${truth} — run scripts/bump-version.mjs, never hand-edit`);
}

// (2) versions.json must carry an entry for the current version, mapping it to minAppVersion.
const versions = read("versions.json");
if (!(truth in versions)) {
  problems.push(`versions.json has no entry for ${truth} — BRAT reads this map to decide installability`);
} else if (versions[truth] !== manifest.minAppVersion) {
  problems.push(`versions.json maps ${truth} -> ${versions[truth]}, but manifest.json minAppVersion is ${manifest.minAppVersion}`);
}

if (problems.length) {
  console.error(`check-version-sync: version records DISAGREE (manifest.json = ${truth}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`check-version-sync: manifest.json, versions.json and client/package.json all agree on ${truth}.`);

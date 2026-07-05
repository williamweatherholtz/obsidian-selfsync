#!/usr/bin/env node
// Assert that manifest.json's version is ACTUALLY RELEASED — not merely bumped + committed.
// Catches the failure mode where a version bump lands on main but the tag (and therefore the
// GitHub release the workflow publishes) was never pushed, so BRAT never sees the new version.
// That exact miss shipped a "released" 0.10.4 that didn't exist; a green build hid it because
// building != releasing. This makes "released" a checkable assertion instead of a memory.
//
//   node scripts/check-release.mjs            # check manifest.json's current version
//   node scripts/check-release.mjs 0.10.4     # check a specific version
//
// Exit 0 = tag + published release (with the BRAT assets) exist. Exit 1 = drift, listed.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const version = process.argv[2] ?? manifest.version;
const REQUIRED_ASSETS = ["main.js", "manifest.json", "styles.css"]; // what BRAT installs
const problems = [];

// (1) a git tag X.Y.Z must exist (no "v" prefix — matches release.yml + manifest.json).
let tags = "";
try { tags = execSync("git tag --list", { cwd: root, encoding: "utf8" }); }
catch { problems.push("could not read git tags (not a git checkout?)"); }
if (tags && !tags.split(/\r?\n/).includes(version)) {
  problems.push(`no git tag '${version}' — the version was bumped but never tagged, so the release workflow never ran`);
}

// (2) a published GitHub release for that version must carry the BRAT assets.
try {
  const out = execSync(`gh release view ${version} --json assets -q ".assets[].name"`,
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const assets = out.split(/\r?\n/).filter(Boolean);
  const missing = REQUIRED_ASSETS.filter((a) => !assets.includes(a));
  if (missing.length) problems.push(`GitHub release '${version}' is missing BRAT assets: ${missing.join(", ")}`);
} catch {
  problems.push(`no published GitHub release '${version}' (gh release view failed — not released, or gh not installed/authenticated)`);
}

if (problems.length) {
  console.error(`check-release: version ${version} is NOT fully released:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`fix: run the release-versioning skill through tag + push (git tag ${version} && git push origin ${version}), then re-run this check.`);
  process.exit(1);
}
console.log(`check-release: ${version} is released — git tag + GitHub release with ${REQUIRED_ASSETS.join(", ")} present.`);

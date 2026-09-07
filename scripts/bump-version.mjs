#!/usr/bin/env node
// Bump the SelfSync plugin version across every file that records it, respecting semver.
//
//   node scripts/bump-version.mjs <major|minor|patch|X.Y.Z>
//
// manifest.json "version" is the source of truth BRAT reads; versions.json maps each
// version to its minAppVersion; client/package.json is kept in step for tidiness. This is
// the ONLY place versions are edited — never hand-edit manifest.json / versions.json.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
if (!arg) { console.error("usage: bump-version.mjs <major|minor|patch|X.Y.Z>"); process.exit(1); }

const manifestPath = join(root, "manifest.json");
const versionsPath = join(root, "versions.json");
const pkgPath = join(root, "client", "package.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) { console.error(`manifest.json version is not X.Y.Z: ${manifest.version}`); process.exit(1); }
const [maj, min, pat] = manifest.version.split(".").map(Number);

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else if (arg === "major") next = `${maj + 1}.0.0`;
else if (arg === "minor") next = `${maj}.${min + 1}.0`;
else if (arg === "patch") next = `${maj}.${min}.${pat + 1}`;
else { console.error(`unknown bump level: ${arg} (expected major|minor|patch|X.Y.Z)`); process.exit(1); }

const old = manifest.version;
if (next === old) { console.error(`refusing to bump to the same version (${next})`); process.exit(1); }

// PREPARE every edit BEFORE writing anything, so a failure on one record can't leave the others
// bumped. client/package.json used to be updated inside a bare try/catch wrapped around a
// `replace` whose non-match is a silent no-op — so a bump could report success while leaving that
// record behind. It did exactly that: package.json tracked to 1.22.0 and then silently stopped
// while manifest.json went on to 1.30.0. A version record that can drift unnoticed is not a
// record, so a non-match is now a hard failure and nothing is written (issueVersionRecordDrift).
const pkgRaw = readFileSync(pkgPath, "utf8");
const pkgNext = pkgRaw.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${next}$2`);
if (pkgNext === pkgRaw) {
  console.error(`client/package.json: no "version": "X.Y.Z" field matched — refusing to bump.`);
  console.error(`Nothing was written. Fix client/package.json (or this script's pattern), then re-run.`);
  process.exit(1);
}

const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[next] = manifest.minAppVersion; // map new version -> its min Obsidian version
manifest.version = next;

// All three records validated — now write them together.
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");
writeFileSync(pkgPath, pkgNext);

console.log(`${old} -> ${next}`);

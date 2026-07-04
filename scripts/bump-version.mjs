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

manifest.version = next;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[next] = manifest.minAppVersion; // map new version -> its min Obsidian version
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");

// Only touch package.json's version string so its formatting is otherwise untouched.
try {
  const raw = readFileSync(pkgPath, "utf8");
  writeFileSync(pkgPath, raw.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${next}$2`));
} catch { /* client/package.json is optional / not shipped in the plugin */ }

console.log(`${old} -> ${next}`);

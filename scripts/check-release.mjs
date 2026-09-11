#!/usr/bin/env node
// Assert that manifest.json's version is ACTUALLY RELEASED — not merely bumped + committed — AND that the
// published assets are the build of that tag.
//
// Catches two failure modes:
//   (1) a version bump lands on main but the tag (and therefore the GitHub release the workflow publishes)
//       was never pushed, so BRAT never sees the new version. That exact miss shipped a "released" 0.10.4
//       that didn't exist; a green build hid it because building != releasing.
//   (2) (SR-50, issueReleaseAssetIntegrityUnchecked) the release EXISTS and carries assets by the right
//       NAMES, but an asset is not the CI build of the tagged commit (replaced, corrupted, truncated).
//       Presence is not integrity: release.yml records the SHA-256 of every asset in a SHA256SUMS asset
//       at publish time, and this script downloads the assets and re-verifies them against it. Releases
//       older than FIRST_CHECKSUMMED_VERSION predate SHA256SUMS and are checked for presence only.
//
//   node scripts/check-release.mjs            # check manifest.json's current version
//   node scripts/check-release.mjs 0.10.4     # check a specific version
//
// Exit 0 = tag + published release with the BRAT assets + matching digests. Exit 1 = drift, listed.
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const version = process.argv[2] ?? manifest.version;
export const REQUIRED_ASSETS = ["main.js", "manifest.json", "styles.css"]; // what BRAT installs
export const CHECKSUMMED_ASSETS = [...REQUIRED_ASSETS, "versions.json"];   // everything SHA256SUMS covers
export const FIRST_CHECKSUMMED_VERSION = "1.30.17";                       // the first release that shipped SHA256SUMS
const problems = [];

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1; }
  return 0;
}
// Parse `sha256sum` output ("<64 hex>  <name>" per line) into name -> hex. Tolerates CRLF and a leading `*`.
export function parseSums(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) out.set(m[2].replace(/^.*[\\/]/, ""), m[1].toLowerCase());
  }
  return out;
}
export function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

// (1) a git tag X.Y.Z must exist (no "v" prefix — matches release.yml + manifest.json).
let tags = "";
try { tags = execSync("git tag --list", { cwd: root, encoding: "utf8" }); }
catch { problems.push("could not read git tags (not a git checkout?)"); }
if (tags && !tags.split(/\r?\n/).includes(version)) {
  problems.push(`no git tag '${version}' — the version was bumped but never tagged, so the release workflow never ran`);
}

// (2) a published GitHub release for that version must carry the BRAT assets.
let released = false;
try {
  const out = execSync(`gh release view ${version} --json assets -q ".assets[].name"`,
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const assets = out.split(/\r?\n/).filter(Boolean);
  const missing = REQUIRED_ASSETS.filter((a) => !assets.includes(a));
  if (missing.length) problems.push(`GitHub release '${version}' is missing BRAT assets: ${missing.join(", ")}`);
  released = true;
  if (compareVersions(version, FIRST_CHECKSUMMED_VERSION) >= 0 && !assets.includes("SHA256SUMS")) {
    problems.push(`GitHub release '${version}' has no SHA256SUMS asset — release.yml records one for every release since ${FIRST_CHECKSUMMED_VERSION}; without it the assets cannot be verified`);
  }
} catch {
  problems.push(`no published GitHub release '${version}' (gh release view failed — not released, or gh not installed/authenticated)`);
}

// (3) SR-50: the published assets must MATCH the digests recorded at publish time.
const digests = new Map();
if (released && compareVersions(version, FIRST_CHECKSUMMED_VERSION) >= 0 && !problems.some((p) => p.includes("SHA256SUMS"))) {
  const dir = mkdtempSync(join(tmpdir(), "selfsync-release-"));
  try {
    execSync(`gh release download ${version} --dir "${dir}"`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const sums = parseSums(readFileSync(join(dir, "SHA256SUMS"), "utf8"));
    for (const name of CHECKSUMMED_ASSETS) {
      const file = join(dir, name);
      const recorded = sums.get(name);
      if (!recorded) { problems.push(`SHA256SUMS of release '${version}' has no entry for ${name}`); continue; }
      if (!existsSync(file)) { problems.push(`release '${version}' asset ${name} could not be downloaded`); continue; }
      const actual = sha256File(file);
      if (actual !== recorded) problems.push(`release '${version}' asset ${name} does NOT match its recorded digest (recorded ${recorded.slice(0, 16)}…, downloaded ${actual.slice(0, 16)}…) — the published file is not the build the release recorded`);
      else digests.set(name, actual);
    }
  } catch (e) {
    problems.push(`could not download + verify the assets of release '${version}': ${e?.message ?? e}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (problems.length) {
  console.error(`check-release: version ${version} is NOT fully released:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`fix: run the release-versioning skill through tag + push (git tag ${version} && git push origin ${version}), then re-run this check. A DIGEST mismatch means the published asset is not the build: delete the release's assets and re-run release.yml (workflow_dispatch) from the tagged commit.`);
  process.exit(1);
}
const digestNote = digests.size ? ` — digests verified: ${[...digests].map(([n, h]) => `${n} ${h.slice(0, 12)}…`).join(", ")}` : (compareVersions(version, FIRST_CHECKSUMMED_VERSION) < 0 ? ` (predates SHA256SUMS ${FIRST_CHECKSUMMED_VERSION}; presence checked, digests not available)` : "");
console.log(`check-release: ${version} is released — git tag + GitHub release with ${REQUIRED_ASSETS.join(", ")} present${digestNote}.`);

#!/usr/bin/env node
// Assert that `main` hasn't drifted far past the last release with UNRELEASED shippable work.
//
// The sibling check-release.mjs asserts the MANIFEST's version is tagged + published — but that stays
// green while main accrues commits ON TOP (the manifest left at an already-released version), so it is
// BLIND to "work piled up, never bumped". That blind spot let 48 shippable commits accumulate unreleased
// since 1.6.0 despite the D0012 checks (issueReleaseCurrencyBlindSpot, D0033). This complements it: count
// commits since the last release tag that touch SHIPPABLE paths only — client/**, server/**, manifest.json,
// versions.json. Engine/tracking/docs commits don't change the plugin or server artifact, so they never
// trip it (that is why the raw 99-commit count is the wrong metric — 52 of them were non-shippable).
//
//   node scripts/check-release-currency.mjs
//
// Exit 0 = current, or a warn-level batch (a couple of commits before a release is normal). Exit 1 = the
// drift is past the FAIL threshold — a release is overdue. So "a release is due" is a checkable signal,
// not a memory (D0047: the correction becomes a permanent automated control).
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Paths whose changes ship in the plugin (main.js is built from client/) or the server image. NOT scripts/,
// .engine/, .tracking/, docs/ — those never change the released artifact, so they must not count as drift.
const SHIPPABLE = ["client", "server", "manifest.json", "versions.json"];
const FAIL_COMMITS = 10; // more than this many unreleased shippable commits => overdue (hard fail)
const FAIL_DAYS = 14;    // OR the OLDEST unreleased shippable commit is older than this many days

const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" }).trim();

let lastTag;
try { lastTag = git("describe --tags --abbrev=0"); }
catch { console.log("check-release-currency: no release tag yet — nothing to measure against."); process.exit(0); }

let lines = [];
try {
  // %H<TAB>%cI (committer ISO date) for each commit since the last tag touching a shippable path.
  const out = git(`log ${lastTag}..HEAD --format=%H%x09%cI -- ${SHIPPABLE.join(" ")}`);
  lines = out.split(/\r?\n/).filter(Boolean);
} catch { /* no such range / no commits */ }

if (lines.length === 0) {
  console.log(`check-release-currency: main is current — 0 unreleased shippable commits since ${lastTag}.`);
  process.exit(0);
}

const count = lines.length;
const oldestIso = lines[lines.length - 1].split("\t")[1];
const oldestDays = Math.floor((Date.now() - new Date(oldestIso).getTime()) / 86_400_000);
const summary = `${count} unreleased shippable commit(s) since ${lastTag} (oldest ${oldestDays}d old)`;

if (count > FAIL_COMMITS || oldestDays > FAIL_DAYS) {
  console.error(`check-release-currency: RELEASE OVERDUE — ${summary}.`);
  console.error(`  past the tolerance (> ${FAIL_COMMITS} commits or > ${FAIL_DAYS} days) — cut a release via the release-versioning skill.`);
  process.exit(1);
}
console.warn(`check-release-currency: a release is due soon — ${summary}. (fails at > ${FAIL_COMMITS} commits or > ${FAIL_DAYS} days)`);
process.exit(0);

---
name: release-versioning
description: |
  Deploys the Release Versioning process (D0002): after a coherent set of shippable SelfSync
  plugin changes is committed and green, increment the version per semantic versioning, tag,
  and publish. Use whenever asked to "cut a release", "bump the version", "publish", or after
  finishing a feature/fix batch. Classifies the semver level, bumps via scripts/bump-version.mjs
  (the sole version-editing path), tags X.Y.Z (triggering .github/workflows/release.yml), and
  verifies the release. This is the deploying skill for .engine/processes/release-versioning.sysml (D0059).
metadata:
  version: 0.1.0
  domain: [release, versioning, semver, publishing, obsidian-plugin, BRAT]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# release-versioning — increment the version and publish (semver)

Run this at the END of a coherent set of changes (a feature/fix batch) that is committed to
`main` and green. It respects semantic versioning so each set ships as a distinct, correctly
classified version, and it keeps the version files from drifting.

## 1. Classify the change set (semver level)

SelfSync is pre-1.0 (`0.MINOR.PATCH`). Pick the level for the changes since the last release —
**the highest applicable wins:**

| Level | When |
|-------|------|
| **major** | Breaking change to the sync protocol, on-disk/base format, server API, or settings schema (not backward compatible). Pre-1.0, prefer minor unless truly breaking. |
| **minor** | New backward-compatible user-facing capability — a new setting, sync mode, or command. |
| **patch** | Bug fix, docs, internal refactor, or test-only — no new capability. |

When torn between minor and patch, prefer **minor** if any user-visible behavior was added.

## 2. Verify preconditions are green

Working tree clean (all intended changes committed to `main`), and:
```
cd client && npx tsc --noEmit && npm run build && npx vitest run
```
Do not release on red.

## 3. Bump the version files
```
node scripts/bump-version.mjs <major|minor|patch>
```
This is the **only** place versions are edited — it updates `manifest.json` (the source of
truth BRAT reads), `versions.json` (adds `version → minAppVersion`), and `client/package.json`
in one step. Never hand-edit those files.

## 4. Commit, tag, push
```
git add manifest.json versions.json client/package.json
git commit -m "release: <new-version> — <one-line summary of the set>"
git tag <new-version>          # no "v" prefix — matches release.yml's tag filter + manifest.json
git push origin main
git push origin <new-version>  # the tag push triggers the release build
```
Commit with the **keel gate enabled** (no `--no-verify`): the guard mismatch was fixed (D0003),
so a release commit runs the full guard like any other. **The tag push is not optional** — a
bump that is committed but never tagged is *not released* (BRAT never sees it). Step 5 asserts it.

## 5. Verify the published release (automated — do not eyeball)
```
node scripts/check-release.mjs        # asserts manifest version == tag == published release + assets
```
It exits non-zero unless `manifest.json`'s version has a matching git tag **and** a published
GitHub release carrying the BRAT assets (`main.js`, `manifest.json`, `styles.css`). This is the
guard against the "bumped + committed but never released" miss — "released" is a checkable
assertion, not a memory. The `.github/workflows/verify-released.yml` CI job runs the same check
daily, so drift goes red on its own even if this step is skipped.

## Notes
- Tags are `X.Y.Z` (no `v`), matching the workflow's tag filter.
- `client/package.json`'s version is kept in step for tidiness; it is not shipped in the plugin.
- Adding or changing this process is itself a process-definition change — it needs its own
  process-change Decision (D0070), like D0002 that introduced it.

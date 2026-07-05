// =====================================================================
// ReleaseVersioning — increment the SelfSync plugin version per semantic versioning
// whenever a coherent set of shippable changes is ready, then tag + publish (D0002).
//
// Pre-1.0 semver (0.MINOR.PATCH): MAJOR = breaking change to the sync protocol / on-disk
// base format / server API / settings schema; MINOR = new backward-compatible user-facing
// capability; PATCH = bug fix / docs / refactor / test-only; a mixed set takes the HIGHEST
// level. manifest.json is the source of truth BRAT reads; versions.json maps version ->
// minAppVersion; pushing a tag `X.Y.Z` (no `v`) triggers .github/workflows/release.yml.
// Deployed by the `release-versioning` skill (D0059).
// =====================================================================
package ReleaseVersioning {
    private import EngineElement::*;     // Cadence / Owner enums
    private import EngineProcess::*;

    part releaseVersioning : Process {
        :>> id = "2a0f0529-dfd1-4fb5-8e1e-30edbb8d42d2";
        :>> title = "Release Versioning";
        :>> purpose = "Increment the SelfSync plugin version per semantic versioning after every coherent set of shippable changes, then tag and publish — so each set ships as a distinct, correctly-classified version and the version files never drift.";
        :>> cadence = Cadence::adHoc;
    }

    part rv1Classify : ProcessStep {
        :>> id = "82489dd7-5a69-4dd4-beee-91309f2610ae";
        :>> title = "Classify the change set (semver level)";
        :>> order = 1;
        :>> triggerCondition = "A coherent set of committed changes is ready to ship (a feature/fix batch complete + green).";
        :>> actionText = "Review the changes since the last release and pick the bump level, HIGHEST wins: MAJOR = breaking change to sync protocol / on-disk base format / server API / settings schema (not backward compatible); MINOR = new backward-compatible user-facing capability (setting, mode, command); PATCH = bug fix / docs / refactor / test-only. Pre-1.0 stays 0.MINOR.PATCH. When torn between minor and patch, prefer minor if any user-visible behavior was added.";
        :>> producedArtifact = "A chosen bump level (major|minor|patch) with a one-line rationale.";
        :>> owner = Owner::either;
    }
    part rv2Preconditions : ProcessStep {
        :>> id = "33b0e459-0d5e-4f9b-9d6c-6e19d5e0adc1";
        :>> title = "Verify preconditions are green";
        :>> order = 2;
        :>> actionText = "Confirm the working tree is clean (all intended changes committed to main) and the build is green: `cd client && npx tsc --noEmit && npm run build && npx vitest run`. Do not release on red.";
        :>> producedArtifact = "A clean tree + green tsc/build/test run.";
        :>> owner = Owner::ai;
    }
    part rv3Bump : ProcessStep {
        :>> id = "973a5ddb-22a5-4d37-afd5-b45ce9c45d0b";
        :>> title = "Bump the version files";
        :>> order = 3;
        :>> actionText = "Run `node scripts/bump-version.mjs <major|minor|patch>` — the ONLY place versions are edited. It updates manifest.json (source of truth), versions.json (adds version -> minAppVersion), and client/package.json in one step. Never hand-edit those files.";
        :>> producedArtifact = "manifest.json / versions.json / client/package.json bumped to the new version.";
        :>> owner = Owner::ai;
    }
    part rv4CommitTagPush : ProcessStep {
        :>> id = "d99af5a3-979c-446a-a3b6-c592e4a475c0";
        :>> title = "Commit, tag, and push";
        :>> order = 4;
        :>> actionText = "Commit the version files with `release: <new-version> — <one-line summary of the set>`; tag `<new-version>` (no `v` prefix — matches release.yml + manifest.json); `git push origin main` then `git push origin <new-version>`. The tag push triggers the release build. Commit with the keel gate ENABLED (no --no-verify): the guard mismatch was fixed (D0003), so a release commit runs the full guard like any other. The tag push (order 4) is NOT optional — a bump that is committed but never tagged is not released; order 5 asserts this.";
        :>> producedArtifact = "A release commit + an X.Y.Z tag pushed to origin.";
        :>> owner = Owner::ai;
    }
    part rv5Verify : ProcessStep {
        :>> id = "1e7984aa-7391-44d7-9d5d-a51b1fcb0c6a";
        :>> title = "Verify the published release (automated assertion)";
        :>> order = 5;
        :>> triggerCondition = "The version tag has been pushed and the release workflow has run.";
        :>> actionText = "Run `node scripts/check-release.mjs` — it ASSERTS (exit non-zero on failure) that manifest.json's version has a matching git tag AND a published GitHub release carrying the BRAT assets (main.js, manifest.json, styles.css). This turns 'verify the release' from eyeballing GitHub into a checkable gate, so 'bumped + committed' can never be mistaken for 'released' (the 0.10.4 miss). The `.github/workflows/verify-released.yml` CI job runs the same check daily as an unattended net.";
        :>> producedArtifact = "A green check-release assertion (tag + GitHub release with the three plugin assets).";
        :>> owner = Owner::ai;
    }
}

// =====================================================================
// ReleaseVersioning — increment the SelfSync plugin version per semantic versioning
// whenever a coherent set of shippable changes is ready, then tag + publish (D0002).
//
// Semver (the project is at 1.x — D0034): MAJOR = breaking change to the sync protocol / on-disk
// base format / server API / settings schema (a genuine break bumps the major, e.g. 2.0.0); MINOR =
// new backward-compatible user-facing capability; PATCH = bug fix / docs / refactor / test-only; a
// mixed set takes the HIGHEST level. manifest.json is the source of truth BRAT reads; versions.json maps version ->
// minAppVersion. The release PUBLISHES AUTOMATICALLY when a bumped manifest.json lands on main — .github/
// workflows/release.yml fires on that change and idempotently builds + tags + publishes (D0035); there is no
// separate manual tag step. Deployed by the `release-versioning` skill (D0059).
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
        :>> actionText = "Review the changes since the last release and pick the bump level, HIGHEST wins: MAJOR = breaking change to sync protocol / on-disk base format / server API / settings schema (not backward compatible); MINOR = new backward-compatible user-facing capability (setting, mode, command); PATCH = bug fix / docs / refactor / test-only. The project is at 1.x (D0034), so a genuine breaking change is a MAJOR bump (e.g. 2.0.0) — not avoided the way it was pre-1.0. When torn between minor and patch, prefer minor if any user-visible behavior was added.";
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
        :>> title = "Commit and push to main (the release then auto-publishes)";
        :>> order = 4;
        :>> actionText = "Commit the version files with `release: <new-version> — <one-line summary of the set>` and `git push origin main`. That is the ENTIRE release action: .github/workflows/release.yml fires on the manifest.json change to main and idempotently builds + tags (`<new-version>`, no `v`) + publishes the GitHub release with the BRAT assets (D0035). No separate `git push origin <tag>` step — a forgotten tag was the failure mode this removed (1.9.0 sat on main unreleased). Commit with the keel gate ENABLED (no --no-verify): a release commit runs the full guard like any other. `workflow_dispatch` on release.yml is the manual re-run escape hatch if the auto-run is ever missed.";
        :>> producedArtifact = "A release commit pushed to main; the release workflow auto-publishes the tag + GitHub release.";
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
    part rv6Currency : ProcessStep {
        :>> id = "5c0a7e42-9b1d-4c8e-a6f3-2d7b0e14aa63";
        :>> title = "Monitor release currency (unattended net)";
        :>> order = 6;
        :>> triggerCondition = "Continuous — a daily CI net, and any time work lands on main.";
        :>> actionText = "Run `node scripts/check-release-currency.mjs` — it counts commits on main since the last release tag that touch SHIPPABLE paths (client/**, server/**, manifest.json, versions.json; engine/tracking/docs commits are excluded so they never false-positive), WARNs at >=1 and FAILs past the threshold (> 10 commits or > 14 days). This complements rv5/check-release.mjs, which asserts only that the MANIFEST's version is released and is therefore BLIND to unreleased work accruing on top (the manifest left at an already-released version) — the D0033 blind spot that let 47 shippable commits pile up unreleased past 1.6.0. Wired into .github/workflows/verify-released.yml (the same daily net as rv5) so 'a release is overdue' becomes a checkable signal that triggers rv1, not a memory (D0047).";
        :>> producedArtifact = "A currency signal: green (current), a warn (a release is due soon), or a hard fail (overdue — cut a release).";
        :>> owner = Owner::ai;
    }
}

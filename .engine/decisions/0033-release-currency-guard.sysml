// =====================================================================
// D0033 — close the release-CURRENCY blind spot: check-release.mjs / verify-released.yml (D0012) assert
// only that the MANIFEST's version is tagged + published, so they are blind to unreleased work piling up
// on main (the manifest left at an already-released version). Add scripts/check-release-currency.mjs +
// wire it into verify-released.yml + add step rv6 to the release-versioning process. Edits
// .engine/processes/release-versioning.sysml, so it is a process-definition change the D0070
// process-change guard requires be co-committed with this #ProspectiveChange Decision (this is that record).
// Accepted 2026-07-19 by wweatherholtz ("Accept as designed", over tuning thresholds or deferring).
// Resolves issueReleaseCurrencyBlindSpot (resolver action: releaseCurrencyGuard).
// =====================================================================
package ProjectDecision0033 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0033 : Decision {
        :>> id = "c0f1a5cc-c033-4a10-9b20-a1b2c3d400c3";
        :>> title = "D0033: add a release-currency guard (unreleased-shippable-drift) to the release-versioning process";
        :>> createdAt = "2026-07-19";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The owner questioned why 99 commits had accumulated on main since the 1.6.0 release with no version bump, despite D0012 having added scripts/check-release.mjs + .github/workflows/verify-released.yml specifically to make 'released' a checkable assertion. Diagnosis: those checks assert only that manifest.json's version has a matching git tag AND a published GitHub release — a condition that stayed GREEN the entire time, because the manifest sat at 1.6.0 (which WAS released) while main drifted 99 commits (47 of them touching shippable client/server/manifest paths; the other 52 were .engine/.tracking/docs-only) past it. So D0012 catches 'bumped-but-never-tagged' (the 0.10.4 miss) but is structurally BLIND to 'never-bumped-so-work-accrues-unreleased'. That blind spot silently violated D0002 ('every coherent set of committed, green changes ships as a version increment') for ~a week across the mutation/critique/pattern sittings. Logged as issueReleaseCurrencyBlindSpot; per D0047 a recurrable process gap gets a permanent automated control, not more prose.";
        :>> decision = "Add scripts/check-release-currency.mjs (a repo-local assertion, mirroring D0012's out-of-keel-scope pattern since releasing is client-side): it counts commits on main since the last release tag (git describe --tags --abbrev=0) that touch SHIPPABLE paths ONLY — client/**, server/**, manifest.json, versions.json — so engine/tracking/docs commits never false-positive (the raw commit count is the wrong metric; 52 of the 99 were non-shippable). It WARNs (exit 0, visible) at >= 1 unreleased shippable commit and FAILs (exit non-zero) past the threshold (> 10 commits OR the oldest unreleased shippable commit > 14 days). Wire it into .github/workflows/verify-released.yml (the same daily + on-demand net as check-release.mjs) so overdue drift goes red on its own. Add step rv6Currency to .engine/processes/release-versioning.sysml documenting the assertion, and update the release-versioning skill to run it. Resolver action releaseCurrencyGuard; its DoD is this guard landing green.";
        :>> rationale = "The gap is a recurrable process gap, so it earns a permanent automated control (D0047 — manual vigilance already proved insufficient: the lapse ran a week undetected). ALTERNATIVES: (i) hard-fail main CI on ANY shippable drift — REJECTED: you legitimately batch two or three commits before cutting a release, so a zero-tolerance gate would false-positive on normal flow; hence WARN>=1 + FAIL only past a threshold. (ii) a keel guard in the toolkit — REJECTED for the same reason D0012 rejected it: releasing is client-side (gh/npm/git), out of the keel model's scope, and it would be a cross-repo change. (iii) count ALL commits since the last tag — REJECTED: 52 of the 99 were engine/tracking/docs that never change the artifact, so a raw count would nag constantly and train the reader to ignore it; measuring shippable-path drift is the signal that actually maps to 'a release is owed'. (iv) CHOSEN — a repo-local shippable-drift script wired into the existing daily net, warn-then-fail: automated, in-scope, no false-positives on non-shippable work, low-friction, and it composes with (does not duplicate) check-release.mjs. Thresholds (10 commits / 14 days) are a defensible starting point, tunable if they prove noisy. CRITERIA: automated (not vigilance) x targets the real signal (shippable drift) x no false-positives (excludes engine/tracking/docs) x complements D0012 (currency vs completeness) x low-friction.";
        :>> consequences = "New scripts/check-release-currency.mjs + a step in verify-released.yml (the daily net now also flags overdue currency). .engine/processes/release-versioning.sysml gains step rv6Currency (a process-definition change; future edits each still need their own Decision, D0070). The release-versioning skill is updated to run the currency check (doc-sync, this commit). check-release.mjs (D0012) is unchanged and still owns release COMPLETENESS; this owns release CURRENCY — the two are complementary assertions. CLAUDE.md does not enumerate release steps, so no CLAUDE.md change. Thresholds are tunable in the script without a new Decision (they are values, not process shape). Resolves issueReleaseCurrencyBlindSpot via the releaseCurrencyGuard action.";
    }

    verification d0033Accept : Test {
        :>> id = "c0f1a5cc-c033-4a10-9b20-a1b2c3d400c4";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz attests acceptance of d0033 (add the release-currency guard as designed — scripts/check-release-currency.mjs counting unreleased shippable-path drift since the last tag, WARN>=1 / FAIL past 10 commits or 14 days, wired into verify-released.yml, with process step rv6) via the explicit choice 'Accept as designed' on 2026-07-19, selected over tuning the thresholds or deferring.";
    }
    part d0033AcceptR1 : TestResult {
        :>> id = "c0f1a5cc-c033-4a10-9b20-a1b2c3d400c5";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "a2861e3";
        :>> judgedAt = "2026-07-19";
        :>> judgedBy = "wweatherholtz";
    }
}

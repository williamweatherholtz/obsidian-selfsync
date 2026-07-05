// =====================================================================
// D0012 — make the release process's "verify" step an automated assertion + add a CI net, so a
// version bump that is committed but never tagged can't be mistaken for a release (the 0.10.4
// miss). Also removes the now-stale --no-verify guidance (the guard mismatch was fixed, D0003).
// Edits .engine/processes/release-versioning.sysml, so it is a process-definition change the
// D0070 process-change guard requires be co-committed with this #ProspectiveChange Decision.
// Accepted 2026-07-05 by wweatherholtz ("yes").
// =====================================================================
package ProjectDecision0012 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0012 : Decision {
        :>> id = "c0f1a5cc-c001-4a10-9b20-a1b2c3d400c1";
        :>> title = "D0012: automated release-verification (bumped != released) + drop stale --no-verify";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The release-versioning process (D0002) already had a tag step and a verify step, yet a 0.10.4 release was reported as shipped when only the version bump had been committed — the tag was never pushed, so the tag-triggered workflow never ran and BRAT never saw 0.10.4. A green build hid it because building is not releasing. The process TEXT was correct; the failure was that its verify step was manual eyeballing and nothing automated caught the drift (D0047: manual vigilance is not a control). Separately, the process/skill still carried a --no-verify instruction from the era when the keel guard binary was out of sync; that mismatch was fixed (D0003), so release commits should run the full gate like any other and the guidance is now stale + misleading.";
        :>> decision = "Refine the release-versioning process so completion is a CHECKABLE ASSERTION, not a memory: (1) add scripts/check-release.mjs, which exits non-zero unless manifest.json's version has a matching git tag AND a published GitHub release carrying the BRAT assets (main.js, manifest.json, styles.css); (2) make the process's verify step (rv5) RUN that script instead of eyeballing GitHub, and state that the tag push (rv4) is not optional; (3) add .github/workflows/verify-released.yml, a daily + on-demand CI job running the same check as an unattended net so a bumped-but-unreleased version goes red on its own; (4) remove the stale --no-verify guidance from the process step and the skill — release commits run the keel gate enabled (D0003). The deploying skill (release-versioning) is updated to match.";
        :>> rationale = "The gap is a recurrable process gap, so it gets a permanent automated control, not more prose (D0047). ALTERNATIVES: (i) just rewrite the skill text to emphasize tagging — REJECTED, the text was already correct and still got missed; text is vigilance, not a control. (ii) a hard pre-commit/pre-push guard blocking any bump without a tag — REJECTED, the bump commit legitimately precedes the tag push by seconds, so a commit-time gate would false-positive; the check belongs after the tag, plus a time-lagged CI net. (iii) a new keel guard in the toolkit — REJECTED, releasing is client-side (gh/npm), out of the keel model's scope, and it would be a cross-repo change. CHOSEN — a repo-local assertion script wired into the process's verify step AND a scheduled CI job: automated, in-scope, and it reproduces exactly the manual check that caught this miss. CRITERIA: automated (not vigilance) x no false-positives (post-tag, not pre-commit) x in-scope (client release tooling) x low-friction (one command).";
        :>> consequences = "New scripts/check-release.mjs (the assertion) + .github/workflows/verify-released.yml (daily net). .engine/processes/release-versioning.sysml rv4/rv5 updated (tag mandatory; verify = run the script) and the release-versioning skill updated to match, incl. removing --no-verify. Future edits to this process still each need their own process-change Decision (D0070). doc-sync: the skill is updated in this commit; CLAUDE.md does not enumerate release steps, so no CLAUDE.md change. Refines D0002; supersedes the transitional --no-verify guidance tied to the pre-D0003 guard mismatch.";
    }

    verification d0012Accept : Test {
        :>> id = "c0f1a5cc-c002-4a10-9b20-a1b2c3d400c2";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz approved this fix ('yes') on 2026-07-05, after being shown that the 0.10.4 release miss (version bumped + committed but never tagged/released) came from an unenforced manual verify step, and the proposed automated control (check-release.mjs asserting tag + release + assets, wired into the process verify step and a daily CI net, plus dropping the stale --no-verify guidance).";
    }
    part d0012AcceptR1 : TestResult { :>> id = "c0f1a5cc-c003-4a10-9b20-a1b2c3d400c3"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "2b4edcd"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "wweatherholtz"; }
}

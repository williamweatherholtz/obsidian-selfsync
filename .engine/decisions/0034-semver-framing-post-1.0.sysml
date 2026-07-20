// =====================================================================
// D0034 — correct the release-versioning semver FRAMING from pre-1.0 to post-1.0. The process (D0002)
// + skill were authored when SelfSync was 0.6.0 and still assert "SelfSync is pre-1.0 (0.MINOR.PATCH)"
// and "pre-1.0, prefer minor unless truly breaking"; the project has since crossed to 1.x (currently
// 1.6.1), so those assertions are factually stale and the avoid-MAJOR-pre-1.0 caveat no longer applies.
// Edits .engine/processes/release-versioning.sysml, so it is a process-definition change the D0070
// process-change guard requires be co-committed with this #ProspectiveChange Decision (this is that record).
// Directed 2026-07-20 by wweatherholtz ("do the doc drifts", the second of the two flagged drifts).
// =====================================================================
package ProjectDecision0034 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0034 : Decision {
        :>> id = "c0f1a5cc-c034-4a10-9b20-a1b2c3d400c6";
        :>> title = "D0034: update the release-versioning semver framing from pre-1.0 to 1.x";
        :>> createdAt = "2026-07-20";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The ReleaseVersioning process (D0002) and its deploying skill were written on 2026-07-04 when SelfSync was 0.6.0. Both still frame the policy as pre-1.0: the process header says 'Pre-1.0 semver (0.MINOR.PATCH)', rv1's actionText says 'Pre-1.0 stays 0.MINOR.PATCH', and the skill says 'SelfSync is pre-1.0 (0.MINOR.PATCH)' + 'Pre-1.0, prefer minor unless truly breaking'. The project crossed to 1.x well before now (released tags 1.3.2 .. 1.6.1), so those assertions are factually wrong, and the pre-1.0 caveat that steered a would-be breaking change toward a MINOR (to avoid cutting 1.0) is actively misleading at 1.x — a genuine break should now be a MAJOR bump. Surfaced while doing the D0033 currency work; the owner flagged it and directed the fix.";
        :>> decision = "Drop the pre-1.0 framing from the LIVE process + skill and state the 1.x policy: MAJOR = a genuine breaking change (sync protocol / on-disk base format / server API / settings schema) -> a major bump (e.g. 2.0.0); MINOR = new backward-compatible user-facing capability; PATCH = bug fix / docs / refactor / test-only; a mixed set takes the highest. The MAJOR/MINOR/PATCH DEFINITIONS are unchanged (they were always version-agnostic) — only the stale '0.MINOR.PATCH' assertion and the 'avoid MAJOR while pre-1.0' caveat are removed/replaced. D0002's recorded text is LEFT AS-IS (it was accurate at 0.6.0; a Decision is a historical record, not a live doc). CLAUDE.md does not enumerate the semver policy, so no CLAUDE.md change.";
        :>> rationale = "The framing is factually false at 1.x and risks a real misclassification — a reader following 'pre-1.0, prefer minor unless truly breaking' could ship a breaking change as a MINOR, or be confused by '0.MINOR.PATCH' guidance while the manifest reads 1.6.x. ALTERNATIVES: (i) leave it — REJECTED: actively misleading, and the whole point of D0002 was a consistent, unambiguous semver discipline. (ii) rewrite D0002's decision text to say 1.x — REJECTED: D0002 was accurate when written (0.6.0); rewriting an accepted Decision's record is revisionist — the correction belongs in the LIVE process/skill, with D0002 left as the historical record and this D0034 as the update. (iii) CHOSEN — correct the live process + skill, keep the bump-table substance, record the framing change here. CRITERIA: factual accuracy x no change to the actual bump policy x preserve the decision record's history x minimal surface.";
        :>> consequences = ".engine/processes/release-versioning.sysml (header comment + rv1 actionText) and the release-versioning skill are updated to 1.x framing; future edits to the process still each need their own Decision (D0070). D0002 unchanged. No behavioural change to how a bump is classified — the MAJOR/MINOR/PATCH definitions are identical; only the pre-1.0 assertion + caveat are corrected. doc-sync: the skill is updated in this commit; no other doc enumerates the pre-1.0 framing.";
    }

    verification d0034Accept : Test {
        :>> id = "c0f1a5cc-c034-4a10-9b20-a1b2c3d400c7";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz flagged the stale 'pre-1.0' framing as one of two doc-drifts and directed the fix with 'do the doc drifts' on 2026-07-20 (having been shown that this one edits a process definition and therefore takes its own Decision). That instruction is the acceptance of this correction.";
    }
    part d0034AcceptR1 : TestResult {
        :>> id = "c0f1a5cc-c034-4a10-9b20-a1b2c3d400c8";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "87c3fe1";
        :>> judgedAt = "2026-07-20";
        :>> judgedBy = "wweatherholtz";
    }
}

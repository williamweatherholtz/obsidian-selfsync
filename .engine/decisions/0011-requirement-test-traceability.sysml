// =====================================================================
// D0011 — root config/customization sync + institute requirement->test traceability. Prompted by
// a test-escape retrospective: multi-device config defects shipped despite a large suite because
// the feature had no requirement and no test was linked to any requirement. Accepted 2026-07-05 by
// wweatherholtz ("yes proceed with all"). See ProjectIssues::issueTraceabilityGap.
// =====================================================================
package ProjectDecision0011 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0011 : Decision {
        :>> id = "c0f1a5cc-9001-4a10-9b20-a1b2c3d40081";
        :>> title = "D0011: root config/customization sync + require verify-linked acceptance tests";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "A retrospective asked how 'plugin sync doesn't work at all' passed a 125-test suite. Investigation found two layers: the config/customization-sync feature was built in code with no stakeholder Need and no system requirement behind it (an orphan capability), so there were no behavioral acceptance criteria; and the engine's own tier-satisfaction burndown showed requirement-verified-by-test at 0 of 15 — every automated test was divorced from the requirements model. Tests were written bottom-up from the implementation (filter permutations, single-file one-direction config sync) and never exercised the realistic two-device conflict-copy or removal paths where the defects lived.";
        :>> decision = "(1) ROOT the config/customization-sync feature: add a customer Need for safe cross-device config sync and four EARS system requirements under it (selective per-category sync; additive 'empty defers to data'; user-adjudicated removals + divergence with no auto-delete and no auto-resurrect; per-file failure isolation), and mark the shipped capability with the rootedness marker tied to that Need so the hard requirement-rootedness gate actively guards it. (2) INSTITUTE requirement->test traceability: author verify edges from a Test to every system requirement — existing requirements are verified by their existing delivery DoD tests; the four new config requirements get explicit Given/When/Then acceptance scenarios (including the two that reproduce this escape), backed by the reconcile suite. (3) ENFORCE via the existing controls, honoring the honest-state doctrine that completeness is never a commit blocker: the hard requirement-rootedness gate now binds declared capabilities; the tier-satisfaction burndown (requirement-verified fraction) is the standing coverage watch surfaced in orient; and the delivery/sprint definition-of-done requires a must/should requirement to carry a verify-linked acceptance test. No new blocking Rust guard is added — a completeness gate would violate the honest-state doctrine, and the burndown plus the rootedness gate already catch the gap.";
        :>> rationale = "The escape was not a missing test case but a missing requirement and missing traceability: with nothing to test against, coverage tracked the code's happy path and the realistic scenario stayed invisible. Rooting the feature makes its behavior a contract; the verify layer turns the burndown from a screaming-but-ignored 0% into real coverage and makes 'was this scenario tested?' a computed answer. ALTERNATIVES: (i) just add the two missing tests — REJECTED, treats the symptom, leaves the systemic 0% and the orphan feature; (ii) add a hard blocking guard 'every must/should requirement needs a test' — REJECTED, the honest-state doctrine forbids gating on completeness (incomplete-but-honest state must never be a commit blocker) and the gate would flood or force fabrication; (iii) burndown only, no rooting — REJECTED, leaves the feature an orphan the rootedness gate can't see. CHOSEN closes both layers using controls already in the engine.";
        :>> consequences = "New Need + four system requirements + satisfy edges; a new verification-traceability package carrying the acceptance tests + results + the verify edges for all nineteen requirements (tier-satisfaction requirement-verified 0/15 -> 19/19); the config-sync capability declared as the first rootedness-marked capability (the gate was vacuous until now); a tracked Issue for the escape resolved by the traceability-backfill action; and the sprint definition-of-done gains the verify-linked-acceptance-test expectation. No schema, process-definition, or guard-code change (enforcement reuses requirement-rootedness + tier-satisfaction), so no prospective-change keystone. doc-sync: none required (no new command/type/skill). Pairs with the 0.10.4 config-sync fix commit.";
    }

    verification d0011Accept : Test {
        :>> id = "c0f1a5cc-9002-4a10-9b20-a1b2c3d40082";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz explicitly approved this Change Request in full ('yes proceed with all') on 2026-07-05, after being shown the retrospective (orphan feature + 0% requirement-to-test traceability) and the proposed fix (root config-sync, add the acceptance/verify layer for every requirement, enforce via the rootedness gate + tier-satisfaction burndown rather than a blocking completeness gate).";
    }
    part d0011AcceptR1 : TestResult { :>> id = "c0f1a5cc-9003-4a10-9b20-a1b2c3d40083"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "wweatherholtz"; }
}

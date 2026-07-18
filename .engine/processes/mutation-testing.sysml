// =====================================================================
// EngineMutationTesting — measure whether the test suite actually CATCHES bugs (D0030).
//
// Coverage proves lines RAN; it does NOT prove a bug would be caught. Mutation testing injects small
// faults (mutants) into the source and checks whether the suite fails — a SURVIVING mutant is a concrete
// test-gap (a bug that would ship undetected). This is the direct, COMPUTED answer to "are tests really
// being carried out?" (the founding complaint). cargo-mutants (Rust) + Stryker (TS). The mutation score is
// an Indicator (D0088/D0089), floorable in CI once a defensible baseline exists. Deployed by the
// `mutation-testing` skill. Findings (surviving mutants) are recorded; each is closed by a killing test or
// an explicit, justified accept (equivalent/uninteresting mutant).
// =====================================================================
package EngineMutationTesting {
    private import EngineElement::*;
    private import EngineProcess::*;

    part mutationTesting : Process {
        :>> id = "efd252ec-47b2-470e-9357-163e4e33ef1f";
        :>> title = "Mutation Testing (test-suite efficacy)";
        :>> purpose = "Inject faults and measure whether the suite catches them; turn surviving mutants into killing tests (or justified accepts), and the mutation score into a monitored Indicator — computed proof the tests bite.";
        :>> cadence = Cadence::adHoc;
    }

    part mtRun : ProcessStep {
        :>> id = "30895599-adf2-40b5-b08e-0ad1483070fd";
        :>> title = "Run the mutation engine";
        :>> order = 1;
        :>> triggerCondition = "Asked to assess test efficacy, after a test-hardening pass, or periodically on a high-criticality module (keel arch criticality).";
        :>> actionText = "Run cargo-mutants (server) / Stryker (client), scoped to the target module first (whole-repo runs are slow). Capture the mutation score + the list of SURVIVING mutants (faults no test caught).";
        :>> producedArtifact = "Mutation score + surviving-mutant list per module.";
        :>> owner = Owner::ai;
    }
    part mtTriage : ProcessStep {
        :>> id = "e2c53d8d-ed1e-49ff-af46-307ff10a7c43";
        :>> title = "Triage the survivors";
        :>> order = 2;
        :>> actionText = "For each surviving mutant decide: a REAL test-gap (a meaningful behavior change no test detected — most valuable, often on a high-criticality element), or an EQUIVALENT/uninteresting mutant (semantically identical, or in cosmetic/logging code). Prioritize survivors on dataLoss/security/durability/correctness elements.";
        :>> producedArtifact = "Survivors classified: test-gap vs equivalent/accept.";
        :>> owner = Owner::ai;
    }
    part mtKill : ProcessStep {
        :>> id = "25476bda-2a96-448b-8d52-560bfa6f077f";
        :>> title = "Kill the gaps (or justify the accept)";
        :>> order = 3;
        :>> actionText = "Write a fail-first test that KILLS each real-gap mutant (the test-authoring standard); re-run to confirm the mutant dies. For an equivalent/uninteresting mutant, record a justified skip (never silently ignore). Green at every step.";
        :>> producedArtifact = "Killing tests (mutant dead) + recorded justified accepts.";
        :>> owner = Owner::ai;
    }
    part mtIndicator : ProcessStep {
        :>> id = "cd476b0f-9b67-4156-b198-fe814e52ca94";
        :>> title = "Record the score as an Indicator";
        :>> order = 4;
        :>> actionText = "Record the mutation score as a monitored Indicator (D0089, computed/pulled per the measure spectrum) with a DIRECTION (higher = better). Promote to a CI floor only once a defensible baseline exists (D0088 — avoid an arbitrary threshold / Goodhart).";
        :>> producedArtifact = "A mutation-score Indicator + optional CI floor.";
        :>> owner = Owner::ai;
    }
    part mtRecord : ProcessStep {
        :>> id = "7c3e1908-76b7-4871-ab0c-add5fcb5b215";
        :>> title = "Record findings";
        :>> order = 5;
        :>> actionText = "RECORD a systemic test-gap class surfaced by survivors as a tracked Issue (D0077, #Resolves from the killing action); a defect the mutant EXPOSED in the code (not just the test) is its own Issue. The killing tests + Indicator are the computed evidence — never a prose 'tests look adequate'.";
        :>> producedArtifact = "Issues for test-gap classes / exposed defects + the killing tests + the score Indicator.";
        :>> owner = Owner::ai;
    }
}

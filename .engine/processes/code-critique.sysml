// =====================================================================
// EngineCodeCritique — the Antagonistic Code Critique process (D0031): adversarial, multi-lens BUG
// hunting of the DELIVERABLE source code by INDEPENDENT critics, with a mandatory verify-before-record
// gate, findings recorded as severity-carrying Issues (D0077), and each confirmed defect fixed with a
// FAIL-FIRST regression.
//
// This is the recurring activity behind the code-critique rounds (round1/round2/round6 + the R+1 pass)
// that previously leaked into conversation history with no skill (D0040 gap). It is DISTINCT from the
// three neighbouring critique/audit processes: element-critique adversarially verifies tracked MODEL
// elements (Need/SystemRequirement/Decision) as method=critique verifications; architectural-critique
// stress-tests the ENGINE + its processes; function-audit is a per-function idiom/design line-audit with
// @audit-hash markers. code-critique hunts RUNTIME defects (data loss, security holes, races, correctness)
// ACROSS a subsystem of the deliverable code — so its findings are Issues (the code is not a tracked
// #Verify target), not method=critique verifications. Deployed by the `code-critique` skill.
//
// Core disciplines: (a) INDEPENDENCE — each critic runs in FRESH context (a subagent), never the author,
// so it genuinely tries to BREAK the code (the D0080 independent-critic principle, applied to code); (b)
// VERIFY-BEFORE-RECORD — every reported finding is re-checked against the actual code + tests before it
// becomes an Issue (a plausible-but-wrong critic claim is worse than silence; this session caught a false
// "dead code" claim); (c) COMPUTE-DON'T-ATTEST — a finding is a concrete file:line + failure scenario, a
// fix carries a fail-first regression, and a cleared area is stated as cleared — never a prose "looks fine".
// =====================================================================
package EngineCodeCritique {
    private import EngineElement::*;
    private import EngineProcess::*;

    part codeCritique : Process {
        :>> id = "7a3c9e12-4d5b-4a6c-8e9f-0b1c2d3e4f50";
        :>> title = "Antagonistic Code Critique (adversarial deliverable bug-hunt)";
        :>> purpose = "Find real runtime defects (data loss, security, concurrency, correctness) in the deliverable source code via INDEPENDENT multi-lens critics, VERIFY each finding against the code before recording, file confirmed findings as severity-carrying Issues (D0077), and fix them with fail-first regressions.";
        :>> cadence = Cadence::adHoc;
    }

    part ccScope : ProcessStep {
        :>> id = "7a3c9e12-4d5b-4a6c-8e9f-0b1c2d3e4f51";
        :>> title = "Scope the pass + choose lenses";
        :>> order = 1;
        :>> triggerCondition = "Asked to critique / red-team / adversarially review the code, 'find bugs', 'where is this weak', or after a substantial change to a high-criticality subsystem.";
        :>> actionText = "Pick the target code (highest-criticality + most-recently-changed first — keel arch criticality: dataLoss/security/durability/correctness elements). Choose the DISTINCT adversarial lenses that fit the target (default set: data-integrity/durability, security/authorization, concurrency/races, correctness/protocol; extend per target). Each lens is a separate critic so no single reviewer's blind spots dominate.";
        :>> producedArtifact = "The target file set + one adversarial lens (with focus files) per critic.";
        :>> owner = Owner::ai;
    }
    part ccDispatch : ProcessStep {
        :>> id = "7a3c9e12-4d5b-4a6c-8e9f-0b1c2d3e4f52";
        :>> title = "Dispatch INDEPENDENT critics";
        :>> order = 2;
        :>> actionText = "Run one critic per lens in FRESH context (a subagent) — INDEPENDENT of the author, so it genuinely tries to BREAK the code, not affirm it (the D0080 independence principle applied to code). Instruct each: read the ACTUAL code; the codebase is hardened, so hunt SUBTLE/residual defects; report ONLY genuine issues with (file:line, exact mechanism, a CONCRETE failure scenario, severity, confidence, suggested fix); a false positive is worse than silence; say 'no real findings' when true — never manufacture. Critics run in parallel.";
        :>> producedArtifact = "Per-lens candidate findings (UNVERIFIED) + explicitly-cleared areas.";
        :>> owner = Owner::ai;
    }
    part ccVerify : ProcessStep {
        :>> id = "7a3c9e12-4d5b-4a6c-8e9f-0b1c2d3e4f53";
        :>> title = "Verify before believing";
        :>> order = 3;
        :>> actionText = "MANDATORY gate: independently re-check EVERY candidate finding against the real code + its tests/guards. Discard any that a test or guard already covers, that misreads the control flow, or that can't be reproduced (this session caught a false 'dead code' claim — verify-before-record is non-negotiable). Dedupe overlapping findings across critics. Keep only defects you are confident are real, each with a reproducible failure scenario.";
        :>> producedArtifact = "The CONFIRMED finding set (deduped), plus a list of dismissed/mitigated candidates with the reason.";
        :>> owner = Owner::ai;
    }
    part ccRecord : ProcessStep {
        :>> id = "7a3c9e12-4d5b-4a6c-8e9f-0b1c2d3e4f54";
        :>> title = "Record findings as Issues";
        :>> order = 4;
        :>> actionText = "File each CONFIRMED finding as a tracked Issue (D0077, severity-carrying, #Resolves from a fixing action — create one if none). The code is not a tracked #Verify element, so findings are Issues, NOT method=critique verifications (contrast element-critique). Lower/mitigated candidates are documented (in the resolving action's scope or dismissed inline), not filed as noise; cleared areas are stated as cleared. Never a prose report in design-history.";
        :>> producedArtifact = "Severity-ranked Issues (triaged with #Resolves) for every confirmed finding.";
        :>> owner = Owner::ai;
    }
    part ccFix : ProcessStep {
        :>> id = "7a3c9e12-4d5b-4a6c-8e9f-0b1c2d3e4f55";
        :>> title = "Fix with fail-first regressions";
        :>> order = 5;
        :>> actionText = "Fix confirmed findings highest-severity first, each with a FAIL-FIRST regression test (RED under the defect, GREEN after the fix — test-authoring D0026/D0047). Validate green (cargo test / clippy / vitest) + reverify the deliverable gate. A finding too large for this pass is triaged to an OPEN follow-on action (honest open state, tracked — never dropped silently). Record the covering TestResult; the resolving action's DoD closes each Issue on completion.";
        :>> producedArtifact = "Fixes + permanent regressions (green), reverified gate, closed Issues (or a tracked open follow-on).";
        :>> owner = Owner::ai;
    }
}

// =====================================================================
// EngineArchitectureAudit — audit a deliverable's source architecture (D0029).
//
// Catalogues authored code elements, ranks them by the risk they accept (against
// Needs), records a PRIMARY invariant-safety + coupling assessment (design patterns
// are a DESCRIPTIVE tag, never a compliance gate), captures STPA control-structure
// INPUTS for a later STPA process (no analysis here), and detects drift vs the
// D0028 // @audit-hash markers. All authored facts + keel-computed views (no code
// parser in keel). Deployed by the `architecture-audit` skill.
// =====================================================================
package EngineArchitectureAudit {
    private import EngineElement::*;   // Cadence / Owner enums
    private import EngineProcess::*;

    part architectureAudit : Process {
        :>> id = "ac2c5701-8fa6-42ae-992d-4e75452bcfbc";
        :>> title = "Programmatic Architecture Audit";
        :>> purpose = "Catalogue authored code elements, rank by accepted-risk against Needs, assess invariant-safety + coupling (patterns descriptive only), capture STPA inputs, and keep the registry honest via codeHash drift.";
        :>> cadence = Cadence::adHoc;
    }

    part aaEnumerate : ProcessStep {
        :>> id = "26c8823c-412c-46c9-a080-3ad7a370fb42";
        :>> title = "Enumerate authored code elements";
        :>> order = 1;
        :>> triggerCondition = "Asked to audit the architecture, or a `keel arch drift` / `arch coverage` frontier is non-empty.";
        :>> actionText = "Go file-by-file over the deliverable source; author a CodeElement (id, file, name, kind, codeHash from audit_hash.py) for each separable element not yet registered.";
        :>> producedArtifact = "CodeElement rows in .tracking/architecture/.";
        :>> owner = Owner::ai;
    }
    part aaRisk : ProcessStep {
        :>> id = "fb297743-c598-4e34-83a7-f1ce3a9ff40a";
        :>> title = "Assign risk-class + trace Needs";
        :>> order = 2;
        :>> actionText = "Author riskClass (+ riskRationale) = the risk the element accepts, and #DependsOn edges to the Needs/SystemRequirements it serves. keel computes criticality = risk-class tier bumped by high-severity Need-trace.";
        :>> producedArtifact = "riskClass + Need-trace edges; keel arch criticality ranking.";
        :>> owner = Owner::ai;
    }
    part aaRank : ProcessStep {
        :>> id = "d335953c-7337-47ad-9467-01e0c064cd02";
        :>> title = "Compute the criticality frontier";
        :>> order = 3;
        :>> actionText = "Run keel arch criticality to get the High->Low worklist; audit in that order (highest accepted-risk first).";
        :>> producedArtifact = "Ranked audit frontier (a computed view).";
        :>> owner = Owner::ai;
    }
    part aaAssess : ProcessStep {
        :>> id = "3a3c9f48-da0c-4bf7-bc7b-7247d8a140c3";
        :>> title = "Assess each element (invariant-safety + coupling; pattern tag; STPA inputs)";
        :>> order = 4;
        :>> actionText = "PRIMARY: invariantSafety (typeEnforced > parsed > runtimeGuarded > unguarded) + invariantNotes; author #DependsOn coupling edges (keel derives Ca/Ce/instability/distance). Add the OPTIONAL descriptive pattern tag (blank = no named pattern, a valid answer). Capture STPA INPUTS: stpaRole, actions, #Controls/#Feedback edges (analysis deferred to the later STPA process). Leave an in-code // @audit + // @audit-hash marker (D0028) so codeHash stays honest.";
        :>> producedArtifact = "Fully-assessed CodeElement rows + in-code @audit markers.";
        :>> owner = Owner::ai;
    }
    part aaDecideRestructure : ProcessStep {
        :>> id = "c2dbeeee-4c7d-47bf-9913-4310dcd7302e";
        :>> title = "Decide restructurings (objective test; caution is the default)";
        :>> order = 5;
        :>> actionText = "Default restructure = keepAsIs. Set combine/split/decouple ONLY when the objective test holds: it demonstrably LOWERS coupling (net #DependsOn edges removed > added) OR CLOSES a named defect class. Record restructureRationale + the #Restructure target. Exempt when: criticality Low & invariantSafety in {typeEnforced,parsed}; OR it would raise coupling; OR it protects no invariant the element actually has (cargo-cult test).";
        :>> producedArtifact = "restructure recommendations + rationale (or recorded exemptions).";
        :>> owner = Owner::ai;
    }
    part aaCombine : ProcessStep {
        :>> id = "520f50ee-11f0-4cf7-a1ac-53c525b429ac";
        :>> title = "Combine / split / decouple as decided";
        :>> order = 6;
        :>> actionText = "Implement the accepted restructurings behavior-preservingly, green at every step (the deliverable test suite is the gate); update each touched element's codeHash + @audit-hash.";
        :>> producedArtifact = "Restructured code, tests green, refreshed hashes.";
        :>> owner = Owner::ai;
    }
    part aaImprove : ProcessStep {
        :>> id = "2cfcfdaf-7e26-480c-bd8b-ffdc4daf3fb6";
        :>> title = "Per-element correctness/invariant improvements";
        :>> order = 7;
        :>> actionText = "For elements below the invariant-safety bar (runtimeGuarded/unguarded where a compile-time or parse-boundary guard is feasible), tighten toward typeEnforced/parsed — the pass that actually prevents this codebase's defect classes. Green + refresh hashes.";
        :>> producedArtifact = "Tightened invariants; ≥Medium defects recorded as Issues (D0077).";
        :>> owner = Owner::ai;
    }
    part aaDrift : ProcessStep {
        :>> id = "d1351fbb-9b12-4323-99e3-a275977419f8";
        :>> title = "Keep the registry honest (drift)";
        :>> order = 8;
        :>> actionText = "keel arch drift cross-checks each CodeElement.codeHash vs the live // @audit-hash; a changed element re-enters the criticality frontier for re-audit. Non-blocking honest-state burndown (D0098).";
        :>> producedArtifact = "Drift report; re-audit frontier.";
        :>> owner = Owner::ai;
    }
}

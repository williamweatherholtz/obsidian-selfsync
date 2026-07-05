// =====================================================================
// ProjectIssues — tracked problems (D0077/D0078: every Issue must be TRIAGED with a #Resolves
// edge from a resolving action or a mooting Decision; resolution is COMPUTED, never prose).
// =====================================================================
package ProjectIssues {
    private import EngineElement::*;
    private import EngineWork::*;
    private import ProjectDelivery::*; // requirementTraceabilityBackfill — the resolver

    // The test-escape retrospective (2026-07-05): "plugin sync doesn't work at all" shipped
    // despite a large test suite. Root cause is two-layered and recorded here so the class is
    // guarded, not just patched (D0047).
    part issueTraceabilityGap : Issue {
        :>> id = "c0f1a5cc-8001-4a10-9b20-a1b2c3d40071";
        :>> title = "Config-sync feature shipped unrooted, with zero requirement->test traceability";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> description = "The multi-device config divergence/removal defects (0.10.4: a crash on a divergent community-plugins.json + a phantom-base deletion of a peer's plugin) escaped a 125-test suite. Two-layer cause: (1) the config/customization-sync feature was implemented in code with NO Need or SystemRequirement behind it (an orphan capability), so there were no behavioral acceptance criteria and no use case enumerating the 'two already-configured devices' scenario; (2) tier-satisfaction showed SR-verified-by-Test at 0/15 — every automated test was divorced from the requirements model, so nothing enforced that a requirement carried a behavioral test. Tests were written bottom-up from the code (filter combos, single-file one-way config sync) and never exercised config conflict-copy or removal.";
        :>> discoveredInField = true;
        :>> severity = Severity::High;
    }

    // Triage: resolved by the CR d0011 traceability backfill (roots the feature as a #Capability,
    // adds the #Verify acceptance layer for every SR incl. the two scenarios that catch this class).
    #Resolves dependency from requirementTraceabilityBackfill to issueTraceabilityGap;
}

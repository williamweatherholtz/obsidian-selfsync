// Per-actor issues records for claudeOpus (issue210/srDcPerActorWriteTargets): new records
// route here so concurrent contributors never conflict at a shared append anchor.
package IssuesClaudeOpus {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProcessDefect part issueNestedCoversEdgesSkipped : Issue {
        :>> id = "15a1983f-a7ca-4717-a8f8-014cc2d3116f";
        :>> title = "keel-parser silently skips the 74 nested #Covers edges inside action def SelfSyncDelivery - sitting-coverage read 0 covered against 74 authored covering edges";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> description = "Found 2026-09-07 while reading the parser-coverage warning after the engine resync onto keel 0.3.1. The guard reported 81 skipped statements: 7 successions (the engine's own baseline) plus 74 `dependency` statements it did not locate. Measured by comparing grep counts to the AST census (`keel show marker-census`): every marker matched except #Covers - 74 in the text, 0 AST edges. All 74 `#Covers dependency from <sittingReview> to <sprintTask>;` lines sat at indent 8 INSIDE `action def SelfSyncDelivery { ... }` in .tracking/delivery/delivery.sysml, whereas the 114 #Verify edges that DID count sit at package level. keel-parser skips a dependency statement nested inside an action body, and it does so silently: `keel check` on a probe file with the nested form reports 'checked clean' (as do probes with two statements on one line and with a trailing comment, which were the first hypotheses and are NOT the cause). CONSEQUENCE: the sitting-coverage lens (D0049/issue040 - which delivery sprints have a covering per-sitting human review) read 0 covered while the record contained 74 covering edges, and the sitting-coverage guard was blind in the direction that matters - it could not have caught a sprint that genuinely lacked a review, because to it none had one. The per-sitting review is the single human gate in this project's sprint discipline (D0049), so this was the control most worth being able to see. FIX (coversEdgesHoisted, same commit): the 74 edges hoisted verbatim to package level; Covers AST edges 0 -> 74; parser-coverage skipped 81 -> 7; sitting-coverage now counts covered sittings. GUARD (D0047): the parser-coverage ratchet in .engine/contracts/parser-coverage-baseline.toml, set at the stock 7 - any new nested edge raises the skipped count and fails the gate, so this class cannot recur silently. UPSTREAM (keel toolkit): a construct the parser does not read should be a parse error, not a clean check; carried with the reproduction. discoveredInField = false. Severity Medium: no data at risk, but a governance control reported a false zero for the whole life of the record.";
        :>> discoveredInField = false;
        :>> relatedTask = "coversEdgesHoisted";
        :>> severity = Severity::Medium;
    }
    #Resolves dependency from coversEdgesHoisted to issueNestedCoversEdgesSkipped;
}

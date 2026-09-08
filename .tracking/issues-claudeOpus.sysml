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

    part issueHistoricalDoDsUnstamped : Issue {
        :>> id = "1ebd18c7-aa30-497f-bda7-bf2a059487ad";
        :>> title = "103 delivery DoDs (80 method=test) read DONE in prose but carry no TestResult - shipped work with unrecorded verdicts; blocks honest #Verify edges for sr11/sr16/sr19";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> description = "Found 2026-09-07 while authoring #Verify edges from Tests to the 25 STPA SafetyRequirements. A census of .tracking/delivery/delivery.sysml shows 103 verification Tests (DoDs) with no TestResult of any kind: 80 method=test, 14 inspect, 3 demo, 1 analyze, 1 critique, 4 confirmation. Their action comments and procedure texts read DONE and name the releases they shipped in (m1ProtocolDoD .. round7RecoveryFixesDoD, autoReindexDoD, uiFunctionalAuditDoD, round1DeferredHardeningDoD and others), and .tracking/verification/acceptance.sysml adds 5 unstamped method=test acceptance Tests for the embedded-timestamp requirements that timestampIgnoreRedesign (1.9.0) retired. CONSEQUENCE: (a) three SafetyRequirements (sr11 refuse-reindex-over-incomplete-directory, sr16 operator-repair-any-vault, sr19 bound-uncommitted-storage) cannot honestly carry a #Verify edge although the verifying server tests exist and pass - the DoD that owns each was never stamped; (b) every computed lens that keys on recorded verdicts (assured, tier-satisfaction, sitting-coverage, whats-next) under-reports work that shipped, while the prose over-reports it - the exact drift CLAUDE.md 2.1 exists to prevent (prose is not truth; the verdict is). WHY IT HAPPENED: these DoDs predate the write-API (2026-06-15) becoming the primary path and the evidence-cited convention (2026-08-25); DONE was written into the comment and the result never appended. Not fabricated here: a pass without a receipt would be a testimony, not a record (D0232). RESOLVER: dodBackfillStamp - classify each as reproducible (stamp at HEAD with a real run receipt), mooted (record the superseding decision as basis), or owner-judgment (listed for the owner), with reconciled control totals (D0067). discoveredInField = false. Severity Medium: no data at risk, but the record's honesty is the deliverable of this engine.";
        :>> discoveredInField = false;
        :>> relatedTask = "dodBackfillStamp";
        :>> severity = Severity::Medium;
    }
    #Resolves dependency from dodBackfillStamp to issueHistoricalDoDsUnstamped;

    #ProcessDefect part issueE2eObsidianBelowMinAppVersion : Issue {
        :>> id = "f661d25a-2a19-4aed-8a73-ce262035986d";
        :>> title = "real-Obsidian e2e ran green on Obsidian 1.5.8, below the plugin's minAppVersion 1.11.0 - a green run outside the supported envelope proves nothing";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> description = "Found 2026-09-07 while trying to automate l3GuiPass (the manual GUI pass) as a real-Obsidian Playwright demonstration. The machine's Obsidian is 1.5.8 (Electron 28 / Chrome 120); manifest.json declares minAppVersion 1.11.0, and client/src/settings.ts imports SettingGroup from the obsidian API, which 1.5.8 does not provide. The e2e-obsidian suite (smoke, configsync, convergence) nevertheless ran GREEN on 1.5.8 this sitting, because those specs only load the plugin and sync files - they never open the settings tab. So the layer that exists to prove the real glue works was proving it on an Obsidian no user of this plugin can run (Obsidian refuses to enable a plugin below minAppVersion), and the first spec to touch the settings UI would have failed for a reason unrelated to the plugin. Hazard class: a test environment silently outside the supported envelope - green means nothing, red means noise. FIX (e2eObsidianVersionGate): obsidianDriver reads the running version from the renderer user agent and every spec skips loudly, naming installed vs. minimum, when the install is below the floor. The operator-facing consequence is honest: on this machine the real-Obsidian layer now SKIPS until Obsidian is updated to >= 1.11.0 - which is also what l3GuiPass needs before it can be demonstrated. discoveredInField = false. Severity Medium (assurance defect, no data at risk).";
        :>> discoveredInField = false;
        :>> relatedTask = "e2eObsidianVersionGate";
        :>> severity = Severity::Medium;
    }
    #Resolves dependency from e2eObsidianVersionGate to issueE2eObsidianBelowMinAppVersion;
}

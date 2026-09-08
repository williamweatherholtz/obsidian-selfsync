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

    part issueConflictDiffSidesUnlabeled : Issue {
        :>> id = "8b5562eb-44f8-4b69-aa3c-1de295f11619";
        :>> title = "Resolve-conflicts modal: which side is − and which is + was fine print; the keep-buttons carried no sign";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> description = "Owner field report 2026-09-07 on the Resolve-conflicts modal: 'you say 'keep this device's' or keep the other's but you give no indication as to which one is − and which one is + in diff view. it should be concise and clear.' Cause: the only mapping from diff sign to side was an 11px, 70%-opacity legend line above the diff ('− the other version + this device's'), styled like fine print and worded differently from the buttons, while the two keep-buttons ('Keep the other device's' / 'Keep this device's') carried no sign at all - so a reader looking at red/green lines had to hunt for the mapping before an irreversible choice. Consequence: a user could keep the wrong side (data loss on the other device's edit) or stall on a conflict they could otherwise resolve in a second. Fix (conflictDiffSideLegend): the header names the mapping in words, the legend is two bold spans in the diff's own red/green with the signs, and the buttons carry the signs ('Keep − other device's' / 'Keep + this device's'). Guarded by a DOM test. discoveredInField = true. Severity Medium (a UX defect on the one irreversible control in the plugin).";
        :>> discoveredInField = true;
        :>> relatedTask = "conflictDiffSideLegend";
        :>> severity = Severity::Medium;
    }
    #Resolves dependency from conflictDiffSideLegend to issueConflictDiffSidesUnlabeled;

    part issueRejectedPushRetriedEveryPass : Issue {
        :>> id = "df1034a6-0d81-4b71-a39d-c9986a249f6a";
        :>> title = "Server-refused pushes (commit: HTTP 400) were re-sent on every pass with the reason thrown away - ~500 futile uploads per reconcile made the UI crawl";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> description = "Owner field report 2026-09-07: 'it's much slower now' - opening the Resolve-conflicts modal, clicking anything. The debug log showed why: the connect pass was PUSHING several hundred files under the PARA roots (4 Archive/**, 3 Resources/**, 2 Areas/**, 99 Utilities/**) - notes, PDFs, images alike - and the server answered 'commit: HTTP 400' for every one; 'checked 750/1835 files' arrived at +118.8s and the pass was still running at +165s, on a vault whose no-op rescan the perf harness completes in ~150 ms. Two client defects made this what it was. (1) transport.commit threw a bare 'commit: HTTP 400', discarding the server's body - which is the client-actionable reason (the server returns validation failures verbatim) - so neither the user nor the code could see WHY. (2) reconcile treated a 400 like any transient per-file error: the next pass re-read, re-chunked, queried missing chunks, re-uploaded and re-committed the identical content, and was refused again - for every file, every pass, forever. The reconcile loop runs on the renderer's main thread with the modal and settings tab, hence 'clicking anything' is slow. FIX (rejectedPushHold): a typed CommitRejectedError carrying the server text; a (path -> refused hash) memo so an unchanged rejected file is HELD (one summary log line per burst) until it is edited or the plugin reloads; 409/404 stay retryable. ROOT CAUSE OF THE REFUSALS IS STILL OPEN and will be named by 1.30.9's log. Leading hypothesis from the evidence: every rejected path sits under a top-level folder whose CAPITALISATION may differ between this Windows vault and the server's index keys - the server's commit guard refuses 'a path differing only in case already exists' - i.e. a case-only folder rename on a case-insensitive filesystem, which decide() sees as a local-only-new file (push) plus a remote file that a presence re-probe says is still present (no delete), so the two never converge. If confirmed, the fix is case-aware path identity on case-insensitive filesystems (a follow-up issue with its own resolver). discoveredInField = true. Severity High: the sync loop was doing hundreds of futile uploads per pass and the UI was unusable while it ran.";
        :>> discoveredInField = true;
        :>> relatedTask = "rejectedPushHold";
        :>> severity = Severity::High;
    }
    #Resolves dependency from rejectedPushHold to issueRejectedPushRetriedEveryPass;

    part issueCasePathDivergence : Issue {
        :>> id = "0602d5d2-2339-4861-8665-38afba8c25bb";
        :>> title = "Case-only folder capitalisation difference between a Windows vault and the server made every file in those folders unpushable - and edits there silently did not sync";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> description = "Confirmed 2026-09-07 from the owner's 1.30.9 log: every refused push read 'the server refused it - a path differing only in case already exists' - hundreds of files under 4 Archive/**, 3 Resources/**, 2 Areas/**, 99 Utilities/**. The server's index holds those folders in a different capitalisation than this Windows vault reports. Path identity in the client was exact-case everywhere (base keys, manifest keys, decide()), while the filesystem underneath is case-insensitive, so a case-only divergence produced: (a) the local spelling has no base/remote key -> decide() = local-only-new -> push -> the server's collision guard refuses it (correctly - it protects case-sensitive servers from two keys folding onto one file); (b) the server's spelling is 'absent' from the local listing, but the false-absence re-probe (adapter.exists, case-insensitive) says present -> no delete -> the pair never converges; (c) and the DATA hazard: an edit made under the local spelling changes a file the client can only push under a refused key - edits in those folders did not sync at all, silently, since whenever the capitalisation diverged. Performance was the visible symptom (~500 futile uploads per pass, 1.30.9 held them after the first pass); the silent non-sync of edits is the real defect. FIX (casePathAlias): on case-insensitive platforms the local spelling is aliased to the existing server/base key for sync identity, in the full pass, the config pass and the vault-event path; nothing is renamed; the server keeps its spelling; Linux/Android untouched. ROOT CAUSE of the divergence itself (which device re-capitalised the folders, and when) is not knowable from the record; the client must simply be correct under it. discoveredInField = true. Severity High: silent non-sync of edits in a whole folder tree.";
        :>> discoveredInField = true;
        :>> relatedTask = "casePathAlias";
        :>> severity = Severity::High;
    }
    #Resolves dependency from casePathAlias to issueCasePathDivergence;

    part issueBusyStateNotSurfaced : Issue {
        :>> id = "fac1e0a7-587e-4d6c-aaef-de20fa781936";
        :>> title = "A sync pass in progress made the conflict/config/switch modals unusable for minutes with no indication of the state or the reason - functions were unavailable invisibly";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> description = "Owner 2026-09-07, after the Resolve-conflicts modal sat on its placeholder for the whole 152 s first aliased pass: 'this state should be tracked and indicated somewhere. better transparency, especially if it affects availability of functions. maybe just grey out some options until actually ready, along with an indication as to why? state tracking'. The plugin knew it was busy - the status light said 'Connecting... checked 750/1420 files' - but no surface whose FUNCTION that state degraded said so: the conflict modal, the config-differences modal and the vault switcher all rendered their committing buttons as if ready while their own file reads queued behind the pass (on a large vault, minutes), so the user read 'broken' where the truth was 'busy, here is why, here is when'. Transparency defect on the plugin's irreversible controls. FIX (busyStateGating): busyState() as a pure projection + onBusyChange() subscription; busygate.ts mounts a reason banner and disables the committing buttons in the three modals until the plugin reports settled; the action handlers also refuse with the reason. discoveredInField = true. Severity Medium (no data at risk; availability of functions was invisible).";
        :>> discoveredInField = true;
        :>> relatedTask = "busyStateGating";
        :>> severity = Severity::Medium;
    }
    #Resolves dependency from busyStateGating to issueBusyStateNotSurfaced;
}

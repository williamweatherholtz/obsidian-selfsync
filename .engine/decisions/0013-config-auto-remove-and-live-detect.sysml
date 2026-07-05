// =====================================================================
// D0013 — config sync: removals PROPAGATE (auto-remove everywhere) and local config changes are
// detected while connected. From a report that removing a plugin left it on the other device.
// Refines D0011 (which adjudicated removals); the accepts() gate (D0011) makes a delete an
// evidenced tombstone, so auto-remove is safe now — only genuine same-file divergence still
// adjudicates. Accepted 2026-07-05 by wweatherholtz (chose "Auto-remove everywhere"). No process-
// definition edit, so no #ProspectiveChange. Shipped in 0.10.5 (client commit af8b722).
// =====================================================================
package ProjectDecision0013 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0013 : Decision {
        :>> id = "c0f1a5cc-d001-4a10-9b20-a1b2c3d400d1";
        :>> title = "D0013: config removals auto-propagate + live detection of local config changes";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "A user removed a plugin on one device and it stayed on the other. Two causes: (1) DETECTION — local config changes fire no Obsidian vault event (.obsidian files are not TFiles) and do not advance the server version, so the incremental idle poll short-circuited and config was reconciled ONLY at connect; a removal made while connected was never noticed. (2) SEMANTICS — D0011 had every config removal queue for user adjudication (never auto-delete), so even once detected a removal would not propagate without a manual confirm on each device — surprising, and higher friction than a user expects from 'sync'. The adjudicate-removals stance in D0011 was chosen while the data-loss bug was fresh; the accepts() gate added in the same work removed the underlying danger (a replica without the data can no longer manufacture a deletion).";
        :>> decision = "(1) DETECTION: when config sync is enabled, the idle poll forces a full reconcile every CONFIG_SCAN_EVERY_POLLS polls (~32s), so a local config add/edit/remove is detected and pushed within a bounded interval without a reconnect; the config-scope log fires only when the count changes so the periodic scan does not spam. (2) SEMANTICS: a config removal now PROPAGATES like ordinary sync (auto-remove everywhere) instead of adjudicating. This is safe because the accepts() gate guarantees only a device that genuinely holds a path reaches the delete branch (an evidenced tombstone, never a phantom), and a removed file is never automatically pulled back (no resurrection). The ONLY case still adjudicated is a genuine same-file DIVERGENCE (both sides edited the same config file) — because a note-style conflict copy of a config file is filtered out and crashed the whole sync (the 0.10.4 crash).";
        :>> rationale = "The user chose 'Auto-remove everywhere' over 'Ask me first', accepting the small residual edge case (a plugin whose files fail to write on one device could read as a removal) in exchange for intuitive behavior. ALTERNATIVES: (i) keep adjudicating every removal (D0011) — REJECTED by the user as too much friction now that the data-loss danger is gone. (ii) auto-remove but keep detection at connect-only — REJECTED, the removal would still appear to do nothing until reconnect. (iii) watch the .obsidian folder for OS file events — REJECTED, Obsidian exposes no reliable cross-platform hidden-file watcher; a periodic reconcile is how customization sync is done. CHOSEN — propagate evidenced removals + periodic detection, divergence-only adjudication. CRITERIA: intuitive (removal just works) x safe (accepts() gate + no resurrection) x no-crash (divergence never conflict-copies config) x bounded latency.";
        :>> consequences = "Client 0.10.5 (af8b722): reconcile.ts routes only merge/conflict-copy of config to adjudication (removals + edits propagate); main.ts onRemoteChanged forces a periodic full reconcile when config sync is on + logs scope on change only. Model: srConfigAdditiveSafe restated (removals propagate from a holding device; never from one that lacks it; no resurrection), srConfigAdjudication narrowed to divergence-only, new srConfigLiveDetect added (satisfy nConfigSync) with a verify-linked acceptance test, and the nConfigSync Need statement updated. Refines D0011 (removal stance reversed; the accepts() gate and divergence-adjudication + no-resurrection from D0011 stand). doc-sync: none (no command/type/skill surface changed). On-device removal latency is confirmed under the L4 mobile pass.";
    }

    verification d0013Accept : Test {
        :>> id = "c0f1a5cc-d002-4a10-9b20-a1b2c3d400d2";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz chose 'Auto-remove everywhere (Recommended)' on 2026-07-05 when asked how removing a plugin on one device should behave on the others, after being shown that the earlier adjudicate-removals stance (D0011) is no longer needed for safety because the accepts() gate makes a removal an evidenced tombstone (an empty/opted-out device can never trigger a deletion) and nothing is auto-resurrected — and that config changes were only being detected at reconnect.";
    }
    part d0013AcceptR1 : TestResult { :>> id = "c0f1a5cc-d003-4a10-9b20-a1b2c3d400d3"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "af8b722"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "wweatherholtz"; }
}

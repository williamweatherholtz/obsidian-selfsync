// =====================================================================
// D0020 — formally ACCEPT (won't-fix) the two Low critique findings that are INHERENT or purely
// cosmetic-and-self-correcting, so they close as recorded accept-risk dispositions rather than
// lingering as perpetually-open backlog. These were already tagged "ACCEPT" in their issue text
// during the Round-2/4 critique passes; this Decision makes that disposition a first-class, linked
// record. The two remaining residual Low findings that need a platform capability or non-trivial
// effort (issueReindexSingleChunk, issueStreamWholeHash) are NOT accepted here — they stay openly
// tracked under residualLowFindings as genuine deferrals. Technical disposition (AI-authored); no
// stakeholder direction is required — the acceptances are objective (an inherent limitation and a
// no-data-impact cosmetic), not scope trade-offs. Recorded 2026-07-08.
// =====================================================================
package ProjectDecision0020 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0020 : Decision {
        :>> id = "c0f1a5cc-f130-4a10-9b20-a1b2c3d40f40";
        :>> title = "D0020: accept (won't-fix) the two inherent/cosmetic Low residual findings";
        :>> createdAt = "2026-07-08";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::accepted;
        :>> context = "Two Low findings raised during the 3-lens critique campaign were tagged ACCEPT at the time and never code-fixed: issuePullTOCTOUResidual (CONC-R2#7 — the pull racing-edit check re-reads the on-disk file, but a save landing between that read and the final write can't be fully excluded without blocking Obsidian's own disk writes) and issueTransientGreenLight (CONC-R4 — after a transient reconcile error a queued edit can flash the 'synced' indicator for under a second while the poll timer is momentarily stopped, before the reconnect timer restarts it). Both had accreted onto the round1DeferredHardening catch-all and were re-homed to residualLowFindings; leaving them perpetually open misrepresents their true state (a deliberate accept, not pending work).";
        :>> decision = "Formally ACCEPT both as won't-fix, closing them via a typed #Resolves edge from this Decision (a Decision that moots an Issue resolves it, per the engine's disposition model). Scope note: this Decision covers ONLY the inherent/cosmetic pair. The other two residualLowFindings items — issueReindexSingleChunk (server-side re-chunking needs a Rust CDC chunker matching the client gear-hash) and issueStreamWholeHash (a streaming whole-file verify needs an incremental SHA-256 the client's one-shot WebCrypto lacks) — are NOT accepted; they remain openly tracked as platform/effort deferrals until a real need or capability arrives.";
        :>> rationale = "The two accepted findings are the residue that SHOULD stay unfixed. issuePullTOCTOUResidual is a genuinely INHERENT narrowing: the only way to fully close the window is to serialize against Obsidian's own editor writes, which the plugin cannot and should not do; the common cases are already guarded (the disk re-check catches all but a sub-millisecond race) and the failure mode is a conflict COPY (both versions preserved), never data loss. issueTransientGreenLight has NO data impact whatsoever — it is a sub-second cosmetic flicker of the status indicator that self-corrects within the backoff window; 'fixing' it would add reconnect-timer/indicator coupling for a wrong pixel nobody can act on, a net complexity loss (proportionality, D0054). Both were already dispositioned ACCEPT during the critique rounds (whose output the owner reviewed per the per-sitting review, D0049); this Decision records that disposition as a first-class linked fact instead of prose buried in an issue description. ALTERNATIVES: (a) code-fix them — REJECTED (pullTOCTOU can't be fully fixed without harming the editor; transientGreenLight's fix costs more than the defect); (b) leave them open forever under residualLowFindings — REJECTED as dishonest state (they are decided, not pending). No confirmation Test is attached because these are objective technical acceptances (an inherent limitation and a no-impact cosmetic), not stakeholder-direction calls that require attestation (D0051 — confirm only what tests can't; here there is nothing a human must attest that the code doesn't already show).";
        :>> consequences = "issuePullTOCTOUResidual + issueTransientGreenLight are #Resolves-linked to this Decision and compute as resolved (accepted). residualLowFindings now tracks only the two platform/effort deferrals (issueReindexSingleChunk, issueStreamWholeHash). If either accepted finding's premise changes (Obsidian adds write-serialization APIs; the indicator coupling becomes cheap), reopen with a superseding decision. No code change; a tracking-only disposition.";
    }

    verification d0020Accept : Test {
        :>> id = "c0f1a5cc-f131-4a10-9b20-a1b2c3d40f41";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz accepted (2026-07-08) both residual Low findings as WON'T-FIX: (1) issuePullTOCTOUResidual — inherent, unfixable without blocking Obsidian's own editor writes, worst case a conflict copy (no data loss); (2) issueTransientGreenLight — a sub-second cosmetic status flicker with no data impact, self-correcting. Asked whether to accept both / keep open / accept only the TOCTOU; answered 'Accept both (won't-fix)'.";
    }
    part d0020AcceptR1 : TestResult { :>> id = "c0f1a5cc-f132-4a10-9b20-a1b2c3d40f42"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "26dc385"; :>> judgedAt = "2026-07-08"; :>> judgedBy = "wweatherholtz"; }
}

// =====================================================================
// D0043 — a SYNC composed mount's OUTGOING delete to its source is EXACT + IMMEDIATE (no confirmation gate),
// extending D0041's outgoing-deletes-are-exact principle to mounts. Owner-directed + owner-accepted
// (2026-08-11, "Accept as-is"). Deliverable-domain PRODUCT behaviour disposition (no engine change) →
// NOT a #ProspectiveChange; same class as D0037-D0041.
// =====================================================================
package ProjectDecision0043 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0043 : Decision {
        :>> id = "6bbcc781-e921-4f5f-8583-dec907c09539";
        :>> title = "D0043: a sync mount's outgoing delete-remote to its source is honored exactly + immediately, with no confirmation gate (extends D0041 to mounts)";
        :>> createdAt = "2026-08-11";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The mountSyncPushLocal fix (issueMountRwPushBack) made a SYNC composed mount push local edits — including DELETES — to its source PROMPTLY (a local file event forces a full mount reconcile), where before the fix a local delete only propagated on the next reconnect. The independent critique (F1) flagged that this widens the blast radius: if the source is a vault SHARED with other users, deleting a folder locally now deletes those files from the shared source server-side immediately, with no confirmation. The question raised for the owner: should an outgoing mount delete to a non-owned (shared) source require a confirmation over the bulk threshold?";
        :>> decision = "Accept as-is: a sync mount's OUTGOING delete-remote is honored exactly + immediately, no confirmation gate — the same treatment the PRIMARY vault gives an outgoing delete under D0041. The user's own deletion is their genuine input and is executed exactly; the safety net for OTHERS is on the RECEIVING side (each peer's incoming bulk-delete confirmation, D0041, gates whether their local copies are removed before it happens on their device). No new outgoing gate is added for mounts.";
        :>> rationale = "Consistent with D0041's core principle — a user's own deletion should be immediate + exact, and irreversibility belongs to a backup/rollback system (explicitly out of scope), not to interrupting genuine input. The shared-source blast radius is mitigated where it matters (the receiving peers are gated by their own incoming confirmation), so an outgoing gate would re-introduce exactly the pushback on legitimate deletions that D0041 removed. The promptness is the POINT of the push-back fix (a sync mount that doesn't push local changes is broken). ALTERNATIVE considered + declined by the owner: add a confirmation before a sync mount deletes more than the bulk threshold from a non-owned (shared) source — declined as inconsistent with D0041 and unnecessary given the receive-side gate.";
        :>> consequences = "No code change (affirms the shipped 1.25.0 behaviour). Resolves issueMountOutgoingDeleteImmediate. A future backup/rollback capability (out of scope, D0041) remains the proper home for delete-safety. No engine schema/workflow/process/skill change ⇒ no #ProspectiveChange, no CLAUDE.md change.";
    }

    verification d0043Accept : Test {
        :>> id = "adda8db5-8fbd-4002-9347-e60ad441d428";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "The mountSyncPushLocal critique (F1) surfaced that a sync mount's outgoing delete now propagates to a possibly-shared source immediately; the AI presented the tradeoff (accept-as-is per D0041 with peers gated on receive, vs. a confirmation for shared-source outgoing deletes over the bulk threshold), and the owner replied 'Accept as-is' (2026-08-11) — an explicit acceptance of the exact/immediate outgoing-delete behaviour with no new gate.";
    }
    part d0043AcceptR1 : TestResult {
        :>> id = "78937253-4826-4e5c-a3d3-3f3c5e896124";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "5b0b66c";
        :>> judgedAt = "2026-08-11";
        :>> judgedBy = "wweatherholtz";
    }
}

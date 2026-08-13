// =====================================================================
// D0044 — a cross-boundary MOVE-OUT of a SYNC composed mount that deletes the file from its (possibly shared)
// SOURCE vault is CORRECT sync semantics; accept as-is, add no move-detection or confirmation. Owner-directed
// + owner-accepted (2026-08-13). Deliverable-domain PRODUCT behaviour disposition (no engine/code change) →
// NOT a #ProspectiveChange; same class as D0037-D0043.
// =====================================================================
package ProjectDecision0044 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0044 : Decision {
        :>> id = "5d5bbdeb-7209-445b-9984-c42fd5a532b3";
        :>> title = "D0044: a sync mount's cross-boundary move-out delete-remote is correct sync semantics — accept as-is, no move-detection or confirmation (mountMoveSafety)";
        :>> createdAt = "2026-08-13";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "Hardening Round 5 (finding MED-2, issueMountCrossBoundaryMove) flagged that dragging a note OUT of a SYNC-mount folder (e.g. Work/ASI/note.md -> Notes/note.md) makes the mount see the old path as locally-absent (base+source present) -> delete-local -> on a sync mount a delete-REMOTE to the source, removing the file from a possibly-shared source vault. It is technically-correct sync but was flagged as a surprising cross-boundary data flow, with a proposed follow-up of lightweight move-detection or a confirmation before a mount-driven delete-remote of a non-tombstoned file. The AI presented three options (hold+confirm / auto-keep-on-source / accept-current) and initially framed 'a move isn't really a delete'. The owner pushed back: semantically a move IS a delete FOR THE SOURCE (folder-membership = source-membership), and asked for a practical counterexample where you would give yourself R/W, MOVE (not copy) content out of a shared folder, and NOT want it removed on the source; absent one, 'delete is fine'.";
        :>> decision = "Accept as-is: a cross-boundary move-out of a sync mount is honored as a delete from the source, exactly as D0043 honors an in-mount delete. No move-detection, no confirmation gate, no code change. The move/delete distinction holds for the LOCAL filesystem but NOT for shared-folder membership: for a live bidirectional window onto a shared source, leaving the folder IS leaving the shared set, and a MOVE (as opposed to a COPY) is the explicit 'no longer here' gesture. If a user wants the file to remain on the source, the correct operation is COPY (which leaves the original), not MOVE.";
        :>> rationale = "No compelling counterexample survives: 'keep a personal copy but keep it shared' is a COPY not a move; 'archive an old shared note while it stays shared' is likewise a copy; 'promote a finished draft out of a shared Drafts/' SHOULD leave the source folder. The R/W grant the user was given explicitly authorizes deleting source files (deleting a file INSIDE the mount folder already deletes it from the source — move-out is consistent with that grant). The residual risk is an ACCIDENTAL drag, which is bounded: a single file (below the bulk-delete floor), recoverable (moving it back re-adds it to the source), and only on an opt-in, warned-as-bidirectional sync mount. Consistent with D0041/D0043 (a user's own deletion is immediate + exact; irreversibility belongs to a backup/rollback system, explicitly out of scope). ALTERNATIVES considered + declined: (a) hold+confirm the source delete on a detected move-out — declined as inconsistent with D0043's exact/immediate outgoing deletes and unjustified absent a real counterexample; (b) auto-keep on the source (suppress the delete) — declined because it contradicts the move gesture and re-pull would resurrect the file into the mount, producing a confusing duplicate.";
        :>> consequences = "No code change (affirms the shipped composed-vaults behaviour). Resolves issueMountCrossBoundaryMove; the mountMoveSafety resolver is a decision (accept), not a build. The existing sync-mount warning (bidirectional push/delete) remains the surfacing. A future backup/rollback capability (out of scope, D0041) remains the proper home for delete-safety. No engine schema/workflow/process/skill change => no #ProspectiveChange, no CLAUDE.md change.";
    }

    verification d0044Accept : Test {
        :>> id = "3dfcab88-0a67-49e9-9521-eed05a8371ae";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "The AI presented the cross-boundary move-out tradeoff (issueMountCrossBoundaryMove) with three options and an initial 'a move isn't really a delete' framing. The owner challenged that framing (2026-08-13): 'justify ... a move isn't really a delete. I agree semantically, but it really is for the source, no? ... can you think of practical counterexamples? If not, I say delete is fine.' The AI justified that for shared-folder membership a move-out IS a removal-from-the-source, found no compelling counterexample (copy vs move), and concluded accept-as-is; the owner's stated position was an explicit conditional acceptance of that outcome ('if not, delete is fine'), the condition being met by the AI's analysis. Owner disposition: ACCEPT — delete is correct; add no move-detection or confirmation.";
    }
    part d0044AcceptR1 : TestResult {
        :>> id = "b17b190a-308b-40ce-9f6d-4ca2cfd0bdf3";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "e288ed4";
        :>> judgedAt = "2026-08-13";
        :>> judgedBy = "wweatherholtz";
    }
}

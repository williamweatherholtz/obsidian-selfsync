// =====================================================================
// D0040 — composed-vault mounts are POLL-DRIVEN in v1 (per-mount real-time WebSocket subscription deferred).
// A within-epic refinement of D0039. 2026-08-07. Deliverable-domain (no engine schema/process change), so
// NOT a #ProspectiveChange — same class as D0037/D0038/D0039.
// =====================================================================
package ProjectDecision0040 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0040 : Decision {
        :>> id = "b1e2f3a4-5c6d-4e7f-a081-2b3c4d5e6f70";
        :>> title = "D0040: composed-vault mounts sync POLL-DRIVEN on the primary cycle in v1; per-mount real-time WebSocket subscription deferred";
        :>> createdAt = "2026-08-07";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::proposed; // AI-made implementation refinement under the owner's 'proceed until finished' authorization; IMPLEMENTED but awaiting the owner's ratification in the pending composed-vaults sitting review (not an AI-fabricated human acceptance — D0106/D0016)
        :>> context = "D0039 (the accepted composed-vaults architecture) states in its consequences that 'each mount has its own persisted base store, cursor, and SUBSCRIPTION.' 'Subscription' in the existing engine means a per-vault change-notification WebSocket (spinUpWs). While implementing the live mount engine (Phase 3), the engine map showed that the primary sync is driven by ONE SyncEngine serial queue fed by a single ws + a safety-net poll, and that a mount reconcile can simply be run as an additive step AFTER the primary pass on that same cycle — reusing the whole tested connect/reconcile/recovery machinery — rather than standing up N independent ws + timer + engine stacks (each a new copy of the singleton lifecycle surface the map flagged as the multi-scope blocker set). This Decision records the v1 choice + why the deviation from D0039's literal 'own subscription' is acceptable.";
        :>> decision = "In v1, a mount's reconcile is DRIVEN by the PRIMARY sync cycle: after each primary pass (connect full reconcile + every poll), the plugin runs reconcileMountScopes over the live mount scopes (detached, re-entrancy-guarded, fail-isolated). A mount therefore has its own persisted base store + cursor (per D0039) but NOT its own real-time WebSocket subscription — it is polled on the primary's poll cadence. A per-mount (or multiplexed) real-time change subscription is a DEFERRED enhancement, tracked for a later phase; it is not required for correctness, only for lower change-propagation latency.";
        :>> rationale = "Correctness does not depend on a per-mount ws: a mount pulls/pushes correctly on the poll cadence exactly as the primary's own safety-net poll does, and the primary vault itself keeps its real-time ws unchanged. The compose-my-notes use case (e.g. a personal vault pulling in ASI notes) is well served by near-real-time-on-poll propagation; sub-second latency on a MOUNTED subtree is not a requirement the owner stated. Against that small, deferrable latency cost, piggybacking avoids replicating the entire singleton lifecycle stack (ws, liveness timer, poll timer, reconnect/backoff, transport FSM) per mount — the exact surface the engine map identified as the multi-scope blocker — which would multiply the concurrency-hazard surface and the code to test/maintain. ALTERNATIVE (per-mount ws now) — deferred, not rejected: it buys only latency and can be added later behind the same MountRuntime/MountScope seam without reworking the base/cursor/reconcile model. So v1 ships the correct, lower-risk poll-driven engine and leaves real-time as a clean future increment.";
        :>> consequences = "A change made in a mount's SOURCE vault propagates to this device on the primary poll cadence (idle-poll interval), not instantly. A local edit under a mount point on a SYNC mount likewise propagates on the mount's full-scan cadence (the mount has no local-event route in v1) — a latency residual, not data loss; a pull mount is unaffected (local edits never sync). No engine schema/workflow/process/skill change (deliverable-domain) => no #ProspectiveChange, no CLAUDE.md change. Refines D0039; the composed-vaults spike spec remains the living design record. A future 'per-mount real-time subscription' increment can layer a ws onto each MountScope without changing the persisted base/cursor model.";
    }

    // NOT an acceptance (status is proposed): a method=analysis record of the AI's reasoning, self-evidencing
    // (D0051). Owner ratification is the pending composed-vaults sitting review, not an AI-stamped sign-off.
    verification d0040Analysis : Test {
        :>> id = "c2f3a4b5-6d7e-4f80-b192-3c4d5e6f7081";
        :>> method = VerificationMethod::analysis;
        :>> procedureText = "Recorded as a within-epic implementation refinement of the owner-accepted D0039 (capture-the-decision, §2.4), PROPOSED (AI-made under the owner's 'proceed until finished' authorization; implemented, awaiting owner ratification). The deviation from D0039's literal 'own subscription' to poll-driven-on-the-primary-cycle is analyzed against correctness (unaffected — a mount reconciles on the poll cadence as the primary's safety-net poll does) and risk (piggybacking avoids replicating the singleton ws/timer/engine lifecycle per mount, the engine map's multi-scope blocker set). Deliverable-domain design choice; the owner's on-device review of the composed-vaults sitting is the human ratification gate.";
    }
    part d0040AnalysisR1 : TestResult {
        :>> id = "d3a4b5c6-7e8f-4091-b2a3-4d5e6f708192";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "13fbd86";
        :>> judgedAt = "2026-08-07";
        :>> judgedBy = "claudeOpus";
    }
}

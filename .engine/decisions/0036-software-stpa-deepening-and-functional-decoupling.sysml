// =====================================================================
// D0036 — apply STPA rigorously to the DELIVERABLE's non-happy-path interactions, and add a separate
// Functional Decoupling process. The 1.11.3-1.11.7 status-display bug family (false "Synced", stuck
// "Switching vault…", hung "Connecting…", no-reattempt-on-mobile-resume, switch swallowing a DNS outage)
// were all shipped GREEN by 540 tests — because those tests assert data correctness + implementation
// behavior, and the existing SelfSync STPA (safety.sysml/hazards/control-structure/ucas, D0016) was
// severity-first on L-1..L-4 and modeled the user-facing FEEDBACK as cosmetic, not as feedback to the USER
// (a controller). The owner identified STPA as the fitting rigorous method for these interaction hazards,
// and directed two things: (1) add a loss for the user being misled by the UX, phrased as a STATE (not its
// consequences); (2) author a SEPARATE functional-decoupling process (code-quality / testability), decoupled
// from STPA. Adds a Loss to .tracking/safety/safety.sysml + a new .engine/processes/functional-decoupling.sysml
// + its skill, so the D0070 process-change guard requires this co-committed #ProspectiveChange Decision.
// Directed + accepted 2026-08-02 by wweatherholtz. The stpa + function-audit skills ALREADY exist and are reused.
// =====================================================================
package ProjectDecision0036 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0036 : Decision {
        :>> id = "1317154e-ef5e-450e-bc9d-f9f259adda2d";
        :>> title = "D0036: add L-5 (user misled by UX, as a state) + a Functional Decoupling process, separate from STPA";
        :>> createdAt = "2026-08-02";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The status-display bug family shipped in 1.11.3-1.11.7 (false 'Synced (polling)' while unreachable; a persisted pendingSwitch latching 'Switching vault…'; a switch reporting no progress so it looked hung; connect optimistically showing synced during a failing initial reconcile; a switch swallowing a whole-server DNS outage per-file; and — the mobile one — a failed connection never re-attempting on resume because the backoff timer is suspended and the resume enqueued a dropped 'remote') were ALL field-reported by the owner AFTER passing 540 green tests. The owner asked the right question: how are basic non-happy-path interactions missed? Root cause: the suite is weighted to DATA CORRECTNESS + tests that assert implementation behavior (e.g. 'given phase syncing, show Syncing' — which encoded the buggy read of a persisted setting); the e2e is entirely happy-path (no failure/outage/mobile-lifecycle injection); and the existing STPA (D0016, complete for L-1..L-4) was severity-first and treated the STATUS DISPLAY as cosmetic rather than as FEEDBACK to the USER, who is a controller acting on it. Every one of these bugs is a textbook Unsafe Control Action on a feedback or recovery control action. The owner chose STPA as the fitting method and refined the loss framing: a Loss is a STATE, so 'the user is misled by the UX' — with NO AI-authored damage/consequence clauses (whether a divergence is harmful is derived by analysing which UCAs/scenarios reach it, not pre-judged). The owner also separated the code DECOUPLING (a quality/testability refactor) from the STPA (an interaction analysis), directing that decoupling be its own process.";
        :>> decision = "(1) Add L-5 to .tracking/safety/safety.sysml: 'The user is misled by the plugin's UX' — the user's understanding diverges from the actual system state because the UX conveys a false or unintelligible picture; the USER is a controller and the UX is feedback to their process model. Stated as a STATE (no consequence clauses). This makes every user-facing feedback signal a control action subject to UCA analysis — the structural gap that let the bugs through. (2) Author .engine/processes/functional-decoupling.sysml + the functional-decoupling skill (D0059): a BEHAVIOR-PRESERVING refactor discipline (scope+rank -> characterize -> analyze -> decouple -> verify-green+hookable -> record) that, where it earns its keep, splits multi-responsibility functions, separates pure decision logic from side effects, and injects hard-wired deps at seams — grounded in Feathers (seams, characterization tests), Bernhardt (functional-core/imperative-shell), Fowler (extract/move), SOLID (SRP/DIP), Cockburn (ports&adapters) AND this repo's own idioms (EngineEffects/ReconcileDeps/pure classifiers). (3) Keep decoupling SEPARATE from STPA: STPA reads the control structure; decoupling improves the code and hands STPA cleaner seams, but is a standalone pass with no behavior change. The existing `stpa` skill (already complete) is REUSED to run the deepened analysis (add hazards H-9.. for L-5's feedback/lifecycle loops, the UCAs, and the loss scenarios -> interaction tests); `function-audit` is reused to feed decoupling targets.";
        :>> rationale = "STPA is the RIGHT method here because the defects are unsafe INTERACTIONS (a control action wrong in a context), not unit bugs — and the repo already has the STPA machinery, so this DEEPENS an existing analysis rather than inventing one. L-5-as-a-state (not consequence) is correct STPA discipline (a loss is an unacceptable outcome/state; causes + damage live in Step-4 scenarios) AND removes AI severity-judgement from the loss — if a UX can mislead, it is analysed against L-5, and the analysis decides the harm. Separating decoupling from STPA is the owner's correction and is sound: conflating a behavior-preserving refactor with a safety analysis would let a refactor smuggle a behavior change or a safety finding get lost in a diff. ALTERNATIVES: (i) the AI's earlier 'status-truth test dimension' — REJECTED as one-off whack-a-mole (assert labels the AI happened to think of) vs a systematic method that DERIVES the tests from UCAs; kept as the mechanism UCAs verify through, not the method. (ii) fold decoupling into STPA Phase 1 (the AI's first proposal) — REJECTED per the owner: decoupling is a quality concern independent of safety; the clean seams are a byproduct, not a precondition. (iii) bake the damage into L-5 ('...so they abandon/trust unsafe data') — REJECTED: that is the AI judging severity in the loss. (iv) a fresh subsystem-scoped STPA companion — REJECTED: extend the one control structure. CRITERIA: rigorous-method-over-ad-hoc x loss-as-state x refactor-separate-from-analysis x reuse-existing-skills x behavior-preserving.";
        :>> consequences = "safety.sysml gains L-5 (the trace root for the coming feedback/lifecycle hazards H-9.. -> SC -> UCA -> scenario -> interaction test). A new process + skill exist; the D0070 process-change guard is satisfied by this Decision (co-committed). The deepened STPA run + the codebase decoupling are ONGOING execution (kicked off on the connection-lifecycle + status-feedback subsystem first — highest bug density); each is its own tracked work. function-audit + code-critique + stpa + functional-decoupling are now the four distinct code-quality disciplines (review idiom / hunt defects / analyse interactions / refactor structure) — kept separate by design. CLAUDE.md does not enumerate the process/skill set or the losses, so no CLAUDE.md change; the .engine/README and any process index are doc-synced this commit. No behavior change ships in this commit (it is process + model only).";
    }

    verification d0036Accept : Test {
        :>> id = "b121a74c-70f2-407f-a230-e3a71b44580f";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed this change in their own words on 2026-08-02: they chose STPA over the AI's proposed status-truth dimension ('there's a better fitting rigorous method... STPA'), refined the loss to a state without AI damage-judgement ('I don't want parenthetical damage implications in the loss... the loss is misleading the user through UX... losses are a state - consequences come by analyzing the interaction'), directed authoring the process ('yes implement the process and kick off please'), and directed the decoupling be its own separate process ('make that a process too... I agree the decoupling should probably be unrelated to STPA'). The specific artifacts (the L-5 wording, the six-step functional-decoupling process, the method grounding) are the AI's implementing design fulfilling those directives, surfaced in the same turn for veto.";
    }
    part d0036AcceptR1 : TestResult {
        :>> id = "6b05544c-32d3-44db-9fe7-2ead84dc3dca";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "50027d2";
        :>> judgedAt = "2026-08-02";
        :>> judgedBy = "wweatherholtz";
    }
}

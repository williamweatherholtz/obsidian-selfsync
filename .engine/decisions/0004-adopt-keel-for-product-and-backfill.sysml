// =====================================================================
// D0004 — adopt keel to track the SelfSync PRODUCT (not just the engine's own self-build)
// and backfill the already-shipped work as tracked items. Until now the product (Rust server
// + TS plugin, releases 0.1.0-0.6.0) was built entirely outside the co-located engine:
// .tracking held only actors.sysml and `keel orient` showed 0 items, despite CLAUDE.md
// mandating that all substantive work be tracked. A workflow critique surfaced the
// contradiction. Accepted 2026-07-04 by wweatherholtz ("Adopt keel + backfill").
// =====================================================================
package ProjectDecision0004 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0004 : Decision {
        :>> id = "94cd5a06-8a31-4e44-9533-fcfac4bd2a08";
        :>> title = "D0004: adopt keel to track the SelfSync product + backfill the shipped work";
        :>> createdAt = "2026-07-04";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The SelfSync product was built entirely outside the keel engine co-located in this repo. .tracking/ held only actors.sysml; `keel orient` reported 0 done / 0 outstanding; no product Need, SystemRequirement, Test, sprint, or architecture Decision was ever recorded, even though the engine (D0001) governs this repo and CLAUDE.md mandates that all substantive work go through tracked sprints with traceable needs/requirements/verification. A workflow critique (2026-07-04) surfaced this as the central process gap: a work-tracking engine tracking nothing about the actual work.";
        :>> decision = "Adopt keel as the tracking system for the SelfSync PRODUCT and backfill the shipped work as tracked items, in green-committed phases: (1) Business Needs — the three founding goals (clear config UX; simple/fast backend without CouchDB; strong un-paywalled conflict merge) decomposed into sub-needs; (2) the key architecture Decisions (D0005+); (3) SystemRequirements with satisfy edges to Needs and verify edges to the existing test suites; (4) the milestones (M1-M6, the goal-#1 UX overhaul, the 0.6.0 fix set) as closed sprints, with the outstanding backlog (B7 auth hardening, B9 durability/streaming, B11 parallel chunk transfer, L3/L4 GUI+mobile verification) as the ready frontier. Product work henceforth follows the engine's triage-first workflow loop.";
        :>> rationale = "ALTERNATIVES: (i) formally scope the product OUT of keel — REJECTED by the owner; (ii) adopt keel forward-only, no backfill — REJECTED in favor of a faithful recorded history; (iii) CHOSEN — adopt AND backfill so `orient`/tier-satisfaction/rootedness become meaningful for the product and the engine dogfoods on the real deliverable it is co-located with. CRITERIA: honesty (the work is finally tracked) x faithful history x demonstrating the engine on a real product, not only on itself.";
        :>> consequences = "`.tracking/` gains business/requirements/delivery/verification content; product architecture decisions are recorded as D0005+; `keel orient`, tier-satisfaction, and rootedness become meaningful for the product. Backfill proceeds in green-committed phases (each `keel guard` ALL PASS). Going forward, product work is triaged and run through the workflow loop rather than ad hoc.";
    }

    verification d0004Accept : Test {
        :>> id = "d2e664fd-bc4b-49cd-afc2-1980fb834910";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz selected 'Adopt keel + backfill' on 2026-07-04, in response to the workflow critique's question on how the SelfSync product should relate to the keel engine — authorizing adoption of keel for the product and reconstruction of the shipped work as tracked items.";
    }
    part d0004AcceptR1 : TestResult {
        :>> id = "22e6ac88-ea6a-49ff-8c0c-f283bfacb273";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "bef3c9c";
        :>> judgedAt = "2026-07-04";
        :>> judgedBy = "wweatherholtz";
    }
}

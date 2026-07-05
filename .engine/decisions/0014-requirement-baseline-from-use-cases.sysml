// =====================================================================
// D0014 — expand the requirement baseline by a use-case functional decomposition. The user asked
// to take each use case, flesh out all downstream functions, build the full feature set, then make
// requirements from it. This records that expansion: 2 new Needs + 14 new SystemRequirements
// (reliability, data-safety/durability, large-file perf, vault management/onboarding, config
// completeness, and splitting the bundled sharing/admin requirement), each satisfy- + verify-linked.
// Accepted 2026-07-05 by wweatherholtz ("inline in batches"). No schema/process edit → plain ADR.
// =====================================================================
package ProjectDecision0014 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0014 : Decision {
        :>> id = "c0f1a5cc-f001-4a10-9b20-a1b2c3d400f1";
        :>> title = "D0014: expand the requirement baseline from the use-case functional decomposition";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The backfilled model had 20 system requirements, but decomposing each of the 11 use cases into the downstream functions it needs surfaced ~14 functional areas that existed only in code and tests with no requirement behind them: the HTTP sync API surface, WebSocket push, incremental version-cursor sync, self-healing reconnect, degraded/empty-server refusal (C2), the durable append-only index journal, streamed/parallel large-file transfer, interrupted-sync resume, vault switching, the no-secret onboarding link, per-device identity, config live-reload, the adjudication queue/UI, and the client read-only gating / registration policy / admin surface that were bundled into one coarse sharing requirement. Unrequirement'd functions are exactly how the config-sync defects escaped, so leaving them implicit is a known risk.";
        :>> decision = "Author the missing requirements in five subsystem batches, committed independently and validated green after each: (1) continuous-sync reliability under a new reliable-sync Need; (2) data-safety + durability under never-clobber + no-external-DB; (3) large-file performance under fast-sync + reliable-sync; (4) vault management + onboarding under a new manage-which-vault Need; (5) config completeness + splitting the bundled sharing requirement into distinct client-gating, registration-policy, and admin-surface requirements. Each new requirement is satisfy-linked to a Need and verify-linked to an acceptance Test — pointing at the real green suite where one exists, or an inspection of the implemented mechanism (with on-device confirmation deferred to L3/L4) where honest. Two new Needs are added; the requirement baseline grows from 20 to 34.";
        :>> rationale = "Making the implicit functions explicit closes the traceability gaps the retrospective (D0011) warned about: every user-facing function now has a stated requirement + a verifying test, so tier-satisfaction and the coverage lenses reflect reality instead of an under-count. ALTERNATIVES: (i) leave the functions implicit in code/tests — REJECTED, that is the exact gap that let defects ship untested. (ii) one giant requirements commit — REJECTED for reviewability; subsystem batches keep each change auditable and green. (iii) run it as a parallel workflow — offered; the user chose inline batches. CRITERIA: completeness (every use-case function rooted) x honesty (verify method matches available evidence) x reviewability (per-subsystem batches) x low-friction (reuse existing tests as evidence where they exist).";
        :>> consequences = "Two new Needs (reliable continuous sync; onboard + manage which vault syncs) and fourteen new SystemRequirements across five committed batches, each satisfy- + verify-linked; tier-satisfaction stays at 100% on both tiers (Needs decomposed, requirements verified). A few requirements are verified by inspection with their on-device demonstration deferred to the open L3/L4 manual passes (self-healing reconnect, resumable initial sync, device identity, config reload, adjudication UI) — surfaced honestly rather than claimed as tested. doc-sync: none (no command/type/skill surface changed). Complements D0011 (requirement-to-test traceability) by widening the rooted requirement set.";
    }

    verification d0014Accept : Test {
        :>> id = "c0f1a5cc-f002-4a10-9b20-a1b2c3d400f2";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed the expansion ('take each use case independently and flesh out all downstream functions... build the full set of features, then make requirements from them') and chose to author it 'inline in batches' on 2026-07-05.";
    }
    part d0014AcceptR1 : TestResult { :>> id = "c0f1a5cc-f003-4a10-9b20-a1b2c3d400f3"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "f98c1f2"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "wweatherholtz"; }
}

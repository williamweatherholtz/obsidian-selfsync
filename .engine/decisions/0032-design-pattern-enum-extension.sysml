// =====================================================================
// D0032 — Extend the DesignPattern enum (EngineCodeAudit, D0029) with two descriptive members needed to
// HONESTLY retag the elements the pattern-conformance critique found mislabeled. Additive, non-core.
// Accepted 2026-07-19 by wweatherholtz ("kick off implementation" / "proceed through all").
// =====================================================================
package ProjectDecision0032 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    #ProspectiveChange part d0032 : Decision {
        :>> id = "0d320a1c-7e34-4b55-9a11-2f3c4d5e6a32";
        :>> title = "D0032: add DesignPattern::contentAddressedImmutable + errorIsolationLoop to honestly retag the mislabeled CodeElements";
        :>> createdAt = "2026-07-19";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The design-pattern conformance critique (5 independent critics, issuePatternTagsMislabeled) found 5 CodeElement `pattern` tags that don't match what the code does: ceContentStorePut (tagged singleWriter but is a content-addressed IMMUTABLE store — concurrent same-hash puts are safe by hashing+immutability, NOT single-writer), ceResolveConfigConflict (command → strategy), ceSharesAuthorized + ceMergeEnabledPlugins (makeIllegalStatesUnrepresentable → functionalCoreImperativeShell, runtime decision functions not type-level state elimination), and ceIsolatedPass (boundedPool → its bound is DELEGATED to mapPool; the element itself IS an error-isolation loop). Three retag to existing enum members (strategy, functionalCoreImperativeShell x2); two — the content-addressed store and the error-isolation loop — have no existing member that fits honestly, and forcing a wrong tag or `none` would lose real descriptive information.";
        :>> decision = "Add two members to the DesignPattern enum (.engine/schema/codeaudit/codeelement.sysml): `contentAddressedImmutable` (a store whose safety comes from content-addressing + immutability — a put is idempotent, a concurrent same-hash put is a redundant identical write, never a torn/racing mutation) and `errorIsolationLoop` (a loop that isolates per-item failures — one item's error never aborts the batch — over a separately-bounded pool). Retag the five elements accordingly (contentAddressedImmutable / strategy / functionalCoreImperativeShell / functionalCoreImperativeShell / errorIsolationLoop). Also fix the .engine/docs/design-patterns.md parseDontValidate exemplar row (validateChanges/validateFileMeta historically cast; the true exemplars are safe_rel_path + validateStatus). The DesignPattern vocabulary is DESCRIPTIVE (D0029) — it names shapes the code uses; keeping it honest is the point.";
        :>> rationale = "The pattern registry is only useful if its tags are TRUE (D0029: patterns are a descriptive lens). The critique proved two shapes are real + recurring in the code but unnamed by the vocabulary; adding them is the minimal accurate fix, and it is additive to a non-core audit schema (schema/core stays frozen). Pre-authorized by the recorded issuePatternTagsMislabeled ('with a DesignPattern enum extension where needed') + the owner's implement directive.";
        :>> consequences = "Schema: +2 DesignPattern members (additive, no existing tag changes meaning). Registry: 5 CodeElement retags. Docs: the design-patterns.md exemplar row corrected. No code/behavior change. Closes issuePatternTagsMislabeled; with the untagged tags already applied, completes patternRegistryReview (→ also closes issueUntaggedElementsPatternReview). #ProspectiveChange: prior outputs stay valid.";
    }

    verification d0032Accept : Test {
        :>> id = "0d32acc7-2b33-4c44-9d55-6e7f80912332";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed on 2026-07-19 to implement the recorded pattern backlog ('create issues for all, then kick off implementation' → 'go' → 'proceed through all'). issuePatternTagsMislabeled explicitly scoped 'a DesignPattern enum extension where needed'; this Decision records that additive schema change + the retags it enables.";
    }
    part d0032AcceptR1 : TestResult { :>> id = "0d32ac00-ab22-4c33-9d44-5e6f70819332"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "21e2871"; :>> judgedAt = "2026-07-19"; :>> judgedBy = "wweatherholtz"; }
}

// =====================================================================
// D0028 — Function-audit methodology: line-by-line source-code audits leave a durable in-code trail —
// an `// @audit` finding comment on every audited function and an `// @audit-hash` code-hash stamp on
// every function actually fixed — so audits COMPOUND and become drift-aware (a per-function analogue of
// the engine's file-level `suspect`/verifiedAtCommit). Deployed by the `function-audit` skill +
// `.engine/tools/audit_hash.py`. Directed + accepted 2026-07-18 by wweatherholtz.
// =====================================================================
package ProjectDecision0028 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0028 : Decision {
        :>> id = "0d280a1c-7e34-4b55-9a11-2f3c4d5e6a28";
        :>> title = "D0028: function-audit methodology — // @audit finding comments + // @audit-hash code-hash drift stamps, via the function-audit skill + audit_hash.py";
        :>> createdAt = "2026-07-18";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The top-20 critical-functions critique pass (2026-07-17) verified real defects + shipped behavior-preserving cleanups, but the audit itself left NO durable trace in the code: the findings lived only in the conversation + commit messages, so a future pass re-covers the same ground and cannot cheaply tell WHICH functions have changed since they were last audited (and therefore need re-auditing) vs. which are still as-blessed. This is the same gap the engine already solves at FILE granularity with `suspect`/verifiedAtCommit (a deliverable task is suspect when its source changed since it was verified) — but there was no equivalent at FUNCTION granularity. On 2026-07-18 the owner directed the next round with an explicit methodology: 'do again for the next 20 functions. for each function we audit, leave a comment indicating the finding, then a hash of the function code when implementation is applied.' Auditing critical functions is now clearly RECURRING (2nd round), so per D0040/D0059 the approach must be encoded in a skill rather than re-improvised each time.";
        :>> decision = "Adopt the function-audit methodology as a first-class engine convention. (1) A `function-audit` skill (.engine/skills/function-audit/, registered in skills-registry) encodes the recurring line-by-line audit (idiom / design patterns / concision, never terseness), the verify-before-believing rule, and the marker discipline. (2) Every AUDITED function carries an in-code marker `// @audit r<N> <YYYY-MM-DD> — <finding, or \"clean\">` directly above its signature. (3) Every function whose IMPLEMENTATION IS CHANGED by the audit additionally carries `// @audit-hash sha256:<16hex>` — the reproducible hash of that function's post-fix source (signature through the matching body-close), recorded by `.engine/tools/audit_hash.py compute`. (4) `audit_hash.py verify` recomputes each stamped function's hash and reports DRIFT (code changed since blessed → re-audit) or STALE (marker resolves to no function); it runs at the start of a new pass to re-scope, and must end clean before a pass is considered done. The hash is a DRIFT SIGNAL, not a security control — brace matching is naive-but-deterministic, so unchanged code always yields the same hash and a pathological case only ever triggers a harmless re-audit. ≥Medium findings still become tracked Issues (D0077) with fail-first regressions (D0026/D0047); behavior-preserving cleanups ride a delivery action with a method=test DoD.";
        :>> rationale = "A prose critique evaporates; an in-code marker makes the audit a durable, drift-aware artifact that COMPOUNDS across passes instead of repeating. The `@audit-hash` stamp is the per-function analogue of the engine's file-level suspect mechanism — it answers 'has the thing I blessed changed?' cheaply and objectively, so a future pass re-audits only what drifted rather than re-reading everything. Encoding it as a skill + a committed, reproducible tool (rather than conversation habit) is exactly what D0040 (recurring ⇒ skill) and D0059 (no inert process) require, and keeps the method reviewable and improvable. A tool-computed hash (never hand-authored) keeps the stamp honest and cross-platform-stable (CRLF/whitespace normalized). Placing markers ABOVE the signature keeps them out of their own hashed range.";
        :>> consequences = "New: .engine/skills/function-audit/SKILL.md (+ skills-registry entry) and .engine/tools/audit_hash.py. Source files gain `// @audit` comments on audited functions and `// @audit-hash` stamps on fixed ones (visible provenance; the hash lines are excluded from the hashed range). Future audit rounds start with `audit_hash.py verify` to find drifted functions and increment the round number r<N>. No schema change, no runtime/deliverable behavior change (comments + a dev tool only). The critique-pass request class is now routed through the function-audit skill (engine-triage). A CI/pre-commit `audit_hash.py verify` gate is a possible future guard but is NOT added now (kept advisory until the marker set is established).";
    }

    verification d0028Accept : Test {
        :>> id = "0d28acc7-2b33-4c44-9d55-6e7f80912328";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed the methodology on 2026-07-18: 'do again for the next 20 functions. for each function we audit, leave a comment indicating the finding, then a hash of the function code when implementation is applied.' — an explicit instruction to adopt the // @audit finding comment + // @audit-hash code-hash convention for critical-function audits, which this Decision + the function-audit skill + audit_hash.py record and deploy.";
    }
    part d0028AcceptR1 : TestResult { :>> id = "0d28ac00-ab22-4c33-9d44-5e6f70819328"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "6f6dcc4"; :>> judgedAt = "2026-07-18"; :>> judgedBy = "wweatherholtz"; }
}

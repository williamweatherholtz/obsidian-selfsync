---
name: code-critique
description: |
  Adversarial, multi-lens BUG hunt of the deliverable SOURCE CODE by INDEPENDENT
  critics (data-integrity, security, concurrency, correctness): each critic runs in
  fresh context and tries to BREAK the code, findings are VERIFIED against the source
  before recording, confirmed defects become severity-carrying Issues (D0077), and each
  is fixed with a fail-first regression. Deploys .engine/processes/code-critique.sysml.
  Use when asked to "critique / red-team / adversarially review the code", "find bugs",
  "where is this weak", "another critique pass", or after a big change to a critical
  subsystem. NOT for tracked model elements (element-critique), the engine itself
  (architectural-critique), or per-function idiom (function-audit).
metadata:
  version: 0.1.0
  domain: [critique, adversarial, code-review, bug-finding, data-integrity, security, concurrency, correctness, independent-critic]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# code-critique

Deploys `.engine/processes/code-critique.sysml`. Finds REAL runtime defects — data loss, security holes,
races, correctness bugs — in the deliverable code, by independent adversarial critics whose findings are
verified against the source before they become tracked Issues. This is the answer to the founding complaint
("bugs slip past the test suite"): a repeatable, independent, verify-first bug hunt.

## When it's the right tool
Asked to critique/red-team/adversarially review the code, "find bugs", "where are we weak", "another
critique pass", or after a substantial change to a high-criticality subsystem. Prioritize the target by
`keel arch criticality` (dataLoss/security/durability/correctness first) and by what changed most recently.

- **NOT this skill:** critiquing a tracked Need/SystemRequirement/Decision → **element-critique** (findings
  are `method=critique` verifications on the element). Stress-testing the engine + its processes →
  **architectural-critique**. A per-function idiom/design line-audit with `@audit-hash` markers →
  **function-audit**. Measuring whether the suite catches bugs → **mutation-testing**; finding bugs via
  invariants → **property-based-testing**. code-critique is the cross-subsystem adversarial *bug* hunt.

## Method (the 5 steps)
1. **Scope + choose lenses** — pick the target files (highest-criticality / most-recently-changed) and one
   distinct adversarial lens per critic (default: data-integrity/durability, security/authz, concurrency/
   races, correctness/protocol; extend per target).
2. **Dispatch INDEPENDENT critics** — one per lens, each in FRESH context (a subagent), never the author, so
   it truly tries to BREAK the code. Instruct each: read the ACTUAL code; the codebase is hardened, so hunt
   SUBTLE/residual defects; report ONLY real issues with `(file:line, exact mechanism, a CONCRETE failure
   scenario, severity, confidence, suggested fix)`; a false positive is worse than silence; say "no real
   findings" when true. Run them in parallel.
3. **Verify before believing** — the non-negotiable gate: re-check EVERY candidate against the real code +
   its tests/guards. Drop what a test/guard already covers, what misreads the flow, or what can't be
   reproduced. Dedupe across critics. (A plausible-but-wrong finding recorded as real is the failure mode —
   this session caught a false "dead code" claim by verifying.)
4. **Record findings as Issues** — each confirmed finding → a tracked `Issue` (D0077, severity, `#Resolves`
   from a fixing action). The code is not a `#Verify` element, so findings are Issues, NOT `method=critique`
   verifications. Document (don't file) lower/mitigated candidates; state cleared areas as cleared.
5. **Fix with fail-first regressions** — fix highest-severity first, each with a fail-first test (RED under
   the defect → GREEN after), validate green + reverify the deliverable gate. A finding too big for this pass
   → an OPEN follow-on action (honest, tracked). The resolving action's DoD closes each Issue.

## Rules
- **Independence is the point.** A critic that is the author, or that shares the author's context, is not a
  critic. Fresh subagents per lens.
- **Verify-before-record is mandatory.** Never file a finding you haven't re-confirmed against the code.
- **Compute, don't attest.** A finding is a file:line + failure scenario; a fix carries a fail-first
  regression; a cleared area is stated as cleared — never a prose "looks correct".
- **Scale to the ask.** "find any bugs" → a few critics, verify, fix. "thorough audit" → more lenses, a
  wider target sweep, an explicit cleared-areas list.

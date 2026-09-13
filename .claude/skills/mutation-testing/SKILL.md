---
name: mutation-testing
description: |
  Measure whether the test suite actually CATCHES bugs (not just runs lines):
  inject faults with cargo-mutants (Rust) / Stryker (TS), turn each SURVIVING mutant
  into a killing test (or a justified accept), and record the mutation score as a
  monitored Indicator. The computed answer to "are tests really being carried out?".
  Deploys .engine/processes/mutation-testing.sysml. Use when asked to assess test
  efficacy, after a test-hardening pass, or to prove a module's tests bite.
metadata:
  version: 0.1.0
  domain: [testing, correctness, mutation-testing, test-efficacy, cargo-mutants, stryker, indicators]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# mutation-testing

Deploys `.engine/processes/mutation-testing.sysml`. Coverage proves lines *ran*; a mutation score proves the
suite would *fail* on a real fault. A surviving mutant = a concrete test-gap (a bug that would ship undetected).

## Method
1. **Run** cargo-mutants (server) / Stryker (client), scoped to a target module first (whole-repo is slow);
   capture the score + surviving-mutant list. Prioritize modules by `keel arch criticality`.
2. **Triage** each survivor: a REAL test-gap (a meaningful behavior change no test caught) vs an
   EQUIVALENT/uninteresting mutant (semantically identical, or in cosmetic/logging code).
3. **Kill or justify**: a fail-first test that kills each real-gap mutant (re-run to confirm it dies); a
   recorded, justified skip for an equivalent mutant (never silent). Green at every step.
4. **Indicator**: record the mutation score as a monitored `Indicator` (D0089, computed) with a direction
   (higher = better); promote to a CI floor only once a defensible baseline exists (D0088 — no arbitrary
   threshold).
5. **Record findings**: a systemic test-gap class → a tracked `Issue` (D0077, #Resolves from the killing
   action); a defect the mutant EXPOSED in the code itself → its own Issue. The killing tests + the score are
   the computed evidence.

## Rules
- A surviving mutant on a dataLoss/security/durability/correctness element is high-priority — kill it.
- Don't chase 100%: equivalent mutants exist; record the justified accepts, floor the score defensibly.
- Not this skill: finding NEW bugs via invariants → **property-based-testing**; both are complementary
  (mutation testing finds where the suite is blind; PBT fills correctness gaps it exposes).

---
name: property-based-testing
description: |
  Find correctness bugs by testing INVARIANTS (not examples), adapting Anthropic's
  Claude-PBT method: investigate → propose properties grounded in the code's own
  contracts → write property tests (fast-check for TS, proptest for Rust) → a
  reflection loop that separates genuine bugs from wrong properties → record findings
  as Issues + permanent regression tests. Deploys
  .engine/processes/property-based-testing.sysml. Use when asked to "property-test",
  "find edge-case bugs", or to harden a pure/high-criticality function beyond examples.
metadata:
  version: 0.1.0
  domain: [testing, correctness, invariants, property-based, fast-check, proptest, bug-finding]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# property-based-testing

Deploys `.engine/processes/property-based-testing.sysml`. Finds correctness bugs example-based tests miss,
by testing general invariants over generated inputs (with shrinking → a minimal counterexample).

## When it's the right tool
The PURE, total functions — highest value, cheapest to specify. Prioritize by `keel arch criticality`
(dataLoss/correctness first). For SelfSync: `decide`, `merge3`, the chunker, `sameIgnoringEol`,
`mergeEnabledPluginsJson` (client, fast-check); the Rust chunker, `safe_rel_path`, index round-trips
(server, proptest). Effect-heavy code is a poor fit — property-test its pure core, integration-test the shell.

## Method (Anthropic's 5 steps)
1. **Investigate** — read the target + its WHY-comments/invariant tags + types + callers.
2. **Propose properties, grounded in the code** — totality (never throws), round-trip (`concat(chunk(x)) == x`;
   decode∘encode = id), metamorphic (EOL/whitespace-invariance, order-independence), safety (never a
   clobbering/destructive result for a genuine divergence), monotonicity (grow-only union ⊇ both inputs).
   **CURATE**: AI-drafted properties are frequently trivial or wrong — only the real contract decides what's
   correct. A property that just restates the implementation is worthless.
3. **Write** the tests with the PBT engine over real generators; test the REAL code path, never a mock; no
   tautologies.
4. **Reflect** — for each failure, read the shrunk counterexample: REAL bug, or too-strong property (an
   intended implicit semantic)? Fix a wrong property; keep a real-bug property RED until the code is fixed.
   Never accept a green that merely swallows the failure in a catch.
5. **Record** — each confirmed bug → a tracked `Issue` (D0077, severity-ranked, act on high-confidence first),
   fixed green with the property test kept as a permanent regression; a clean pass → the computed TestResult.

## Rules
- Curate every property against the invariant it encodes (cite it). Trivial/incorrect properties are noise.
- Fail-first: a property that exposes a real bug stays RED until the fix (test-authoring D0026/D0047).
- Not this skill: measuring whether the SUITE catches bugs → **mutation-testing**; per-function code quality →
  **function-audit**; the architecture registry → **architecture-audit**.

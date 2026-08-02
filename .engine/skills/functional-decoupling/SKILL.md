---
name: functional-decoupling
description: |
  Behavior-preserving refactoring pass over a subsystem: walk it function by
  function and, WHERE IT EARNS ITS KEEP, split multi-responsibility functions,
  separate pure decision logic from side effects, and inject hard-wired
  dependencies at seams — improving testability + clarity and yielding clean
  control-structure seams for STPA as a byproduct. Use when asked to "decouple",
  "refactor for testability", "split these functions", "do the decoupling /
  functional-analysis pass", or when a subsystem keeps sprouting interaction
  bugs that are hard to test. DISTINCT from function-audit (which REVIEWS idiom,
  doesn't restructure), code-critique (hunts DEFECTS), and stpa (analyses unsafe
  INTERACTIONS). Deploys .engine/processes/functional-decoupling.sysml (D0036).
metadata:
  version: 0.1.0
  domain: [refactoring, decoupling, testability, design-patterns, seams, functional-core, SOLID]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# functional-decoupling

A **behavior-preserving** refactor discipline (D0036). It changes STRUCTURE, never behavior — the full
suite stays green throughout. Its output is code that is easier to test in isolation, and clean seams
(pure cores + injected effects) that a later `stpa` pass reads as its control structure. It is decoupled
FROM STPA on purpose: STPA analyses the control structure; this improves the code and hands STPA cleaner
hooks, but is a standalone quality pass.

## Method (named, so it is auditable — not vibes)

Refactor TOWARD established seams, and toward **this repo's own proven idioms**, not novel ones:

- **Characterization tests first** (Feathers, *Working Effectively with Legacy Code*) — PIN current
  behavior before touching it. Thin coverage on a critical function ⇒ add characterization tests first.
- **Seams** (Feathers) — a place to change behavior without editing in place: an injected collaborator.
  This repo's canonical seams: `EngineEffects`, `ReconcileDeps`, `buildApi`/`buildIo`, injected `deps`.
- **Functional core / imperative shell** (Bernhardt) — extract the PURE decision logic (a total function
  of its inputs) out of the side-effecting shell. Already embodied here: pure `decide()`,
  `classifyConnectError`, the FSM transitions. Push more code toward that shape.
- **SRP + DIP** (SOLID) — one reason to change per unit; depend on an injected abstraction, not a concretion.
- **Ports & Adapters / Hexagonal** (Cockburn) — domain logic depends on ports; adapters do the I/O.
- **Extract Function / Move Function / Introduce Parameter Object / Separate Query from Modifier** (Fowler);
  **Command-Query Separation** (Meyer) — the mechanics.

## The guardrail (read this before every step)

Decouple ONLY where a real smell is removed: mixed pure/effectful logic, a >1-responsibility function, an
untestable seam, a hard-wired dependency. Do **NOT** shatter cohesive functions or add indirection for its
own sake — over-decoupling buries intent as badly as coupling. **Behavior-preserving is non-negotiable.**

## Procedure (the six ProcessSteps)

1. **Scope + rank.** Pick the subsystem (highest data-safety/security/concurrency criticality + most-tangled
   first; reuse function-audit's ranking + open `@audit` findings). Inventory its functions; rank by
   decoupling VALUE (mixed pure/effectful, multi-responsibility, untestable, hard-wired dep = high; small
   cohesive pure fn = low, leave it).
2. **Characterize.** Pin behavior with tests before refactoring — add characterization tests where coverage
   is thin (cover the non-happy-path branches too).
3. **Analyze each function** — purpose (>1 ⇒ split), pure-vs-effectful boundary, dependency seams, the fitting
   pattern. This is the per-function map.
4. **Decouple** — one small step at a time, suite green between steps: Extract Function, extract the pure core
   from the effectful shell, inject a hard-wired collaborator via the repo's `EngineEffects`/`ReconcileDeps`
   idiom. Only where it earns its keep.
5. **Verify** — full vitest + `tsc --noEmit` + keel green (SAME behavior, the characterization tests are the
   proof) AND a direct unit test per new seam proving it's now testable in isolation. Not green + hookable ⇒ revert.
6. **Record** — a brief WHY on each new seam (repo idiom); hand any newly-exposed **controller** (holds a
   process-model belief + can act wrongly) to the `stpa` backlog; file any incidental DEFECT (not mere coupling)
   as an Issue via code-critique, never fixed silently under the refactor.

## Relationship to the other quality skills

`functional-decoupling` (refactor structure) → hands clean seams to `stpa` (analyse unsafe interactions) →
whose UCAs become status-truth/interaction tests. `function-audit` (review idiom) and `code-critique` (hunt
defects) feed decoupling targets. Keep them separate: a decoupling PR contains no behavior change; a defect
found mid-decouple is filed, not folded in.

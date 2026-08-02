// =====================================================================
// EngineFunctionalDecoupling — the Functional Decoupling process (D0036): a BEHAVIOR-PRESERVING
// refactoring discipline that walks a subsystem function-by-function and, where it earns its keep,
// SPLITS multi-responsibility functions, SEPARATES pure decision logic from side effects, and INJECTS
// hard-wired dependencies at seams — improving testability + clarity and, as a BYPRODUCT, yielding the
// clean control-structure seams that the `stpa` analysis and status-truth tests hook into.
//
// DISTINCT from its neighbours: `function-audit` REVIEWS functions (idiom/design/concision, @audit
// markers) but does not restructure; `code-critique` hunts runtime DEFECTS; `stpa` analyses unsafe
// INTERACTIONS. This process CHANGES STRUCTURE (refactor), never behavior — so it is decoupled from STPA
// (STPA reads the control structure; decoupling improves the code and hands STPA cleaner seams, but is a
// standalone quality pass, D0036). It CONSUMES function-audit findings as decoupling targets.
//
// METHOD (researched, named so it is auditable — Feathers/Fowler/Bernhardt/SOLID/Cockburn + this repo's
// OWN proven idioms; refactor TOWARD the established seams, not novel ones):
//   * Characterization tests before refactoring (Feathers, "Working Effectively with Legacy Code") —
//     PIN current behavior first; a decoupling with thin coverage is unsafe.
//   * Seams (Feathers) — a place to change behavior without editing in place: an injected collaborator.
//     This repo's canonical seams: `EngineEffects`, `ReconcileDeps`, `buildApi`/`buildIo`, injected `deps`.
//   * Functional core / imperative shell (Bernhardt) — extract PURE decision logic (a total fn of inputs)
//     out of the side-effecting shell. This repo already embodies it: pure `decide()`, `classifyConnectError`,
//     the FSM transitions; push more code toward that shape.
//   * SRP + DIP (SOLID) — one reason to change per unit; depend on an injected abstraction, not a concretion.
//   * Ports & Adapters / Hexagonal (Cockburn) — domain logic depends on PORTS; adapters do the I/O.
//   * Extract Function / Move Function / Introduce Parameter Object / Separate Query from Modifier (Fowler)
//     — the mechanics; Command-Query Separation (Meyer).
// GUARDRAIL: decouple only where it earns its keep (a real responsibility split, an untestable seam, an
// entangled pure/effectful boundary). Do NOT shatter cohesive functions or add indirection for its own
// sake — over-decoupling buries intent. Behavior-preserving is non-negotiable: the full suite stays green.
// Deployed by the `functional-decoupling` skill.
// =====================================================================
package EngineFunctionalDecoupling {
    private import EngineElement::*;
    private import EngineProcess::*;

    part functionalDecoupling : Process {
        :>> id = "7a59a2e5-a7d3-442e-aa6e-0afde27e3085";
        :>> title = "Functional Decoupling (behavior-preserving refactor for testability + clean seams)";
        :>> purpose = "Walk a subsystem function-by-function and, where it earns its keep, split multi-responsibility functions, separate pure decision logic from side effects, and inject hard-wired dependencies at seams — improving testability + clarity and yielding clean control-structure seams — WITHOUT changing behavior (the full suite stays green).";
        :>> cadence = Cadence::adHoc;
    }

    part fdScope : ProcessStep {
        :>> id = "16a90423-4260-42bf-bcd0-a49deb44e738";
        :>> title = "Scope + criticality-rank the target functions";
        :>> order = 1;
        :>> triggerCondition = "Asked to decouple / refactor-for-testability / 'split these functions' / 'this is too tangled to test'; or a subsystem repeatedly sprouted status/interaction bugs (a decoupling signal); or an stpa pass needs cleaner control-structure seams.";
        :>> actionText = "Pick the target subsystem (highest data-safety/security/concurrency criticality + most-tangled/bug-prone first — reuse function-audit's criticality ranking and any open @audit findings as targets). Inventory its functions. Rank by decoupling VALUE: a function that mixes pure decision logic with I/O, holds >1 responsibility, is hard to test in isolation, or hard-wires a collaborator, ranks high; a small cohesive pure function ranks low (leave it).";
        :>> producedArtifact = "The target function inventory, ranked by decoupling value, with the specific smell per candidate (mixed pure/effectful, multi-responsibility, untestable seam, hard-wired dep).";
        :>> owner = Owner::ai;
    }
    part fdCharacterize : ProcessStep {
        :>> id = "ed82bf2a-df04-42aa-a9d8-7d9033fa8532";
        :>> title = "Characterize behavior before touching it";
        :>> order = 2;
        :>> actionText = "Feathers: PIN the current behavior before refactoring. If the target's coverage is thin, ADD characterization tests that lock in what it does NOW (incl. the non-happy-path branches), so the refactor is provably behavior-preserving. Never refactor a critical function whose behavior isn't pinned — a silent behavior change is worse than the coupling.";
        :>> producedArtifact = "Green characterization + existing tests covering every branch of each function about to be refactored.";
        :>> owner = Owner::ai;
    }
    part fdAnalyze : ProcessStep {
        :>> id = "81303428-7c7d-484a-9d27-12493dc66d52";
        :>> title = "Analyze each function: purpose, responsibilities, pure-vs-effectful, deps, pattern";
        :>> order = 3;
        :>> actionText = "For each ranked function record: its single PURPOSE (if it has >1, that is the SRP split); which parts are PURE DECISION logic vs SIDE EFFECTS (the functional-core/imperative-shell boundary); its DEPENDENCIES (injected via a seam, or hard-wired?); and the design PATTERN that fits (extract a pure fn; inject an effect via the repo's EngineEffects/ReconcileDeps idiom; a parameter object; command-query separation). This is the per-function map the decoupling (and any later stpa control-structure) reads.";
        :>> producedArtifact = "Per-function analysis: purpose, pure/effectful split points, dependency seams, and the chosen refactoring/pattern (or 'leave — already cohesive/pure').";
        :>> owner = Owner::ai;
    }
    part fdDecouple : ProcessStep {
        :>> id = "6d8f7272-7904-46a8-a2f4-051eac9b1d22";
        :>> title = "Decouple / split — only where it earns its keep";
        :>> order = 4;
        :>> actionText = "Apply the chosen refactoring, ONE small step at a time, running the suite between steps: Extract Function (split a multi-responsibility fn), extract the PURE decision core out of the effectful shell (toward pure classifiers/decide-style fns), inject a hard-wired collaborator at a seam (toward EngineEffects/ReconcileDeps/buildApi). GUARDRAIL: decouple only where a real smell is removed — do NOT shatter cohesive functions or add indirection for its own sake (over-decoupling buries intent). Refactor TOWARD the repo's existing seams, not novel ones.";
        :>> producedArtifact = "The decoupled functions: pure cores extracted, responsibilities split, dependencies injectable — each a testable seam.";
        :>> owner = Owner::ai;
    }
    part fdVerify : ProcessStep {
        :>> id = "5cd32314-252a-48e4-baa5-376fe77a7fcd";
        :>> title = "Verify behavior-preserving (green) + prove the new seams are testable";
        :>> order = 5;
        :>> actionText = "MANDATORY gate: full client vitest + tsc --noEmit clean + keel green — the SAME behavior, now decoupled (the characterization tests are the proof it didn't drift). Then demonstrate each new seam is a HOOK: a focused unit test that drives the extracted pure core or the injected effect directly (the testability payoff). A decoupling that doesn't end green + hookable is reverted, not shipped.";
        :>> producedArtifact = "Green suite (behavior unchanged) + at least one direct unit test per new seam proving it is now testable in isolation.";
        :>> owner = Owner::ai;
    }
    part fdRecord : ProcessStep {
        :>> id = "5e313df8-9798-4d32-8621-8fee72037980";
        :>> title = "Record the seams + hand off to stpa";
        :>> order = 6;
        :>> actionText = "Note the decoupling in-code where useful (a brief WHY on the extracted seam, consistent with this repo's dense-comment idiom). The clean seams — pure cores + injected effects — are the control-structure elements a subsequent `stpa` pass reads (controllers vs channels, control actions, feedback); flag any newly-exposed seam that looks like a controller (holds a process-model belief + can act wrongly) as an stpa input. A decoupling that reveals a genuine defect (not just coupling) is routed to code-critique/an Issue, not silently fixed under the refactor.";
        :>> producedArtifact = "Decoupled + green code with recorded seams; a short list of newly-exposed controllers/feedback handed to the stpa backlog; any incidental defect filed as an Issue.";
        :>> owner = Owner::ai;
    }
}

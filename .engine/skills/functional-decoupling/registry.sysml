// This skill's own registry declaration, beside the skill it describes (D0222).
//
// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine
// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a
// move rather than a copy. A project-authored skill (not shipped by the engine).
package SkillsRegistryFunctionalDecoupling {
    private import EngineElement::*;
    private import EngineSkills::*;

    part functionalDecoupling : AISkill {
        :>> id = "fdec0c17-1a2b-4c3d-8e4f-5a6b7c8d9e02";
        :>> title = "functional-decoupling";
        :>> purpose = "Behavior-preserving refactor of a subsystem (D0036): walk it function by function and, where it earns its keep, split multi-responsibility functions, separate pure decision logic from side effects, and inject hard-wired deps at seams — improving testability + clarity and yielding clean control-structure seams for STPA as a byproduct. Grounded in Feathers (seams, characterization tests) / Bernhardt (functional-core/imperative-shell) / Fowler / SOLID / Cockburn + this repo's own idioms (EngineEffects/ReconcileDeps/pure classifiers). Distinct from function-audit (reviews idiom, no restructure), code-critique (hunts defects), stpa (analyses interactions). Deploys .engine/processes/functional-decoupling.sysml.";
        :>> location = ".engine/skills/functional-decoupling/SKILL.md";
        :>> triggerCondition = "Asked to decouple / refactor-for-testability / 'split these functions' / 'do the decoupling / functional-analysis pass', or a subsystem keeps sprouting hard-to-test interaction bugs.";
        :>> writePolicy = WritePolicy::direct;
    }
}

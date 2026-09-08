// This skill's own registry declaration, beside the skill it describes (D0222).
//
// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine
// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a
// move rather than a copy. A project-authored skill (not shipped by the engine).
package SkillsRegistryMutationTesting {
    private import EngineElement::*;
    private import EngineSkills::*;

    part mutationTesting : AISkill {
        :>> id = "c69d21ec-d2d3-4c2e-8c9f-c6c56c445c9c";
        :>> title = "mutation-testing";
        :>> purpose = "Measure whether the test suite actually CATCHES bugs (cargo-mutants / Stryker): a surviving mutant is a concrete test-gap; turn each into a killing test (or justified accept) and record the mutation score as a monitored Indicator (D0089) — the computed answer to 'are tests really being carried out?'. Deploys .engine/processes/mutation-testing.sysml.";
        :>> location = ".engine/skills/mutation-testing/SKILL.md";
        :>> triggerCondition = "Asked to assess test efficacy, after a test-hardening pass, or to prove a module's tests bite.";
        :>> writePolicy = WritePolicy::direct;
    }
}

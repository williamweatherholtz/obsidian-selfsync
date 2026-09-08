// This skill's own registry declaration, beside the skill it describes (D0222).
//
// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine
// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a
// move rather than a copy. A project-authored skill (not shipped by the engine).
package SkillsRegistryPropertyBasedTesting {
    private import EngineElement::*;
    private import EngineSkills::*;

    part propertyBasedTesting : AISkill {
        :>> id = "7569d191-64f4-4e11-86df-013025d420aa";
        :>> title = "property-based-testing";
        :>> purpose = "Find correctness bugs by testing INVARIANTS not examples (Anthropic's Claude-PBT method): investigate -> propose properties grounded in the code's contracts -> write property tests (fast-check TS / proptest Rust) -> reflect genuine bugs from wrong properties -> record findings as Issues + permanent regressions. Targets pure high-criticality cores (decide/merge3/chunker/...). Deploys .engine/processes/property-based-testing.sysml.";
        :>> location = ".engine/skills/property-based-testing/SKILL.md";
        :>> triggerCondition = "Asked to property-test / find edge-case bugs / harden a pure function beyond examples.";
        :>> writePolicy = WritePolicy::direct;
    }
}

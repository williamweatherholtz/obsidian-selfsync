// This skill's own registry declaration, beside the skill it describes (D0222).
//
// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine
// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a
// move rather than a copy. A project-authored skill (not shipped by the engine).
package SkillsRegistryTestAuthoring {
    private import EngineElement::*;
    private import EngineSkills::*;

    part testAuthoring : AISkill {
        :>> id = "a042dce7-59f0-4d2c-b635-5e92e5f0e556";
        :>> title = "test-authoring";
        :>> purpose = "Encode the standard for WRITING deliverable tests (D0026/D0047): fail-first regression per fix; test the real code path, never a mock of it; cover the failure/edge classes (binary/EOL/connection/read-only/concurrent/CAS/DoS/token/degraded); no tautological assertions; coverage stays a COMPUTED, floored fact. Codebase specifics in docs/testing.md.";
        :>> location = ".engine/skills/test-authoring/SKILL.md";
        :>> triggerCondition = "Writing/expanding/reviewing deliverable unit/integration/e2e tests, or shipping any fix.";
        :>> writePolicy = WritePolicy::direct;
    }
}

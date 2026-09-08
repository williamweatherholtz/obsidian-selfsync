// This skill's own registry declaration, beside the skill it describes (D0222).
//
// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine
// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a
// move rather than a copy. A project-authored skill (not shipped by the engine).
package SkillsRegistryFunctionAudit {
    private import EngineElement::*;
    private import EngineSkills::*;

    part functionAudit : AISkill {
        :>> id = "a1c9d2e3-4b5f-4a60-9c71-8d2e3f4a5b60";
        :>> title = "function-audit";
        :>> purpose = "Line-by-line SOURCE-CODE audit of the most critical programmatic functions (idiom / design patterns / concision, never terseness), leaving an in-code provenance trail: an // @audit finding comment on every audited function and an // @audit-hash code-hash stamp (via .engine/tools/audit_hash.py) on every function actually fixed, so a later pass detects drift (keel-style suspect for functions) and re-audits only what changed. Distinct from element-critique (model elements) and architectural-critique (engine architecture).";
        :>> location = ".engine/skills/function-audit/SKILL.md";
        :>> triggerCondition = "Asked to audit/critique the top-N or next-N programmatic functions line by line, or to re-audit drifted @audit-hash functions.";
        :>> writePolicy = WritePolicy::direct;
    }
}

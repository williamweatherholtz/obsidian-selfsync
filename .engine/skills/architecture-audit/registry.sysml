// This skill's own registry declaration, beside the skill it describes (D0222).
//
// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine
// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a
// move rather than a copy. A project-authored skill (not shipped by the engine).
package SkillsRegistryArchitectureAudit {
    private import EngineElement::*;
    private import EngineSkills::*;

    part architectureAudit : AISkill {
        :>> id = "c2a12ce8-45b7-4d22-a194-ebef17cdcac3";
        :>> title = "architecture-audit";
        :>> purpose = "Audit a deliverable's source ARCHITECTURE (D0029): maintain the authored CodeElement registry (.tracking/architecture/), rank elements by accepted-risk against Needs, assess invariant-safety + coupling as the PRIMARY lens (design patterns are a descriptive tag, never a compliance gate), capture STPA control-structure INPUTS for a later STPA process (no analysis here), and detect drift via the D0028 @audit-hash. Deploys .engine/processes/architecture-audit.sysml. Distinct from function-audit (per-function code quality), element-critique (tracked model elements), architectural-critique (the engine's own architecture).";
        :>> location = ".engine/skills/architecture-audit/SKILL.md";
        :>> triggerCondition = "Asked to audit the architecture / catalogue code elements / rank by criticality, or to work the keel arch drift/coverage frontier.";
        :>> writePolicy = WritePolicy::direct;
    }
}

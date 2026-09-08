// This skill's own registry declaration, beside the skill it describes (D0222).
//
// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine
// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a
// move rather than a copy. A project-authored skill (not shipped by the engine).
package SkillsRegistryCodeCritique {
    private import EngineElement::*;
    private import EngineSkills::*;

    part codeCritique : AISkill {
        :>> id = "c0de0c17-1a2b-4c3d-8e4f-5a6b7c8d9e01";
        :>> title = "code-critique";
        :>> purpose = "Adversarial multi-lens BUG hunt of the deliverable SOURCE CODE by INDEPENDENT critics (data-integrity / security / concurrency / correctness): each runs in fresh context and tries to BREAK the code; findings are VERIFIED against the source before recording, filed as severity-carrying Issues (D0077, NOT method=critique verifications — the code is not a #Verify element), and each fixed with a fail-first regression. The recurring code-critique-round activity (round1/2/6 + R+1). Distinct from element-critique (model elements), architectural-critique (the engine), function-audit (per-function idiom). Deploys .engine/processes/code-critique.sysml.";
        :>> location = ".engine/skills/code-critique/SKILL.md";
        :>> triggerCondition = "Asked to critique / red-team / adversarially review the code, 'find bugs', 'where is this weak', 'another critique pass', or after a big change to a critical subsystem.";
        :>> writePolicy = WritePolicy::direct;
    }
}

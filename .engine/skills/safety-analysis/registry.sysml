// This skill's own registry declaration, beside the skill it describes (D0222). A project-authored skill.
package SkillsRegistrySafetyAnalysis {
    private import EngineElement::*;
    private import EngineSkills::*;

    part safetyAnalysis : AISkill {
        :>> id = "ec16023f-9ed2-48f7-81f6-091636c34dab";
        :>> title = "safety-analysis";
        :>> purpose = "Deploy the project's STPA process .engine/processes/stpa.sysml (D0053): Steps 1-4 of System-Theoretic Process Analysis via the engine's stpa SOP (losses, hazards, constraints; control structure; UCAs by the four guide words; loss scenarios + verified safety requirements), Step 5 reanalysis-on-change (D0017), Step 6 every hazard-bearing state is a client/src/fsm.ts machine registered on its STPA process model (fsm-conformance.test). The deploying skill for .engine/processes/stpa.sysml (D0059).";
        :>> location = ".engine/skills/safety-analysis/SKILL.md";
        :>> triggerCondition = "Safety-relevant scope opens, a state machine is added or changed, a controller/control action/feedback changes, or a field report names a loss.";
        :>> writePolicy = WritePolicy::direct;
    }
}

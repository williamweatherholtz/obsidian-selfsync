// This skill's own registry declaration, beside the skill it describes (D0222).
//
// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine
// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a
// move rather than a copy. A project-authored skill (not shipped by the engine).
package SkillsRegistryReleaseVersioningSkill {
    private import EngineElement::*;
    private import EngineSkills::*;

    part releaseVersioningSkill : AISkill {
        :>> id = "b50c45b8-d1ba-452d-a68e-06450228345b";
        :>> title = "release-versioning";
        :>> purpose = "Deploy the Release Versioning process (D0002): after a coherent set of shippable changes, classify the semver level (MAJOR breaking / MINOR new backward-compatible capability / PATCH fix-refactor-docs; highest wins; pre-1.0 0.MINOR.PATCH), verify tsc/build/tests green, bump via `node scripts/bump-version.mjs <level>` (the sole version-editing path across manifest.json + versions.json + client/package.json), then commit/tag/push (tag X.Y.Z triggers release.yml) and verify the published release. The deploying skill for .engine/processes/release-versioning.sysml.";
        :>> location = ".engine/skills/release-versioning/SKILL.md";
        :>> triggerCondition = "A coherent set of committed, green plugin changes is ready to ship / asked to cut a release, bump the version, or publish.";
        :>> writePolicy = WritePolicy::direct;
    }
}

// =====================================================================
// D0052 (PROJECT numbering) — record, as a Decision, what 1.9.0 already did: SelfSync no longer owns note
// timestamps, so the five embedded-timestamp SystemRequirements are SUPERSEDED. PROPOSED: a scope
// reduction is a Decision that supersedes the requirement (CLAUDE.md §2.4) and needs the owner's word;
// until accepted the five requirements and their acceptance Tests stand as they are.
// =====================================================================
package ProjectDecision0052 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0052 : Decision {
        :>> id = "8a695439-d229-48e9-86ce-8d40e2c5abd0";
        :>> title = "D0052: the embedded-timestamp requirements (srEmbeddedTimestamp, srNormalizedIdentity, srTimestampConflictResolve, srDriveFsTimes, srExcludedFolders) are superseded — timestampIgnoreRedesign (1.9.0) retired the model they specify";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::proposed;
        :>> context = "The 2026-07-29 sprint embeddedTimestampMetadata introduced SelfSync-OWNED embedded created/updated timestamps (seed, conform, backfill, stamp, drive the filesystem times, restore-detection) and five SystemRequirements for it, each with a Given/When/Then acceptance Test in .tracking/verification/acceptance.sysml. The 1.9.0 sprint timestampIgnoreRedesign then DELETED that model: SelfSync writes NO note timestamps (timestampBackfill.ts + fstimes.ts removed) and instead only IGNORES timestamp-valued frontmatter keys in content identity (value-shape gated, pattern matched) - its DoD passed and shipped. The requirements were never superseded: they still read as live contracts, their five acceptance Tests (acEmbeddedTimestamp, acNormalizedIdentity, acTimestampConflictResolve, acDriveFsTimes, acExcludedFolders) carry no verdict and can never earn one because the behaviour they specify no longer exists, and tier-satisfaction counts them among the unverified. The dodBackfillStamp census (2026-09-07) classified them MOOTED and named this Decision as the honest close. srNormalizedIdentity's INTENT (identity ignores managed timestamp fields) survives in a different form - the ignore-patterns feature - and is verified by the 1.9.0 and 1.30.x DoDs; the requirement as WRITTEN (managed by SelfSync-owned stamps) does not.";
        :>> decision = "Supersede the five SystemRequirements with this Decision (typed #Supersede edges below). They remain in the record as history; nothing is deleted. Their acceptance Tests stay as authored, unstamped, and stop counting as gaps once the requirements are superseded. The surviving behaviour - content identity masks user-declared timestamp-valued frontmatter keys, value-shape gated - is covered by the shipped and stamped timestampIgnoreRedesign, contentIdentityUnicodeNormalise and frontmatterTrailingSpaceIdentity DoDs and needs no new requirement text here; if the owner wants a fresh SR for the ignore-patterns feature, that is a separate authoring act.";
        :>> rationale = "CLAUDE.md §2.4: a 'we won't do X' is a first-class Decision that supersedes the need - scope is superseding Decisions, not deletion and not silence. Here the scope reduction actually happened (1.9.0, accepted in the sitting reviews), but only as a sprint; the requirements layer kept promising what the code stopped doing, which is the prose-vs-truth drift the engine exists to prevent. Recording the supersession makes the requirement tier truthful without touching the shipped code. ALTERNATIVES: (i) delete the five requirements and Tests - REJECTED, history is evidence and §2.4 says supersede; (ii) stamp the Tests 'fail' or 'inconclusive' - REJECTED, no run was performed and a verdict would be fabricated; (iii) leave as-is - REJECTED, it is exactly the latent debt project D0047 forbids. WHY PROPOSED: retiring requirements is the owner's call (D0016), even when the code already made it.";
        :>> consequences = "On acceptance: tier-satisfaction's SystemRequirement tier stops counting the five as unverified (150 live SRs); the five acceptance Tests remain unstamped by design and are excluded from the dodBackfillStamp owner list. Nothing changes in client/ or server/. REMOVAL PATH: a later Decision superseding this one re-activates the requirements. Accept with `keel accept d0052 --by wweatherholtz --note ... --date ...`.";
    }

    #Supersede dependency from d0052 to srEmbeddedTimestamp;
    #Supersede dependency from d0052 to srNormalizedIdentity;
    #Supersede dependency from d0052 to srTimestampConflictResolve;
    #Supersede dependency from d0052 to srDriveFsTimes;
    #Supersede dependency from d0052 to srExcludedFolders;
}

// =====================================================================
// ProjectAcceptance — the requirement-verification traceability layer (CR d0011, 2026-07-05).
// Before this, tier-satisfaction showed SR-verified-by-Test at 0/15: the 125 automated tests
// were entirely divorced from the requirements model, so nothing enforced that a requirement
// had a behavioral test — which is how the multi-device config divergence/removal defects
// (0.10.4) shipped untested. This package authors the `#Verify` edges (Test -> SystemRequirement)
// that were missing: existing SRs are verified by their existing delivery DoD Tests; the four
// new config-sync SRs get explicit Given/When/Then ACCEPTANCE scenarios (the two that would have
// caught the escape are called out), backed by the reconcile suite green at the 0.10.4 fix commit.
// =====================================================================
package ProjectAcceptance {
    private import EngineElement::*;
    private import EngineVerification::*;
    private import ProjectRequirements::*;
    private import ProjectDelivery::*;
    private import ProjectUseCases::*;

    // ---- new config-sync acceptance scenarios (BDD) ----
    verification acConfigSelective : Test {
        :>> id = "c0f1a5cc-3001-4a10-9b20-a1b2c3d40021"; :>> method = VerificationMethod::test;
        :>> location = "client/test/configsync.test.ts";
        :>> procedureText = "GIVEN config sync with a per-category selection WHEN shouldSync classifies a path THEN notes always sync, each .obsidian category syncs only when opted in, unrecognized .obsidian files never sync, and SelfSync's own/legacy plugin folder never syncs — the 32-combo matrix + the e2e per-dial + own-folder tests are green.";
    }
    verification acConfigAdditiveSafe : Test {
        :>> id = "c0f1a5cc-3002-4a10-9b20-a1b2c3d40022"; :>> method = VerificationMethod::test;
        :>> location = "client/test/reconcile.test.ts";
        :>> procedureText = "SCENARIO (would have caught the data loss): GIVEN device A has a plugin and device B never installed it WHEN both sync THEN B receives it and it is never removed from A; AND a filtered/never-held path records no base and can never manufacture a delete-remote. Reconcile tests 'accepts=false skipped entirely', 'no phantom delete', and 'additive pull' are green.";
    }
    verification acConfigAdjudication : Test {
        :>> id = "c0f1a5cc-3003-4a10-9b20-a1b2c3d40023"; :>> method = VerificationMethod::test;
        :>> location = "client/test/reconcile.test.ts";
        :>> procedureText = "SCENARIO (would have caught the crash): GIVEN two devices with different community-plugins.json WHEN they sync THEN neither list is overwritten, NO note-style conflict copy is created, and the difference is queued for user adjudication; AND a removal is neither auto-deleted nor auto-resurrected. Reconcile tests 'divergence -> adjudicate, no crash/no garbage copy', 'removal -> adjudicate not delete/resurrect', and the resolveConfigConflict local/remote cases are green.";
    }
    verification acSyncRobust : Test {
        :>> id = "c0f1a5cc-3004-4a10-9b20-a1b2c3d40024"; :>> method = VerificationMethod::test;
        :>> location = "client/test/reconcile.test.ts";
        :>> procedureText = "GIVEN one file throws during reconcile WHEN reconcileAll runs THEN that file's error is reported and skipped and every other file still syncs — the 'per-file isolation' reconcile test is green.";
    }
    verification acFreeMerge : Test {
        :>> id = "c0f1a5cc-3005-4a10-9b20-a1b2c3d40025"; :>> method = VerificationMethod::inspect;
        :>> procedureText = "Inspected: neither the plugin nor the server contains a licence/payment/sponsorship gate on any sync, conflict, or merge capability — all reconciliation is available to every user.";
    }

    part acConfigSelectiveR1 : TestResult { :>> id = "c0f1a5cc-4001-4a10-9b20-a1b2c3d40031"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acConfigAdditiveSafeR1 : TestResult { :>> id = "c0f1a5cc-4002-4a10-9b20-a1b2c3d40032"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acConfigAdjudicationR1 : TestResult { :>> id = "c0f1a5cc-4003-4a10-9b20-a1b2c3d40033"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acSyncRobustR1 : TestResult { :>> id = "c0f1a5cc-4004-4a10-9b20-a1b2c3d40034"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acFreeMergeR1 : TestResult { :>> id = "c0f1a5cc-4005-4a10-9b20-a1b2c3d40035"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }

    // ---- #Verify edges: Test -> SystemRequirement (the previously-missing traceability) ----
    // new config SRs
    #Verify dependency from acConfigSelective to srConfigSelective;
    #Verify dependency from acConfigAdditiveSafe to srConfigAdditiveSafe;
    #Verify dependency from acConfigAdjudication to srConfigAdjudication;
    #Verify dependency from acSyncRobust to srSyncRobust;
    #Verify dependency from acFreeMerge to srFreeMerge;
    // existing SRs verified by their existing delivery DoD Tests
    #Verify dependency from goal1ConfigUxDoD to srClearConfig;
    #Verify dependency from goal1ConfigUxDoD to srGuidedWizard;
    #Verify dependency from goal1ConfigUxDoD to srSettingsOneHome;
    #Verify dependency from rel06FixSetDoD to srSingleIndicator;
    #Verify dependency from m1ProtocolDoD to srSimpleBackend;
    #Verify dependency from m2ChunkingBinaryDoD to srSingleBinary;
    #Verify dependency from m2ChunkingBinaryDoD to srContentDedup;
    #Verify dependency from b11ParallelChunkDoD to srConcurrentPerf;
    #Verify dependency from m3ConflictMergeDoD to srConflictMerge;
    #Verify dependency from m3ConflictMergeDoD to srThreeWayMerge;
    #Verify dependency from m3ConflictMergeDoD to srNeverClobber;
    #Verify dependency from m5MobileDoD to srMobile;
    #Verify dependency from b7AuthHardeningDoD to srSecurity;
    #Verify dependency from vaultSharingP1DoD to srVaultSharing;
    // validation (D0006): the escape-reproducing scenarios validate their use cases too
    #Verify dependency from acConfigAdjudication to ucResolveConfigDifference;
    #Verify dependency from acConfigAdditiveSafe to ucRemoveOrKeepPlugin;
    #Verify dependency from acConfigAdditiveSafe to ucSyncSetupAcrossDevices;
}

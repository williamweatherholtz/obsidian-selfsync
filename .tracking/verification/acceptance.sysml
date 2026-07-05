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
        :>> procedureText = "GIVEN device A has a plugin and device B never installed it WHEN both sync THEN B receives it (defer to data) and it is never removed from A; AND a filtered/never-held path records no base and can never manufacture a deletion; AND a genuine removal from a device that HELD the file propagates (auto-remove, D0013) while a removed file is never auto-pulled-back. Reconcile tests 'accepts=false skipped entirely', 'no phantom delete', 'additive pull', and 'removal -> PROPAGATES' (both directions) are green.";
    }
    verification acConfigAdjudication : Test {
        :>> id = "c0f1a5cc-3003-4a10-9b20-a1b2c3d40023"; :>> method = VerificationMethod::test;
        :>> location = "client/test/reconcile.test.ts";
        :>> procedureText = "SCENARIO (would have caught the crash): GIVEN two devices with different community-plugins.json WHEN they sync THEN neither list is overwritten, NO note-style conflict copy is created, and the SAME-FILE difference is queued for user adjudication. Reconcile tests 'divergence -> adjudicate, no crash/no garbage copy' and the resolveConfigConflict local/remote cases are green. (Removals propagate, not adjudicate — see acConfigAdditiveSafe.)";
    }
    verification acConfigLiveDetect : Test {
        :>> id = "c0f1a5cc-3006-4a10-9b20-a1b2c3d40026"; :>> method = VerificationMethod::inspect;
        :>> location = "client/src/main.ts";
        :>> procedureText = "Inspected: the plugin registers vault.on('raw', ...) (feature-detected) and, for in-scope .obsidian/ paths, debounces the event burst (600ms), suppresses the echo of its own writes/removes (markConfigSelfWrite, 4s window), and reconciles the changed paths via reconcilePath — so a config change syncs promptly (event-driven) on desktop. onRemoteChanged's periodic full reconcile remains the mobile fallback + safety net (Obsidian mobile does not fire 'raw' reliably for hidden files). On-device latency confirmed under L4.";
    }
    verification acSyncRobust : Test {
        :>> id = "c0f1a5cc-3004-4a10-9b20-a1b2c3d40024"; :>> method = VerificationMethod::test;
        :>> location = "client/test/reconcile.test.ts";
        :>> procedureText = "GIVEN one file throws during reconcile WHEN reconcileAll runs THEN that file's error is reported and skipped and every other file still syncs — the 'per-file isolation' reconcile test is green.";
    }
    // ── Batch 1: continuous-sync reliability ──
    verification acServerApi : Test {
        :>> id = "c0f1a5cc-3211-4a10-9b20-a1b2c3d40211"; :>> method = VerificationMethod::test;
        :>> location = "client/test/e2e.spec.ts";
        :>> procedureText = "e2e (real server) exercises the health ping, login, create + list vault, and changes/commit/get across two clients; server cargo tests cover put/delete-chunk + argon2id auth — green.";
    }
    verification acInstantPush : Test {
        :>> id = "c0f1a5cc-3212-4a10-9b20-a1b2c3d40212"; :>> method = VerificationMethod::inspect;
        :>> location = "server/src/ws.rs";
        :>> procedureText = "Inspected: the server broadcasts a change notification on commit over the WebSocket channel and the client subscribes and reconciles on notify, so a remote change reflects near-real-time rather than only on the next poll.";
    }
    verification acIncrementalSync : Test {
        :>> id = "c0f1a5cc-3213-4a10-9b20-a1b2c3d40213"; :>> method = VerificationMethod::test;
        :>> location = "client/test/e2e.spec.ts";
        :>> procedureText = "e2e sequential edits each propagate in order via the version-cursor incremental path (changes(since=version)); an idle poll with no server advance does the cheap check only — green.";
    }
    verification acSelfHealingReconnect : Test {
        :>> id = "c0f1a5cc-3214-4a10-9b20-a1b2c3d40214"; :>> method = VerificationMethod::inspect;
        :>> location = "client/src/main.ts";
        :>> procedureText = "Inspected: reconnect() is single-flight (connecting guard), backs off on failure, restarts polling + WS on success, and ceases after unload; a failed poll hands off to scheduleReconnect.";
    }
    // ── Batch 2: data-safety + durability ──
    verification acDegradedServerGuard : Test {
        :>> id = "c0f1a5cc-3215-4a10-9b20-a1b2c3d40215"; :>> method = VerificationMethod::test;
        :>> location = "client/test/reconcile.test.ts";
        :>> procedureText = "Reconcile tests: C2 refuses bulk delete-local when the server manifest is empty but base is non-empty (batch + event paths), and still honors a legit delete-local when the server has other files; e2e 'deleting the LAST file leaves the peer's copy intact' — green.";
    }
    verification acDurableIndex : Test {
        :>> id = "c0f1a5cc-3216-4a10-9b20-a1b2c3d40216"; :>> method = VerificationMethod::test;
        :>> location = "server/src/vault.rs";
        :>> procedureText = "Server tests: commits/deletes append absolute journal records; replay reconstructs on reopen; a torn trailing record is discarded; a malformed complete record errors; chunk-refs recompute from files; compaction snapshots + truncates — green.";
    }
    // ── Batch 3: large-file performance ──
    verification acStreamedTransfer : Test {
        :>> id = "c0f1a5cc-3217-4a10-9b20-a1b2c3d40217"; :>> method = VerificationMethod::test;
        :>> location = "client/test/reconcile.test.ts";
        :>> procedureText = "Reconcile + e2e: a >=8MiB download streams to disk (base hash-only) and bypasses the buffered size gate; without an appendWrite io it's skipped; a too-large file fires onSkip once; e2e large binary (~4MB) syncs byte-identical + dedups a copy; mapPool bounds parallel transfer — green.";
    }
    verification acResumableInitialSync : Test {
        :>> id = "c0f1a5cc-3218-4a10-9b20-a1b2c3d40218"; :>> method = VerificationMethod::inspect;
        :>> location = "client/src/reconcile.ts";
        :>> procedureText = "Inspected: reconcile is idempotent (base + chunk cache mean already-written files are in-sync and not re-fetched) and uploads negotiate missing chunks, so an interrupted sync continues on the next reconcile rather than restarting. On-device initial-sync resume under load is confirmed at L4.";
    }
    // ── Batch 4: vault management + onboarding ──
    verification acVaultSwitch : Test {
        :>> id = "c0f1a5cc-3219-4a10-9b20-a1b2c3d40219"; :>> method = VerificationMethod::test;
        :>> location = "client/test/reconcile.test.ts";
        :>> procedureText = "switchTo tests: download (target wins, drops local-only, resets stale base), upload (local wins, drops target-only), merge (union, conflict-copies divergence, nothing lost), and download-into-empty (auto). Config exclusion holds (io.list is filtered) — green.";
    }
    verification acSetupLink : Test {
        :>> id = "c0f1a5cc-3220-4a10-9b20-a1b2c3d40220"; :>> method = VerificationMethod::test;
        :>> location = "client/test/connstr.test.ts";
        :>> procedureText = "connstr tests: encode/parse round-trips server+user (+optional vault), preserves scheme/port, canonicalizes default ports, and the encoded link contains NO password/secret; invalid links are rejected — green.";
    }
    verification acDeviceIdentity : Test {
        :>> id = "c0f1a5cc-3221-4a10-9b20-a1b2c3d40221"; :>> method = VerificationMethod::inspect;
        :>> location = "client/src/main.ts";
        :>> procedureText = "Inspected: autoDeviceName() derives a name from the platform (Android UA model, else iPhone/iPad/Mac/Windows/Linux), deviceLabel() = configured name || auto, shown as muted placeholder in settings and used in conflictCopyName().";
    }
    verification acFreeMerge : Test {
        :>> id = "c0f1a5cc-3005-4a10-9b20-a1b2c3d40025"; :>> method = VerificationMethod::inspect;
        :>> procedureText = "Inspected: neither the plugin nor the server contains a licence/payment/sponsorship gate on any sync, conflict, or merge capability — all reconciliation is available to every user.";
    }

    part acConfigSelectiveR1 : TestResult { :>> id = "c0f1a5cc-4001-4a10-9b20-a1b2c3d40031"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acConfigAdditiveSafeR1 : TestResult { :>> id = "c0f1a5cc-4002-4a10-9b20-a1b2c3d40032"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "af8b722"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acConfigAdjudicationR1 : TestResult { :>> id = "c0f1a5cc-4003-4a10-9b20-a1b2c3d40033"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "af8b722"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acSyncRobustR1 : TestResult { :>> id = "c0f1a5cc-4004-4a10-9b20-a1b2c3d40034"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acFreeMergeR1 : TestResult { :>> id = "c0f1a5cc-4005-4a10-9b20-a1b2c3d40035"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acConfigLiveDetectR1 : TestResult { :>> id = "c0f1a5cc-4006-4a10-9b20-a1b2c3d40036"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "d6c0325"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acServerApiR1 : TestResult { :>> id = "c0f1a5cc-4211-4a10-9b20-a1b2c3d40311"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acInstantPushR1 : TestResult { :>> id = "c0f1a5cc-4212-4a10-9b20-a1b2c3d40312"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acIncrementalSyncR1 : TestResult { :>> id = "c0f1a5cc-4213-4a10-9b20-a1b2c3d40313"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acSelfHealingReconnectR1 : TestResult { :>> id = "c0f1a5cc-4214-4a10-9b20-a1b2c3d40314"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acDegradedServerGuardR1 : TestResult { :>> id = "c0f1a5cc-4215-4a10-9b20-a1b2c3d40315"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acDurableIndexR1 : TestResult { :>> id = "c0f1a5cc-4216-4a10-9b20-a1b2c3d40316"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acStreamedTransferR1 : TestResult { :>> id = "c0f1a5cc-4217-4a10-9b20-a1b2c3d40317"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acResumableInitialSyncR1 : TestResult { :>> id = "c0f1a5cc-4218-4a10-9b20-a1b2c3d40318"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acVaultSwitchR1 : TestResult { :>> id = "c0f1a5cc-4219-4a10-9b20-a1b2c3d40319"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acSetupLinkR1 : TestResult { :>> id = "c0f1a5cc-4220-4a10-9b20-a1b2c3d40320"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    part acDeviceIdentityR1 : TestResult { :>> id = "c0f1a5cc-4221-4a10-9b20-a1b2c3d40321"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "5364968"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }

    // ---- #Verify edges: Test -> SystemRequirement (the previously-missing traceability) ----
    // new config SRs
    #Verify dependency from acConfigSelective to srConfigSelective;
    #Verify dependency from acConfigAdditiveSafe to srConfigAdditiveSafe;
    #Verify dependency from acConfigAdjudication to srConfigAdjudication;
    #Verify dependency from acSyncRobust to srSyncRobust;
    #Verify dependency from acConfigLiveDetect to srConfigLiveDetect;
    #Verify dependency from acFreeMerge to srFreeMerge;
    // Batch 1 — continuous-sync reliability
    #Verify dependency from acServerApi to srServerApi;
    #Verify dependency from acInstantPush to srInstantPush;
    #Verify dependency from acIncrementalSync to srIncrementalSync;
    #Verify dependency from acSelfHealingReconnect to srSelfHealingReconnect;
    // Batch 2 — data-safety + durability
    #Verify dependency from acDegradedServerGuard to srDegradedServerGuard;
    #Verify dependency from acDurableIndex to srDurableIndex;
    // Batch 3 — large-file performance
    #Verify dependency from acStreamedTransfer to srStreamedTransfer;
    #Verify dependency from acResumableInitialSync to srResumableInitialSync;
    // Batch 4 — vault management + onboarding
    #Verify dependency from acVaultSwitch to srVaultSwitch;
    #Verify dependency from acSetupLink to srSetupLink;
    #Verify dependency from acDeviceIdentity to srDeviceIdentity;
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

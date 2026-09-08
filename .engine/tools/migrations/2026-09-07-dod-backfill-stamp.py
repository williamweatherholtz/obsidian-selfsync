#!/usr/bin/env python3
"""Backfill the verdicts on DoDs that shipped without one (dodBackfillStamp / issueHistoricalDoDsUnstamped).

A census on 2026-09-07 found 103 delivery DoDs (80 method=test) plus 5 acceptance Tests with NO TestResult
although their prose read DONE. This transform is the D0067 backfill-with-recorded-basis for that set:

  REPRO     method=test DoDs whose criterion is "the suites are green (+ these named tests exist)". The
            named artifacts were checked to exist at HEAD (dod_classify census) and the WHOLE deliverable
            gate was actually run at HEAD 468027ac (receipt below). Each is stamped pass with that receipt.
  INSPECT   method=inspect DoDs whose claims are code/config facts. Each fact was RE-INSPECTED at HEAD
            today (the grep is in the evidence) and stamped pass only where every fact held.
  OWNER     confirmation / demo / critique DoDs, and open work: NOT stamped. The evidence would be a
            human's word or a hardware run; they are listed for the owner (D0016/D0051).
  MOOTED    the five embedded-timestamp acceptance Tests: their SystemRequirements were retired by
            timestampIgnoreRedesign (1.9.0) but never superseded by a Decision, so no verdict is
            recordable; listed for the owner's superseding Decision.
  PENDING   perfHarnessScaleLatencyDoD (stamped by its own `npm run test:perf` run, separately) and
            b11ParallelChunkDoD (a wall-clock comparison nobody can re-run today).

Never fabricates: nothing is stamped whose criterion did not hold in a run performed today. Idempotent:
a DoD that already carries a TestResult is skipped. Dry-run by default; --apply writes through
`keel append-result` (the sanctioned write path). Control totals print at the end and must reconcile:
census = stamped + owner + mooted + pending.

Usage:  python 2026-09-07-dod-backfill-stamp.py [REPO_ROOT] [--apply]
"""
from __future__ import annotations
import io, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SHA, DATE, BY = "468027ac", "2026-09-07", "claudeOpus"
DELIVERY = ".tracking/delivery/delivery.sysml"

GATE = ("RAN 2026-09-07 at HEAD 468027ac (clean tree): cd server && cargo test --locked -> 9 suites ok "
        "(153+34+21+10+8+5+2+1 tests, 0 failed); cargo clippy --all-targets --locked -- -D warnings -> clean; "
        "cd client && npx tsc --noEmit && npm run build -> ok; npx vitest run -> 53 files passed / 1 skipped "
        "(config-permutations standalone matrix, SELFSYNC_PERM unset), 882 tests passed / 2 skipped, 89.4s, with the "
        "real-server integration + sharing e2e specs RUNNING (server/target/debug/selfsync-server.exe present); "
        "npx tsc -p tsconfig.e2e.json -> ok. Backfill basis: this DoD's criterion is the suites green")

# REPRO: (task, extra evidence). The extra names the artifacts the DoD cites that were checked to exist at HEAD.
REPRO = {
 "m1Protocol": "protocol suites (sync/ws) in the server run + client e2e.spec two-client propagation",
 "m2ChunkingBinary": "chunker tests + e2e binary round-trip in the client run",
 "m3ConflictMerge": "merge/reconcile tests in the client run",
 "m4MultiTenant": "per-vault isolation tests in the server admin/sync suites",
 "goal1ConfigUx": "configsync tests + the config-sync permutation matrix (e2e path) in the client run",
 "rel06FixSet": "client suite + tsc + build",
 "b7AuthHardening": "server auth tests (argon2, tokens, must_change) + client transport tests",
 "b9DurabilityStreaming": "server journal/streaming tests (acDurableIndex basis)",
 "streamingReassembly": "client streaming tests (streamhash, streamFileToDisk)",
 "vaultSharingP1": "server sharing suite (5) + admin suite + client sharelink tests",
 "configSyncSafety": "client reconcile config-sync tests",
 "critiqueClientWave": "client suite",
 "capabilityShareLinks": "sharelinks.rs create_then_redeem_once_binds_and_consumes, expired_and_unknown_and_revoked_links_do_not_redeem, list_is_owner_scoped_and_survives_reopen (present at HEAD)",
 "hfStatusSurfacingAndPreview": "plugin-wiring statusDisplay cases",
 "hfConfirmAndSidePicking": "modals-ui.dom",
 "hfStatusAndWarnings": "syncstate tests",
 "statusDetailAndResuming": "plugin-wiring statusDisplay cases",
 "adoptServerPlugins": "reconcile community-plugin-ids test",
 "pendingExcludesDeclined": "reconcile pending tests",
 "configSyncPerPluginDirection": "configgroup tests",
 "configSyncFirstContactDirection": "configgroup configSurfaceOf",
 "configSyncEventDriven": "plugin-wiring css-change event test",
 "fastCheapConfigScan": "reconcile config-scan fast-path test",
 "connErrorAbortsPass": "reconcile connection-failure-aborts-the-pass test",
 "conflictReadOnlyAndBinaryCorrectness": "reconcile + sharelink fail-closed tests",
 "shareRefreshedOnConnect": "sharelink.test resolveShareGrant",
 "conflictModelDerivedFromVault": "reconcile originalOfConflictCopy + modals-ui.dom",
 "pendingProgressAndConflictResilience": "syncstate + reconcile onProgress tests",
 "conflictModalFixAndSyncProgress": "modals-ui.dom conflict + settings-ui.dom",
 "falseEolConflictFixAndDiff": "reconcile.test sameIgnoringEol",
 "granteeLeaveShare": "server DELETE /api/shared tests + client",
 "settingsPanelTargetedCleanup": "settings-ui.dom + modals-ui.dom",
 "redeemE2ECoverage": "sharing-e2e.spec (2 tests) RAN against the real server binary in this run",
 "guidedRedeemViaSetup": "sharelink redeemTargetError cases",
 "redeemNotSetUpGuardAndDirect": "sharelink.test redeemTargetError",
 "shareLinkUrlParseFix": "sharelink + connstr parse tests",
 "shareCurrentVaultOnly": "modals-ui.dom share modal test",
 "shareUxAndCaseInsensitiveNames": "transport errText + sharing tests",
 "usernameRuleAndUx": "sync.rs userstore_register_verify_persist",
 "skipOsJunkFiles": "configsync.test isJunkFile/shouldSync",
 "critResidual2": "syncstate isWsStale + server admin suite (require_admin ClientIp)",
 "critResidualEasy": "users.rs totp_code_cannot_be_replayed_within_its_window",
 "critRoundCmmc": "admin.rs require_admin_mfa_blocks_admin_until_totp_enrolled",
 "critRoundStd": "reconcile.test delta-tombstone / unreadable-file cases",
 "uiFunctionalAudit": "admin.rs must_change_account_is_blocked_until_password_set_then_works, admin_grant_and_revoke_toggles_admin_access, admin_deletes_an_account, admin_reindex_and_prune_history_http_ok, admin_invite_list_and_delete; syncstate/wizardsteps/plugin-wiring cases (present at HEAD)",
 "cmmcMfa": "server MFA tests (mfa_totp_full_lifecycle)",
 "cmmcForcedChangeReuse": "server must_change + password-reuse tests",
 "critiqueServerHardening": "server hardening tests incl. WS token via subprotocol",
 "round1CriticFixes": "client + server suites",
 "round2CriticFixes": "client + server suites",
 "fsmRefactor": "client engine suite (syncengine)",
 "pluginShareOptIn": "client configsync suite",
 "round5CriticFixes": "vault.rs commit_rejects_unicode_case_collision_and_delete_evicts_legacy_key; revoke-before-purge in the admin suite",
 "round5CompletenessFollowups": "server lib + integration + e2e, client reconcile + plugin-wiring",
 "round4CriticFixes": "client + server suites",
 "round3CriticFixes": "client + server suites",
 "round7RecoveryFixes": "reindex_recovers_from_store_and_force_drops_truly_lost (present at HEAD)",
 "resourceScaleFixes": "server integration + client RS-4 base-cap test",
 "incrementalReconcile": "reconcile incremental/mass-tombstone tests",
 "sqliteMigration": "index_store.rs (SQLite, WAL, migration) + its tests (mutationTestingIndexChunkstore pass)",
 "deletedVaultRecreatePrompt": "plugin-wiring test",
 "historyRebase": "server history-floor tests + client onKeptAbsent",
 "tombstonePrune": "admin_reindex_and_prune_history_http_ok + history-floor tests",
 "round6CriticFixes": "server lib + integration, client unit + e2e",
 "preReleaseHardening": "commit_cas_rejects_stale_expected_version + client CAS/reactive-401 tests",
 "deleteLocalTombstoneGate": "client reconcile tombstone-gate tests",
 # promoted from review after reading each text against the tree:
 "shareClientConsume": "sharing-e2e.spec (shared-vault sync end to end) + acReadOnlyGating basis",
 "shareRedeemStoreConsistency": "grant_rolls_back_in_memory_when_save_fails, self_redeem_does_not_burn_the_link, share_link_owner_scoped_and_revoke_blocks_redeem (present)",
 "shareLinkRedeemConsumeLast": "unredeem_rolls_back_a_claim_so_a_failed_grant_does_not_burn_the_link (present)",
 "wizardForcedPasswordChange": "modals-ui.dom 'a must-change account is prompted for a new password before any other call' (present)",
 "vaultNameAndSizeLimits": "commit_over_size_limit_is_rejected + wizardsteps.test isValidVaultName/sanitizeVaultName (present)",
 "autoReindex": "empty_index_with_data_auto_repairs, reindex_recovers_from_store_and_force_drops_truly_lost, reindex_routes_a_bitrotted_recovered_file_to_lost_not_corruption, admin_reindex_and_prune_history_http_ok (present)",
 "adminSplitDeploy": "default_admin_bind + admin router integration tests (present)",
 "adminPortalEnhancements": "admin_grant_and_revoke_toggles_admin_access, admin_deletes_an_account (present)",
 "scaleHardening": "umbrella over RS-1..7; resolved by sqliteMigration/resourceScaleFixes/incrementalReconcile, all in the same green run",
 "round1DeferredHardening": "SEC#4 runtime_orphan_sweep_runs_on_upload_but_spares_inflight_chunks, DI#4 reindex_prefers_store_over_stale_mirror_when_healthy, CONC#5 pendingSwitch cases in plugin-wiring.test (present)",
}

# INSPECT: (task, what was re-inspected today and held)
INSPECT = {
 "m5Mobile": "manifest.json isDesktopOnly:false; client/src/transport.ts uses requestUrl (4 sites); chunker.ts + streamhash.ts use crypto.subtle (WebCrypto), no desktop-only deps",
 "m6Packaging": "node scripts/check-release.mjs -> '1.30.7 is released - git tag + GitHub release with main.js, manifest.json, styles.css present' (today); release.yml fires on the manifest.json bump and publishes the BRAT assets; deploy/docker-compose.yml + Caddy reverse-proxy example present",
 "surfaceSharingAndConflicts": "main.ts addCommand ids present: setup, switch-vault, redeem, resolve-conflicts, status, show-log, clear-log, reconnect",
 "pluginAdoptionRestartHint": "settings.ts:872 needsRestart = syncedIds adopted AND not installed; :874 warning banner counting them; :881 'Checking the server for plugins...' placeholder when the server list is not yet reported",
 "guardDestructiveActions": "vaultswitch.ts gates fork-over-existing (:113), leave-shared (:126) and the destructive switch modes (:182) behind confirmModal; settings.ts:378 Sign out behind confirmModal - the window.confirm() of 1.3.2 became the in-app confirm modal (confirm.dom.test green in the same run)",
 "uxPolishBundle": "noteconflict.ts button 'Keep the other device's' (1 site); 'fully close and reopen Obsidian' wording in main.ts (4) + settings.ts (1); 'SelfSync: '-prefixed notices (accountui.ts)",
 "forkVault": "main.ts:1328 forkVault(name) = createRemoteVault(name) then switchToVault(name, 'upload', '', false); vaultswitch.ts 'Fork over an existing vault?' guard at :113",
 "editorStatusCleanupOnUnload": "main.ts onunload() at :591 removes every editorActionEls element and clears the set (:599-600)",
 "deployComposeHardening": "deploy/docker-compose.yml: image ghcr.io/williamweatherholtz/obsidian-selfsync-server:latest (no build:), healthcheck present, caddy:2 proxy; the server-image publish job now lives in .github/workflows/server-image.yml and ran green on d0ac3d66 today",
}

OWNER = {
 "scanSkipBoundaryPin": "PART 2 is the owner's acceptRisk attestation",
 "engineVintageResync": "awaits `keel accept d0050`",
 "lockfilePolicy": "owner policy decision",
 "keelDispositionLensReport": "upstream filing - owner decides the channel",
 "dodBackfillStamp": "this task; stamped when the totals reconcile",
 "l3GuiPass": "manual pass in real Obsidian (demo)",
 "l4MobileOndevice": "on-device mobile run (demo)",
 "perfDevicePass": "real-device fidelity pass (demo)",
 "deferUxEnhancements": "confirmation - the record says the owner reviewed on 2026-07-11; only the owner can stamp it",
 "acceptOpenEnumRisk": "confirmation - owner accepted 2026-07-11 per the record; only the owner can stamp it",
 "acceptMobileFsyncRisk": "confirmation - owner accepted 2026-07-11 per the record; only the owner can stamp it",
 "critiqueR8Fixes": "method=critique - an independent critic's verdict, not the implementer's",
 "stpaSafetyAnalysis": "analyze - closes after the sr11/sr16/sr19 links and the D0017 mechanism",
 "stpaSuspicionPropagation": "keel-toolkit change",
 "sittingReview20260807b": "per-sitting human review - the owner's",
 "settingsGroupingPolish": "inspect - a design-quality judgment ('reads sensibly'); the structure was re-inspected today but the judgment is the owner's",
}
MOOTED = ["acEmbeddedTimestamp", "acNormalizedIdentity", "acTimestampConflictResolve", "acDriveFsTimes", "acExcludedFolders"]
PENDING = {
 "perfHarnessScaleLatency": "stamped separately with its own `npm run test:perf` receipt (3 files / 9 tests green, 63s, scale + latency tables produced)",
 "b11ParallelChunk": "sequential-vs-parallel wall-clock comparison; not re-runnable today",
 "requirementTraceabilityBackfill": "its claim 'every SystemRequirement carries a #Verify edge' held for the 19 SRs of its day; at HEAD tier-satisfaction reads 101/155 SRs verified - 54 later-added compliance SRs (the sr_3_10_x family and others) carry no Test, so a pass judged at HEAD would be false. The gap is the tier-satisfaction burndown, honest and non-blocking (D0098)",
}


def main(argv):
    apply = "--apply" in argv
    roots = [a for a in argv[1:] if not a.startswith("--")]
    root = os.path.abspath(roots[0]) if roots else ROOT
    d = io.open(os.path.join(root, DELIVERY), encoding="utf-8").read()
    def stamped(task): return re.search(r"part " + task + r"DoDR\d+ : TestResult", d) is not None
    def exists(task): return re.search(r"verification " + task + r"DoD : Test", d) is not None
    n_stamp = n_skip = 0
    for cls, table in (("REPRO", REPRO), ("INSPECT", INSPECT)):
        for task, extra in table.items():
            assert exists(task), f"no DoD for {task}"
            if stamped(task):
                n_skip += 1; continue
            ev = (GATE + "; " + extra) if cls == "REPRO" else ("RE-INSPECTED 2026-09-07 at HEAD 468027ac: " + extra)
            cmd = ["keel", "append-result", "--file", DELIVERY, "--task", task, "--sha", SHA, "--verdict", "pass",
                   "--judged-by", BY, "--judged-at", DATE, "--evidence", ev]
            print(f"  {cls:7} {task}")
            if apply:
                r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, encoding="utf-8")
                if r.returncode != 0:
                    print(r.stdout, r.stderr); raise SystemExit(f"append-result failed for {task}")
            n_stamp += 1
    print(f"\nstamped={n_stamp} already={n_skip} owner={len(OWNER)} mooted={len(MOOTED)} pending={len(PENDING)}"
          f"  total accounted={n_stamp + n_skip + len(OWNER) + len(MOOTED) + len(PENDING)}" + ("" if apply else "  (dry-run)"))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))

// =====================================================================
// ProjectStpaAuthorities — STPA Steps 3-4 over the plugin's actions in the environment of the four authorities the
// 2026-09-09 Step 1 refresh named NEW: the HOST APP, OTHER PLUGINS, OTHER SYNC TOOLS, the RELEASE CHANNEL
// (authored 2026-09-10, owner: "continue with step 2"). Step 2 for them (c12-c15, pmHost, their control actions and
// feedback) lives in control-structure.sysml. These authorities are ENVIRONMENT controllers: the plugin cannot
// command them, so each UCA here is a PLUGIN action (or a release-channel action we operate ourselves) analysed
// in the context of what that authority does. Every scenario but one is a recorded finding with its closing
// mechanism named; S-39 is PROJECTED and marks the one un-mitigated cell (with S-38's release-side twin UCA-57):
// both are filed as Issues with OPEN resolver tasks (syncToolCoexistence, releaseAssetIntegrity) rather than
// left as prose. Requirements already on the books that mitigate a new UCA get an edge, not a duplicate.
// =====================================================================
package ProjectStpaAuthorities {
    private import EngineElement::*;
    private import EngineSafety::*;
    private import ProjectSafety::*;
    private import ProjectHazards::*;
    private import ProjectControlStructure::*;
    private import ProjectStpaAnalysis::*;      // sr2, sr5, sr15, sr23, sr28 - existing mitigations edged, not duplicated
    private import ProjectStpaNesting::*;       // uca41 (accepted move-out) is mitigated by sr62 below


    part uca46 : UnsafeControlAction {
        :>> id = "141e5329-ba2a-4878-b611-adb0834c271a"; :>> ucaType = UcaType::wrongTimingOrder;
        :>> title = "UCA-46: the plugin keeps acting (timers, sockets, listeners, deferred effects) after the host unloaded it - for an update, two instances act on one vault";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "BRAT disables and re-enables the plugin (update) or the user reloads; an operation, a backoff timer, a mount poke or a WebSocket callback is in flight.";
        :>> statement = "Dispatch-reconcile and its deferred effects are provided by a torn-down instance: a leaked timer or socket of the OLD instance repaints, reconciles or writes beside the NEW one - two writers of one vault, and orphaned UI. Found: engineFsmOnPrimitive (UCA-26), editorStatusCleanupOnUnload, pluginWiringTimerLeakFix. [H-13, H-9]";
    }
    part cc44 : ControllerConstraint { :>> id = "2199e9e8-0cc3-4ad2-97b4-380cc59d271c"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-44: everything an instance owns dies with it";
        :>> statement = "onunload tears down every timer, socket, DOM element and listener the instance registered; every deferred callback re-checks `unloading` (and that its socket is still the current one) before acting; the engine's `unloading` is terminal."; }

    part uca47 : UnsafeControlAction {
        :>> id = "16b961f2-67a4-4ad8-b123-379cb7359c10"; :>> ucaType = UcaType::notProvided;
        :>> title = "UCA-47: recovery is not re-attempted after the host suspended the plugin (mobile background)";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "The app was backgrounded on mobile while disconnected; the host paused the backoff timer; on resume the engine dropped the `remote` event because it was not connected.";
        :>> statement = "Establish-connection NOT provided on resume, so a recoverable link stays down with nothing indicating a recheck. Found 2026-08-02 in the field (resumeReattemptsConnection). [H-10]";
    }
    part cc45 : ControllerConstraint { :>> id = "ef88b70a-50e1-427d-97f4-fea0b7e5572c"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-45: resume re-arms recovery";
        :>> statement = "On visibilitychange to visible, a disconnected engine cancels the paused backoff and re-attempts NOW, logging the recheck; a connected one reconciles."; }

    part uca48 : UnsafeControlAction {
        :>> id = "e7e90736-536e-4ba1-8f24-9fa880f6ad64"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-48: push / pull / conflict decided on the host's EXACT-case path while the filesystem folds case - one file handled as two";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "The host's file index keys paths by the spelling it first saw; the server keys by the spelling another device pushed; the filesystem treats both as one file (413 such paths in the owner's vault, 2026-09-07).";
        :>> statement = "Push-file / pull-file provided for the local spelling as a NEW file while the server holds the other spelling: the server refuses ('a path differing only in case already exists') on every pass, the edit never syncs, and the pass crawls through hundreds of 400s. [H-11, H-6]";
    }
    part cc46 : ControllerConstraint { :>> id = "da288c47-6449-4659-a3c1-5aaa57adfedb"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-46: sync identity follows the filesystem, not the host's spelling";
        :>> statement = "On a case-insensitive platform a local path with no exact server/base key but a case-fold match is ALIASED to the existing key; nothing is renamed on disk or on the server."; }

    part uca49 : UnsafeControlAction {
        :>> id = "51697881-0f92-49c7-9aa6-c95ce5d09b96"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-49: another plugin's identity-only rewrite is treated as an authored change - phantom conflicts recur on every pass";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "A timestamp stamper, Metadata Menu's fileClass normaliser or a linter rewrites frontmatter whitespace / key order / a timestamp value / Unicode form on every open, on every device.";
        :>> statement = "Write-conflict-copy / push-file provided for a change the user cannot see: a conflict copy is generated for `key: ` vs `key:`, or a stamped `updated:` ping-pongs between devices. Found: the owner's recurring meeting.md conflict (2026-09-07) and the 1.8.x timestamp loops. [H-13, H-11]";
    }
    part cc47 : ControllerConstraint { :>> id = "f0db20f5-2bf6-41bd-a635-e1900dfd346a"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-47: identity is content the user can see";
        :>> statement = "Content identity normalises EOL / BOM / trailing newline / Unicode form for every text file, trims trailing whitespace inside frontmatter fences only, and masks timestamp-valued keys when enabled; the plugin itself writes NO note timestamps."; }

    part uca50 : UnsafeControlAction {
        :>> id = "f90d0e7b-64c2-4bb2-8199-b8170d07e389"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-50: a pull overwrites a file another authority wrote between the decision and the write";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "The editor, another plugin or another sync tool saves the file during the plugin's multi-second download (streamed branch) or between fetch and write.";
        :>> statement = "Pull-file provided over a racing write with no re-check at the write seam: the other authority's version is clobbered and base is set to remote, so the next pass reads local==base and the edit is gone. Found 1.12.1 (streamedPullRacingEditGuard). [H-1, H-13]";
    }
    part cc48 : ControllerConstraint { :>> id = "7165c078-8b9c-4491-8857-437c8de060a0"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-48: re-check at the write seam";
        :>> statement = "Every pull re-checks the local file against its pre-fetch snapshot immediately before the write (in the temp-write -> rename seam for streamed files) and preserves a racing version as a conflict copy."; }

    part uca51 : UnsafeControlAction {
        :>> id = "ce7cfc4c-3163-4922-a57c-924f90b90c52"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-51: plugin CODE delivered through config sync is enabled so it executes on this device";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "Config sync carries another plugin's main.js from a vault a peer can write to.";
        :>> statement = "Apply-config provided with live enablement of synced code: a shared-vault peer pushes a malicious main.js that runs in the host's un-sandboxed renderer. Closed by the trust gate (SR-5) and the provably-private-vault exception for hot-load. [H-5]";
    }
    part cc49 : ControllerConstraint { :>> id = "3ec9aee0-5f2c-4db2-853c-fba293d8a70b"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-49: synced code never auto-executes outside a provably private vault";
        :>> statement = "Synced plugin code and CSS are staged, not enabled, unless the vault is OUR OWN with NO read-write grant or share link; any doubt keeps the restart barrier."; }

    part uca52 : UnsafeControlAction {
        :>> id = "793b5a86-0ab8-4904-b18e-d05ab1d0e8ab"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-52: another sync tool's conflict copy or rewrite is propagated as authored content, and two sync tools re-trigger each other on one file";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "Syncthing or a cloud drive operates on the same directory (the owner's vault holds `.sync-conflict-*` files); both tools react to each other's writes.";
        :>> statement = "Push-file provided for a foreign tool's artefact (its conflict copy synced to every device as a note) and for every round of a two-tool rewrite loop, which nothing bounds - the plugin bounds only the echo of its OWN writes. NO MITIGATION EXISTS (issueSyncToolCoexistenceUnguarded). [H-13, H-6]";
    }
    part cc50 : ControllerConstraint { :>> id = "6893fd1e-c078-429e-af8f-750aa69e047a"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-50: coexist with a co-located sync tool";
        :>> statement = "The plugin recognises a co-located tool and its artefact paths (never pushed, never read as deletions), names what it skips, and holds for review a path whose identity flips more than a bounded number of times in a window."; }

    part uca53 : UnsafeControlAction {
        :>> id = "7c62d1e8-469b-4e51-994b-30e502320223"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-53: a cloud-drive placeholder, an AV-locked or a mid-write file is read as ABSENT (delete) or as EMPTY content";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "OneDrive Files-On-Demand has not hydrated the file; antivirus holds a lock; another tool is mid-write; a directory fails to enumerate.";
        :>> statement = "Delete-local / delete-remote provided on a listing that transiently omits a still-present file, or push-file provided with the empty/partial bytes of a file being written. Found: switchUpload's single-snapshot drop loop (1.11.8) and the mount false-absence hold. [H-1]";
    }
    part cc51 : ControllerConstraint { :>> id = "d8738a3f-6cd9-4f8c-83a2-f0c792f92c7a"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-51: unreadable is not absent";
        :>> statement = "A path that fails to read or list is a first-class INDETERMINATE state: never fed to decide() as absent, re-probed before any delete, and a bulk drop is guarded."; }

    part uca54 : UnsafeControlAction {
        :>> id = "b741e71f-4e8e-4015-9219-0bdab3ad50a7"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-54: the plugin saturates the host's single main thread or a mobile device's memory, so the user cannot work or reach the plugin's own controls";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "A 200 MB mp4 is decoded as text for a diff; hundreds of unstamped binaries are hashed at connect; a mobile device buffers a whole file per concurrent download.";
        :>> statement = "Dispatch-reconcile / the resolver's reads provided without a bound on what is decoded, diffed or buffered: the modal hangs for minutes, the app freezes, controls read as broken where the truth is busy. Found 2026-09-07/08 (conflictModalBinaryView, conflictModalPerf, busyStateGating, the mobile maxSyncBytes cap). [H-12]";
    }
    part cc52 : ControllerConstraint { :>> id = "1641cf5c-57ff-4cd3-9c32-892d34a5a3c3"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-52: bounded use of the host";
        :>> statement = "Never decode or diff a file that is binary or above the diff cap; bound per-file bytes to the device (mobile cap) and concurrency to FILE_CONCURRENCY; show the busy state on the controls it gates instead of hanging them."; }

    part uca55 : UnsafeControlAction {
        :>> id = "4bce763d-ac70-4d02-a3f2-155d27068abf"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-55: the plugin syncs against a server whose protocol or index schema no longer fits it (plugin auto-updated ahead, or server image rolled back)";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "BRAT updated the plugin before the operator redeployed the server, or the operator rolled the image back over a vault a newer image had migrated.";
        :>> statement = "Establish-connection provided into a version mismatch: the client reconciles against a manifest it misreads, or a rolled-back server answers every route with an opaque 500 / reports an intact vault as MISSING and nudges the tombstone-destroying reindex. Found: preReleaseHardening (handshake), schemaRollbackClearError, adminHealthRollbackStatus, rollback503CleanMessage. [H-9, H-1]";
    }
    part cc53 : ControllerConstraint { :>> id = "e50908a9-dd0f-4496-9a7d-156291ae35e7"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-53: refuse a version mismatch, and say which side is older";
        :>> statement = "The apiVersion handshake refuses to sync on a mismatch with an 'update whichever is older' message; a schema downgrade is a clear 503 ('this server is OLDER than the version that last wrote this vault'), reported as 'incompatible' (never 'missing') by the admin surface."; }

    part uca56 : UnsafeControlAction {
        :>> id = "0dcb69d8-5636-41d8-88fc-a0ce86511ac3"; :>> ucaType = UcaType::notProvided;
        :>> title = "UCA-56: a plugin build is published whose recorded versions disagree, or main drifts unreleased for weeks - devices run code no release describes";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "bump-version.mjs silently failed to update one record (package.json stayed at 1.22.0 through 1.30.0); shippable commits accumulate on main without a tag.";
        :>> statement = "Publish-plugin-build NOT provided for what main actually holds (or provided with inconsistent version records), so what a device reports and what it runs diverge and a field report cannot be mapped to code. Found: versionRecordDriftGuard (eight releases of drift), releaseCurrencyGuard. [H-9]";
    }
    part cc54 : ControllerConstraint { :>> id = "e154d067-d624-4462-8ad8-9c9fdf25e25c"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-54: one version, everywhere, released within a bounded window";
        :>> statement = "The bump prepares every version record before writing any and hard-fails on a non-match; CI asserts the records agree; the currency check fails when unreleased shippable commits exceed a bound in count or age."; }

    part uca57 : UnsafeControlAction {
        :>> id = "0845f0db-a556-4fa1-a8f1-eb421165116b"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-57: BRAT installs a main.js that is not the CI build of the tagged commit (replaced or corrupted asset)";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> context = "The release's assets are checked for PRESENCE only; nothing records or re-verifies their digests; no signature exists.";
        :>> statement = "Publish-plugin-build provided with an asset that does not match the tagged source, and every device installs it - code from an unauthorised source runs in the host. NO MITIGATION EXISTS beyond GitHub's account security (issueReleaseAssetIntegrityUnchecked). [H-5]";
    }
    part cc55 : ControllerConstraint { :>> id = "35974546-243d-4c2b-9700-44d72ddae950"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "C-55: a published asset is the build of its tag";
        :>> statement = "Release CI records each asset's SHA-256, re-downloads and compares after publish, the daily release check verifies the digests, and a device can show the digest of the build it runs."; }

    #Analyzes dependency from uca46 to caDispatchReconcile;
    #Causes dependency from uca46 to h13;
    #Causes dependency from uca46 to h9;
    #Inverts dependency from cc44 to uca46;
    #Analyzes dependency from uca47 to caEstablishConn;
    #Causes dependency from uca47 to h10;
    #Inverts dependency from cc45 to uca47;
    #Analyzes dependency from uca48 to caPushFile;
    #Analyzes dependency from uca48 to caPullFile;
    #Causes dependency from uca48 to h11;
    #Causes dependency from uca48 to h6;
    #Inverts dependency from cc46 to uca48;
    #Analyzes dependency from uca49 to caWriteConflictCopy;
    #Analyzes dependency from uca49 to caPushFile;
    #Causes dependency from uca49 to h13;
    #Causes dependency from uca49 to h11;
    #Inverts dependency from cc47 to uca49;
    #Analyzes dependency from uca50 to caPullFile;
    #Causes dependency from uca50 to h1;
    #Causes dependency from uca50 to h13;
    #Inverts dependency from cc48 to uca50;
    #Analyzes dependency from uca51 to caApplyConfig;
    #Causes dependency from uca51 to h5;
    #Inverts dependency from cc49 to uca51;
    #Analyzes dependency from uca52 to caPushFile;
    #Causes dependency from uca52 to h13;
    #Causes dependency from uca52 to h6;
    #Inverts dependency from cc50 to uca52;
    #Analyzes dependency from uca53 to caDeleteLocal;
    #Analyzes dependency from uca53 to caDeleteRemote;
    #Analyzes dependency from uca53 to caPushFile;
    #Causes dependency from uca53 to h1;
    #Inverts dependency from cc51 to uca53;
    #Analyzes dependency from uca54 to caDispatchReconcile;
    #Causes dependency from uca54 to h12;
    #Inverts dependency from cc52 to uca54;
    #Analyzes dependency from uca55 to caEstablishConn;
    #Causes dependency from uca55 to h9;
    #Causes dependency from uca55 to h1;
    #Inverts dependency from cc53 to uca55;
    #Analyzes dependency from uca56 to caReleasePluginBuild;
    #Causes dependency from uca56 to h9;
    #Inverts dependency from cc54 to uca56;
    #Analyzes dependency from uca57 to caReleasePluginBuild;
    #Causes dependency from uca57 to h5;
    #Inverts dependency from cc55 to uca57;

    part s31 : LossScenario { :>> id = "987226c2-b516-4b8a-9909-ccbdbd437953"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "missing / paused feedback (mobile suspend pauses the host's timers; the resume notice was dropped while disconnected)";
        :>> title = "S-31: 'is it rechecking though?' - a mobile device stuck disconnected after a failed connect";
        :>> statement = "Backgrounded mid-backoff, the reconnect timer was paused by the OS; on foregrounding, onResume enqueued `remote`, which the engine ignores while disconnected, so nothing re-attempted and the log showed nothing. Closed 1.11.7: onResume checks the engine state and re-connects now. SR-23."; }
    #Explains dependency from s31 to uca47;
    #LeadsTo dependency from s31 to h10;
    #Senses dependency from s31 to fbAppLifecycle;
    part s32 : LossScenario { :>> id = "a4a56864-0fed-4e97-93c6-1a8c1659acfa"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate process model inherited from the host (paths keyed by exact case on a folding filesystem)";
        :>> title = "S-32: 413 local paths differing from the server only in capitalisation";
        :>> statement = "After a rename/re-capitalisation on one device, every other device's host index held the old spelling; the reconciler pushed each as a new file, the server refused with HTTP 400 on every pass (hundreds per connect), edits under those paths silently stopped syncing, and the UI crawled. Closed 1.30.9/1.30.10: rejected-push hold + case-aware aliasing. SR-45."; }
    #Explains dependency from s32 to uca48;
    #LeadsTo dependency from s32 to h11;
    #Senses dependency from s32 to fbVaultEvents;
    part s33 : LossScenario { :>> id = "c399b7e3-4927-443f-a8e2-964298fc0d57"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (identity compared byte-exact where another writer normalises)";
        :>> title = "S-33: the recurring meeting.md conflict";
        :>> statement = "Metadata Menu's fileClass tooling rewrote `key: ` as `key:` in frontmatter on each open; the reconciler saw a divergence from base on every device and generated a conflict copy each pass, which the diff showed as visually identical lines. Closed 1.30.5/1.30.6: frontmatter trailing-whitespace and Unicode normalisation in content identity. SR-46."; }
    #Explains dependency from s33 to uca49;
    #LeadsTo dependency from s33 to h13;
    #Senses dependency from s33 to fbLocalHashes;
    part s34 : LossScenario { :>> id = "7360857f-e862-4421-a75a-9d9a1f4dc280"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (the racing-edit check ran before, not at, the write seam)";
        :>> title = "S-34: an edit saved during a multi-second download was clobbered";
        :>> statement = "The streamed pull checked for a racing local edit BEFORE streaming, then atomically renamed over the path with no re-check, setting base to remote; the buffered path re-checked, the streamed path did not. Closed 1.12.1: the check moved into the temp-write -> rename seam. SR-2."; }
    #Explains dependency from s34 to uca50;
    #LeadsTo dependency from s34 to h1;
    part s35 : LossScenario { :>> id = "021267b0-ab5b-46c8-9318-af96810e01fd"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (an owned resource not torn down on unload)";
        :>> title = "S-35: duplicate editor icons stacking across reloads";
        :>> statement = "view.addAction elements are not auto-removed by the host on unload (unlike ribbon/status-bar items); each reload/update left the old instance's icons in place. Closed 1.0.34 (editorStatusCleanupOnUnload); the timer-leak flake in the wiring tests was the same class (pluginWiringTimerLeakFix). SR-44."; }
    #Explains dependency from s35 to uca46;
    #LeadsTo dependency from s35 to h9;
    part s36 : LossScenario { :>> id = "b6b052db-01f7-4e39-b916-e356ce869811"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "missing feedback (a silent no-op inside a try/catch reported success)";
        :>> title = "S-36: package.json eight releases behind the manifest";
        :>> statement = "bump-version.mjs updated package.json through a String.replace whose non-match is a silent no-op inside a bare try/catch, so the bump reported success while one record stayed at 1.22.0 through 1.30.0. Closed (versionRecordDriftGuard): prepare-all-then-write, hard-fail on non-match, CI version-sync check. SR-49."; }
    #Explains dependency from s36 to uca56;
    #LeadsTo dependency from s36 to h9;
    #Senses dependency from s36 to fbReleaseAssertion;
    part s37 : LossScenario { :>> id = "796f280c-f428-4fce-8d63-f6eaa7c87cef"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate feedback (a clear operator condition mapped to a generic error)";
        :>> title = "S-37: a rolled-back server image answered every route with 'internal error' and reported the vault MISSING";
        :>> statement = "After the operator rolled the image back over a vault a newer image had migrated, index_store correctly refused the downgrade, but the refusal surfaced as a generic 500 on every route and the admin health mapped it to 'missing' (which nudges the tombstone-destroying reindex). Closed 1.29.5: 503 with a path-free message + 'incompatible' health + the client shows the server's reason. SR-15."; }
    #Explains dependency from s37 to uca55;
    #LeadsTo dependency from s37 to h9;
    #Senses dependency from s37 to fbVaultHealth;
    part s38 : LossScenario { :>> id = "cc5dfded-a957-46d8-8c1d-37d39f5d2f33"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (no bound on what the resolver decodes)";
        :>> title = "S-38: the Resolve-conflicts modal hung on a 200 MB mp4";
        :>> statement = "A binary conflict pair was read and decoded as text for a diff, queued behind the connect pass, on the host's main thread; the modal showed '2 files need review' and nothing else for minutes. Closed 1.30.11-13: binary/oversize pairs render sizes + dates with keep choices and no read; the busy state is shown on the buttons. SR-48."; }
    #Explains dependency from s38 to uca54;
    #LeadsTo dependency from s38 to h12;
    #Senses dependency from s38 to fbEngineBusy;
    part s39 : LossScenario { :>> id = "916a7745-7cdf-4f6e-8a70-f959a3bacc2d"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "missing control (no coexistence rule) - a PROJECTED scenario, not yet observed as a loss";
        :>> title = "S-39: a Syncthing-managed vault ping-pongs one note between two sync tools";
        :>> statement = "Device A's Syncthing delivers a peer's version of a note; the plugin sees a local change and pushes it; device B receives it from the server, its Syncthing sees a change and sends it back to A with a `.sync-conflict-*` copy beside it; the plugin syncs the copy as a note to every device and the two tools keep exchanging rewrites. UNMITIGATED today (issueSyncToolCoexistenceUnguarded); SR-47 is the requirement."; }
    #Explains dependency from s39 to uca52;
    #LeadsTo dependency from s39 to h13;
    #Senses dependency from s39 to fbVaultEvents;

    part sr44 : SafetyRequirement { :>> id = "90e6632d-78bf-49ba-8a9c-45dbdf155343"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "SR-44: an unloaded instance acts no further";
        :>> statement = "onunload tears down every timer, socket, DOM element and listener the instance owns; deferred callbacks re-check `unloading` and socket identity before acting; the engine's `unloading` state admits no transition.";
        :>> triggeringEvent = "unload / update / reload at any point of an operation";
        :>> safeState = "the old instance is inert; the new one is the only writer";
        :>> safetyFunction = "onunload teardown + unloading guards + terminal engine state"; }
    #Mitigates dependency from sr44 to uca46;
    #Satisfies dependency from sr44 to sc13;
    #Satisfies dependency from sr44 to sc9;
    #RealizedBy dependency from sr44 to c2SyncEngine;
    part sr45 : SafetyRequirement { :>> id = "4996a6ab-9b83-478c-8679-28864cbef280"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "SR-45: sync identity of a path follows the filesystem";
        :>> statement = "On a case-insensitive platform a local path with no exact server/base key but a case-fold match is aliased to the existing key for sync identity; nothing is renamed on disk or on the server; a server-refused push is held, not retried every pass.";
        :>> triggeringEvent = "a path re-capitalised on any device";
        :>> safeState = "one file, one identity; no refused-push storm";
        :>> safetyFunction = "aliasLocalPaths / canonicalLocalPath + rejectedPushes hold"; }
    #Mitigates dependency from sr45 to uca48;
    #Satisfies dependency from sr45 to sc11;
    #RealizedBy dependency from sr45 to c4Reconciler;
    part sr46 : SafetyRequirement { :>> id = "e29382d4-68cd-483e-9ce4-575fbdb65727"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "SR-46: content identity is what the user can see";
        :>> statement = "Content identity normalises EOL / BOM / trailing newline and Unicode form for every text file, trims trailing whitespace inside frontmatter fences only, masks timestamp-valued keys when enabled, and the plugin writes NO note timestamps of its own.";
        :>> triggeringEvent = "another plugin's cosmetic rewrite";
        :>> safeState = "no conflict copy, no rewrite loop";
        :>> safetyFunction = "normalizedContent / normalizedHash; timestampIgnoreRedesign"; }
    #Mitigates dependency from sr46 to uca49;
    #Satisfies dependency from sr46 to sc11;
    #Satisfies dependency from sr46 to sc13;
    #RealizedBy dependency from sr46 to c4Reconciler;
    part sr47 : SafetyRequirement { :>> id = "47cbacfc-28e2-4c61-b43d-d58b8aa48e47"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "SR-47: coexist with a co-located sync tool";
        :>> statement = "The plugin recognises a co-located sync tool and its artefact paths (never pushed, never read as deletions), names what it skips, and holds for review a path whose identity flips more than a bounded number of times within a window.";
        :>> triggeringEvent = "another sync tool on the same directory";
        :>> safeState = "foreign artefacts skipped and named; a rewrite loop held after N flips";
        :>> safetyFunction = "artefact classifier + loop breaker (syncToolCoexistence - OPEN)"; }
    #Mitigates dependency from sr47 to uca52;
    #Satisfies dependency from sr47 to sc13;
    #RealizedBy dependency from sr47 to c4Reconciler;
    part sr48 : SafetyRequirement { :>> id = "9377bb71-fd17-4abc-bd38-4c2d3468672e"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "SR-48: bounded use of the host";
        :>> statement = "The plugin never decodes or diffs a binary or over-cap file, bounds per-file bytes to the device (mobile cap) and concurrency to FILE_CONCURRENCY, and shows its busy state on the controls it gates instead of hanging them.";
        :>> triggeringEvent = "a huge or binary file; a large vault; a mobile device";
        :>> safeState = "the app stays usable; the control says why it waits";
        :>> safetyFunction = "isTextExt/MAX_DIFF_BYTES + maxSyncBytes + busygate"; }
    #Mitigates dependency from sr48 to uca54;
    #Satisfies dependency from sr48 to sc12;
    #RealizedBy dependency from sr48 to c8ConflictResolver;
    #RealizedBy dependency from sr48 to c2SyncEngine;
    part sr49 : SafetyRequirement { :>> id = "f4f06f5b-1ff0-4629-834c-feef4df883c0"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "SR-49: one version everywhere, released within a bounded window";
        :>> statement = "The version bump prepares every record before writing any and hard-fails on a non-match; CI asserts the records agree; the release-currency check fails when unreleased shippable commits exceed a bound in count or age.";
        :>> triggeringEvent = "a bump, a merge to main";
        :>> safeState = "records agree; drift bounded";
        :>> safetyFunction = "bump-version.mjs + check-version-sync + check-release-currency"; }
    #Mitigates dependency from sr49 to uca56;
    #Satisfies dependency from sr49 to sc9;
    #RealizedBy dependency from sr49 to c15ReleaseChannel;
    part sr50 : SafetyRequirement { :>> id = "71dcac0f-4906-4897-a850-1220b8f046f3"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "SR-50: a published asset is the build of its tag";
        :>> statement = "Release CI records each asset's SHA-256 and re-verifies after publish; the daily release check compares digests; a device can show the digest of the build it runs.";
        :>> triggeringEvent = "a release publish; a daily check";
        :>> safeState = "a mismatched asset fails the release, never installs unnoticed";
        :>> safetyFunction = "checksums asset + digest verification (releaseAssetIntegrity - OPEN)"; }
    #Mitigates dependency from sr50 to uca57;
    #Satisfies dependency from sr50 to sc5;
    #RealizedBy dependency from sr50 to c15ReleaseChannel;
    part sr51 : SafetyRequirement { :>> id = "453f90df-84c7-4e56-963d-02ef745b7dc1"; :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> title = "SR-51: unreadable is not absent";
        :>> statement = "A path that fails to read or list is a first-class indeterminate state - never fed to the decision as absent, re-probed before any delete, with a bulk drop guarded.";
        :>> triggeringEvent = "placeholder / lock / mid-write / failed enumeration";
        :>> safeState = "nothing deleted or pushed empty";
        :>> safetyFunction = "indeterminate readability + probePresence + bulk guard"; }
    #Mitigates dependency from sr51 to uca53;
    #Satisfies dependency from sr51 to sc1;
    #RealizedBy dependency from sr51 to c4Reconciler;

    #Mitigates dependency from sr23 to uca47;
    #Mitigates dependency from sr2 to uca50;
    #Mitigates dependency from sr5 to uca51;
    #Mitigates dependency from sr15 to uca55;
    #Mitigates dependency from sr28 to uca46;

    // ---- 2026-09-11 architecture panel (host / identity / other-sync-tools / release-channel critics + SE): the cells
    // found open. Fixed in sprints hostCoexistenceHardening, contentIdentityTwoSided, coexistenceHardening,
    // releaseIntegrityHardening (1.30.18); #Verify edges land with their DoDs. ----

    part uca64 : UnsafeControlAction {
        :>> id = "ffdd8975-b130-40c5-af5e-85808d0544a4"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-64: a case-only rename made on a case-SENSITIVE peer deletes the note fleet-wide on a folding peer";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "The server delivers tombstone `Note.md` + upsert `note.md` in one pass; on Windows/macOS/iOS both spellings are ONE on-disk file.";
        :>> statement = "Delete-local provided for the tombstoned spelling removes the very file the upsert just adopted; the host's delete event then folds onto the new key and delete-remote tombstones `note.md` for every peer. Found by the panel (host H1, BLOCKER). [H-1, H-11]";
    }
    part cc62 : ControllerConstraint { :>> id = "18e721c7-0a93-4190-9c3d-6d4392f7eeca"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-62: a fold-sibling tombstone is a rename";
        :>> statement = "On a case-insensitive filesystem a tombstoned path whose fold-sibling is a remote key of the same pass is treated as a base rename: the old key is dropped, nothing is removed from disk, nothing is tombstoned."; }

    part uca65 : UnsafeControlAction {
        :>> id = "813bbd37-9df5-44c5-beb9-733719959835"; :>> ucaType = UcaType::wrongTimingOrder;
        :>> title = "UCA-65: an in-flight pass keeps writing the vault and persisting its base after the host unloaded the instance";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "BRAT updates / the user reloads while a connect or reconcile is running; the effect already awaited continues to completion.";
        :>> statement = "Pull-file / push-file / persist provided by a torn-down instance beside the new one — two writers of one vault and one data.json (UCA-26 guarded only the state repaint). Found by the panel (host H2). [H-13]";
    }
    part cc63 : ControllerConstraint { :>> id = "e1e12dde-a9d2-4fc3-8ce6-4e4feeb54b36"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-63: a pass checks it is still wanted";
        :>> statement = "isolatedPass consults deps.alive between items and stops; persistence is refused after unload except the final flush."; }

    part uca66 : UnsafeControlAction {
        :>> id = "1b5cfab6-7148-4165-b5a5-4a8cbd4084d9"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-66: the plugin exhausts the host — a mobile per-file cap equal to the desktop default, and a whole-base persist on every setBase";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "maxSyncMB defaulted to 200 on every platform (mobile buffers whole files ×FILE_CONCURRENCY); persist() stringified the entire base on each base change during a pass.";
        :>> statement = "Dispatch-reconcile provided without a device bound or a persistence bound: an OOM path on mobile, and a continuous full-data.json write loop on the main thread. Found by the panel (host H3/H4). [H-12]";
    }
    part cc64 : ControllerConstraint { :>> id = "02f39372-4858-479a-aaeb-8b3a72b09735"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-64: bounded per-file memory and coalesced persistence";
        :>> statement = "A hard mobile ceiling the setting cannot exceed; base persistence coalesces to one write ~1.5 s after the last change, flushed on unload; the streamed writer loops until every byte is written."; }

    part uca67 : UnsafeControlAction {
        :>> id = "892f2dcc-a532-4a36-b9a9-ee2e6fb1281d"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-67: a conflict copy is written for a change the user cannot see — a stamp-only local on a remote move, or a one-sided 'merge'";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "(a) the push→in-sync override stamped the scan-skip hint on a raw-different file; the next full pass trusted the hint, a remote edit decided pull, and the write seam saw raw ≠ base. (b) both hashes moved but ONE side moved only cosmetically (NFD re-save, `key: `→`key:`).";
        :>> statement = "Write-conflict-copy provided where identity says nothing changed on our side (or on theirs) — the phantom copy UCA-49 was supposed to have closed, reappearing on reconnect and in the two-sided case. Found by the panel (identity ID1/ID2). [H-13, H-11]";
    }
    part cc65 : ControllerConstraint { :>> id = "3b6f7ad7-eaa4-402f-a5a3-88f23d4dbd71"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-65: identity is two-sided and reaches the write seam";
        :>> statement = "The racing-edit seam skips a copy when the current bytes are identity-equal to base; a 'merge' where exactly one side is identity-equal to base is a plain pull or push."; }

    part uca68 : UnsafeControlAction {
        :>> id = "14593089-7084-4117-84a1-8c7ba146cbbe"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-68: adopting the remote drops content identity cannot see — a masked timestamp line present on one side only, or trailing whitespace inside a YAML block scalar";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "identity masks timestamp-valued ignored keys and trimmed every in-fence line; a local `created:` line vs a remote without it, or a `description: |` block with significant trailing spaces, compared equal.";
        :>> statement = "Pull-file (adopt remote) provided over a file whose only difference is invisible to identity — the line or the whitespace is gone with no copy; the auto-sweep already refused the first case, the engine did not. Found by the panel (identity ID4/ID5). [H-1, H-11]";
    }
    part cc66 : ControllerConstraint { :>> id = "7fb86424-b0cb-4f4a-a981-c520dc70771e"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-66: an automatic adopt loses nothing at all";
        :>> statement = "Adopt-remote requires equal masked-key presence on both sides; in-fence trimming applies to top-level lines only; the display folds exactly what identity folds."; }

    part uca69 : UnsafeControlAction {
        :>> id = "fd636817-d5bc-4d44-acc3-01d46440f72c"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-69: synced plugin code is hot-loaded because the vault is private NOW, not because this account wrote it";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "A peer's main.js pushed under a since-revoked read-write grant; the privacy check is taken after the revocation and passes.";
        :>> statement = "Apply-config (enable) provided for code whose recorded committer is a peer — executes in the host. The autopilot already required the author to be this account; hot-load did not. Found by the panel (identity ID8). [H-5]";
    }
    part cc67 : ControllerConstraint { :>> id = "2c62fab1-eb96-4d47-a0c2-f2e5e8bda94c"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-67: hot-load keys on the committer";
        :>> statement = "Code is hot-loaded only when its recorded committer is this account (an unknown author only in a private vault); everything else keeps the restart barrier."; }

    part uca70 : UnsafeControlAction {
        :>> id = "9c635789-634d-4da7-ab3a-6ac4149ba252"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-70: the foreign-artefact skip is a frozen snapshot in mount scopes, and a user 'upload anyway' disarms the loop breaker for good";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "The mount runtime captured skipForeignArtefacts as a boolean while the mount io read the live setting; release() set a standing override.";
        :>> statement = "Mount-pull (delete-remote) provided when io and accepts disagree after a toggle — a based foreign path read as absent and tombstoned on the SOURCE; and push-file provided without bound after one 'upload anyway' while the loop continued. Found by the panel (other-sync-tools FT1/FT2) in code that had shipped the same day. [H-1, H-13]";
    }
    part cc68 : ControllerConstraint { :>> id = "662d2130-4a11-465e-b23c-4608ebd0126d"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-68: one live predicate; one-shot release";
        :>> statement = "Every sink reads the skip setting through the same live predicate; a release passes exactly the current content and re-arms on the next flip; toggling the skip off forces a full pass."; }

    part uca71 : UnsafeControlAction {
        :>> id = "9de5e89d-f1e7-4206-8f8e-617c54327a79"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-71: a release is installable before it is verified, a tag is silently reused for another commit, integrity has no anchor outside the mutable release, and no version-tagged server image exists";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "gh release create published non-draft before the verify step; `--target` reuses an existing tag; SHA256SUMS lives beside the assets it attests; GITHUB_TOKEN-created tags never trigger server-image.yml.";
        :>> statement = "Publish-plugin-build provided (a) live before verification, (b) under a tag pointing at another commit, (c) with a self-attesting digest, and publish-server-image NOT provided for the version. Found by the panel (release RL1..RL4). [H-5, H-9]";
    }
    part cc69 : ControllerConstraint { :>> id = "6afcd93c-6659-46c1-9bc5-c08bd2987c49"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-69: draft → verify → publish, tag-safe, independently anchored, image versioned";
        :>> statement = "The release is a draft until its assets verify; a tag pointing elsewhere is refused; the daily check rebuilds the tag and compares; release.yml dispatches the version-tagged server image."; }

    part uca72 : UnsafeControlAction {
        :>> id = "fac06433-0fe5-48c0-a008-c8ac566e2642"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-72: a vault switch downloads the server's content over divergent local content without a deliberate choice";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "The user re-points the primary at another vault whose content differs from the local folder.";
        :>> statement = "Request-switch (download-mirror / upload-overwrite) provided without confirmation would replace or overwrite divergent content. The switch modal's confirmModal + the switch's own probe guard close it; recorded so the control action is analysed, not silent (SE3). [H-1]";
    }
    part cc70 : ControllerConstraint { :>> id = "1662ee1d-ea52-4565-a3b5-8d6f502961ee"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-70: a switch is a confirmed, guarded choice";
        :>> statement = "Download-mirror and upload-overwrite require an explicit confirmation naming the consequence, and the upload probe never tombstones on a transient listing."; }

    part uca73 : UnsafeControlAction {
        :>> id = "dc776959-6a0f-4937-9cd3-987bc8d2a3b5"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-73: the operator prunes deletion history while a device's cursor is still below the new floor";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "POST /api/admin/prune-history advances the tombstone floor; a device offline since before the floor still relies on those tombstones (SR-1's evidence).";
        :>> statement = "Prune-history provided past a device's cursor: on reconnect that device sees files absent with no tombstone (kept, SR-1) or, worse, re-uploads a peer's deletions (UCA-34) — the model knew the consequence only as context. Found by the SE critic (SE4). [H-1, H-2]";
    }
    part cc71 : ControllerConstraint { :>> id = "138f69ac-4730-4788-bbaf-d753bb42dd3a"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-71: history has a stated horizon";
        :>> statement = "Tombstones are retained at least the stated horizon; a device whose cursor is below the floor is routed through history-reset detection (full reconcile + keep-absent), never an incremental delta."; }

    part uca74 : UnsafeControlAction {
        :>> id = "3ba155a0-bb28-4d1f-8929-ade27284cab6"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-74: a legitimate, tombstoned mass deletion is applied locally without the user's confirmation";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "A peer wipes a shared folder: SR-1 is satisfied (real tombstones), yet the fleet-wide effect is the loss of everything under it on every device.";
        :>> statement = "Delete-local provided for an over-threshold tombstone set with no hold — the D0041 incoming bulk-delete confirmation is the only barrier and no SR stated it (SE5). [H-1]";
    }
    part cc72 : ControllerConstraint { :>> id = "cc5d962f-acd4-47d4-9afb-0b8e0792be29"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-72: an over-threshold incoming deletion set is held";
        :>> statement = "Incoming delete-locals above the user's threshold (count or percent) are held for confirmation on both the full and the delta path; the user keeps them (re-sync back) or applies them."; }

    #Analyzes dependency from uca64 to caDeleteLocal;
    #Analyzes dependency from uca64 to caDeleteRemote;
    #Causes dependency from uca64 to h1;
    #Causes dependency from uca64 to h11;
    #Analyzes dependency from uca65 to caPullFile;
    #Analyzes dependency from uca65 to caPushFile;
    #Causes dependency from uca65 to h13;
    #Analyzes dependency from uca66 to caDispatchReconcile;
    #Causes dependency from uca66 to h12;
    #Analyzes dependency from uca67 to caWriteConflictCopy;
    #Causes dependency from uca67 to h13;
    #Causes dependency from uca67 to h11;
    #Analyzes dependency from uca68 to caPullFile;
    #Causes dependency from uca68 to h1;
    #Causes dependency from uca68 to h11;
    #Analyzes dependency from uca69 to caApplyConfig;
    #Causes dependency from uca69 to h5;
    #Analyzes dependency from uca70 to caMountPull;
    #Analyzes dependency from uca70 to caPushFile;
    #Causes dependency from uca70 to h1;
    #Causes dependency from uca70 to h13;
    #Analyzes dependency from uca71 to caReleasePluginBuild;
    #Analyzes dependency from uca71 to caReleaseServerImage;
    #Causes dependency from uca71 to h5;
    #Causes dependency from uca71 to h9;
    #Analyzes dependency from uca72 to caRequestSwitch;
    #Causes dependency from uca72 to h1;
    #Analyzes dependency from uca73 to caPruneHistory;
    #Causes dependency from uca73 to h1;
    #Causes dependency from uca73 to h2;
    #Analyzes dependency from uca74 to caDeleteLocal;
    #Causes dependency from uca74 to h1;
    #Inverts dependency from cc62 to uca64;
    #Inverts dependency from cc63 to uca65;
    #Inverts dependency from cc64 to uca66;
    #Inverts dependency from cc65 to uca67;
    #Inverts dependency from cc66 to uca68;
    #Inverts dependency from cc67 to uca69;
    #Inverts dependency from cc68 to uca70;
    #Inverts dependency from cc69 to uca71;
    #Inverts dependency from cc70 to uca72;
    #Inverts dependency from cc71 to uca73;
    #Inverts dependency from cc72 to uca74;

    part sr54 : SafetyRequirement { :>> id = "ae72f3dd-68bc-4244-9196-5cb2fffef50c"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-54: a tombstone whose fold-sibling is a remote key is a rename, never a removal";
        :>> statement = "On a case-insensitive filesystem a tombstoned path with a case-fold sibling among the pass's remote keys drops its base key and removes nothing; the upsert adopts the file under the new key.";
        :>> triggeringEvent = "a case-only rename delivered as tombstone + upsert";
        :>> safeState = "the file survives under its new key; nothing tombstoned back";
        :>> safetyFunction = "caseRenamedTombstones + the removeLocal guard (reconcile.ts)"; }
    part sr55 : SafetyRequirement { :>> id = "9f1c88cb-c9c4-4157-b46d-2e1a8b8aec4b"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-55: an unloaded instance's pass stops, and the host's memory and storage are bounded";
        :>> statement = "A pass re-checks deps.alive between items and stops after unload; persistence coalesces to one write per ~1.5 s and flushes on unload; mobile per-file bytes are capped at 100 MB regardless of the setting; the streamed writer loops until every byte is written.";
        :>> triggeringEvent = "unload mid-pass; a large file on mobile; a long pass";
        :>> safeState = "no zombie writer; no OOM path; no persist storm; no truncated file recorded as complete";
        :>> safetyFunction = "deps.alive + schedulePersist + MOBILE_MAX_SYNC_MB + the append loop (main.ts, reconcile.ts)"; }
    part sr56 : SafetyRequirement { :>> id = "2ade514e-ab8c-44f2-a86d-09b8cbaf3a7c"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-56: content identity is two-sided, reaches the write seam, and an automatic adopt loses nothing at all";
        :>> statement = "A 'merge' where exactly one side is identity-equal to base is a pull or a push; the racing-edit seam skips a copy when the current bytes are identity-equal to base; adopt-remote requires equal masked-key presence; in-fence trimming stops at indented lines; the display folds what identity folds.";
        :>> triggeringEvent = "a cosmetic change on one side with a real edit on the other; a masked line on one side only; a block scalar";
        :>> safeState = "no phantom conflict copy; no silently dropped line or whitespace; the diff shows nothing identity sees nothing in";
        :>> safetyFunction = "reconcileMergeOrConflict demotion + conflictCopyIfRaced identity check + sameMaskedKeys + top-level trim + maskedForDisplay"; }
    part sr57 : SafetyRequirement { :>> id = "7f1c7929-fe39-4beb-a890-1d8311b99285"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-57: hot-load keys on the recorded committer";
        :>> statement = "Synced plugin code is enabled live only when its recorded committer is this account (an unknown author only in a provably private vault); everything else keeps the restart barrier.";
        :>> triggeringEvent = "a newly arrived plugin";
        :>> safeState = "a peer's code never executes without a restart";
        :>> safetyFunction = "hotLoadable filter (main.ts applyPluginCodeChange)"; }
    part sr58 : SafetyRequirement { :>> id = "94c9f7dd-cc5b-4d84-a7ab-7621a594781e"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-58: the foreign-artefact skip is one live predicate and a loop release is one-shot";
        :>> statement = "Every sink (primary io + accepts, mount io + accepts) reads skipForeignArtefacts through a live predicate; a user release passes exactly the current content and re-arms on the next flip; foreign paths already on the server are reported as such; root markers are probed through the adapter; toggling the skip off forces a full pass.";
        :>> triggeringEvent = "a toggle mid-session; an 'upload anyway'";
        :>> safeState = "io and reconcile never disagree; the breaker cannot be permanently disarmed";
        :>> safetyFunction = "ctx.skipForeignArtefacts() + FlipGuard.releasedHash + noteDeclined split + FOREIGN_ROOT_MARKERS + requestFullReconcile"; }
    part sr59 : SafetyRequirement { :>> id = "f8cb8d66-dc98-497b-a778-ef5860255643"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-59: a release is published only after its assets verify, under a tag that is its own, with an independent anchor and a version-tagged server image";
        :>> statement = "release.yml creates a draft, verifies the uploaded assets against SHA256SUMS, refuses a tag pointing at another commit, publishes, and dispatches server-image.yml on the tag; verify-released.yml rebuilds the tag daily and compares with the published assets; third-party actions are pinned to commit SHAs with Dependabot bumps.";
        :>> triggeringEvent = "a release publish; the daily check";
        :>> safeState = "nothing installable until verified; assets and tag describe one build; the image operators are told to pin exists";
        :>> safetyFunction = "release.yml draft→verify→publish + tag guard + verify-released rebuild step + dependabot.yml"; }
    part sr60 : SafetyRequirement { :>> id = "6b61a741-9e93-4079-9acb-e644654ee19f"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-60: a vault switch is a confirmed, guarded choice";
        :>> statement = "Download-mirror and upload-overwrite each require an explicit confirmation naming the consequence; the upload path re-probes absence before any delete-remote.";
        :>> triggeringEvent = "the user re-points the primary";
        :>> safeState = "no silent replace; no tombstone from a transient listing";
        :>> safetyFunction = "vaultswitch.ts confirmModal + switchUploadProbeGuard"; }
    part sr61 : SafetyRequirement { :>> id = "07c97b1c-9a64-4177-8193-a37593d30499"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-61: deletion history has a stated retention horizon and a device below the floor is reset, not deltaed";
        :>> statement = "Tombstones are retained at least the configured horizon (D0019); a device whose cursor is below the current floor is routed through history-reset detection to a full reconcile with keep-absent, never an incremental delta.";
        :>> triggeringEvent = "an operator prune; a long-offline device";
        :>> safeState = "no silent resurrection or phantom deletion after a prune";
        :>> safetyFunction = "server tombstone prune + floor; client history-reset detection (noteHistory / reset routing)"; }
    part sr62 : SafetyRequirement { :>> id = "0613a207-d680-4c75-ad90-f9e409a863ac"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-62: an over-threshold incoming deletion set is held for the user";
        :>> statement = "Incoming delete-locals above the configured threshold (count or percent of the synced set) are held on both the full and the delta path until the user keeps or applies them; outgoing deletes are never gated.";
        :>> triggeringEvent = "a tombstone batch over the threshold";
        :>> safeState = "nothing removed locally until confirmed";
        :>> safetyFunction = "bulkDeleteHold (reconcile.ts) + the Conflicts review rows (D0041)"; }
    #Mitigates dependency from sr54 to uca64;
    #Mitigates dependency from sr55 to uca65;
    #Mitigates dependency from sr55 to uca66;
    #Mitigates dependency from sr56 to uca67;
    #Mitigates dependency from sr56 to uca68;
    #Mitigates dependency from sr57 to uca69;
    #Mitigates dependency from sr58 to uca70;
    #Mitigates dependency from sr59 to uca71;
    #Mitigates dependency from sr60 to uca72;
    #Mitigates dependency from sr61 to uca73;
    #Mitigates dependency from sr62 to uca74;
    #Mitigates dependency from sr62 to uca41;
    #Satisfies dependency from sr54 to sc11;
    #Satisfies dependency from sr54 to sc1;
    #Satisfies dependency from sr55 to sc13;
    #Satisfies dependency from sr55 to sc12;
    #Satisfies dependency from sr56 to sc11;
    #Satisfies dependency from sr56 to sc13;
    #Satisfies dependency from sr57 to sc5;
    #Satisfies dependency from sr58 to sc13;
    #Satisfies dependency from sr59 to sc5;
    #Satisfies dependency from sr59 to sc9;
    #Satisfies dependency from sr60 to sc1;
    #Satisfies dependency from sr61 to sc1;
    #Satisfies dependency from sr61 to sc2;
    #Satisfies dependency from sr62 to sc1;
    #RealizedBy dependency from sr54 to c4Reconciler;
    #RealizedBy dependency from sr55 to c2SyncEngine;
    #RealizedBy dependency from sr56 to c4Reconciler;
    #RealizedBy dependency from sr57 to c2SyncEngine;
    #RealizedBy dependency from sr58 to c4Reconciler;
    #RealizedBy dependency from sr59 to c15ReleaseChannel;
    #RealizedBy dependency from sr60 to c1User;
    #RealizedBy dependency from sr61 to c5ServerVault;
    #RealizedBy dependency from sr61 to c4Reconciler;
    #RealizedBy dependency from sr62 to c4Reconciler;

    // ---- D0108: the panel's corrections to sr44 / sr47 / sr50 / cc49 / cc55 are SUPERSEDING items (the originals are
    // claudeOpus-owned and this change was authored under the owner's bound actor; a non-owner adds, never overwrites). ----
    part cc73 : ControllerConstraint { :>> id = "46d54553-de8a-4d10-bbcc-6e40df370bf0"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-73 (supersedes C-49): synced code never auto-executes unless the vault is private AND the code is this account's; CSS is applied by the host with a warning";
        :>> statement = "Synced plugin CODE is staged behind the restart barrier unless the vault is our own with no read-write grant or share link AND the code's recorded committer is this account; any doubt keeps the barrier. CSS cannot be staged (the host applies an enabled snippet live) and is written with a source-named warning (panel ID7/ID8, 2026-09-11)."; }
    part cc74 : ControllerConstraint { :>> id = "7da1a648-75ea-41cb-b4f0-acb0cd351cd4"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-74 (supersedes C-55): a published asset is the build of its tag — verified before publish, anchored by a rebuild";
        :>> statement = "Release CI records each asset's SHA-256, verifies the uploaded assets against it BEFORE publishing (draft → verify → publish), refuses a tag that points at another commit, and the daily check both verifies the digests and REBUILDS the tag to compare — the independent anchor, since SHA256SUMS lives in the same mutable release as the assets; a device can show the digest of the build it runs (panel RL1-RL3, 2026-09-11)."; }
    part sr63 : SafetyRequirement { :>> id = "2c9efbbd-cfc0-4aa7-ba33-62b67b7cdfeb"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-63 (supersedes SR-44): an unloaded instance acts no further — the effect body too, not only the state repaint";
        :>> statement = "onunload tears down every timer, socket, DOM element and listener the instance owns (incl. the one-shot UI timers) and flushes the pending base write; deferred callbacks re-check `unloading` and socket identity before acting; the engine's `unloading` state admits no transition; an IN-FLIGHT pass checks the instance is still alive between items (deps.alive) so it stops writing the vault and stops persisting once unloaded.";
        :>> triggeringEvent = "unload / update / reload at any point of an operation, incl. mid-pass";
        :>> safeState = "the old instance is inert — no write, no persist; the new one is the only writer";
        :>> safetyFunction = "onunload teardown + unloading guards + terminal engine state + deps.alive in isolatedPass + persist flush (panel H2/H7)"; }
    part sr64 : SafetyRequirement { :>> id = "58fa5af1-5149-4fbe-aa73-9db7a729d657"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-64 (supersedes SR-47): coexist with a co-located sync tool — one live predicate, one-shot release, honest scope";
        :>> statement = "The plugin recognises a co-located sync tool and its artefact paths (never pushed, never read as deletions; the skip predicate is read LIVE by every sink so io and reconcile cannot disagree across a toggle), names what it skips (root markers probed through the adapter), reports foreign paths already on the server as such, and holds for review a path whose content RETURNS to an already-seen value more than a bounded number of times within a window; a user release is one-shot (exactly the current content). HONEST SCOPE: a writer producing a never-seen value each round (a monotonic stamper on an unmasked key) is not detected here — masked keys are handled by content identity; the unmasked case is a recorded residual (issueMonotonicRewriteLoopUndetected).";
        :>> triggeringEvent = "another sync tool on the same directory; a toggle mid-session; an 'upload anyway'";
        :>> safeState = "foreign artefacts skipped and named consistently by every sink; a returning-content loop held after N flips; the breaker cannot be permanently disarmed";
        :>> safetyFunction = "foreigntools.ts classifier + FOREIGN_ROOT_MARKERS probe + live ctx.skipForeignArtefacts() + FlipGuard (limit 6 / 10 min, releasedHash) reaching primary, mounts and the merged push"; }
    part sr65 : SafetyRequirement { :>> id = "0ca6387e-c29d-4920-8aae-f04b9cafa453"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-65 (supersedes SR-50): a published asset is the build of its tag — draft → verify → publish, tag-safe, rebuild-anchored";
        :>> statement = "Release CI records each asset's SHA-256 and verifies the uploaded assets against it before the release is published (a draft until then; a mismatch or partial upload never becomes installable); a tag already pointing at another commit is refused; the daily check verifies the digests AND rebuilds the tagged commit to compare with the published assets; every plugin release dispatches the version-tagged server image; a device can show the digest of the build it runs.";
        :>> triggeringEvent = "a release publish; the daily check";
        :>> safeState = "nothing installable until verified; assets and tag describe one build; an altered asset is caught by the rebuild, not by its own digest";
        :>> safetyFunction = "release.yml draft/verify/publish + tag guard + verify-released.yml rebuild-and-compare + server-image dispatch (D0055)"; }
    #Supersede dependency from cc73 to cc49;
    #Supersede dependency from cc74 to cc55;
    #Supersede dependency from sr63 to sr44;
    #Supersede dependency from sr64 to sr47;
    #Supersede dependency from sr65 to sr50;
    #Inverts dependency from cc73 to uca51;
    #Inverts dependency from cc74 to uca57;
    #Mitigates dependency from sr63 to uca46;
    #Mitigates dependency from sr63 to uca65;
    #Mitigates dependency from sr64 to uca52;
    #Mitigates dependency from sr64 to uca70;
    #Mitigates dependency from sr65 to uca57;
    #Mitigates dependency from sr65 to uca71;
    #Satisfies dependency from sr63 to sc13;
    #Satisfies dependency from sr63 to sc9;
    #Satisfies dependency from sr64 to sc13;
    #Satisfies dependency from sr65 to sc5;
    #RealizedBy dependency from sr63 to c2SyncEngine;
    #RealizedBy dependency from sr64 to c4Reconciler;
    #RealizedBy dependency from sr65 to c15ReleaseChannel;

    // ---- 2026-09-12 (sprint monotonicRewriteDetection): the SR-64 residual is closed — the breaker also detects returns of
    // the content's SHAPE (timestamps masked), so a monotonic stamper's rounds are held too. Superseding item (D0108). ----
    part sr66 : SafetyRequirement { :>> id = "e39365ed-ecb5-4ff3-bf66-f7254bbaa2bf"; :>> createdAt = "2026-09-12"; :>> createdBy = "claudeOpus";
        :>> title = "SR-66 (supersedes SR-64): the rewrite-loop breaker holds exact returns AND timestamp-shape returns";
        :>> statement = "The plugin recognises a co-located sync tool and its artefact paths (skip predicate read live by every sink; root markers probed; foreign paths already on the server reported as such) and holds for review a path whose content returns — exactly, OR with only timestamp-shaped tokens changed (the SHAPE of mergeable text up to 256 KiB, passed beside the hash) — more than a bounded number of times within a window; a user release is one-shot. A monotonic stamper on an unmasked key, or in a .txt / excluded folder, is therefore held like an alternating rewriter. Residual: a writer that changes NON-timestamp content each round (a counter) is indistinguishable from typing and is not held.";
        :>> triggeringEvent = "another writer re-stamping or alternating a file after every sync";
        :>> safeState = "uploading pauses after N returns; nothing on disk or on the server changes; the user is told which file and why";
        :>> safetyFunction = "FlipGuard.record(path, hash, now, shape) + shapeOf (flipguard.ts); flipShape in main.ts feeds text ≤ 256 KiB on the primary and mount push paths and the merged push"; }
    #Supersede dependency from sr66 to sr64;
    #Mitigates dependency from sr66 to uca52;
    #Mitigates dependency from sr66 to uca70;
    #Satisfies dependency from sr66 to sc13;
    #RealizedBy dependency from sr66 to c4Reconciler;
}

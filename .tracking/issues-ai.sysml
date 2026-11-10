// Per-actor issues records for ai (issue210/srDcPerActorWriteTargets): new records
// route here so concurrent contributors never conflict at a shared append anchor.
package IssuesAi {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part issue007 : Issue {
        :>> id = "fb91c6d9-eb80-4e84-b049-27bb1cefdeac";
        :>> title = "A raw vault event for a synced FOLDER records an unsynced-edit claim for a change nobody made; NTFS last-access updates re-fire it per folder with no write";
        :>> createdAt = "2026-11-04";
        :>> createdBy = "ai";
        :>> description = "OBSERVATION (owner, st008, 2026-11-04). With 1.32.0 installed, the status detail read '7 unsynced edits: .obsidian/themes/Minimal (0s), .obsidian/plugins/quickadd (0s), ...'. The owner saw the same eleven items again and again. The vault log (info level) holds seventeen stale-claim warn lines on 2026-11-04, in three bursts (03:05Z, 07:19Z, 08:51Z). Every path is a FOLDER: eight synced plugin folders and two theme folders. Get-Item on each folder shows directory and file write times months old (quickadd 2026-07-17, themes/Minimal 2026-01-20). All of them share one last-access time, 17:31:42Z, inside a burst of settings-tab config renders. fsutil behavior query disablelastaccess reports 2 (last-access updates enabled). REPEATABLE RESULT (real Obsidian 1.12 on Windows 11, plugin built from HEAD 7f8467f, 2026-11-04). The check is client/e2e-obsidian/configclaim.pwspec.ts ARM B. It ages a synced plugin folder's last-access time two hours back with utimes. It then lists the folder five times from outside, with no write. Obsidian emits 'raw' with the FOLDER path eight times. The plugin's claim map then holds '.obsidian/plugins/testplugin'. The detail reads '1 unsynced edit: .obsidian/plugins/testplugin (0s)'. Two of five fresh launches sat on syncing for the whole 60 s baseline before any arm acted. The same folder claim appeared and vanished during that time. ARM A (a file write inside the folder) reports the file path and settles. ARM C (adapter list, stat, exists, read, readBinary, a walk, pluginSyncClean, a config scan) emits no folder event while the access time is fresh. MECHANISM, as read at 7f8467f. onRawConfigEvent (client/src/main.ts) buffers any path that passes shouldSync. shouldSync accepts a bare plugin or theme folder path. flushRawConfig then calls noteLocalChange for it, which records an unsynced-edit claim, and enqueues a per-path pass. A folder is never a synced item, so the claim is noise for a change nobody made. CORRECTION (panel 2026-11-04, SE F1, PEDANT-1 F1, PEDANT-3 F2): the first record said no pass settles that claim. That is false. A connected per-path pass settles it as in-sync in about a second (the finally block of reconcilePath in client/src/reconcile.ts). The light blinks yellow for that second. A claim stands past 60 s only while no per-path pass runs: syncengine.ts drops a path event when the engine is not connected, and the connect's full pass or the next config pass settles it. That standing-claim class is issue008. NTFS persists a folder's last-access time at most hourly, on any listing. The config scan lists every synced folder at most every 30 s (the 60 s idle poll in practice), so each folder re-fires when NTFS next persists its access time. The owner's warn bursts were 4 h 14 m and 1 h 32 m apart, not hourly. The settings-tab sentence in the first record (re-render on each status change) has no code path behind it; the 400 section.config renders per hour are issue009.";
        :>> discoveredInField = true;
        :>> severity = Severity::High;
    }
    #Resolves dependency from rawFolderEventNoClaim to issue007;

    part issue008 : Issue {
        :>> id = "37767c7f-19d2-4b60-ae1a-b0912b383c70";
        :>> title = "A disk claim raised while no per-path pass runs stands until the next full or config pass; the stale warn line only reports it";
        :>> createdAt = "2026-11-04";
        :>> createdBy = "ai";
        :>> description = "OBSERVATION (owner log, 2026-11-04). Seventeen stale-claim warn lines in three bursts (03:07Z, 07:21Z, 08:52Z) report waits of 61 s to 140 s 'with no pass settling it'. Each burst ends at the next 'end reconcileAll delta+config' line. The 06:37Z to 07:22Z gap in the periodic poll points to a sleep and resume. The same class showed in the harness. Two of five fresh-vault launches of client/e2e-obsidian/configclaim.pwspec.ts sat on syncing for the whole 60 s baseline before any arm acted. MECHANISM (panel 2026-11-04, SE F1, PEDANT-1 F1, PEDANT-3 F2, read at d668698). syncengine.ts drops a path event when the engine is not connected (the isConnected guard in the path case of handle). noteLocalChange already recorded the disk claim before the enqueue (flushRawConfig and onLocalEvent in client/src/main.ts). Nothing settles that claim until a full pass (finishConnect calls settleUnsyncedBefore) or a config pass visits the path. A folder claim raised in that window was the owner's 140 s line. A real file edit in the same window shows the same way. The CLAIM_STALE_WARN_MS line is a symptom report, not a control. It logs and sets warned, and nothing acts (unsyncedEditCount in main.ts). A unit test in client/test/plugin-wiring.test.ts verifies the mechanism. Its name: 'a claim raised while the engine is NOT connected stands (the path event is dropped) until a full pass settles it'. NOT ESTABLISHED. Which engine state held during the owner's three bursts. The vault log is at info level and does not carry the engine transitions. The resolver names the holder in a real-Obsidian probe and adds a settle try at the stale bound.";
        :>> discoveredInField = false;
        :>> severity = Severity::Medium;
    }
    #Resolves dependency from standingClaimSettleTry to issue008;

    part issue009 : Issue {
        :>> id = "745533b4-19dc-4554-aaed-1bbc95a4a478";
        :>> title = "About 400 section.config renders per hour with the settings tab open; the producer is not identified";
        :>> createdAt = "2026-11-04";
        :>> createdBy = "ai";
        :>> description = "OBSERVATION (owner log, 2026-11-04). About 400 section.config render spans in one hour while the settings tab was open. All synced plugin folders shared one last-access time, 17:31:42Z, inside that burst. NOT ESTABLISHED. issue007 first attributed the burst to 'the settings tab re-renders its config section on each status change'. The panel (2026-11-04, PEDANT-1 F3, PESSIMIST-2 F4, PEDANT-3 F2) read the code and found no such path. statusListener runs fillStatus only (client/src/settings.ts). A config section re-render comes only from settingsRefresh('config', ...) at five named producers in client/src/main.ts. Those are: server plugin set changed, plugin name resolved, plugin purged, plugin sync toggled, plugins hot-loaded. The per-plugin walk is cached for the tab session. The producer of the 400 renders is not identified. The vault log carries the span but not the requestRefresh reason. RESOLVER. Log the refresh reason with each section.config span. Reproduce with the settings tab open in real Obsidian. Assert a bound on renders per minute with no settings change.";
        :>> discoveredInField = false;
        :>> severity = Severity::Low;
    }
    #Resolves dependency from configSectionRenderStorm to issue009;

    part issue010 : Issue {
        :>> id = "6a5fc680-7fa1-4c45-9313-ba2cdfd0cb99";
        :>> title = "cargo-audit fails: libsqlite3-sys 0.30.1 carries SQLite CVE-2026-119375 (RUSTSEC-2026-0459)";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> description = "The CI job cargo-audit fails on every push since the scheduled run of 2026-11-09, run 42656295355 at 4f5d298, before any E2EE commit. The report names RUSTSEC-2026-0459. The crate libsqlite3-sys 0.30.1 carries C SQLite CVE-2026-119375, severity 6.8 medium, published 2026-10-30. The fix is libsqlite3-sys 0.39.0 or newer, which rusqlite 0.41 pulls in. server/Cargo.toml pins rusqlite 0.32 with the bundled feature, so the vulnerable SQLite is compiled into the server binary. The owner reported the failing CI on 2026-11-10. The bump is a dependency change with a bundled C library behind it. So it is tracked and verified by the full server test suite, not patched silently.";
        :>> discoveredInField = false;
        :>> severity = Severity::Medium;
    }
    #Resolves dependency from rusqliteAuditBump to issue010;

    part issue011 : Issue {
        :>> id = "e9d2a793-5287-452d-a93b-0ba2177a266f";
        :>> title = "E2EE refusal-two mirror scan runs unbounded on every refused open";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> description = "Design residual from E2EE panel round 8, PESSIMIST-2 finding 3. The second refusal of Vault::open reads the four-byte magic of every file under vault/ to tell which stale file the operator must move aside. A refused open is never cached. So the scan runs on every request that reaches the vault while the refusal holds, at the client's slow retry. The walk has no size bound. On a large vault with many devices the cost is a full directory walk per retry. Acceptable for v1, because the state is an operator error that the body names and the retry is slow. The E2 sprint records the cost in its result. A later change caps the walk or memoises it on the directory mtime if a fleet ever hits it.";
        :>> discoveredInField = false;
        :>> severity = Severity::Low;
    }
    #Resolves dependency from e2eeMirrorScanCap to issue011;
}

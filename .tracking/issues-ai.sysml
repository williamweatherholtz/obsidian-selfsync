// Per-actor issues records for ai (issue210/srDcPerActorWriteTargets): new records
// route here so concurrent contributors never conflict at a shared append anchor.
package IssuesAi {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part issue007 : Issue {
        :>> id = "fb91c6d9-eb80-4e84-b049-27bb1cefdeac";
        :>> title = "A raw vault event for a synced FOLDER records an unsynced-edit claim no pass can settle; NTFS last-access updates re-fire it hourly per folder with no write";
        :>> createdAt = "2026-11-04";
        :>> createdBy = "ai";
        :>> description = "OBSERVATION (owner, st008, 2026-11-04). With 1.32.0 installed, the status detail read '7 unsynced edits: .obsidian/themes/Minimal (0s), .obsidian/plugins/quickadd (0s), ...'. The owner saw the same eleven items again and again. The vault log (info level) holds seventeen stale-claim warn lines on 2026-11-04, in three bursts (03:05Z, 07:19Z, 08:51Z). Every path is a FOLDER: eight synced plugin folders and two theme folders. Get-Item on each folder shows directory and file write times months old (quickadd 2026-07-17, themes/Minimal 2026-01-20). All of them share one last-access time, 17:31:42Z, inside a burst of settings-tab config renders. fsutil behavior query disablelastaccess reports 2 (last-access updates enabled). REPEATABLE RESULT (real Obsidian 1.12 on Windows 11, plugin built from HEAD 7f8467f, 2026-11-04). The check is client/e2e-obsidian/configclaim.pwspec.ts ARM B. It ages a synced plugin folder's last-access time two hours back with utimes. It then lists the folder five times from outside, with no write. Obsidian emits 'raw' with the FOLDER path eight times. The plugin's claim map then holds '.obsidian/plugins/testplugin'. The detail reads '1 unsynced edit: .obsidian/plugins/testplugin (0s)'. Two of five fresh launches sat on syncing for the whole 60 s baseline before any arm acted. The same folder claim appeared and vanished during that time. ARM A (a file write inside the folder) reports the file path and settles. ARM C (adapter list, stat, exists, read, readBinary, a walk, pluginSyncClean, a config scan) emits no folder event while the access time is fresh. MECHANISM, as read at 7f8467f. onRawConfigEvent (client/src/main.ts) buffers any path that passes shouldSync. shouldSync accepts a bare plugin or theme folder path. flushRawConfig then calls noteLocalChange for it, which records an unsynced-edit claim, and enqueues a per-path pass. A folder is never a synced item, so no pass settles that claim. NTFS persists a folder's last-access time at most hourly, on any listing. The config scan lists every synced folder every 30 s, so each folder re-fires about once an hour while the app is active. The settings tab re-renders its config section on each status change and walks the same folders. That is the feedback loop behind 400 section.config renders in one hour on 2026-11-04.";
        :>> discoveredInField = true;
        :>> severity = Severity::High;
    }
    #Resolves dependency from rawFolderEventNoClaim to issue007;
}

// =====================================================================
// ProjectUseCases — the goal-oriented interactions that connect a Persona to the Needs (2026-07-05).
// The layer that was missing when config-sync shipped untested: a use case names an actor + a goal
// and enumerates its scenarios (mainSuccess + extensions = alternate/failure flows), which is where
// multi-actor / multi-device permutations get surfaced ON PURPOSE. Each use case #DependsOn the
// Persona it serves and the Need it realizes; the executable form of its scenarios is the verify-
// linked acceptance Tests (see .tracking/verification/acceptance.sysml). The two config use cases
// whose scenarios reproduce the 0.10.4 escape are validated by those Tests via #Verify.
// =====================================================================
package ProjectUseCases {
    private import EngineElement::*;
    private import EngineNeeds::*;
    private import ProjectBusiness::*;

    use case ucFirstRunSetup : UseCase {
        :>> id = "c0f1a5cc-b001-4a10-9b20-a1b2c3d400a1"; :>> title = "First-run setup";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "A new user connects the plugin to their server and starts syncing a vault, without hand-editing opaque fields.";
        :>> mainSuccess = "The wizard opens on first run; the user enters the server URL and tests reachability; signs in (or creates an account); picks or creates a remote vault; the plugin begins syncing and the indicator goes green.";
        :>> extensions = "Server unreachable from a phone (LAN IP / localhost) -> the wizard explains to use the LAN IP or https address. | The server disallows new accounts -> the user is told to ask the admin for login details. | A pasted setup link prefills server+username and skips to sign-in.";
    }
    use case ucAddSecondDevice : UseCase {
        :>> id = "c0f1a5cc-b002-4a10-9b20-a1b2c3d400a2"; :>> title = "Add a second device";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "An already-syncing user brings a new device onto the same vault via a setup link.";
        :>> mainSuccess = "The user copies a setup link (server + username + vault, never the password) from device A; on device B pastes it, tests reachability, signs in, adopts the vault, and content downloads.";
        :>> extensions = "Device B is empty -> it auto-downloads the vault (defer to data), no prompt. | Device B already has content -> a one-time prompt to download / upload / merge. | The device name is auto-detected for conflict labelling if the user leaves it blank.";
    }
    use case ucContinuousNoteSync : UseCase {
        :>> id = "c0f1a5cc-b003-4a10-9b20-a1b2c3d400a3"; :>> title = "Keep notes synced continuously";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "Ongoing note/attachment edits propagate between devices with low latency.";
        :>> mainSuccess = "An edit on device A is pushed and, via the WebSocket channel, appears on device B near-instantly; edits made while offline reconcile on reconnect.";
        :>> extensions = "A large file is streamed to disk rather than buffered whole. | A file over the size limit is skipped with a one-time notice rather than failing the sync. | The server index is unavailable -> the client surfaces 'repair needed' and does not act on an empty manifest.";
    }
    use case ucConcurrentEdit : UseCase {
        :>> id = "c0f1a5cc-b004-4a10-9b20-a1b2c3d400a4"; :>> title = "Resolve concurrent edits to a note";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "The same note is edited on two devices before they sync.";
        :>> mainSuccess = "The client detects both changed against a common base, performs a three-way merge, and applies the clean merged result with nothing lost.";
        :>> extensions = "The changes cannot be merged cleanly (or the file is binary) -> both versions are preserved as a conflict copy, neither overwriting the other. | The server lost its index (empty manifest) -> the C2 guard refuses a bulk delete.";
    }
    use case ucSyncSetupAcrossDevices : UseCase {
        :>> id = "c0f1a5cc-b005-4a10-9b20-a1b2c3d400a5"; :>> title = "Sync my Obsidian setup across devices";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "A user's settings, themes, and community plugins follow them to another device.";
        :>> mainSuccess = "The user enables config sync per category on each device; opted-in settings/themes/plugins that exist on one device appear on the other (additive), leaving each device's own selection intact.";
        :>> extensions = "A device opted out of a category simply ignores those files (never records them, never deletes them elsewhere). | SelfSync's own plugin folder and credentials are never synced. | A device that never had a plugin receives it (defer to data).";
    }
    use case ucResolveConfigDifference : UseCase {
        :>> id = "c0f1a5cc-b006-4a10-9b20-a1b2c3d400a6"; :>> title = "Resolve a config difference across devices";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "Two devices have genuinely different config for the same file (e.g. different enabled-plugin lists). THIS is the scenario the 0.10.4 escape missed.";
        :>> mainSuccess = "The difference surfaces as 'Config differences (N)'; the user opens it and chooses, per file, to keep this device's version or take the other's; both devices converge on the choice.";
        :>> extensions = "Neither version is auto-overwritten and NO note-style conflict copy is created (which previously crashed the whole sync). | Nothing is resolved until the user chooses; each device keeps its own version meanwhile.";
    }
    use case ucRemoveOrKeepPlugin : UseCase {
        :>> id = "c0f1a5cc-b007-4a10-9b20-a1b2c3d400a7"; :>> title = "Remove (or keep) a plugin across devices";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "A plugin is present on one device and absent on another; the user decides whether the absence is a real removal.";
        :>> mainSuccess = "A removal on one device is neither silently propagated nor silently reversed; it is surfaced for adjudication, and the user chooses to propagate the removal or restore the plugin.";
        :>> extensions = "A device that NEVER held the plugin receives it automatically (defer to data), with no prompt. | A device that opted out of community plugins is never involved in the decision. | Choosing 'remove everywhere' propagates the deletion; choosing 'keep' restores it (user-chosen resurrection).";
    }
    use case ucMobileSync : UseCase {
        :>> id = "c0f1a5cc-b008-4a10-9b20-a1b2c3d400a8"; :>> title = "Sync on mobile";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "A mobile user syncs within phone constraints and sees state at a glance.";
        :>> mainSuccess = "Foreground sync runs on the phone; a single ribbon indicator shows sync state; an interrupted initial sync resumes rather than restarting.";
        :>> extensions = "A desktop-only plugin's files sync to the phone but never break it. | The in-editor indicator can be opted in where the ribbon is out of view.";
    }
    use case ucShareVault : UseCase {
        :>> id = "c0f1a5cc-b009-4a10-9b20-a1b2c3d400a9"; :>> title = "Share a vault with another user";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "An owner grants another account access to a vault at a chosen permission level.";
        :>> mainSuccess = "The owner grants a named user read-only or read-write access; the grantee sees the shared vault, selects it, and syncs it via owner-qualified routes.";
        :>> extensions = "A read-only grantee can pull but is never allowed to push (local edits kept as a local conflict copy). | A non-grantee is denied server-side. | The owner's other vaults and credentials are never exposed by the share.";
    }
    use case ucAdministerServer : UseCase {
        :>> id = "c0f1a5cc-b010-4a10-9b20-a1b2c3d400b0"; :>> title = "Administer the server";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "An operator manages accounts, shares, and registration through the admin surface.";
        :>> mainSuccess = "The operator opens the web admin UI, creates/removes accounts and vault shares, and sets registration to closed or open-with-invite.";
        :>> extensions = "A single-use invite token is consumed exactly once. | The admin UI never leaks password hashes or session tokens. | The server persists everything to its own filesystem storage with no external database.";
    }
    use case ucSwitchVault : UseCase {
        :>> id = "c0f1a5cc-b011-4a10-9b20-a1b2c3d400b1"; :>> title = "Switch which remote vault this vault syncs to";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "A user re-points a local vault at a different remote vault without re-entering server/account.";
        :>> mainSuccess = "Using the saved session, the user picks a different vault; if the local vault is empty it auto-downloads; otherwise a one-time prompt offers download / upload / merge.";
        :>> extensions = "Merge keeps everything (three-way merge or conflict copy on divergence, nothing lost). | A read-only shared target can only be downloaded. | Switching never touches SelfSync's own config. | DATA-SAFETY: switching/pointing at a WRONG, FRESH, or RESTORED server (a populated local vault against an empty/unfamiliar remote) NEVER deletes local files — a file absent from the remote WITHOUT a deletion tombstone is restored to the server, not destroyed; only a file the server actually TOMBSTONED is removed. The guard is DURABLE — repeated reconciles (even after the client's own pushes make the remote non-empty) never delete the kept files. This is the scenario the 0.10.25 data-loss escape missed.";
    }
    // The data-safety invariant as its OWN use case with adversarial scenarios — the class of case
    // the switch/continuous use cases only touched happy-path. Deletion is TOMBSTONE-authoritative:
    // absence is never proof of deletion. This is the executable meaning of 'never lose a note'.
    use case ucNeverLoseLocalData : UseCase {
        :>> id = "c0f1a5cc-b012-4a10-9b20-a1b2c3d400b2"; :>> title = "Never lose local data to a wrong/empty/restored server";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> description = "A local file is only ever deleted by sync when the server carries a REAL deletion tombstone for it — never on mere absence. Covers the wrong-server, fresh-server, restored-index, and stale-base permutations that silently deleted files before 0.10.25.";
        :>> mainSuccess = "The client reconciles against the server; a file the server has genuinely deleted (tombstone present) is removed locally; a file merely absent (no tombstone) is kept and restored to the server. Local content is never destroyed on absence alone.";
        :>> extensions = "Point a populated vault at an EMPTY/FRESH server -> every local file is restored, none deleted. | Point at a RESTORED/reindexed server missing many files (no tombstones) -> all missing files restored, none deleted (partial-shrink is not a mass delete). | Two reconciles in a row against such a server -> still no deletion on the second pass (durable, not a one-shot guard). | A genuine deletion on device A (tombstone) DOES propagate to device B. | A read-only shared target that lacks a file we hold -> kept locally, not pushed, not deleted.";
    }

    // ---- traceability: each use case serves a Persona (#DependsOn) and realizes a Need (#DependsOn) ----
    #DependsOn dependency from ucFirstRunSetup to selfHoster;
    #DependsOn dependency from ucFirstRunSetup to n1GuidedSetup;
    #DependsOn dependency from ucAddSecondDevice to selfHoster;
    #DependsOn dependency from ucAddSecondDevice to n1GuidedSetup;
    #DependsOn dependency from ucContinuousNoteSync to selfHoster;
    #DependsOn dependency from ucContinuousNoteSync to goal2SimpleBackend;
    #DependsOn dependency from ucConcurrentEdit to selfHoster;
    #DependsOn dependency from ucConcurrentEdit to n3ThreeWayMerge;
    #DependsOn dependency from ucConcurrentEdit to n3NeverClobber;
    #DependsOn dependency from ucSyncSetupAcrossDevices to selfHoster;
    #DependsOn dependency from ucSyncSetupAcrossDevices to nConfigSync;
    #DependsOn dependency from ucResolveConfigDifference to selfHoster;
    #DependsOn dependency from ucResolveConfigDifference to nConfigSync;
    #DependsOn dependency from ucRemoveOrKeepPlugin to selfHoster;
    #DependsOn dependency from ucRemoveOrKeepPlugin to nConfigSync;
    #DependsOn dependency from ucMobileSync to mobileUser;
    #DependsOn dependency from ucMobileSync to nxMobile;
    #DependsOn dependency from ucShareVault to collaborator;
    #DependsOn dependency from ucShareVault to nVaultSharing;
    #DependsOn dependency from ucAdministerServer to selfHostOperator;
    #DependsOn dependency from ucAdministerServer to nVaultSharing;
    #DependsOn dependency from ucSwitchVault to selfHoster;
    #DependsOn dependency from ucSwitchVault to nConfigSync;
    #DependsOn dependency from ucNeverLoseLocalData to selfHoster;
    #DependsOn dependency from ucNeverLoseLocalData to n3NeverClobber;
}

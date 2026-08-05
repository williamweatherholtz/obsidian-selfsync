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
        :>> extensions = "Server unreachable from a phone (LAN IP / localhost) -> the wizard explains to use the LAN IP or https address. | The server disallows new accounts -> the user is told to ask the admin for login details. | A pasted setup link prefills server+username and skips to sign-in. | An admin-created account is FORCED to set a new password before first use (IA.3.5.9) — the wizard prompts for it, then continues. | A pasted vault SHARE link routes to the redeem flow instead (see ucRedeemSharedVault).";
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
        :>> extensions = "A large file is streamed to disk rather than buffered whole. | A file over the per-device size limit is skipped with a one-time notice rather than failing the sync — the limit is CONFIGURABLE ('Max file size to sync', default 200 MB), and the server enforces its own ceiling (MAX_FILE_MB, default 512 MB); the effective cap is the smaller of the two. | The server index is unavailable -> the client surfaces 'repair needed' and does not act on an empty manifest. | A transient DNS/network failure is retried with backoff and self-heals (no user action).";
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
        :>> description = "An owner shares a vault they own — either by naming an existing account or by sending a single-use LINK (D0023) — at a chosen permission level (read-only / read-write). The grantee-side flow is ucRedeemSharedVault.";
        :>> mainSuccess = "From the vault they are CURRENTLY syncing, the owner opens Share and either adds a named account (read-only/read-write) OR creates a single-use share LINK to send out-of-band; the recipient gains access and syncs via owner-qualified routes.";
        :>> extensions = "Sharing applies ONLY to the vault you own and are currently syncing — not a picker over all your vaults (avoids sharing the wrong one). | A share link is shown once, is single-use (binds a normal grant to whoever redeems it), and can be revoked while still pending. | A read-only grantee can pull but is never allowed to push (local edits kept as a local conflict copy). | A non-grantee is denied server-side; a grantee may later leave/decline (see ucRedeemSharedVault). | The owner's other vaults and credentials are never exposed by the share.";
    }
    use case ucAdministerServer : UseCase {
        :>> id = "c0f1a5cc-b010-4a10-9b20-a1b2c3d400b0"; :>> title = "Administer the server";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> description = "An operator manages accounts, shares, and registration through the admin surface.";
        :>> mainSuccess = "The operator opens the web admin UI, creates/removes accounts and vault shares, and sets registration to closed or open-with-invite.";
        :>> extensions = "A single-use invite token is consumed exactly once. | The admin UI never leaks password hashes or session tokens. | The server persists everything to its own filesystem storage with no external database. | Privileged (server-admin) accounts can enrol TOTP MFA (IA.3.5.3), optionally REQUIRED via REQUIRE_ADMIN_MFA. | An admin-created or operator-reset account is forced to set a new password before use. | The operator can reindex/repair or delete a specific vault from the admin UI. | Usernames are lowercase-canonical (case-insensitive) and may be email addresses (incl. plus-addressing); the create form states the rule.";
    }
    use case ucDeployServer : UseCase {
        :>> id = "c0f1a5cc-b014-4a10-9b20-a1b2c3d400b4"; :>> title = "Stand up the sync server";
        :>> createdAt = "2026-07-12"; :>> createdBy = "wweatherholtz";
        :>> description = "An operator deploys the self-hostable server on infrastructure they control, behind TLS, with no external database (D0007 trusted-server + TLS-in-transit). Was implicit before; modeled 2026-07-12 to reflect the prebuilt-image + Compose deploy reality.";
        :>> mainSuccess = "The operator pulls the PREBUILT server image and runs it via the Docker Compose stack (bundled Caddy for automatic HTTPS, or their own reverse proxy); sets a strong SYNC_PASSWORD + the domain; the server comes up healthy and the plugin connects over https.";
        :>> extensions = "TLS is not optional for remote access — the server speaks plain HTTP/WS and MUST sit behind a TLS-terminating proxy; loopback http is allowed only for local testing. | The admin surface binds to a PRIVATE port by default (host-loopback / not through the public proxy); ADMIN_BIND_ADDR=merge opts into a single port. | The only operator knobs are the published PORT + a few envs (SYNC_USER/PASSWORD, REGISTRATION seed, MAX_FILE_MB, LOG_LEVEL); the internal bind address + data path are image-fixed (not tunable). | The server REFUSES to boot on the default/weak admin password unless ALLOW_WEAK_ADMIN=1. | REGISTRATION is a FIRST-RUN seed only — afterwards the policy is runtime-managed from /admin and persists. | All state lives in the mounted data volume (accounts, ACL, chunks, vault files) — back it up; no external DB. | A no-proxy Compose stack is provided for operators terminating TLS with their own proxy/tunnel.";
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

    // Grantee-side sharing (the flow that shipped untested at the use-case level, 1.0.20–1.0.25):
    // receiving access via a single-use LINK — including onboarding a not-yet-set-up device — and
    // later declining/leaving the share. Complements ucShareVault (owner-side). Added 2026-07-12.
    use case ucRedeemSharedVault : UseCase {
        :>> id = "c0f1a5cc-b013-4a10-9b20-a1b2c3d400b3"; :>> title = "Receive (and later leave) a shared vault via a link";
        :>> createdAt = "2026-07-12"; :>> createdBy = "wweatherholtz";
        :>> description = "A person sent a share link gains access to the owner's vault. The link carries only server + an opaque single-use token — the recipient need NOT already be set up (the link is the onboarding). They can later decline/leave the share, dropping their own access.";
        :>> mainSuccess = "The recipient opens the share link; if this device isn't signed in to that server the guided setup opens with the server PREFILLED from the link; they sign in (or create an account); the link is redeemed (a grant binds to their account); the shared vault appears under 'Shared with you' and syncs via owner-qualified routes.";
        :>> extensions = "Already signed in to that server -> redeem immediately, keep the current vault, prompt to Switch. | NOT set up (or a different server) -> the guided wizard prefills the link's server and finishes by redeeming + adopting the vault. | The account was admin-created (must-change) -> the wizard forces a new password first (no silent 403). | Single-use -> a second redeem of the same link is rejected. | LEAVE/DECLINE -> the grantee drops their OWN access (Switch -> Shared with you -> Leave): local files are kept, only their grant is removed (never the owner's or anyone else's), and if it was the vault being synced it disconnects. | A read-only grant pulls but never pushes.";
    }

    // ---- embedded-timestamp / conflict-noise use cases (2026-07-29) ----
    use case ucCopyPreservesTimestamp : UseCase {
        :>> id = "d7c1b001-0000-4a10-9b20-a1b2c3d400a1"; :>> title = "Copying a note preserves its true modified time";
        :>> createdAt = "2026-07-29"; :>> createdBy = "wweatherholtz";
        :>> description = "A note is copied or moved, or arrives via a tool that rewrites filesystem timestamps; its real last-changed time must not appear to change.";
        :>> mainSuccess = "The embedded `updated`/`created` values are unchanged by the copy (they are content, not filesystem metadata); on the next reconcile SelfSync recognizes the content is unchanged, keeps the older embedded time, and restores the filesystem mtime (and creation time on Windows/macOS) from the embedded value.";
        :>> extensions = "A spurious filesystem-time bump alone (content identical) is never pushed and never raises a diff. | On Linux the creation time cannot be set, so only mtime is restored. | On mobile, filesystem times are best-effort; the embedded value stays authoritative.";
    }
    use case ucTimestampOnlyNoConflict : UseCase {
        :>> id = "d7c1b002-0000-4a10-9b20-a1b2c3d400a2"; :>> title = "Two devices differ only in a timestamp — no conflict";
        :>> createdAt = "2026-07-29"; :>> createdBy = "wweatherholtz";
        :>> description = "The same note exists on two devices with identical body content but a different embedded `updated` (each device re-stamped it, or one was copied).";
        :>> mainSuccess = "SelfSync compares by normalized content (managed timestamp keys masked), finds the versions logically identical, auto-resolves without a conflict copy, and keeps the earliest `created` and the older `updated`.";
        :>> extensions = "If the content genuinely differs as well, the normal three-way merge / conflict-copy path runs unchanged and the merged result takes a fresh `updated`. | A note in an excluded folder is left entirely alone (see ucExcludedFolderUntouched).";
    }
    use case ucExcludedFolderUntouched : UseCase {
        :>> id = "d7c1b003-0000-4a10-9b20-a1b2c3d400a3"; :>> title = "Excluded folders are left completely alone";
        :>> createdAt = "2026-07-29"; :>> createdBy = "wweatherholtz";
        :>> description = "A user designates certain vault folders that SelfSync must not manage timestamps for (generated or externally-owned notes).";
        :>> mainSuccess = "The user adds a folder to the Excluded folders list (with path autocomplete); SelfSync never reads or writes the managed timestamp fields for notes under that folder and never drives their filesystem times — those notes sync by content exactly as before.";
        :>> extensions = "Removing a folder from the list resumes management on its next genuine change. | A path not under any excluded folder is managed normally. | Excluding a folder never deletes or rewrites frontmatter already present in those notes.";
    }

    // ===== Backfill (2026-08-03, owner-directed): use cases for organically-discovered capabilities =====
    // (ucEnableMfa "Add a second factor" was RETIRED by D0038 (2026-08-05) — MFA is deprecated; the
    // flag-gated code is retained, but the use case no longer applies while MFA is off.)
    use case ucChangePassword : UseCase {
        :>> id = "c0f1a5cc-b202-4a10-9b20-a1b2c3d402a2"; :>> title = "Change my password and end other sessions";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "A user whose password may have leaked (or who just wants to rotate it) changes it themselves, without an admin.";
        :>> mainSuccess = "The user enters the current + new password; the change succeeds, every OTHER session is revoked, and this device keeps a fresh token — so a leaked credential can be self-remediated.";
        :>> extensions = "Other token-only devices are told they'll need the new password to sign back in. | Repeated wrong current-password guesses are throttled. | An admin can reset a forgotten password, which forces a change on next use.";
    }
    use case ucManageAccounts : UseCase {
        :>> id = "c0f1a5cc-b203-4a10-9b20-a1b2c3d402a3"; :>> title = "Manage accounts on my server";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "The operator manages the people with accounts on the server from the admin console.";
        :>> mainSuccess = "From /admin the operator lists accounts and can create one, delete one, promote/revoke admin, reset a password, and inspect any account's vaults + health — no file editing, no database.";
        :>> extensions = "A password reset is temporary — the account must set a new one on next use, and its sessions are revoked. | The bootstrap admin can't be deleted or demoted. | Account-admin actions aren't reachable on the public port (the admin surface is private by default).";
    }
    use case ucControlRegistration : UseCase {
        :>> id = "c0f1a5cc-b204-4a10-9b20-a1b2c3d402a4"; :>> title = "Control who can register";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "The operator decides whether new accounts can be created, and hands out invites when registration is closed.";
        :>> mainSuccess = "The operator toggles registration open or closed; when closed, they issue a labelled single-use invite (a token or a copyable account-creation link) that lets exactly one person register, and can revoke an unused invite.";
        :>> extensions = "Registration is CLOSED by default. | A used or revoked invite can't be reused. | A vault share link also authorizes one account creation under closed registration (see ucOnboardFromShareLink).";
    }
    use case ucOnboardFromShareLink : UseCase {
        :>> id = "c0f1a5cc-b205-4a10-9b20-a1b2c3d402a5"; :>> title = "Join from a vault share link as a new user";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "Someone with no account yet receives a vault share link and gets onto the shared vault in one flow — the link is the whole onboarding (D0037).";
        :>> mainSuccess = "Opening the link, the newcomer chooses Create account (or Log in); a valid single-use link authorizes the new account EVEN when registration is closed; the account is created, the share is redeemed, and the device adopts the shared vault — signed in and syncing.";
        :>> extensions = "If they already have an account they sign in and redeem instead. | The link is single-use; a username collision costs the link (one-shot), and the owner can revoke a pending link. | Account creation + grant + session are atomic — a failure leaves no orphan account and no burned link.";
    }
    use case ucOnboardFromAccountLink : UseCase {
        :>> id = "c0f1a5cc-b206-4a10-9b20-a1b2c3d402a6"; :>> title = "Create an account from an account-creation link";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "The operator sends a new person a selfsync-invite:// account-creation link so they can make an account without the server being open to the public.";
        :>> mainSuccess = "The newcomer pastes the link into SelfSync setup; the server + single-use invite are prefilled; they pick a username + password and their account is created even though open registration is closed; they then set up sync normally.";
        :>> extensions = "The invite is single-use and revocable. | Unlike a vault share link, this attaches no vault — it just makes the account. | The link carries no password, only the server + invite token.";
    }
    use case ucCheckSyncState : UseCase {
        :>> id = "c0f1a5cc-b207-4a10-9b20-a1b2c3d402a7"; :>> title = "Trust what the UI says about sync";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "A user glances at SelfSync to answer 'are my notes safely synced right now?' and can rely on the answer.";
        :>> mainSuccess = "One indicator (ribbon + status card) shows the true state — Fully synced / Syncing N pending / Reconnecting / Read-only — as a pure projection of the sync engine; when healthy it reads synced and the user trusts it.";
        :>> extensions = "When the link is down it turns and NAMES the actionable cause (sign-in / version mismatch / vault gone / reconnecting) with a Reconnect action — it never falsely reads 'synced'. | It never gets stuck on a stale 'Switching…'/'Connecting…'. | On mobile (no status bar) a command speaks the state as a toast.";
    }
    use case ucRepairVault : UseCase {
        :>> id = "c0f1a5cc-b208-4a10-9b20-a1b2c3d402a8"; :>> title = "Repair a degraded vault";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "A vault's server-side index is degraded (corrupt, or empty-with-data on disk); the operator gets it healthy again.";
        :>> mainSuccess = "Most degraded vaults auto-reindex from disk on next access; for the rest, the operator clicks Repair (plugin or admin console) and the manifest is rebuilt from the materialized files, clearing the error and re-syncing connected clients.";
        :>> extensions = "A health chip flags which vaults need repair; a healthy vault shows none. | Force-reindex drops truly-unrecoverable entries so the rest of the vault is saved. | Storage stays bounded meanwhile via orphan-chunk GC + a deliberate tombstone prune.";
    }
    use case ucReviewAuditLog : UseCase {
        :>> id = "c0f1a5cc-b209-4a10-9b20-a1b2c3d402a9"; :>> title = "Review the security audit trail";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "The operator reviews what security-relevant actions happened on the server, for accountability or a compliance posture.";
        :>> mainSuccess = "Every security event (sign-in success/failure, lockout, account/registration/invite/share/vault/admin change, authorization denial) is emitted as one structured JSON line with who/what/when/outcome/source-IP, which the operator collects and reviews.";
        :>> extensions = "Log fields are injection-hardened (control chars stripped, bounded length). | The posture maps to CMMC L2 / NIST 800-171 AU controls; CUI-specific controls are formally N/A for a no-CUI deployment (D0027).";
    }
    use case ucSyncSelfHeals : UseCase {
        :>> id = "c0f1a5cc-b20a-4a10-9b20-a1b2c3d402aa"; :>> title = "Sync recovers on its own after a drop";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "The connection drops (network blip, server restart, laptop sleep, mobile suspend); sync comes back without the user doing anything.";
        :>> mainSuccess = "The client detects the dropped WebSocket, backs off and reconnects on its own, re-reconciles only what changed, and the indicator returns to Fully synced — no manual reconnect needed.";
        :>> extensions = "On mobile resume, a suspended backoff timer is re-triggered proactively so it doesn't stall. | A whole-server outage backs off once instead of flooding per-file errors. | The user can still force an immediate Reconnect.";
    }
    use case ucManageVaults : UseCase {
        :>> id = "c0f1a5cc-b20b-4a10-9b20-a1b2c3d402ab"; :>> title = "Create, switch, fork, or delete a vault";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "A user keeps more than one vault and moves this device between them, or spins up / tears down a vault.";
        :>> mainSuccess = "From the switcher the user creates a new named vault, switches this device to another owned or shared vault (download/upload/merge, destructive modes confirmed), forks the current content into a new vault they own, or deletes a vault they own.";
        :>> extensions = "If the server vault was deleted, the client offers Re-create from this device rather than losing data. | Forking a read-only share gives an editable copy without touching the original. | Switching never silently deletes local-only or remote-only files without confirmation.";
    }
    use case ucMigrateFromLiveSync : UseCase {
        :>> id = "c0f1a5cc-b20c-4a10-9b20-a1b2c3d402ac"; :>> title = "Migrate off obsidian-livesync";
        :>> createdAt = "2026-08-03"; :>> createdBy = "wweatherholtz";
        :>> description = "A LiveSync user moves to SelfSync to escape CouchDB + confusing settings while keeping free, strong conflict resolution.";
        :>> mainSuccess = "They stand up the single-binary server (no CouchDB), install the plugin via BRAT, run the guided setup on their existing vault, and their notes + customizations sync with un-paywalled three-way merge and a status they can understand.";
        :>> extensions = "Their themes/snippets/plugins travel via opt-in config sync without one device wiping another. | Nothing is lost pointing a full vault at a fresh server (restore + never-clobber guards). | Each setting has one clear home, unlike LiveSync's toggle maze.";
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
    #DependsOn dependency from ucRedeemSharedVault to collaborator;
    #DependsOn dependency from ucRedeemSharedVault to nVaultSharing;
    #DependsOn dependency from ucDeployServer to selfHostOperator;
    #DependsOn dependency from ucDeployServer to goal2SimpleBackend;
    #DependsOn dependency from ucCopyPreservesTimestamp to selfHoster;
    #DependsOn dependency from ucCopyPreservesTimestamp to nTimestampFidelity;
    #DependsOn dependency from ucTimestampOnlyNoConflict to selfHoster;
    #DependsOn dependency from ucTimestampOnlyNoConflict to nNoMetadataConflicts;
    #DependsOn dependency from ucExcludedFolderUntouched to selfHoster;
    #DependsOn dependency from ucExcludedFolderUntouched to nTimestampFidelity;

    // ---- backfill traceability (2026-08-03) ---- (ucEnableMfa edges removed with its retirement, D0038)
    #DependsOn dependency from ucChangePassword to selfHoster;
    #DependsOn dependency from ucChangePassword to nAccountSecurity;
    #DependsOn dependency from ucManageAccounts to selfHostOperator;
    #DependsOn dependency from ucManageAccounts to nAccountAdministration;
    #DependsOn dependency from ucControlRegistration to selfHostOperator;
    #DependsOn dependency from ucControlRegistration to nAccountAdministration;
    #DependsOn dependency from ucOnboardFromShareLink to collaborator;
    #DependsOn dependency from ucOnboardFromShareLink to nOnboardNewUser;
    #DependsOn dependency from ucOnboardFromAccountLink to collaborator;
    #DependsOn dependency from ucOnboardFromAccountLink to nOnboardNewUser;
    #DependsOn dependency from ucCheckSyncState to selfHoster;
    #DependsOn dependency from ucCheckSyncState to nHonestStatus;
    #DependsOn dependency from ucCheckSyncState to n1SingleIndicator;
    #DependsOn dependency from ucRepairVault to selfHostOperator;
    #DependsOn dependency from ucRepairVault to nVaultHealth;
    #DependsOn dependency from ucReviewAuditLog to selfHostOperator;
    #DependsOn dependency from ucReviewAuditLog to nAuditability;
    #DependsOn dependency from ucSyncSelfHeals to selfHoster;
    #DependsOn dependency from ucSyncSelfHeals to nReliableSync;
    #DependsOn dependency from ucManageVaults to selfHoster;
    #DependsOn dependency from ucManageVaults to nVaultManagement;
    #DependsOn dependency from ucMigrateFromLiveSync to migratingUser;
    #DependsOn dependency from ucMigrateFromLiveSync to goal2SimpleBackend;
    // Tie the existing general admin use case to the new administration Need too.
    #DependsOn dependency from ucAdministerServer to nAccountAdministration;
}

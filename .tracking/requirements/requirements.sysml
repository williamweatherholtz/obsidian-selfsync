// =====================================================================
// ProjectRequirements — the SystemRequirement cascade for SelfSync (backfilled 2026-07-04,
// D0004). Each SR is `satisfy`-linked to the Need it serves (native satisfy edge). EARS-style
// statements describe WHAT the shipped system does; verification is carried by the delivery
// DoD Tests (see .tracking/delivery/) per the engine idiom — `verify X by Y` is not native.
// =====================================================================
package ProjectRequirements {
    private import EngineElement::*;
    private import EngineRequirements::*;
    private import EngineNeeds::*;
    private import ProjectBusiness::*;

    // ---- Goal 1: clear, guided configuration ----
    requirement srClearConfig : SystemRequirement {
        :>> id = "a350e111-cdc7-4872-a08b-08beae027d6d";
        :>> title = "Status-first, guided configuration surface";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin shall present configuration through a guided first-run wizard and a status-first settings tab, replacing free-form opaque fields.";
        :>> rationale = "Directly answers LiveSync's confusing-config pain (goal #1).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srGuidedWizard : SystemRequirement {
        :>> id = "cef56784-ed23-4bc2-b4ee-c44bfe31713a";
        :>> title = "Setup wizard walks through connect + vault choice";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "On first run the plugin shall open a setup wizard that steps the user through server connection, sign-in, and vault selection, auto-opening when unconfigured.";
        :>> rationale = "New users must reach a working sync without hand-editing fields.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srSettingsOneHome : SystemRequirement {
        :>> id = "23d7ffcb-9da9-4c05-b009-9364c884a954";
        :>> title = "Settings grouped one-home-per-concern";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The settings tab shall group controls into Setup & transitions, Connection, What syncs, and Advanced, with each setting appearing in exactly one place.";
        :>> rationale = "Eliminates duplicate/contradictory controls (a LiveSync pain).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement srSingleIndicator : SystemRequirement {
        :>> id = "6aaa0e2c-e90e-42c3-9896-8450fd19cf56";
        :>> title = "One state indicator per platform";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin shall show exactly one sync-state indicator per platform — the status bar on desktop, the ribbon on mobile — colour+glyph coded, with an optional opt-in in-editor indicator.";
        :>> rationale = "Multiple indicators for one state is an anti-pattern (goal #1).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Goal 2: simple, fast backend without CouchDB ----
    requirement srSimpleBackend : SystemRequirement {
        :>> id = "0f6c4817-0973-47f7-9c30-cb49cbf3d889";
        :>> title = "Single self-contained server, no external database";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall run as a single Rust (axum) binary that persists all state to its own filesystem storage, requiring no CouchDB or external database.";
        :>> rationale = "Removes LiveSync's single biggest operational burden.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srSingleBinary : SystemRequirement {
        :>> id = "0da5a2bb-a6ee-42c6-b57f-42095a96e496";
        :>> title = "Content-addressed, durable storage";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall store file content as content-addressed chunks with a persistent, schema-versioned index (per-vault SQLite/WAL, D0018), transactional all-or-nothing durability, and orphan GC that runs both at first-access/open and opportunistically at runtime (lazy, not only at boot — RS-1 handle eviction re-runs it on reopen and SEC#4 sweeps abandoned uploads).";
        :>> rationale = "Own-storage backend must be durable and self-healing without a DBMS.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srContentDedup : SystemRequirement {
        :>> id = "afb30d1f-f384-4e40-bccc-1de93b399b1c";
        :>> title = "Deduplicated chunk transfer + storage";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The client and server shall use content-defined chunking so unchanged and duplicated content is neither re-uploaded (chunks/missing) nor re-stored.";
        :>> rationale = "Efficiency for large vaults; avoids resending whole files on edit.";
        :>> kind = RequirementKind::nonFunctional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srConcurrentPerf : SystemRequirement {
        :>> id = "fb76b24b-ef72-4f0d-97bc-94e350266af8";
        :>> title = "Concurrent reads + large-file safety";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall serve reads and chunk uploads concurrently (per-vault RwLock) so one client's large transfer does not block another's reads, and shall bound file/chunk sizes to protect memory.";
        :>> rationale = "Responsiveness for large vaults/files without a database's concurrency.";
        :>> kind = RequirementKind::nonFunctional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Goal 3: strong, un-paywalled conflict merge ----
    requirement srConflictMerge : SystemRequirement {
        :>> id = "ee6f94a6-9761-4e57-94f7-d7c99b40b3b0";
        :>> title = "Conflict-safe reconciliation, free";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The client shall reconcile concurrent changes with a base-aware decision table that never silently overwrites, and this behaviour shall be available to all users at no cost.";
        :>> rationale = "The un-paywalled conflict-safety differentiator (goal #3).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srThreeWayMerge : SystemRequirement {
        :>> id = "49a554d2-e09f-4e2e-8c9e-8b4908b7c954";
        :>> title = "Three-way merge of concurrent text edits";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "When a text file changed on both sides against a common base, the client shall attempt a three-way (diff3) merge and, if clean, apply the merged result.";
        :>> rationale = "Non-conflicting concurrent edits should just merge.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srNeverClobber : SystemRequirement {
        :>> id = "e519b339-cc72-4cf4-a786-6ea8b103bfcd";
        :>> title = "Never clobber: conflict-copy on unmergeable divergence";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "When divergent changes cannot be merged cleanly (or a file is binary), the client shall preserve both versions via a conflict copy rather than overwriting either.";
        :>> rationale = "No user may ever silently lose data (goal #3).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srFreeMerge : SystemRequirement {
        :>> id = "40748de6-a31c-4448-ac35-3635f0220c46";
        :>> title = "No feature gating / paywall";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin and server shall gate no sync, conflict, or merge capability behind payment, sponsorship, or a licence check.";
        :>> rationale = "LiveSync paywalls its best merge; SelfSync does not.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::inspect;
    }

    // ---- Config/customization sync (CR d0011, 2026-07-05 — roots the previously-orphan feature) ----
    requirement srConfigSelective : SystemRequirement {
        :>> id = "c0f1a5cc-2001-4a10-9b20-a1b2c3d40011";
        :>> title = "Selective, per-category config sync";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin shall sync the .obsidian config surface only per an explicit per-category opt-in (core, hotkeys, appearance, snippets, community plugins), shall never sync unrecognized .obsidian files, and shall never sync SelfSync's own plugin folder or credentials.";
        :>> rationale = "Config sync must be intentional + safe; credentials must never enter the vault.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srConfigAdditiveSafe : SystemRequirement {
        :>> id = "c0f1a5cc-2002-4a10-9b20-a1b2c3d40012";
        :>> title = "Config removals propagate only from a device that held the data";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "A config deletion shall propagate to other devices (auto-remove) ONLY when it originates from a device that genuinely held the file (an evidenced removal); a device that never held or has opted out of a path shall never cause its deletion elsewhere, a device that never held a plugin receives it (defer to data), and a removed file is never automatically pulled back (no resurrection).";
        :>> rationale = "A replica without the data must never manufacture its deletion (the resurrection twin, the 0.10.4 loss bug); the accepts() gate makes a delete an evidenced tombstone, so genuine removals can safely propagate (D0013).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srConfigAdjudication : SystemRequirement {
        :>> id = "c0f1a5cc-2003-4a10-9b20-a1b2c3d40013";
        :>> title = "Config divergence is user-adjudicated";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "When the SAME config file is edited differently on two devices (a genuine divergence), the plugin shall not create a note-style conflict copy and shall not silently overwrite either side; the difference is surfaced for the user to choose which side wins. A removal is not a divergence — it propagates (see srConfigAdditiveSafe).";
        :>> rationale = "A note-style conflict copy of a config file is filtered out and crashed the whole sync (0.10.4); a same-file difference is genuinely ambiguous, so the user decides. Removals are handled by srConfigAdditiveSafe, not here (D0013).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srConfigLiveDetect : SystemRequirement {
        :>> id = "c0f1a5cc-2005-4a10-9b20-a1b2c3d40015";
        :>> title = "Local config changes are detected while connected";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin shall detect a local config change (adding, editing, or removing a plugin/theme/setting) and sync it PROMPTLY while connected, without requiring a reconnect: event-driven via the low-level raw adapter event where the platform fires it (desktop), with a periodic reconcile as the fallback (mobile) — because hidden .obsidian files fire no standard vault event and a local change does not advance the server version.";
        :>> rationale = "Config changes were previously synced only at connect time (no standard hidden-file events; the incremental poll short-circuits on unchanged server version), so a removal appeared to do nothing; the raw event makes it event-driven on desktop, the poll covers mobile where raw is unreliable (D0013).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement srSyncRobust : SystemRequirement {
        :>> id = "c0f1a5cc-2004-4a10-9b20-a1b2c3d40014";
        :>> title = "One file's failure never aborts the whole sync";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The client shall isolate per-file reconcile failures so that one file's error is logged and skipped without aborting reconciliation of the other files.";
        :>> rationale = "A single filtered conflict-copy push once threw and killed every file's sync (the 0.10.4 crash).";
        :>> kind = RequirementKind::nonFunctional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Continuous-sync reliability (Batch 1, from the use-case functional decomposition) ----
    requirement srServerApi : SystemRequirement {
        :>> id = "c0f1a5cc-e001-4a10-9b20-a1b2c3d40201";
        :>> title = "HTTP sync API surface";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall expose, over HTTP(S), a health/status endpoint, account register + login (returning a session token), vault list + create, and the sync operations changes/commit/get-chunk/put-chunk/delete — the complete contract the client drives.";
        :>> rationale = "The onboarding + continuous-sync use cases depend on this concrete API contract being stated, not just implemented.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srInstantPush : SystemRequirement {
        :>> id = "c0f1a5cc-e002-4a10-9b20-a1b2c3d40202";
        :>> title = "WebSocket instant push";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall push a change notification to connected clients over a WebSocket channel so a remote change is reflected on other devices in near real time, not only on the next poll.";
        :>> rationale = "Continuous note sync needs low-latency propagation between devices.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srIncrementalSync : SystemRequirement {
        :>> id = "c0f1a5cc-e003-4a10-9b20-a1b2c3d40203";
        :>> title = "Incremental version-cursor sync";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The client shall track the server's version and reconcile incrementally — an idle poll does one cheap check and only fully reconciles when the server advances (or a periodic config scan is due) — so steady state is inexpensive.";
        :>> rationale = "Avoids re-listing the whole vault on every poll; keeps idle cost low (goal #2 responsiveness).";
        :>> kind = RequirementKind::nonFunctional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srSelfHealingReconnect : SystemRequirement {
        :>> id = "c0f1a5cc-e004-4a10-9b20-a1b2c3d40204";
        :>> title = "Self-healing reconnect";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "On a dropped connection or transient error the client shall reconnect on its own with backoff, at most one attempt in flight, resuming polling + the WebSocket on success and ceasing on plugin unload.";
        :>> rationale = "Mobile/flaky-network use requires recovery without user action (nReliableSync).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }

    // ---- Data-safety + durability (Batch 2) ----
    requirement srDegradedServerGuard : SystemRequirement {
        :>> id = "c0f1a5cc-e005-4a10-9b20-a1b2c3d40205";
        :>> title = "Refuse to act on a degraded or empty server";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The client shall not reconcile against a server reporting a not-ready/corrupt index, and shall refuse a bulk delete-local when the server manifest is empty while local base history is non-empty (the C2 guard) — surfacing the condition instead of destroying local files.";
        :>> rationale = "Server data loss or a reindex reset must never cascade into wiping the user's local vault (goal #3, never lose data).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srDurableIndex : SystemRequirement {
        :>> id = "c0f1a5cc-e006-4a10-9b20-a1b2c3d40206";
        :>> title = "Crash-safe append-only index journal";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall persist the vault index as an append-only journal (absolute Put/Del records) that replays on reopen, discards a torn trailing record, errors on a malformed complete record, recomputes chunk-refs from files, and compacts past a threshold — never rewriting the whole index per change.";
        :>> rationale = "Durability + cheap large-vault writes without a database (D0010); protects the index across crashes.";
        :>> kind = RequirementKind::nonFunctional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Large-file performance (Batch 3) ----
    requirement srStreamedTransfer : SystemRequirement {
        :>> id = "c0f1a5cc-e007-4a10-9b20-a1b2c3d40207";
        :>> title = "Streamed + parallel large-file transfer";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "Large downloads shall stream to disk on desktop (holding ~one chunk in memory) and buffer on mobile; chunk transfer shall be parallelized within a bounded pool; a file over the size cap shall be skipped with a one-time notice rather than failing the sync.";
        :>> rationale = "Large vaults/attachments must sync without exhausting memory or blocking, especially on mobile (goal #2 performance).";
        :>> kind = RequirementKind::nonFunctional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srResumableInitialSync : SystemRequirement {
        :>> id = "c0f1a5cc-e008-4a10-9b20-a1b2c3d40208";
        :>> title = "Interrupted sync resumes, not restarts";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "An interrupted initial or large sync shall continue on the next reconcile without re-downloading already-written files or re-uploading existing chunks — via idempotent reconciliation, a persisted base, and content-addressed dedup.";
        :>> rationale = "Mobile/flaky-network initial sync must make forward progress across drops (nReliableSync).";
        :>> kind = RequirementKind::nonFunctional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Vault management + onboarding (Batch 4) ----
    requirement srVaultSwitch : SystemRequirement {
        :>> id = "c0f1a5cc-e009-4a10-9b20-a1b2c3d40209";
        :>> title = "Switch which remote vault a local vault syncs to";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The client shall let a user re-point a local vault at a different remote vault reusing the saved session: an empty local vault auto-downloads; a non-empty one prompts a one-time download / upload / merge, resetting the stale base; the switch shall never touch SelfSync's own config.";
        :>> rationale = "Users move a vault between servers/vaults and must not lose local content or re-enter credentials (nVaultManagement).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srSetupLink : SystemRequirement {
        :>> id = "c0f1a5cc-e010-4a10-9b20-a1b2c3d40210";
        :>> title = "Device-onboarding link carries no secret";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin shall generate and parse a setup link that carries the server, username, and optional vault ONLY — never a password or token — and parsing shall prefill setup and land on the reachability test (a link's LAN URL may not resolve on another device).";
        :>> rationale = "Fast second-device onboarding without ever transmitting a credential (nVaultManagement + nxSecurity).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srDeviceIdentity : SystemRequirement {
        :>> id = "c0f1a5cc-e011-4a10-9b20-a1b2c3d40211";
        :>> title = "Per-device name for conflict labelling";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "Each device shall have a name used to label conflict copies. When the user leaves it blank it is auto-detected best-effort — on Android via UA Client Hints (getHighEntropyValues['model'], which survives UA reduction) then the UA string, on iOS as 'iPhone'/'iPad' (no web API exposes the model), else a platform label with architecture tokens stripped — and a user-set name always overrides (shown as a muted placeholder).";
        :>> rationale = "Conflict copies + adjudication need to name the origin device; the canonical web way to get the real Android model is UA Client Hints, while iOS/WebKit exposes nothing beyond iPhone/iPad, so the field is the authoritative override (D0015).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Config completeness + sharing/admin split (Batch 5) ----
    requirement srConfigReload : SystemRequirement {
        :>> id = "c0f1a5cc-e012-4a10-9b20-a1b2c3d40212";
        :>> title = "Applied config takes effect without restart";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "After writing a synced config file, the plugin shall reload the affected surface (community plugins, appearance, hotkeys, snippets) so a synced change takes effect without the user restarting Obsidian, best-effort.";
        :>> rationale = "Config sync is only useful if a pulled setting/plugin actually applies (nConfigSync).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement srConfigAdjudicationUI : SystemRequirement {
        :>> id = "c0f1a5cc-e013-4a10-9b20-a1b2c3d40213";
        :>> title = "Pending config differences persist and have a resolution UI";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "Config differences awaiting adjudication shall surface as a 'Config differences (N)' entry counting GROUPED items — at most one per plugin (all its files as one), each labelled by purpose (not a raw filename) — resolvable in one click per group (this device / synced version), and the count shall self-clear as items resolve (a pending entry is pruned when its path reconciles cleanly) so it never shows a stale number.";
        :>> rationale = "Divergence adjudication (srConfigAdjudication) needs a durable queue + a way for the user to act on it (nConfigSync).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement srReadOnlyGating : SystemRequirement {
        :>> id = "c0f1a5cc-e014-4a10-9b20-a1b2c3d40214";
        :>> title = "Read-only share never pushes from the client";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "When the current vault is a read-only share, the client shall never push or delete on the server; a local edit shall be kept as a LOCAL-only conflict copy so it is not lost, and the owner's version stays canonical.";
        :>> rationale = "Client-side enforcement complements the server ACL so a reader can't even attempt a write (nVaultSharing).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srRegistrationPolicy : SystemRequirement {
        :>> id = "c0f1a5cc-e015-4a10-9b20-a1b2c3d40215";
        :>> title = "Admin-controlled registration policy";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall support a registration policy of closed (admin-created accounts only) or open, and single-use invite tokens (hashed, consumed exactly once) for discrete sign-ups when closed.";
        :>> rationale = "Operators need to control who can create accounts without opening the server to the world (nVaultSharing).";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srAdminSurface : SystemRequirement {
        :>> id = "c0f1a5cc-e016-4a10-9b20-a1b2c3d40216";
        :>> title = "Role-checked admin API + web UI, no secret leakage";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall expose a role-checked /api/admin/* JSON API and a web admin UI for account and share management, and shall never return password hashes or session tokens in any response.";
        :>> rationale = "Managing accounts/shares needs a real admin surface that can't itself leak credentials (nVaultSharing).";
        :>> kind = RequirementKind::security; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Cross-cutting ----
    requirement srMobile : SystemRequirement {
        :>> id = "67fec7e1-dec2-4c81-80be-86ba20c5c1ca";
        :>> title = "Desktop + mobile support";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin shall run on both desktop and mobile Obsidian (isDesktopOnly:false), using requestUrl transport and a pure-TS chunker/hasher with no desktop-only dependencies.";
        :>> rationale = "Mobile is a first-class target.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::demo;
    }
    requirement srSecurity : SystemRequirement {
        :>> id = "6df2e66f-bb6c-46ae-a97a-ff2eb2a4ac37";
        :>> title = "Secure transport + own-credentials never sync";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "Passwords shall be stored argon2id-hashed server-side; transport shall run over TLS (reverse proxy); and SelfSync's own plugin folder + credentials (server, login, token) shall be excluded from sync so they never enter the vault.";
        :>> rationale = "Trusted-server model; credentials must never leak into synced content.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Vault sharing (design pending; see docs/design/specs/2026-07-04-vault-sharing-design.md) ----
    requirement srVaultSharing : SystemRequirement {
        :>> id = "4d901a5a-1b47-4ba3-b9b1-31f71b9b2fa1";
        :>> title = "Server-enforced vault sharing + web admin";
        :>> createdAt = "2026-07-04"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall maintain a per-vault access-control list (owner-plus-grantees with read/read-write), enforce it server-side on owner-qualified vault routes, support an admin-controlled registration policy (closed/open + single-use invite tokens), and serve a web admin UI (over a /api/admin JSON authority) for account and share management.";
        :>> rationale = "Lets owners collaborate/share without breaking isolation for non-grantees; management needs a real admin surface.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- embedded-timestamp / conflict-noise requirements (2026-07-29) ----
    requirement srEmbeddedTimestamp : SystemRequirement {
        :>> id = "d7c15001-0000-4a10-9b20-a1b2c3d40051";
        :>> title = "SelfSync-owned embedded created/updated timestamps";
        :>> createdAt = "2026-07-29"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin shall maintain authoritative `created` and `updated` timestamps (full ISO 8601 with UTC offset; keys configurable) in a managed note's YAML frontmatter, shall stamp `updated` only when it detects a genuine content change, and shall inject a frontmatter block where absent for in-scope notes; when first seeding a note that has no managed fields it shall initialize `created` from the file's existing creation time and `updated` from its modification time (TFile.stat / OS metadata), falling back to the current time only when that metadata is unavailable.";
        :>> rationale = "SelfSync, as the sync engine, is the only component that knows when a change is genuine; owning the field avoids the per-device re-stamp churn that editor-event plugins cause. ISO-8601-with-offset is standard, human-readable, and unambiguous. Seeding from existing file metadata (not 'now') means adopting a pre-existing vault preserves each note's real history rather than marking every old note as just-created.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srNormalizedIdentity : SystemRequirement {
        :>> id = "d7c15002-0000-4a10-9b20-a1b2c3d40052";
        :>> title = "Content identity ignores managed timestamp fields";
        :>> createdAt = "2026-07-29"; :>> createdBy = "wweatherholtz";
        :>> statement = "When comparing note versions for change detection and conflict resolution, the plugin shall use a normalized content hash that excludes the managed timestamp keys and normalizes YAML key order and line endings, so a difference confined to those keys is not treated as a content change.";
        :>> rationale = "Git-model content-addressing: masking the volatile field before hashing turns timestamp-only diffs into non-events and prevents SelfSync's own stamping from causing a sync loop.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srTimestampConflictResolve : SystemRequirement {
        :>> id = "d7c15003-0000-4a10-9b20-a1b2c3d40053";
        :>> title = "Auto-resolve timestamp-only differences, keeping the older updated";
        :>> createdAt = "2026-07-29"; :>> createdBy = "wweatherholtz";
        :>> statement = "When two versions are identical under the normalized hash but differ in managed timestamp fields, the plugin shall resolve them without creating a conflict copy, retaining the earliest `created` and the older `updated`; a spurious local timestamp bump on otherwise-unchanged content shall be reverted and not pushed.";
        :>> rationale = "Once content is known identical, the newer stamp is spurious, so the older `updated` is the truthful last-real-change time; reverting the local bump stops the conflict flood at its source.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srDriveFsTimes : SystemRequirement {
        :>> id = "d7c15004-0000-4a10-9b20-a1b2c3d40054";
        :>> title = "Embedded timestamp drives filesystem times where the OS permits";
        :>> createdAt = "2026-07-29"; :>> createdBy = "wweatherholtz";
        :>> statement = "After writing a managed note, the plugin shall set the filesystem modification time from `updated` on all desktop platforms and the file creation time from `created` on Windows and macOS, shall degrade gracefully to modification-time-only where creation time is unsettable (Linux) or unsupported (mobile), and shall never attempt to set POSIX ctime.";
        :>> rationale = "Makes filesystem times and Dataview's file.mtime trustworthy again; per-OS capability is a hard limit, not a preference. Birthtime is strictly best-effort so a missing native addon never breaks sync.";
        :>> kind = RequirementKind::interfaceReq; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srExcludedFolders : SystemRequirement {
        :>> id = "d7c15005-0000-4a10-9b20-a1b2c3d40055";
        :>> title = "User-excluded folders are not managed";
        :>> createdAt = "2026-07-29"; :>> createdBy = "wweatherholtz";
        :>> statement = "The plugin shall provide a configurable list of excluded vault folders and shall not read, write, or drive filesystem times for the managed timestamp fields of any note under an excluded folder; the settings surface shall offer folder-path autocomplete and per-entry add and remove.";
        :>> rationale = "Gives the user explicit opt-out for generated or externally-owned folders; folder matching is a pure, unit-tested predicate wired into the existing shouldSync gate.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- Client<->server protocol compatibility (D0042, 2026-08-11) — signature-derived, not a hand-bumped integer ----
    requirement srWireSignature : SystemRequirement {
        :>> id = "78cb9d99-6e3e-4f2a-8433-2b7d01f6efa8";
        :>> title = "Wire contract exposed as a canonical signature derived from the server types";
        :>> createdAt = "2026-08-11"; :>> createdBy = "wweatherholtz";
        :>> statement = "The server shall derive a canonical SIGNATURE of its sync wire contract from its own serialized request/response types (schemars-generated, serde-accurate) — per endpoint {method, path} the request and response field structure (name -> {type, required}), keys sorted and docs stripped, stable-serialized — shall expose its hash as `schemaHash` in the /status payload and the full signature at a /schema endpoint, and the client shall carry an embedded copy of that signature generated from the same committed artifact.";
        :>> rationale = "Deriving the contract from the actual types (single source of truth) removes the documentation-centered fragility of a hand-bumped integer; hash-in-poll + full-on-demand keeps the steady-state check ~free while enabling a field-level diff when it matters.";
        :>> kind = RequirementKind::interfaceReq; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srCompatVerdict : SystemRequirement {
        :>> id = "9d78f288-2b88-445d-bb7a-6ced538cb8c1";
        :>> title = "Compatibility verdict by directional field-by-field signature diff";
        :>> createdAt = "2026-08-11"; :>> createdBy = "wweatherholtz";
        :>> statement = "On a `schemaHash` mismatch the client shall fetch the server signature, diff it field-by-field against its embedded signature, classify each delta directionally as BREAKING (a response field it reads removed/retyped/newly-required, a required endpoint absent, or — only under strict unknown-field rejection — a dropped request field) or ADDITIVE (a new optional field or endpoint), REFUSE sync on any breaking delta with a message naming the specific field/endpoint and direction, and PROCEED on an additive-only or identical contract; the integer apiVersion shall be retained only as a non-authoritative display label.";
        :>> rationale = "Comparing structures (not a digest) both decides breaking-vs-additive and explains itself; directionality reflects that breaking-ness is asymmetric. Bugfixes (zero deltas) proceed for free; breaking changes are refused with actionable insight rather than an opaque version-mismatch.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srCompatFailClosed : SystemRequirement {
        :>> id = "0a485e5b-c12d-411c-927b-853a62158f70";
        :>> title = "Fail closed when the server signature is unavailable or unparseable";
        :>> createdAt = "2026-08-11"; :>> createdBy = "wweatherholtz";
        :>> statement = "When the client cannot obtain or parse the server's wire signature — a server too old to expose `schemaHash`/`/schema`, or a fetch/parse failure — the client shall treat the peer as incompatible and refuse to sync, surfacing actionable guidance (e.g. update the server), and shall never silently proceed on an unknown contract.";
        :>> rationale = "Preserves the current fail-closed safety posture for the data-bearing path: absence of a verifiable contract is treated as incompatible, not as permission to proceed.";
        :>> kind = RequirementKind::functional; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::test;
    }
    requirement srContractDriftGate : SystemRequirement {
        :>> id = "34836cff-88c2-48d1-98f9-47a49a13c1e3";
        :>> title = "CI fails on unreviewed wire-contract drift";
        :>> createdAt = "2026-08-11"; :>> createdBy = "wweatherholtz";
        :>> statement = "The build shall regenerate the canonical wire signature from the server types and fail CI when it does not match the committed signature artifact, so every change to the wire contract is an intentional, reviewed diff rather than an accidental or silent one.";
        :>> rationale = "Converts 'trust the human to notice a wire change' into 'the human cannot forget' — the automation that makes the derived-signature scheme honest and CI-worthy instead of documentation-centered.";
        :>> kind = RequirementKind::nonFunctional; :>> priority = Priority::should; :>> verificationMethod = VerificationMethod::test;
    }

    // ---- satisfy edges: SR satisfies the Need it serves ----
    satisfy nVaultSharing by srVaultSharing;
    satisfy goal1ClearConfig by srClearConfig;
    satisfy n1GuidedSetup by srGuidedWizard;
    satisfy n1OneHomePerSetting by srSettingsOneHome;
    satisfy n1SingleIndicator by srSingleIndicator;
    satisfy goal2SimpleBackend by srSimpleBackend;
    satisfy n2NoCouchDB by srSingleBinary;
    satisfy n2Dedup by srContentDedup;
    satisfy n2Performance by srConcurrentPerf;
    satisfy goal3ConflictMerge by srConflictMerge;
    satisfy n3ThreeWayMerge by srThreeWayMerge;
    satisfy n3NeverClobber by srNeverClobber;
    satisfy n3Unpaywalled by srFreeMerge;
    satisfy nxMobile by srMobile;
    satisfy nxSecurity by srSecurity;
    // config/customization sync (CR d0011)
    satisfy nConfigSync by srConfigSelective;
    satisfy nConfigSync by srConfigAdditiveSafe;
    satisfy nConfigSync by srConfigAdjudication;
    satisfy nConfigSync by srSyncRobust;
    satisfy nConfigSync by srConfigLiveDetect;
    // Batch 1 — continuous-sync reliability
    satisfy nReliableSync by srServerApi;
    satisfy nReliableSync by srInstantPush;
    satisfy nReliableSync by srIncrementalSync;
    satisfy nReliableSync by srSelfHealingReconnect;
    // Batch 2 — data-safety + durability
    satisfy n3NeverClobber by srDegradedServerGuard;
    satisfy n2NoCouchDB by srDurableIndex;
    // Batch 3 — large-file performance
    satisfy n2Performance by srStreamedTransfer;
    satisfy nReliableSync by srResumableInitialSync;
    // Batch 4 — vault management + onboarding
    satisfy nVaultManagement by srVaultSwitch;
    satisfy nVaultManagement by srSetupLink;
    satisfy nVaultManagement by srDeviceIdentity;
    // Batch 5 — config completeness + sharing/admin split
    satisfy nConfigSync by srConfigReload;
    satisfy nConfigSync by srConfigAdjudicationUI;
    satisfy nVaultSharing by srReadOnlyGating;
    satisfy nVaultSharing by srRegistrationPolicy;
    satisfy nVaultSharing by srAdminSurface;
    // embedded-timestamp / conflict-noise (2026-07-29)
    satisfy nTimestampFidelity by srEmbeddedTimestamp;
    satisfy nNoMetadataConflicts by srNormalizedIdentity;
    satisfy nNoMetadataConflicts by srTimestampConflictResolve;
    satisfy nTimestampFidelity by srDriveFsTimes;
    satisfy nTimestampFidelity by srExcludedFolders;
    // client<->server protocol compatibility (D0042, 2026-08-11)
    satisfy nProtocolCompat by srWireSignature;
    satisfy nProtocolCompat by srCompatVerdict;
    satisfy nProtocolCompat by srCompatFailClosed;
    satisfy nProtocolCompat by srContractDriftGate;
}

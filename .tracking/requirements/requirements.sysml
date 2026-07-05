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
        :>> statement = "The server shall store file content as content-addressed chunks with a persistent index, snapshot-rollback durability, and startup orphan GC.";
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

    // ---- satisfy edges: SR satisfies the Need it serves ----
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
}

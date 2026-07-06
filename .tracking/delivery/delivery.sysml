// =====================================================================
// ProjectDelivery — the SelfSync delivery backlog (backfilled 2026-07-04, D0004). The shipped
// milestones (M1-M6, the goal-#1 config-UX overhaul, the 0.6.0 fix set) are DONE tasks, each
// with a method-tagged DoD Test + an appended pass TestResult (judged at the backfill commit;
// the automated suites are green at HEAD). The outstanding backlog (B7/B9/B11 + the L3/L4
// verification gaps) are OPEN tasks — a DoD criterion with NO pass result yet, so `keel orient`
// reports them as the ready/outstanding frontier. Results are APPENDED, never edited.
// =====================================================================
package ProjectDelivery {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import ProjectBusiness::*; // nConfigSync — the Need the config-sync capability derives from

    action def SelfSyncDelivery {
        // ---- shipped milestones (DONE) ----
        action m1Protocol;          // M1: auth + changes/get/put/delete + WS, two-client propagation
        action m2ChunkingBinary;    // M2: content-defined chunking, content-addressed store, binary+dedup
        action m3ConflictMerge;     // M3: base-aware reconcile, diff3 three-way merge, conflict-copy
        action m4MultiTenant;       // M4: accounts (argon2id) + named vaults, vault-scoped routes
        action m5Mobile;            // M5: mobile-safe paths — isDesktopOnly:false, requestUrl, pure-TS chunker
        action m6Packaging;         // M6: BRAT packaging + release workflow + Docker/reverse-proxy
        action goal1ConfigUx;       // goal #1: setup wizard + status-first grouped settings
        action rel06FixSet;         // 0.6.0: vault-switch resolution, single indicator, settings reorg

        // ---- outstanding (open frontier) ----
        action b7AuthHardening;     // B7: expiring/revocable tokens, token-only persist, TLS guidance, optional E2EE
        action b9DurabilityStreaming; // B9 Part A: append-only index journal (D0010)
        action streamingReassembly; // B9 Part B: streamed reassembly of large downloads (desktop streams, mobile buffers)
        action b11ParallelChunk;    // B11: parallelize chunk transfer (large-file perf)
        action l3GuiPass;           // L3: manual Obsidian GUI verification of 0.6.0 (esp. switch + indicators)
        action l4MobileOndevice;    // L4: on-device mobile run (foreground sync, resumable initial sync)
        action vaultSharingP1;      // vault sharing Phase 1: server ACL + authz + registration policy + web admin
        action shareClientConsume;  // vault sharing Phase 2: plugin syncs vaults shared with you
        action configSyncSafety;    // 0.10.4: config sync additive + adjudicated (never delete/resurrect); crash fix
        action requirementTraceabilityBackfill; // CR d0011: backfill the missing SR->Test #Verify traceability (resolves the escape Issue)
        action settingsGroupingPolish; // deferred cosmetic: group settings intelligently (per comparable plugins), not atomized per-setting containers (issue, D-end)
        action critiqueClientWave;      // DONE (0.10.14): the 5 client data-integrity/correctness fixes from the adversarial critique
        action critiqueServerHardening; // DONE (0.10.16, code): SEC-1/2/MED-1/MED-2/MED-3(semaphore)/DI-3/DI-4/SEC-3 + the Low backlog — cargo-green, needs operator redeploy
        action round1CriticFixes;       // DONE (0.10.17): 15 of 18 fresh Round-1 3-lens critic findings fixed (6 SEC, 4 DI, 5 CONC); 3 dispositioned accept-risk/defer
        action round1DeferredHardening;  // OPEN: the 3 deferred Round-1 findings — SEC#4 per-vault orphan-chunk quota, DI#4 reindex-vs-chunkstore preference, CONC#5 keep pendingSwitch until success
        // e2eEncryption: DECLINED — D0009 (keep trusted-server model); design spec retained as history.

        first m1Protocol then m2ChunkingBinary;
        first m2ChunkingBinary then m3ConflictMerge;
        first m3ConflictMerge then m4MultiTenant;
        first m4MultiTenant then m5Mobile;
        first m5Mobile then m6Packaging;
        first m6Packaging then goal1ConfigUx;
        first goal1ConfigUx then rel06FixSet;
        first rel06FixSet then l3GuiPass;
        first l3GuiPass then l4MobileOndevice;
        first b9DurabilityStreaming then streamingReassembly;
        first rel06FixSet then vaultSharingP1;
        first vaultSharingP1 then shareClientConsume;

        // ---- DoD criteria (one line each; naming contract <task>DoD) ----
        verification m1ProtocolDoD : Test { :>> id = "7b1e4c4e-6590-40f0-a3dd-1e93c18fc890"; :>> method = VerificationMethod::test; :>> procedureText = "server cargo tests + headless two-client E2E: login, changes/commit/get/delete, WS push, and create/edit/delete propagation between two real clients all green."; }
        verification m2ChunkingBinaryDoD : Test { :>> id = "0bc03b3a-c80d-42b1-8098-5ad168194b17"; :>> method = VerificationMethod::test; :>> procedureText = "chunker unit tests + E2E: content-defined chunks, content-addressed store, binary round-trips byte-identical, duplicate content does not re-upload (chunks/missing) — green."; }
        verification m3ConflictMergeDoD : Test { :>> id = "30f45630-3ea6-4488-81c0-685855d60e05"; :>> method = VerificationMethod::test; :>> procedureText = "reconcile + merge unit tests: decide() table, diff3 three-way merge on concurrent edits, conflict-copy on unmergeable/binary divergence, delete-vs-edit safety, C2 empty-server guard — green."; }
        verification m4MultiTenantDoD : Test { :>> id = "48379685-a4ce-40c0-90e0-2d9f0fd2b107"; :>> method = VerificationMethod::test; :>> procedureText = "server tests + E2E: accounts with argon2id, multiple named vaults per account at vault-scoped routes, files in one vault never appear in another — green."; }
        verification m5MobileDoD : Test { :>> id = "a99d3e15-441d-413e-9ebf-c954242cbdfb"; :>> method = VerificationMethod::inspect; :>> procedureText = "manifest isDesktopOnly:false; transport uses requestUrl; chunker/hasher are pure-TS (WebCrypto) with no desktop-only deps — inspected. NOTE: on-device run is tracked separately as l4MobileOndevice."; }
        verification m6PackagingDoD : Test { :>> id = "1464c8a4-5409-45f5-9a39-62eef04bde1b"; :>> method = VerificationMethod::inspect; :>> procedureText = "root manifest.json + versions.json valid; .github/workflows/release.yml builds + publishes main.js/manifest.json/styles.css on a version tag (verified green on 0.6.0); BRAT-installable; Docker/reverse-proxy example shipped."; }
        verification goal1ConfigUxDoD : Test { :>> id = "49b1a827-b90d-40f3-bb2a-67c6b22795b9"; :>> method = VerificationMethod::test; :>> procedureText = "wizardsteps + connstr + configsync unit tests + headless wizard E2E: guided setup connects + picks a vault; status-first settings render; config-sync permutation matrix passes — green."; }
        verification rel06FixSetDoD : Test { :>> id = "7ceb01f4-6bf1-4897-9331-0c44acc1c281"; :>> method = VerificationMethod::test; :>> procedureText = "reconcile switchTo download/upload/merge/empty-auto tests; 99 client unit tests + standalone config-permutation matrix green; tsc + build clean; 0.6.0 released."; }
        verification b7AuthHardeningDoD : Test { :>> id = "4d2f71d4-4177-41ca-968f-6207fdc249bf"; :>> method = VerificationMethod::test; :>> procedureText = "durable/expiring/revocable server tokens (hashed, 30-day, revoked on account delete); client token-only persistence option; shipped TLS/public-exposure guidance (deploy/ Caddy example + docs/deployment.md). Optional client-side E2EE carved out to e2eEncryption. Server + client tests green."; }
        verification b9DurabilityStreamingDoD : Test { :>> id = "3f17347d-5959-4a58-ac42-56146df4c3e2"; :>> method = VerificationMethod::test; :>> procedureText = "B9 Part A (D0010): append-only .sync-index.log — commits/deletes append absolute records instead of rewriting the index; replay reconstructs on reopen; torn trailing record discarded; malformed complete record -> ERROR; chunk_refs recomputed from files; compaction snapshots + truncates. Server tests green."; }
        verification streamingReassemblyDoD : Test { :>> id = "1b001637-4710-4ef6-8d6c-bc269e43bcd8"; :>> method = VerificationMethod::test; :>> procedureText = "streamFileToDisk appends chunks to disk (~one chunk in RAM) via an AppendHandle; applyPull streams downloads >= 8 MiB when the io supports it (base hash-only) and a large download bypasses the size gate by streaming; uploads stay gated. Desktop ObsidianVaultIo streams via Electron Node fs (temp + fsync + rename), mobile falls back to buffered. Client tests green (real Obsidian desktop/mobile = L3/L4)."; }
        verification b11ParallelChunkDoD : Test { :>> id = "18e57bf3-f917-4e18-838a-1c12b3db8d6b"; :>> method = VerificationMethod::test; :>> procedureText = "chunk transfer parallelized via a bounded Promise pool; large-file sync wall-clock materially reduced vs the sequential baseline; E2E large-file timing improved."; }
        verification l3GuiPassDoD : Test { :>> id = "1cdcb701-7762-4540-955b-f99b188ef23c"; :>> method = VerificationMethod::demo; :>> procedureText = "manual pass in a real Obsidian desktop instance: 0.6.0 setup wizard, settings groups, single indicator, and the vault-switch modal (download/upload/merge) behave as specified."; }
        verification l4MobileOndeviceDoD : Test { :>> id = "24eeafa6-25c4-4f41-b1c6-fa47fffa593c"; :>> method = VerificationMethod::demo; :>> procedureText = "on-device mobile run (iOS/Android): foreground sync, resumable initial sync, indicator visible, within the on-device performance budget."; }
        verification vaultSharingP1DoD : Test { :>> id = "34cea90b-79f1-4f3f-b6f9-ae9d8c6b0da6"; :>> method = VerificationMethod::test; :>> procedureText = "per the vault-sharing spec: .shares.json ACL + owner-qualified vault routes + server-side authorization (read vs read-write; non-grantee denied); registration policy (closed/open + single-use invite tokens); web admin UI over /api/admin/* for account + share management (role-checked, no hash/token leakage) — server + admin-API + UI tests green."; }
        verification shareClientConsumeDoD : Test { :>> id = "440a15ee-7b92-4fc8-ba5e-470cc7a86212"; :>> method = VerificationMethod::test; :>> procedureText = "the plugin's vault switcher lists owned + shared vaults; syncing a vault shared with you works end to end; read-only shares disable local->remote push; transport uses owner-qualified routes."; }
        verification configSyncSafetyDoD : Test { :>> id = "c0f1a5cc-5001-4a10-9b20-a1b2c3d40041"; :>> method = VerificationMethod::test; :>> procedureText = "reconcile: an accepts()-filtered path is skipped entirely (no phantom base -> no manufactured deletion); config removals + same-file divergence are recorded for adjudication (never auto-delete, never auto-resurrect, no note-style conflict copy); resolveConfigConflict applies the user's local/remote choice; one file's error never aborts the whole reconcile. 12 new reconcile tests; full client suite 125 green; 0.10.4 shipped."; }
        verification requirementTraceabilityBackfillDoD : Test { :>> id = "c0f1a5cc-5002-4a10-9b20-a1b2c3d40042"; :>> method = VerificationMethod::inspect; :>> procedureText = "every SystemRequirement now carries a #Verify edge from a Test (tier-satisfaction SR-verified 0/15 -> 19/19); the four new config-sync SRs carry Given/When/Then acceptance scenarios; the config-sync capability is #Capability-rooted to nConfigSync (requirement-rootedness non-vacuous)."; }
        verification settingsGroupingPolishDoD : Test { :>> id = "c0f1a5cc-5003-4a10-9b20-a1b2c3d40043"; :>> method = VerificationMethod::inspect; :>> procedureText = "settings within each group are organized intelligently after studying comparable Obsidian plugins' settings layouts (not one atomized container per setting); a before/after review confirms the grouping reads sensibly. DEFERRED to the end-of-project cosmetic pass (owner: avoid repeated cosmetic rework)."; }
        verification critiqueClientWaveDoD : Test { :>> id = "c0f1a5cc-5004-4a10-9b20-a1b2c3d40044"; :>> method = VerificationMethod::test; :>> procedureText = "5 confirmed client data-integrity/correctness defects from the 3-lens adversarial critique fixed, each with a BDD test: DI-1 partial-shrink bulk-delete ratio guard, DI-2 download hash verification, CO-1 stale-base clear on both-absent, CO-2 offline->idle recovery on syncDone, CO-3 config edit-vs-delete adjudication. Full client suite 153 green; shipped 0.10.14."; }
        verification critiqueServerHardeningDoD : Test { :>> id = "c0f1a5cc-5005-4a10-9b20-a1b2c3d40045"; :>> method = VerificationMethod::test; :>> procedureText = "server + coordinated fixes land, are tested (cargo), and are redeployed: SEC-2 default-admin-credential refusal (coded + cargo-green, awaiting operator redeploy), SEC-1 WS token out of the URL query string, SEC-MED-1 register-enumeration parity, SEC-MED-2 account-delete data remanence, SEC-MED-3 login rate-limiting, DI-3 commit-before-journal ordering, DI-4 reindex-refuses-incomplete-dir, client SEC-3 no auto-enable of plugin code received over a shared vault. Server cargo tests + the coordinated client release green."; }
        // SEC-MED-3 is realized as an 8-permit argon2 CONCURRENCY cap (bounds the CPU/RAM DoS); per-IP
        // request-rate throttling is a further hardening left to the reverse proxy (documented).
        verification round1CriticFixesDoD : Test { :>> id = "c0f1a5cc-5006-4a10-9b20-a1b2c3d40046"; :>> method = VerificationMethod::test; :>> procedureText = "Round-1 fresh 3-lens critic findings (18) triaged; 15 fixed + tested + shipped 0.10.17: DI#1 switchTo honors accepts() gate, DI#2 streamed downloads verify per-chunk, DI#3 pull-race conflict-copy, DI#5 event-path bulk-delete ratio guard; CONC#1 single-flight persist, CONC#2 exception-safe applying flag, CONC#3 self-healing WS re-dial, CONC#4 WS MissedTickBehavior::Delay, CONC#6 drain requeue; SEC#1 lowercase-canonical names (case-collision breach), SEC#2 argon2 offload+cap+semaphore, SEC#3 vault cap, SEC#5 512MiB ceiling, SEC#6 generic 5xx, SEC#7 reserved-name reject. 3 dispositioned accept-risk/defer (SEC#4, DI#4, CONC#5). Full client suite 162 green; server cargo 70 green; server needs redeploy."; }
        // OPEN — the 3 deferred Round-1 items (no result yet, so orient shows them outstanding).
        verification round1DeferredHardeningDoD : Test { :>> id = "c0f1a5cc-5007-4a10-9b20-a1b2c3d40047"; :>> method = VerificationMethod::test; :>> procedureText = "SEC#4: a per-vault stored-bytes quota and/or runtime orphan-chunk GC so a ReadWrite grantee can't fill the owner's disk with uncommitted chunks (today reclaimed only at startup). DI#4: during reindex, when an on-disk file's hash disagrees with a still-healthy index entry, prefer/surface the chunk-store content rather than silently adopting the bind-mount bytes. CONC#5: keep pendingSwitchMode set until switchTo fully succeeds so a mid-switch failure doesn't downgrade an authoritative overwrite to a merge. Each landed with tests."; }

        // ---- appended pass results for DONE milestones (judged at the backfill commit) ----
        part m1ProtocolR1 : TestResult { :>> id = "0a679462-4127-44ec-87b6-495d4ca7e426"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "0e02bc0"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        part m2ChunkingBinaryR1 : TestResult { :>> id = "36b58c11-47d4-415e-a22f-a32c7d36c472"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "0e02bc0"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        part m3ConflictMergeR1 : TestResult { :>> id = "54ce7b0d-9f71-49d2-9c98-cab80170e041"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "0e02bc0"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        part m4MultiTenantR1 : TestResult { :>> id = "3de1fbd1-b2ab-4c15-a3d3-ad5921feb988"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "0e02bc0"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        part m5MobileR1 : TestResult { :>> id = "da2e7a98-42d5-43b0-b6d1-4501591d4df5"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "0e02bc0"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        part m6PackagingR1 : TestResult { :>> id = "ecabfe78-687c-451c-895e-cd0c9cc70311"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "0e02bc0"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        part goal1ConfigUxR1 : TestResult { :>> id = "d3722ace-eb30-4a03-bb66-8ca91f40ebad"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "0e02bc0"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        part rel06FixSetR1 : TestResult { :>> id = "338147e1-ba2f-4bc6-bd1d-23ccb8b486d7"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "0e02bc0"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        // Phase 1 shipped: ACL + owner-qualified routes + authz + registration/tokens + admin API + web UI.
        part vaultSharingP1R1 : TestResult { :>> id = "c1c6d04d-3d68-4afc-b086-f83dddc5e730"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "6b39442"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        // Phase 2 shipped: owner-aware client transport + read-only gating + switcher; cross-user E2E green.
        part shareClientConsumeR1 : TestResult { :>> id = "d8576c06-d950-4bcf-9b7b-ba0415a9331e"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "3438003"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "ai"; }
        // B11 shipped: mapPool bounds concurrency; fetchFileBytes + pushFile transfer chunks in parallel.
        part b11ParallelChunkR1 : TestResult { :>> id = "35068780-a122-4860-bb31-7fb1bae251e2"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "88238fb"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
        // B7 shipped: durable/expiring/revocable tokens + token-only persistence + TLS/exposure docs (E2EE carved to e2eEncryption).
        part b7AuthHardeningR1 : TestResult { :>> id = "e44416e1-5f8d-4621-b140-3b1b7a9f0574"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "198d5f1"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
        // B9 Part A shipped: append-only index journal (streaming Part B deferred, D0010).
        part b9DurabilityStreamingR1 : TestResult { :>> id = "b8b81f32-5c6d-4b35-b0f3-cfd935073917"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "2b42a58"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
        // B9 Part B shipped (D0010 deferral lifted per owner request): streamed large-download reassembly.
        part streamingReassemblyR1 : TestResult { :>> id = "09cf210d-4f35-49d4-b9ee-4b4c49ca4c37"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "2c2118c"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
        // 0.10.4 config-sync safety + the CR d0011 traceability backfill (both shipped at db1b008).
        part configSyncSafetyR1 : TestResult { :>> id = "c0f1a5cc-6001-4a10-9b20-a1b2c3d40051"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
        part requirementTraceabilityBackfillR1 : TestResult { :>> id = "c0f1a5cc-6002-4a10-9b20-a1b2c3d40052"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "db1b008"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
        // L4 mobile on-device: owner-attested demo (foreground sync + indicator + config sync on his phone, 0.10.7). settingsGroupingPolish is intentionally left with NO result (deferred/open).
        part l4MobileOndeviceR1 : TestResult { :>> id = "c0f1a5cc-6003-4a10-9b20-a1b2c3d40053"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "912722b"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "wweatherholtz"; }
        // The client critique wave shipped at 0.10.14 (c0576c9).
        part critiqueClientWaveR1 : TestResult { :>> id = "c0f1a5cc-6004-4a10-9b20-a1b2c3d40054"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "c0576c9"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
        // Server hardening (pre-round-1 backlog) + the Round-1 fresh-critic fixes both landed by f7cedca
        // (0.10.17). Server-side fixes are cargo-green and CODE-complete; they take effect on redeploy.
        part critiqueServerHardeningR1 : TestResult { :>> id = "c0f1a5cc-6005-4a10-9b20-a1b2c3d40055"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "f7cedca"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
        part round1CriticFixesR1 : TestResult { :>> id = "c0f1a5cc-6006-4a10-9b20-a1b2c3d40056"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "f7cedca"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "ai"; }
    }

    // The config-sync capability (0.10.4), marked #Capability + rooted to its Need so
    // `keel guard requirement-rootedness` actively enforces its traceability (D0099). This is the
    // first declared capability — the guard was vacuous until now; the escape is why we declare it.
    #Capability part configSyncCapability : Story {
        :>> id = "c0f1a5cc-7001-4a10-9b20-a1b2c3d40061";
        :>> title = "Safe cross-device config/plugin sync";
        :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz";
        :>> kind = WorkKind::code; :>> priority = WorkPriority::p0; :>> owner = "wweatherholtz";
    }
    #DerivedFrom dependency from configSyncCapability to nConfigSync; // hard rootedness gate (D0099)
    #CharteredBy dependency from configSyncCapability to nConfigSync; // charter lineage (rootedness burndown)
}

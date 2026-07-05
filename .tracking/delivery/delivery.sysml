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
        action b9DurabilityStreaming; // B9: append-only journal + true streaming (durability rewrite)
        action b11ParallelChunk;    // B11: parallelize chunk transfer (large-file perf)
        action l3GuiPass;           // L3: manual Obsidian GUI verification of 0.6.0 (esp. switch + indicators)
        action l4MobileOndevice;    // L4: on-device mobile run (foreground sync, resumable initial sync)
        action vaultSharingP1;      // vault sharing Phase 1: server ACL + authz + registration policy + web admin
        action shareClientConsume;  // vault sharing Phase 2: plugin syncs vaults shared with you

        first m1Protocol then m2ChunkingBinary;
        first m2ChunkingBinary then m3ConflictMerge;
        first m3ConflictMerge then m4MultiTenant;
        first m4MultiTenant then m5Mobile;
        first m5Mobile then m6Packaging;
        first m6Packaging then goal1ConfigUx;
        first goal1ConfigUx then rel06FixSet;
        first rel06FixSet then l3GuiPass;
        first l3GuiPass then l4MobileOndevice;
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
        verification b7AuthHardeningDoD : Test { :>> id = "4d2f71d4-4177-41ca-968f-6207fdc249bf"; :>> method = VerificationMethod::test; :>> procedureText = "expiring/refresh tokens with server-side revocation; client can persist token-only (never password); documented TLS/public-exposure guidance; optional client-side E2EE seam — tests green."; }
        verification b9DurabilityStreamingDoD : Test { :>> id = "3f17347d-5959-4a58-ac42-56146df4c3e2"; :>> method = VerificationMethod::test; :>> procedureText = "append-only journal for the index + true streaming of large transfers (no whole-file in RAM) — durability + memory tests green."; }
        verification b11ParallelChunkDoD : Test { :>> id = "18e57bf3-f917-4e18-838a-1c12b3db8d6b"; :>> method = VerificationMethod::test; :>> procedureText = "chunk transfer parallelized via a bounded Promise pool; large-file sync wall-clock materially reduced vs the sequential baseline; E2E large-file timing improved."; }
        verification l3GuiPassDoD : Test { :>> id = "1cdcb701-7762-4540-955b-f99b188ef23c"; :>> method = VerificationMethod::demo; :>> procedureText = "manual pass in a real Obsidian desktop instance: 0.6.0 setup wizard, settings groups, single indicator, and the vault-switch modal (download/upload/merge) behave as specified."; }
        verification l4MobileOndeviceDoD : Test { :>> id = "24eeafa6-25c4-4f41-b1c6-fa47fffa593c"; :>> method = VerificationMethod::demo; :>> procedureText = "on-device mobile run (iOS/Android): foreground sync, resumable initial sync, indicator visible, within the on-device performance budget."; }
        verification vaultSharingP1DoD : Test { :>> id = "34cea90b-79f1-4f3f-b6f9-ae9d8c6b0da6"; :>> method = VerificationMethod::test; :>> procedureText = "per the vault-sharing spec: .shares.json ACL + owner-qualified vault routes + server-side authorization (read vs read-write; non-grantee denied); registration policy (closed/open + single-use invite tokens); web admin UI over /api/admin/* for account + share management (role-checked, no hash/token leakage) — server + admin-API + UI tests green."; }
        verification shareClientConsumeDoD : Test { :>> id = "440a15ee-7b92-4fc8-ba5e-470cc7a86212"; :>> method = VerificationMethod::test; :>> procedureText = "the plugin's vault switcher lists owned + shared vaults; syncing a vault shared with you works end to end; read-only shares disable local->remote push; transport uses owner-qualified routes."; }

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
    }
}

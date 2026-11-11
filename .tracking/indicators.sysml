// =====================================================================
// ProjectIndicators — monitored MEASURES (D0089), watched by DIRECTION, not gated by a threshold.
// Test coverage is tracked here as a computed-by-tool, RECORDED observation (D0026): the ratcheting
// FLOOR is the CI/vitest/llvm-cov CONSTRAINT (a pass/fail gate); this Indicator is the TREND lens —
// where coverage is heading, informed by the goal (maximize). method=pulled: the value is produced by
// an EXTERNAL tool (vitest v8 / cargo llvm-cov), not by keel's model-report engine, so each reading is
// an irreducible recorded `Measurement` with provenance (never fabricated), added via
// `keel record-measurement`. View: `keel indicators`. NO verify/satisfy — an Indicator only informs.
// =====================================================================
package ProjectIndicators {
    private import EngineElement::*;
    private import EngineIndicator::*;
    private import ProjectDecision0026::*; // d0026 — the decision these coverage measures inform
    private import ProjectDecision0030::*; // d0030 — adopted mutation testing + mandated this score Indicator

    part clientLineCoverage : Indicator {
        :>> id = "c0f1a5cc-1d01-4a10-9b20-a1b2c3d41d01";
        :>> title = "Client (plugin) line coverage";
        :>> createdAt = "2026-07-14";
        :>> createdBy = "wweatherholtz";
        :>> measures = "Percent of client/src TypeScript lines executed by `vitest run --coverage` (v8).";
        :>> goal = IndicatorGoal::maximize;
        :>> unit = "%";
        :>> method = MeasurementMethod::pulled;
        :>> collectionRef = "cd client && npm run test:cov  (v8 coverage-summary.json → total.lines.pct)";
    }
    part serverLineCoverage : Indicator {
        :>> id = "c0f1a5cc-1d02-4a10-9b20-a1b2c3d41d02";
        :>> title = "Server line coverage";
        :>> createdAt = "2026-07-14";
        :>> createdBy = "wweatherholtz";
        :>> measures = "Percent of server/src Rust lines executed by `cargo llvm-cov` over the test suite.";
        :>> goal = IndicatorGoal::maximize;
        :>> unit = "%";
        :>> method = MeasurementMethod::pulled;
        :>> collectionRef = "cd server && cargo llvm-cov --summary-only  (TOTAL lines %)";
    }

    // Mutation score (D0030): coverage proves lines RAN; this proves the suite would FAIL on a real
    // fault. method=pulled — produced by the external cargo-mutants tool (server) / Stryker (client),
    // each reading an irreducible recorded Measurement with provenance (per-module scope in `source`).
    // Direction only (maximize); NOT a CI floor until a defensible baseline across modules exists (D0088).
    part serverMutationScore : Indicator {
        :>> id = "c0f1a5cc-1d03-4a10-9b20-a1b2c3d41d03";
        :>> title = "Server mutation score (cargo-mutants)";
        :>> createdAt = "2026-07-18";
        :>> createdBy = "claudeOpus";
        :>> measures = "Percent of VIABLE injected faults (cargo-mutants) that the server test suite catches: caught / (caught + missed), excluding unviable (non-compiling) mutants. Scoped per module; see each Measurement's source.";
        :>> goal = IndicatorGoal::maximize;
        :>> unit = "%";
        :>> method = MeasurementMethod::pulled;
        :>> collectionRef = "cd server && cargo mutants --file <module> --timeout 300  (caught / (caught+missed) from the summary line)";
    }

    #Informs dependency from clientLineCoverage to d0026;
    #Informs dependency from serverLineCoverage to d0026;
    #Informs dependency from serverMutationScore to d0030;
    part clientLineCoverageM1 : Measurement { :>> id = "578a57d2-2cfa-4718-9a2e-507c5d10fe00"; :>> value = "67.49"; :>> measuredAt = "2026-07-14"; :>> source = "vitest v8 coverage-summary total.lines.pct; full suite incl. integration specs"; :>> createdBy = "ai"; }
    #Measures dependency from clientLineCoverageM1 to clientLineCoverage;
    part serverLineCoverageM1 : Measurement { :>> id = "2b20135b-183b-441c-9a2e-507c613afc24"; :>> value = "86.41"; :>> measuredAt = "2026-07-14"; :>> source = "cargo llvm-cov --summary-only TOTAL lines"; :>> createdBy = "ai"; }
    #Measures dependency from serverLineCoverageM1 to serverLineCoverage;
    part clientLineCoverageM2 : Measurement { :>> id = "7e0de2ae-264b-48be-91d0-977f3283efba"; :>> value = "74.74"; :>> measuredAt = "2026-07-14"; :>> source = "vitest v8 total.lines.pct; 382 tests incl. integration specs; after Phase 1"; :>> createdBy = "ai"; }
    #Measures dependency from clientLineCoverageM2 to clientLineCoverage;
    part serverLineCoverageM2 : Measurement { :>> id = "47384f04-6bcc-4002-91d0-977f38bd2a22"; :>> value = "90.02"; :>> measuredAt = "2026-07-14"; :>> source = "cargo llvm-cov TOTAL lines; after Phase 2 (ws + hardening suites)"; :>> createdBy = "ai"; }
    #Measures dependency from serverLineCoverageM2 to serverLineCoverage;
    part serverMutationScoreM1 : Measurement { :>> id = "c0f1a5cc-1d04-4a10-9b20-a1b2c3d41d04"; :>> value = "100.0"; :>> measuredAt = "2026-07-18"; :>> source = "cargo-mutants v27.1 --file src/shares.rs --timeout 300 (authz keystone), AFTER the 7 killing tests: 49 caught / 0 missed / 0 timeout / 4 unviable = 49/49 viable. Pre-fix baseline was 45/49 (91.8%); the 4 survivors were killed (mutationTestingSharesPass). Scope: shares.rs only."; :>> createdBy = "claudeOpus"; }
    #Measures dependency from serverMutationScoreM1 to serverMutationScore;
    part serverMutationScoreM2 : Measurement { :>> id = "c0f1a5cc-1d05-4a10-9b20-a1b2c3d41d05"; :>> value = "100.0"; :>> measuredAt = "2026-07-18"; :>> source = "cargo-mutants v27.1 --file src/index_store.rs --timeout 300 (SQLite index durability authority), AFTER the migrate-stamp killing test: 42/42 viable caught (8 unviable). Pre-fix 41/42 (97.6%) — already solid; 1 survivor (latent R12-CC1 schema_version stamp) killed (mutationTestingIndexChunkstore)."; :>> createdBy = "claudeOpus"; }
    #Measures dependency from serverMutationScoreM2 to serverMutationScore;
    part serverMutationScoreM3 : Measurement { :>> id = "c0f1a5cc-1d06-4a10-9b20-a1b2c3d41d06"; :>> value = "100.0"; :>> measuredAt = "2026-07-18"; :>> source = "cargo-mutants v27.1 --file src/chunkstore.rs --timeout 300 (content-addressed blob store), AFTER 4 killing tests: 38/38 viable caught (1 unviable). Pre-fix 32/38 (84.2%); 6 survivors (sweep_temp crash-recovery, is_valid_hash format gate, get error-propagation, touch orphan-clock x2) killed (mutationTestingIndexChunkstore)."; :>> createdBy = "claudeOpus"; }
    #Measures dependency from serverMutationScoreM3 to serverMutationScore;
    part serverMutationScoreM4 : Measurement { :>> id = "c0f1a5cc-1d07-4a10-9b20-a1b2c3d41d07"; :>> value = "79.7"; :>> measuredAt = "2026-07-18"; :>> source = "cargo-mutants v27.1 --file src/vault.rs --timeout 300 (the largest module: commit/reindex/GC/path-safety), AFTER 5 request-path killing tests: 102 caught / 26 missed / 10 unviable = 102/128 viable (79.7%). Pre-fix 95/128 (74.2%); 8 request-path survivors killed (mutationTestingVault). The 26 residual are TRIAGED: 21 documented equivalent/impractical accepts (MAX_FILE_BYTES 4GiB constant; log-only counters; 300s-gated best-effort orphan sweep w/ core reclaim 100% in chunkstore; a Windows-redundant path guard) + 5 real reindex corrupt-rebuild gaps (issueVaultReindexRebuildTestGaps, open follow-on). Effective non-accepted coverage ~102/107 (95%)."; :>> createdBy = "claudeOpus"; }
    #Measures dependency from serverMutationScoreM4 to serverMutationScore;
    part serverMutationScoreM5 : Measurement { :>> id = "c0f1a5cc-1d08-4a10-9b20-a1b2c3d41d08"; :>> value = "83.6"; :>> measuredAt = "2026-07-18"; :>> source = "cargo-mutants v27.1 --file src/vault.rs --timeout 300, AFTER the 3 reindex corrupt-rebuild killing tests (mutationTestingVaultReindex): 107 caught / 21 missed / 10 unviable = 107/128 viable (83.6%). Up from M4's 79.7% (5 reindex survivors killed). All 21 residual are the documented equivalent/impractical accepts (constants, log-only, time-gated best-effort, Windows-redundant) — 0 real survivors, so 100% of non-accepted mutants are caught."; :>> createdBy = "claudeOpus"; }
    #Measures dependency from serverMutationScoreM5 to serverMutationScore;
    // ---- End-to-end encryption KDF cost on real phones (D0112, 2026-11-10): owner-run manual Measurements,
    // two per Indicator (one per device), per the real-device perf protocol. Policy: D0112.
    part e2eePhoneKdfWallTime : Indicator {
        :>> id = "1862e6d4-d9e0-4749-ada9-de6e0def9972";
        :>> title = "E2EE Argon2id wall time on a real phone";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> measures = "Seconds from password entry to the unwrapped vault key on a real phone at the shipped KDF parameters, one Measurement per device (iOS, Android).";
        :>> goal = IndicatorGoal::minimize;
        :>> unit = "s";
        :>> method = MeasurementMethod::manual;
        :>> collectionRef = "docs/architecture/93-real-device-perf-protocol.md, KDF row added by E3b (stopwatch)";
    }
    part e2eePhoneKdfPeakMemory : Indicator {
        :>> id = "71a506d3-40ef-4e02-8bb1-0b9d073dc098";
        :>> title = "E2EE Argon2id peak memory on a real phone";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> measures = "Peak resident memory of the Obsidian process during the KDF on a real phone at the shipped parameters, one Measurement per device (iOS, Android).";
        :>> goal = IndicatorGoal::minimize;
        :>> unit = "MiB";
        :>> method = MeasurementMethod::manual;
        :>> collectionRef = "docs/architecture/93-real-device-perf-protocol.md, KDF row added by E3b (OS memory readout)";
    }
    part e2eePhoneKdfWallTimeM1 : Measurement { :>> id = "3ba2d590-c65e-48bc-97e8-068a1901fc5b"; :>> value = "4.77"; :>> measuredAt = "2026-11-11"; :>> source = "android:firefox-page:64MiB-t3-p1 runs 4.73,4.80,4.77 Firefox 160 Gecko, owner phone, reported in chat"; :>> createdBy = "wweatherholtz"; }
    #Measures dependency from e2eePhoneKdfWallTimeM1 to e2eePhoneKdfWallTime;
    // ---- End-to-end encryption on the desktop through real Obsidian (Sprint 7, 2026-11-11): pulled by the
    // Playwright spec client/e2e-obsidian/e2ee.pwspec.ts from its E2EE-MEASURE line, one Measurement per run and metric.
    part e2eeDesktopKdfWallTime : Indicator {
        :>> id = "82b91cc2-770a-4850-a4f6-865ebd583c05";
        :>> title = "E2EE Argon2id wall time on the desktop through real Obsidian";
        :>> createdAt = "2026-11-11";
        :>> createdBy = "ai";
        :>> measures = "Seconds from the dialog button to the dialog closing in real Obsidian at the shipped KDF parameters, on create (keyring mint) and on join (keyring open), source prefixed create: or join:.";
        :>> goal = IndicatorGoal::minimize;
        :>> unit = "s";
        :>> method = MeasurementMethod::pulled;
        :>> collectionRef = "client/e2e-obsidian/e2ee.pwspec.ts, kdfCreateSeconds and kdfJoinSeconds of the E2EE-MEASURE line";
    }
    part e2eeSyncWallTime : Indicator {
        :>> id = "03a4ac01-908f-4199-bf2c-cc5b1dbc1964";
        :>> title = "Sync wall time of one note through real Obsidian, plaintext and encrypted";
        :>> createdAt = "2026-11-11";
        :>> createdBy = "ai";
        :>> measures = "Seconds from a note create in real Obsidian to the server holding it (push:plain, push:encrypted) or to the second device holding it (converge:encrypted), on loopback unless the source says otherwise.";
        :>> goal = IndicatorGoal::minimize;
        :>> unit = "s";
        :>> method = MeasurementMethod::pulled;
        :>> collectionRef = "client/e2e-obsidian/e2ee.pwspec.ts, pushPlainSeconds, pushEncryptedSeconds, convergeEncryptedSeconds and convergeEncryptedSecondsLive of the E2EE-MEASURE line";
    }
    part e2eeDesktopKdfWallTimeM1 : Measurement { :>> id = "ab60b777-628b-4c0f-b1c0-68026c907554"; :>> value = "2.22"; :>> measuredAt = "2026-11-11"; :>> source = "create: kdfCreateSeconds; e2ee.pwspec.ts run mwcboq98 2026-11-11, loopback, owner desktop (Windows 11), Obsidian renderer, plugin 1.34.0 build at HEAD, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeDesktopKdfWallTimeM1 to e2eeDesktopKdfWallTime;
    part e2eeDesktopKdfWallTimeM2 : Measurement { :>> id = "6858367e-6646-47ba-bea3-c67e624ef6a0"; :>> value = "2.12"; :>> measuredAt = "2026-11-11"; :>> source = "join: kdfJoinSeconds; e2ee.pwspec.ts run mwcboq98 2026-11-11, loopback, owner desktop (Windows 11), Obsidian renderer, plugin 1.34.0 build at HEAD, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeDesktopKdfWallTimeM2 to e2eeDesktopKdfWallTime;
    part e2eeSyncWallTimeM1 : Measurement { :>> id = "350d125a-3f53-40f0-9674-73fa940f4ed6"; :>> value = "0.47"; :>> measuredAt = "2026-11-11"; :>> source = "push:plain pushPlainSeconds; e2ee.pwspec.ts run mwcboq98 2026-11-11, loopback, owner desktop (Windows 11), Obsidian renderer, plugin 1.34.0 build at HEAD, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM1 to e2eeSyncWallTime;
    part e2eeSyncWallTimeM2 : Measurement { :>> id = "abc65470-3598-48e3-a973-56ee79a84982"; :>> value = "0.46"; :>> measuredAt = "2026-11-11"; :>> source = "push:encrypted pushEncryptedSeconds; e2ee.pwspec.ts run mwcboq98 2026-11-11, loopback, owner desktop (Windows 11), Obsidian renderer, plugin 1.34.0 build at HEAD, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM2 to e2eeSyncWallTime;
    part e2eeSyncWallTimeM3 : Measurement { :>> id = "efb7aebf-a041-4189-a9bb-92a6e76a882b"; :>> value = "1.02"; :>> measuredAt = "2026-11-11"; :>> source = "converge:encrypted convergeEncryptedSeconds, a note made before B joined; e2ee.pwspec.ts run mwcboq98 2026-11-11, loopback, owner desktop (Windows 11), Obsidian renderer, plugin 1.34.0 build at HEAD, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM3 to e2eeSyncWallTime;
    part e2eeSyncWallTimeM4 : Measurement { :>> id = "25d4deb5-1764-4c3f-b3f5-c9c4a519264c"; :>> value = "0.58"; :>> measuredAt = "2026-11-11"; :>> source = "converge:encrypted-live convergeEncryptedSecondsLive, both devices pinned; e2ee.pwspec.ts run mwcboq98 2026-11-11, loopback, owner desktop (Windows 11), Obsidian renderer, plugin 1.34.0 build at HEAD, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM4 to e2eeSyncWallTime;
    part e2eeDesktopKdfWallTimeM3 : Measurement { :>> id = "4e0a3a8f-c4f5-474a-8d30-63527e35cfe8"; :>> value = "1.68"; :>> measuredAt = "2026-11-11"; :>> source = "create: kdfCreateSeconds; e2ee.pwspec.ts run mwceeanp 2026-11-11, real-server mode against https://notes2.willweatherholtz.com (owner container, TLS proxy), test account, Obsidian on the owner desktop over the internet, plugin build at 58c4269, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeDesktopKdfWallTimeM3 to e2eeDesktopKdfWallTime;
    part e2eeDesktopKdfWallTimeM4 : Measurement { :>> id = "2bc893cd-ac6d-4673-8b15-9cc748dae1bb"; :>> value = "1.25"; :>> measuredAt = "2026-11-11"; :>> source = "join: kdfJoinSeconds; e2ee.pwspec.ts run mwceeanp 2026-11-11, real-server mode against https://notes2.willweatherholtz.com (owner container, TLS proxy), test account, Obsidian on the owner desktop over the internet, plugin build at 58c4269, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeDesktopKdfWallTimeM4 to e2eeDesktopKdfWallTime;
    part e2eeSyncWallTimeM5 : Measurement { :>> id = "d9582747-88fa-4880-ad34-8ec17772c6f3"; :>> value = "0.67"; :>> measuredAt = "2026-11-11"; :>> source = "push:plain pushPlainSeconds, remote; e2ee.pwspec.ts run mwceeanp 2026-11-11, real-server mode against https://notes2.willweatherholtz.com (owner container, TLS proxy), test account, Obsidian on the owner desktop over the internet, plugin build at 58c4269, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM5 to e2eeSyncWallTime;
    part e2eeSyncWallTimeM6 : Measurement { :>> id = "c6b7f226-d60f-4c03-9ec8-9be081ebd6c8"; :>> value = "1.35"; :>> measuredAt = "2026-11-11"; :>> source = "push:encrypted pushEncryptedSeconds, remote; e2ee.pwspec.ts run mwceeanp 2026-11-11, real-server mode against https://notes2.willweatherholtz.com (owner container, TLS proxy), test account, Obsidian on the owner desktop over the internet, plugin build at 58c4269, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM6 to e2eeSyncWallTime;
    part e2eeSyncWallTimeM7 : Measurement { :>> id = "a6473ba3-8569-4106-b8a0-759ecc3b572f"; :>> value = "1.02"; :>> measuredAt = "2026-11-11"; :>> source = "converge:encrypted convergeEncryptedSeconds, remote, a note made before B joined; e2ee.pwspec.ts run mwceeanp 2026-11-11, real-server mode against https://notes2.willweatherholtz.com (owner container, TLS proxy), test account, Obsidian on the owner desktop over the internet, plugin build at 58c4269, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM7 to e2eeSyncWallTime;
    part e2eeSyncWallTimeM8 : Measurement { :>> id = "34c649af-20d0-4c04-b3d4-c24e690d1ac1"; :>> value = "62.47"; :>> measuredAt = "2026-11-11"; :>> source = "converge:encrypted-live convergeEncryptedSecondsLive, remote, both devices pinned; loopback gave 0.58, see issue020; e2ee.pwspec.ts run mwceeanp 2026-11-11, real-server mode against https://notes2.willweatherholtz.com (owner container, TLS proxy), test account, Obsidian on the owner desktop over the internet, plugin build at 58c4269, KDF default 32 MiB t=3 p=1"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM8 to e2eeSyncWallTime;
    part e2eeSyncWallTimeM9 : Measurement { :>> id = "1eaaf89d-e27b-43f3-adfe-e8929428c576"; :>> value = "13.51"; :>> measuredAt = "2026-11-11"; :>> source = "converge:encrypted-live convergeEncryptedSecondsLive, loopback, issue020 reproduction SELFSYNC_E2E_RESTART_AT_LIVE=10: server killed at the live note, back 10 s later; e2ee.pwspec.ts run mwcm9clw 2026-11-11, plugin build at be3f5ae"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM9 to e2eeSyncWallTime;
    part e2eeSyncWallTimeM10 : Measurement { :>> id = "36094ab0-58e9-402d-9599-df29c0da86db"; :>> value = "47.26"; :>> measuredAt = "2026-11-11"; :>> source = "converge:encrypted-live convergeEncryptedSecondsLive, loopback, issue020 reproduction SELFSYNC_E2E_RESTART_AT_LIVE=35: server killed at the live note, back 35 s later; device A backoff ladder 3s 4s 9s 22s; e2ee.pwspec.ts run mwcmbk4j 2026-11-11, plugin build at be3f5ae"; :>> createdBy = "ai"; }
    #Measures dependency from e2eeSyncWallTimeM10 to e2eeSyncWallTime;
}

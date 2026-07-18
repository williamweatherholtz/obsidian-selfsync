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
}

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

    #Informs dependency from clientLineCoverage to d0026;
    #Informs dependency from serverLineCoverage to d0026;
    part clientLineCoverageM1 : Measurement { :>> id = "578a57d2-2cfa-4718-9a2e-507c5d10fe00"; :>> value = "67.49"; :>> measuredAt = "2026-07-14"; :>> source = "vitest v8 coverage-summary total.lines.pct; full suite incl. integration specs"; :>> createdBy = "ai"; }
    #Measures dependency from clientLineCoverageM1 to clientLineCoverage;
    part serverLineCoverageM1 : Measurement { :>> id = "2b20135b-183b-441c-9a2e-507c613afc24"; :>> value = "86.41"; :>> measuredAt = "2026-07-14"; :>> source = "cargo llvm-cov --summary-only TOTAL lines"; :>> createdBy = "ai"; }
    #Measures dependency from serverLineCoverageM1 to serverLineCoverage;
}

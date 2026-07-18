// =====================================================================
// EnginePropertyBasedTesting — find correctness bugs by testing INVARIANTS, not examples (D0030).
//
// Adapts Anthropic's Claude-PBT method (red.anthropic.com, 2026): investigate -> propose properties
// grounded in the code -> write property tests -> a REFLECTION loop that decides whether a failure is a
// genuine bug (not a test that merely wraps code in a catch) -> record findings. Properties are mined from
// the codebase's own invariant comments / types / domain math; a failing property yields a shrunk
// counterexample = a concrete bug. Targets the PURE cores first (highest correctness value, cheapest to
// specify): decide / merge3 / the chunker / sameIgnoringEol / mergeEnabledPluginsJson (client, fast-check)
// and the Rust chunker / safe_rel_path / index round-trips (server, proptest — follow-on). Prioritized by
// the architecture-audit criticality ranking (dataLoss/correctness elements first). Deployed by the
// `property-based-testing` skill. Findings are recorded as tracked Issues (D0077); the tests are permanent.
// =====================================================================
package EnginePropertyBasedTesting {
    private import EngineElement::*;
    private import EngineProcess::*;

    part propertyBasedTesting : Process {
        :>> id = "6db66993-eba1-47d0-a0bd-9f942b24984c";
        :>> title = "Property-Based Testing (invariant bug-finding)";
        :>> purpose = "Find correctness bugs by testing general INVARIANTS (mined from the code's own contracts) with a PBT engine, reflecting genuine bugs from false alarms, and recording findings as Issues + permanent regression tests.";
        :>> cadence = Cadence::adHoc;
    }

    part pbtInvestigate : ProcessStep {
        :>> id = "5130f871-f85a-4c51-b263-dc1af713d829";
        :>> title = "Investigate the target";
        :>> order = 1;
        :>> triggerCondition = "Asked to property-test a function/module, or a high-criticality pure element (keel arch criticality) lacks PBT coverage.";
        :>> actionText = "Read the target's code, its WHY-comments/invariant tags, type signatures, and callers. A PURE, total function (decide/merge3/chunker/...) is the ideal target: its invariants are specifiable without effects.";
        :>> producedArtifact = "A list of candidate invariants + the target's exact input domain.";
        :>> owner = Owner::ai;
    }
    part pbtPropose : ProcessStep {
        :>> id = "2c6402dc-0c2d-4d53-b4fa-6b8c6f3ed10a";
        :>> title = "Propose properties grounded in the code";
        :>> order = 2;
        :>> actionText = "State invariants as properties over generated inputs: totality (never throws), round-trip (decode∘encode = id; concat(chunk(x)) = x), metamorphic (EOL/whitespace-invariance; order-independence), safety (never a destructive/clobbering result for a divergence), monotonicity (grow-only union ⊇ both inputs). CAVEAT (Anthropic): AI-drafted properties are frequently trivial or incorrect — CURATE against the real contract; only the code's owner/invariants decide what is correct.";
        :>> producedArtifact = "A curated property set, each traced to a code invariant.";
        :>> owner = Owner::ai;
    }
    part pbtWrite : ProcessStep {
        :>> id = "472b7f2e-0631-4811-a28c-6fd7c3cbed78";
        :>> title = "Write the property tests";
        :>> order = 3;
        :>> actionText = "Encode each property with the PBT engine (fast-check for TS, proptest for Rust) — real generators over the input domain, shrinking on failure. Test the REAL code path, never a mock (test-authoring D0026). Assert the property, not a tautology.";
        :>> producedArtifact = "Property tests in the deliverable test tree.";
        :>> owner = Owner::ai;
    }
    part pbtReflect : ProcessStep {
        :>> id = "4a7b9bc0-898a-4d0d-b8c7-8661a0080a71";
        :>> title = "Reflection loop — genuine bug or false alarm?";
        :>> order = 4;
        :>> actionText = "Run the tests. For each FAILURE, examine the shrunk counterexample and decide: is it a REAL bug in the code, or a wrong/too-strong PROPERTY (an implicit-semantics assumption the code intends)? Never accept a 'pass' that merely wraps the code in a catch. Fix a wrong property; keep a real-bug property RED (fail-first) until the code is fixed.";
        :>> producedArtifact = "Confirmed counterexamples (real bugs) vs corrected properties.";
        :>> owner = Owner::ai;
    }
    part pbtRecord : ProcessStep {
        :>> id = "1f500a61-56b9-4688-aace-3c65454f2075";
        :>> title = "Record findings";
        :>> order = 5;
        :>> actionText = "RECORD each confirmed bug as a tracked Issue (D0077, severity-carrying, #Resolves from the fixing action) — Anthropic's severity-ranking discipline: act on the high-confidence findings first. Fix each (green), leaving the property test as a permanent regression. A pass with NO counterexample is recorded as the (computed) covering TestResult — never a prose 'looks correct'.";
        :>> producedArtifact = "Issues for real bugs + permanent property tests + a recorded TestResult.";
        :>> owner = Owner::ai;
    }
}

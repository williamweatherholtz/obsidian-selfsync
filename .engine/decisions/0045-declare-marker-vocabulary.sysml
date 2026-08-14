// =====================================================================
// D0045 — declare the actually-used metadata-marker vocabulary in schema/core, to satisfy the toolkit's
// marker-declaration guard (issue077/D0133). Frozen-schema change; owner-directed + owner-accepted
// (2026-08-14, "block should be fixed now. confirm and proceed"). Engine-infrastructure change (schema/core)
// ⇒ recorded here with acceptance per §4; it registers edge KINDS already in use, adding no new semantics.
// =====================================================================
package ProjectDecision0045 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0045 : Decision {
        :>> id = "3dff62cf-a415-4049-8dc6-b35e351a08bd";
        :>> title = "D0045: declare the 17 in-use metadata markers (#Verify/#Satisfies/#Covers/#DerivedFrom + the STPA safety edges) in schema/core so the D0133 marker-declaration guard passes";
        :>> createdAt = "2026-08-14";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "A mid-session rebuild of the sibling toolkit's keel binary introduced a new hard guard (issue077/D0133): a metadata MARKER used in an edge (`#X dependency from A to B;`) MUST be declared as a `metadata def`, because an undeclared/misspelled marker is not type-checked — it validates clean while silently dropping the item from whatever guard or view depends on it. The guard scans the whole tree, so it blocked ALL commits (228 errors across 10 markers per run; non-deterministic in which subset it reports). The gap: the engine originally treated satisfy/verify/allocate as NATIVE edges and left them undeclared (relationships.sysml note), but the INSTANCE data authors them in MARKER form — chiefly the compliance (NIST 800-171) traceability edges (#Verify, #Satisfies) and the STPA safety model (#Causes/#LeadsTo/#Inverts/#Enforces/#Senses/#Mitigates/#Analyzes/#Explains) — plus governance/coverage markers (#Covers/#DerivedFrom/#RealizedBy/#Measures/#Informs/#JustifiedBy/#Changes). The full set of markers used in real `#X dependency` edges but undeclared is 17. This surfaced while committing an UNRELATED SelfSync client bug fix (the self-redeem share trap), which the gate blocked.";
        :>> decision = "Declare all 17 in-use markers as `metadata def` in .engine/schema/core/relationships.sysml, grouped by purpose (traceability/coverage/derivation; STPA safety model). This is the fix the guard itself directs ('Declare it in relationships.sysml, or fix the spelling') and registers the marker vocabulary the instance data already relies on — it makes the existing edges TYPE-CHECKED, adding no new relationship semantics and changing no existing item's meaning. The alternative (bulk-convert the compliance + STPA files from marker form to NATIVE satisfy/verify edges) was declined as a large, higher-risk migration for no semantic gain.";
        :>> rationale = "The markers ARE the edge algebra already in use (§2.2); leaving them undeclared is exactly the silent-drop hazard D0133 exists to close (an undeclared marker validates clean but is invisible to guards/views). Declaring them is mechanical registration, not architectural drift — no new edge KIND is introduced, no existing edge is retyped, and the guard + all dependent views become reliable. Owner-directed: presented as (a) bypass the guard for the unrelated fix, (b) declare the markers now, or (c) investigate the toolkit guard first; the owner chose to FIX THE BLOCK now. The change is reversible (removing the declarations restores the prior state) and scoped to schema/core marker declarations only.";
        :>> consequences = "17 `metadata def` lines added to relationships.sysml; keel validate + guard now ALL PASS (were 228 D0133 errors). No instance data changed; no computed view changes (the edges were always authored — they are now type-checked). The stale note that satisfy/verify markers were 'dropped, those edges are native' is corrected in-file (doc-sync). Frozen-schema change ⇒ this Decision + the owner's acceptance are the required record (§4). This unblocks the composed-vaults/self-redeem release path and every future commit in this repo.";
    }

    verification d0045Accept : Test {
        :>> id = "dd38b30b-8702-4284-a6dd-6c0091930471";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "A toolkit keel rebuild added the D0133 marker-declaration guard, which blocked all commits (including an unrelated SelfSync bug fix) over 17 in-use-but-undeclared markers in the compliance + STPA tracking files. The AI presented three options (bypass the guard for the fix / declare the markers now / investigate the toolkit guard first); the owner replied 'block should be fixed now. confirm and proceed if so' (2026-08-14) — an explicit acceptance of declaring the marker vocabulary in frozen schema/core.";
    }
    part d0045AcceptR1 : TestResult {
        :>> id = "9c6c5065-3426-40b7-a85d-3b1def495de4";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "ad8dbb8";
        :>> judgedAt = "2026-08-14";
        :>> judgedBy = "wweatherholtz";
    }
}

// =====================================================================
// D0017 — propagate SUSPICION from architectural elements to the STPA analysis artifacts that
// depend on them, so a controller/action/feedback/sensor/process-model change automatically flags
// its UCAs / loss scenarios / safety requirements for reassessment. This is the element-level
// realization of the D0016 "parity/reanalysis" future-shape note. It is a keel TOOLCHAIN change
// (it extends what "suspect" means), so it goes through the CHANGE path; recorded + accepted now,
// implementation DEFERRED (sibling toolkit repo) and tracked as the open action stpaSuspicionPropagation.
// Accepted 2026-07-07 by wweatherholtz. Commit prefixed CR:.
// =====================================================================
package ProjectDecision0017 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0017 : Decision {
        :>> id = "c0f1a5cc-f107-4a10-9b20-a1b2c3d40f17";
        :>> title = "D0017: propagate suspicion along STPA analysis->architecture linkage edges (reassess-on-change)";
        :>> createdAt = "2026-07-07";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The STPA analysis artifacts are analyses OF architectural elements: a UCA #Analyzes a ControlAction, a SafetyRequirement is #RealizedBy a Controller, a LossScenario #Senses a Feedback/Sensor (edges authored in .tracking/safety/stpa-ucas.sysml). When the architecture changes, those analyses can silently go stale — the omission mode that let the 0.10.25 delete-on-absence UCA ship unenumerated. keel's CURRENT suspicion (D0050): transitive propagation among TASKS in the orient dependency graph (a done task is suspect if a non-ordering dep is), plus deliverable-SOURCE drift (a verification task whose manifest-listed source changed since verifiedAtCommit) and critique_suspect (an unresolved failing critique). It does NOT cover model-element -> analysis-element architectural drift: Controller/ControlAction/Feedback/Sensor/ProcessModel are EngineSafety parts, not tasks, and the #Analyzes/#RealizedBy/#Senses edges are not the task deps graph. So editing a controller today flags nothing downstream.";
        :>> decision = "Extend keel's suspicion computation to propagate along the analysis->architecture linkage edges: when an architectural element (Controller, ControlAction, Feedback, Sensor, ProcessModel) is modified at a commit LATER than a dependent analysis element (UnsafeControlAction, LossScenario, SafetyRequirement) was last REASSESSED, mark that analysis element suspect (surfaced in `keel orient` + the `safety` view + a `keel suspect` reason). Follow #Analyzes / #RealizedBy / #Senses directly and #Explains / #Mitigates / #Inverts / #Enforces transitively, to fixpoint. Requires a per-element 'reassessed-at-commit' stamp on the analysis elements (analogous to verifiedAtCommit on verification tasks): the element is suspect while a linked architectural element's last-touched commit is newer than the stamp. EXCLUDE Hazards and Losses from architectural propagation — they are architecture-INDEPENDENT, so only a change to a Loss / stakeholder / system boundary reassesses a Hazard, never a controller change. Generalize the mechanism beyond STPA to any authored analysis-artifact -> source edge; STPA is the first consumer.";
        :>> rationale = "Linkage without propagation is a static diagram; the value the owner named is that a controller edit AUTOMATICALLY raises 'reassess these UCAs/requirements' rather than relying on a human to remember — the same discipline as deliverable-source suspicion (D0050), extended to model-internal analysis->architecture edges. Excluding hazards/losses keeps the semantics correct: they sit above the design and must not churn when the design does. A per-element reassessed-at stamp (not whole-analysis) gives GRANULAR, low-noise flags — only the artifacts touching the changed element light up. ALTERNATIVES: manual re-review on every architecture change (REJECTED — that is exactly the omission mode we keep hitting); recompute the entire STPA on any change (REJECTED — no granularity, noisy, discards prior judgement); deliverable-manifest coarse drift only (REJECTED — it flags a whole verification task, not WHICH UCA/requirement, and STPA elements are not manifest tasks). DEFERRED because it is a keel toolchain change (implemented in the sibling repo) and the analysis is still settling; the linkage edges it runs on are already authored, so the model side is ready. CRITERIA: automatic (no human memory) x granular (per-element) x semantically-correct (hazards/losses excluded) x reuses the existing suspicion surface x general (any analysis->source edge).";
        :>> consequences = "No code now. A keel change (keel-cli suspicion/orient) via the CHANGE path, tracked as the OPEN delivery action stpaSuspicionPropagation. Needs: (1) a reassessed-at-commit stamp on UnsafeControlAction/LossScenario/SafetyRequirement (schema addition — EngineSafety); (2) suspicion propagation along the linkage edge set to fixpoint, hazards/losses excluded; (3) surfacing in orient + the safety view + `keel suspect`. Complements D0016 (parity/reanalysis) as its element-level realization, and the D0016 note about manifest-listing the STPA verify-Tests (coarse) — D0017 is the fine-grained model-internal counterpart. doc-sync when built: update CLAUDE.md section 5 (suspicion) + the safety-view description. Because item (1) touches schema/core-adjacent EngineSafety, that sub-step is itself frozen-schema-governed (human sign-off).";
    }

    verification d0017Accept : Test {
        :>> id = "c0f1a5cc-f108-4a10-9b20-a1b2c3d40f18";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed (2026-07-07): 'part of the value here is linkage, so going forward controller changes can flag their respective controllers with a need to reassess ucas, hazards, etc. and other elements as well (sensors, feedback, etc.) when the state changes, our model should propagate suspicion' — accepting that we build architecture->analysis suspicion propagation (recorded here, deferred), and that the model author the linkage edges it runs on (done in stpa-ucas.sysml).";
    }
    part d0017AcceptR1 : TestResult { :>> id = "c0f1a5cc-f109-4a10-9b20-a1b2c3d40f19"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "ae04b7d"; :>> judgedAt = "2026-07-07"; :>> judgedBy = "wweatherholtz"; }
}

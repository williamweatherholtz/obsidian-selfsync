// =====================================================================
// EngineRelationships — the engine edge algebra. NATIVE where the pilot
// supports it (nativeTrace 2026-06-10, user-agreed rescope); metadata markers
// only where it does not. Spiked: _spike_trace.py / _spike_verify.py.
//
//   satisfy   -> NATIVE `satisfy <req> by <element>` (renders SatisfyRequirementUsage)
//   verify    -> NO BASE FORM EXISTS for this edge. #Verify is a JUSTIFIED last resort (D0140).
//                Corrected 2026-08-14 (issue098): the line previously here said a requirement-
//                verification "must be in the `objective` of a verification case", which is true of
//                the SYNTAX and false of the SEMANTICS — `objective r;` DECLARES a nested member and
//                carries NO reference. Kernel-proven with the cheapest possible discriminator: an
//                UNDECLARED name. `verification def V { subject s; objective zzz; }` PASSES, while
//                `satisfy r by zzz3` FAILS with "Couldn't resolve reference to Element" — so the
//                kernel does resolve references and `objective` does not take one. Migrating #Verify
//                onto that shape would delete all 456 links while both toolchains reported clean.
//                The reference-bearing forms `objective :>> r` / `:> r` DO resolve, but require a
//                REQUIREMENT-TYPED target, and 309 of 456 #Verify edges target `part Decision`.
//                No standalone `verify` form parses at all. See _spike_objective_binding.py.
//   derive/   -> use `:>` (specialization) where the metaclasses allow it. The v1 keywords
//   refine/      derive/refine/trace are ABSENT from the v2 pilot grammar (re-confirmed 2026-08-14,
//   trace        _spike_base_algebra.py). #DerivedFrom is a JUSTIFIED last resort (D0140): all 37 of
//                its edges are CROSS-metaclass (Decision/Story/UseCase -> Need) and `:>` cannot cross
//                metaclasses — see the D0055 note at element.sysml:48-53.
//   allocate  -> NATIVE `allocate <fn> to <comp>` (parses - _spike_remaining; the
//                old #Allocate marker was redundant and is gone).
//   dependsOn / supersede -> metadata markers below (no native pilot form;
//                supersede's back-reference is COMPUTED).
//
// SUSPICION propagates DOWNSTREAM along satisfy, verify, :>, allocate, and
// semantic dependsOn — but NOT along an ordering-only dependency. Tag those
// with #OrderingOnly to exclude them (see contracts/computed-state.md).
// =====================================================================
package EngineRelationships {
    doc /* The edge algebra: native satisfy/verify/allocate/:> where the pilot supports them; metadata markers (#DependsOn, #Supersede, #OrderingOnly) only where it does not. Suspicion travels semantic edges only. */


    // #Satisfy / #Verify / #Allocate markers dropped — those edges are native.
    metadata def DependsOn;
    metadata def Supersede;
    metadata def OrderingOnly;
    // #CharteredBy: work item -> the originating item (Decision / Need / Requirement) that
    // chartered it (D0068, charter-lineage governance). Authored as a marked dependency:
    // `#CharteredBy dependency from <workItem> to <charter>;`. Carries process IDENTITY by
    // lineage; the governing process VERSION is COMPUTED as-of the charter's creation commit.
    metadata def CharteredBy;

    // #Resolves: a resolver (backlog action OR Decision) -> the Issue it resolves (D0077, issue
    // resolution loop). Authored as a marked dependency: `#Resolves dependency from <resolver>
    // to <issueNNN>;`. An Issue is RESOLVED (computed, never stored) iff a #Resolves resolver is
    // complete — an action that is done or a Decision with status=accepted; else OPEN.
    metadata def Resolves;

    // #ProspectiveChange / #SafetyChange: marks a Decision AS a process change + its RETROACTIVITY
    // (D0068/D0070, process-governance). prospective = outputs chartered under the prior version
    // stay valid (D0062 default); safety = downstream items are mandatory reprocess candidates.
    // Applied as a PREFIX MARKER on the Decision part itself, in its own file (in-package, valid
    // in BOTH rust and the kernel): `#ProspectiveChange part dNNNN : Decision { ... }`. (The
    // `{ @Marker; }` member form parses in the kernel but the rust authority rejects it.) NO
    // cross-reference to the process is stored — which-process + when are COMPUTED from git (the file(s)
    // changed in that Decision's commit), made reliable by the keystone hard-lock guard (a
    // process-def change must co-commit such a Decision, or the commit fails). This SUPERSEDES
    // D0069's stored `#... dependency from dNNNN to <Process>` edge (which forced a floating
    // .tracking file — issue021); the member-marker form removes the cross-package reference
    // entirely, so issue021 dissolves. List: `keel process-changes`.
    metadata def ProspectiveChange;
    metadata def SafetyChange;

    // ── D0133/issue077: the markers guards + computed views CONSUME, now DECLARED ──
    // These were used in anger for months while appearing nowhere as a `metadata def`. Because
    // markers were not type-checked, a MISSPELLED marker validated clean and silently removed that
    // item from the depending check's view — and a blind guard reports PASS, not a violation. The
    // exposure was not theoretical: `#Verify` alone carries 456 edges and is what
    // tier-satisfaction/sr_verified_pct and the verification-trace guard key on, so one typo would
    // report a DELIVERED requirement as unverified. Declared here under the §2.5 frozen-schema
    // sign-off (declaredMarkersSchemaSignOff, 2026-08-13), and `keel validate`/`check-engine` now
    // REJECT an undeclared marker, so a typo fails loudly instead of blinding a control.

    // #Verify: a Test -> the element it verifies. `#Verify dependency from <test> to <element>;`
    // Load-bearing for tier-satisfaction (an SR is verified iff a Test #Verify-links it), the
    // verification-trace guard, critique coverage and critic independence.
    metadata def Verify;
    // #DerivedFrom: a derived item -> the upstream it derives from (Decision/SR -> Need). Load-bearing
    // for the HARD requirement-rootedness guard and the rootedness burndown.
    metadata def DerivedFrom;
    // #Capability: marks a user-facing feature whose rootedness is HARD-gated (D0099) — it must carry
    // a #DerivedFrom edge to a Need. Unmarked decision-driven work is exempt (D0064).
    metadata def Capability;
    // #Dispositions: a typed disposition verdict -> the finding it dispositions (D0092).
    metadata def Dispositions;
    // #Covers: a per-sitting review -> the sprint(s) it covers (D0049/issue040 sitting-coverage).
    metadata def Covers;
    // #ProcessDefect: marks an Issue as a recurrable PROCESS defect, which per D0047 must resolve to a
    // guard-producing action (defect-guard-coverage reads this).
    metadata def ProcessDefect;
    // #Measures: a Measurement datapoint -> the Indicator it measures (D0089/D0091).
    metadata def Measures;
    // #Informs: an Indicator -> the Decision it informs by direction (D0088 — monitored, not gated).
    metadata def Informs;
    // #View: marks an artifact whose nature is COMPUTED, not authored (D0015). Moved here from
    // workflows/_meta.sysml, which declares workflow-local artifact types only — a marker is not one,
    // and splitting the vocabulary across two files meant an audit from this file undercounted by one
    // marker and 73 uses (D0105 one-canonical-home).
    metadata def View;

    // #JustifiedBy: a declared Rule -> the Decision that justifies it (D0105/D0107).
    metadata def JustifiedBy;

    // ---- PROJECT markers (project D0045; re-applied by name after the 2026-09-07 engine resync, D0050) ----
    // Declared so the instance data's marker-form edges are TYPE-CHECKED (an undeclared marker validates
    // clean while silently dropping the edge from every guard and view - D0133). Each carries the D0139(B)
    // justification: the base SysML v2 constructs considered and why each fails for THIS edge. The STPA
    // element types are all `part def X :> Element` (schema/safety/stpa.sysml, D0008), which is the
    // recurring reason the requirement-typed base relationships do not apply to them.
    // (`Changes`, declared by D0045, was retired here: 0 AST edges and 0 prose uses in the instance data.)
    //
    // Compliance / traceability edges (STPA requirement layer, .tracking/safety):
    metadata def Satisfies { doc /* SafetyRequirement -> SystemSafetyConstraint: the requirement is what satisfies the constraint. Base `satisfy X by Y` considered - it needs X to be a requirement USAGE, and the STPA constraint is a `part def SystemSafetyConstraint :> Element` with a part-typed SafetyRequirement as the source, so neither end types. Bare `dependency` considered - it loses the kind, and the STPA trace lens must tell 'satisfies a constraint' apart from #RealizedBy and #Mitigates on the same source. Retyping the STPA vocabulary as requirement usages would let base `satisfy` apply; that is a safety-schema redesign (D0008), not a marker fix, and is not made here. */ }
    metadata def RealizedBy { doc /* SafetyRequirement -> Controller: the controller realizes the requirement. Base `satisfy` considered - same failure as #Satisfies (no requirement usage at either end). Base `allocate X to Y` considered - both ends are parts so it parses, but it would read as a structural allocation indistinguishable from any other part-to-part allocation, losing that a REQUIREMENT is being realized; the control-structure lens keys on that distinction. */ }
    // STPA safety-model edges (losses / hazards / UCAs / constraints / scenarios - see .tracking/safety/):
    metadata def Causes { doc /* UnsafeControlAction -> Hazard: the first hop of the STPA trace (UCA -Causes-> H -LeadsTo-> L). Base `succession` considered - it orders action USAGES in time, and a UCA and a Hazard are analysis elements, not executing actions; causation is not sequence. `:>` considered - a UCA is not a specialization of a hazard. Bare `dependency` considered - it loses which hop this is, and the traceability lens separates the hops. */ }
    metadata def LeadsTo { doc /* Hazard -> Loss (also LossScenario -> Hazard): the second hop of the STPA trace. Same analysis as #Causes: `succession` is temporal ordering of actions, `:>` is specialization, and a bare `dependency` cannot be told from the other hop. Kept distinct from #Causes because the lens renders UCA->H and H->L as different columns. */ }
    metadata def Inverts { doc /* SystemSafetyConstraint -> Hazard, ControllerConstraint -> UnsafeControlAction: the constraint is the INVERSION of the hazard/UCA it was written against (STPA step 1/3 discipline). Base `satisfy` considered - wrong meaning (a constraint does not satisfy a hazard) and part-typed ends. `:>` considered - not a specialization. Bare `dependency` considered - loses the kind; an unlabeled constraint->hazard edge could equally be #Mitigates. */ }
    metadata def Enforces { doc /* Controller -> SystemSafetyConstraint: this controller is where the constraint is enforced. Base `allocate` considered - both ends are parts so it parses, but the control-structure lens must tell 'enforces a constraint' from 'senses a scenario' (#Senses) and an allocation carries neither. Base `assert constraint` considered - it asserts an EVALUABLE `constraint def` predicate; STPA constraints are prose statements, not predicates (D0088 measure spectrum), so there is nothing to assert. */ }
    metadata def Senses { doc /* LossScenario -> Feedback: the scenario is detected (or missed) through this feedback path. Base `connection` / `flow` considered - they relate ports and parts inside a structure, and a LossScenario is an analysis artifact, not a structural element, so the source does not type. Bare `dependency` considered - loses the kind (the lens distinguishes sensing from enforcing). */ }
    metadata def Mitigates { doc /* SafetyRequirement -> UnsafeControlAction: the requirement mitigates the UCA. Base `satisfy` considered - a UCA is not a requirement usage and mitigation is not satisfaction. Bare `dependency` considered - loses the kind; #Satisfies, #RealizedBy and #Mitigates leave the same SafetyRequirement and each feeds a different STPA column. */ }
    metadata def Analyzes { doc /* UnsafeControlAction -> ControlAction: the UCA is an analysis of this control action (one of the four UcaType ways it goes wrong). Base `perform action` considered - a part PERFORMS an action usage; the UCA does not perform the action, it analyses it, and both are `part def` here. `:>` considered - a UCA is not a subtype of the action. Bare `dependency` considered - loses the kind. */ }
    metadata def Explains { doc /* LossScenario -> UnsafeControlAction: the scenario explains how the UCA arises (STPA step 4). Base `succession` considered - not a temporal order. Bare `dependency` considered - loses the kind; the same scenario also carries a #LeadsTo edge to its hazard, and the lens must separate the two. */ }
}

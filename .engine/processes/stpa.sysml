// =====================================================================
// STPA — System-Theoretic Process Analysis (Leveson & Thomas) as an ACTIVATED PROJECT PROCESS with ordered steps
// (owner, 2026-09-08: "do we have an activated STPA process with step 1, step 2, etc.?" — until this file, STPA ran
// only as a skill + SOP, and its four steps lived in prose). Project D0053. Deployed by the `safety-analysis`
// skill (D0059), which wraps the engine's `stpa` SOP for Steps 1–4 and carries Steps 5–6.
//
// Steps 1–4 are Leveson's. Step 5 is D0017's reanalysis-on-change trigger. Step 6 is this project's own rule:
// a state that can introduce a hazard is a machine on the shared primitive (client/src/fsm.ts), registered on
// its STPA process model (`// STPA-FSM:` in control-structure.sysml) — enforced by fsm-conformance.test.
// =====================================================================
package SelfSyncStpa {
    private import EngineElement::*;     // Cadence / Owner enums
    private import EngineProcess::*;

    action stpa : Process {
        :>> id = "297a72aa-a0d5-4e94-851b-7bd285bb61a3";
        :>> title = "STPA (System-Theoretic Process Analysis)";
        :>> purpose = "Identify what must not be lost, the hazards that lead there, the control structure that can cause them, the unsafe control actions and the scenarios behind them, and derive verified safety requirements — then keep the analysis true as the system changes, and keep every hazard-bearing state visible as a registered state machine.";
        :>> cadence = Cadence::adHoc;
        // APPLIES-WHEN: the deliverable can lose, corrupt, expose or silently misreport the user's data — sync, storage, authorization, or any control loop where a wrong or mistimed action causes a loss
    }

    action stpa1Purpose : ProcessStep {
        :>> id = "256b358d-d562-48fd-9a5a-2a11547b84cc";
        :>> title = "Step 1 — Define the purpose: losses, hazards, system-level constraints";
        :>> triggerCondition = "Safety-relevant scope is opened (a new capability, a new trust boundary, a data-loss report).";
        :>> actionText = "Enumerate the Losses (what stakeholders cannot accept losing), the system boundary and environment, the Hazards (system states that, with worst-case environment, lead to a loss), and one inverse System Safety Constraint per hazard. Author them as EngineSafety items in .tracking/safety/ with #LeadsTo (hazard -> loss) and #Inverts (constraint -> hazard) edges. Scope stays where the trusted-server model bounds it (D0008: STPA yes, HARA/ASIL no).";
        :>> producedArtifact = "Loss, Hazard, SystemSafetyConstraint items + #LeadsTo / #Inverts edges (stpa-hazards.sysml).";
        :>> owner = Owner::either;
    }
    action stpa2Structure : ProcessStep {
        :>> id = "20736d8d-379b-425a-9659-d2f964d2e5be";
        :>> title = "Step 2 — Model the hierarchical control structure";
        :>> actionText = "Model every Controller, ControlledProcess, ControlAction (issuedBy / actsOn), Feedback (reportsTo), Sensor and Actuator, and each controller's ProcessModel (its beliefs). A human is a controller too. Authority is the vertical axis; control goes down, feedback comes up (the stpa-diagram process renders it). A controller that holds a state machine names it here — see Step 6.";
        :>> producedArtifact = "Controller / ProcessModel / ControlAction / Feedback items (control-structure.sysml).";
        :>> owner = Owner::either;
    }
    action stpa3Ucas : ProcessStep {
        :>> id = "a7e0084c-83d4-4c8c-807e-0640000235d3";
        :>> title = "Step 3 — Identify unsafe control actions (four guide words per control action)";
        :>> actionText = "For EVERY control action ask the four guide words — provided when it causes a hazard; not provided when needed; provided too early / too late / out of order; stopped too soon / applied too long — and record each hazardous cell as an UnsafeControlAction (ucaType, context, statement naming the hazard) with #Analyzes -> the control action and #Causes -> the hazard, and one inverse ControllerConstraint with #Inverts. Non-hazardous cells are not recorded.";
        :>> producedArtifact = "UnsafeControlAction + ControllerConstraint items with #Analyzes / #Causes / #Inverts edges (stpa-ucas.sysml).";
        :>> owner = Owner::either;
    }
    action stpa4Scenarios : ProcessStep {
        :>> id = "32935f62-dc85-44e6-ab52-b1ef002a61c1";
        :>> title = "Step 4 — Identify loss scenarios and derive verified safety requirements";
        :>> actionText = "For each UCA write the LossScenarios of BOTH classes — why the controller issues it (inadequate process model / feedback / control algorithm) and why a correct action is not executed or feedback never arrives — with #Explains -> UCA, #LeadsTo -> hazard, and #Senses -> the inadequate feedback where that is the cause. Derive SafetyRequirements that #Mitigates the UCA, #Satisfies the constraint, are #RealizedBy a controller, and carry a #Verify edge from a Test with a recorded PASS (acceptance.sysml). An SR without a passed verifying Test is a gap, listed as such.";
        :>> producedArtifact = "LossScenario + SafetyRequirement items; #Explains / #LeadsTo / #Senses / #Mitigates / #Satisfies / #RealizedBy / #Verify edges.";
        :>> owner = Owner::either;
    }
    action stpa5Reanalysis : ProcessStep {
        :>> id = "1b66eeee-9a32-4b1e-ac27-bdb640130374";
        :>> title = "Step 5 — Reanalyse on change (D0017)";
        :>> triggerCondition = "A Controller, ControlAction, Feedback, Sensor or ProcessModel is modified at a commit later than its dependent analysis was last reassessed — or a field report names a loss.";
        :>> actionText = "Re-run Steps 3–4 for the UCAs, scenarios and requirements linked to the changed element (via #Analyzes / #RealizedBy / #Senses and transitively #Explains / #Mitigates / #Inverts / #Enforces). Until keel propagates suspicion along these edges automatically (sysmlv2-ai-toolkit #66, stpaSuspicionPropagation), the trigger is the architecture-audit's element drift plus every in-field loss report; record the reassessment on the analysis items' text with the commit reassessed against. Hazards and Losses are NOT reopened by an architecture change — only by a loss / stakeholder / boundary change.";
        :>> producedArtifact = "Reassessed UCAs / scenarios / SRs (or new ones) for the changed controller, with the commit they were reassessed against.";
        :>> owner = Owner::ai;
    }
    action stpa6Fsm : ProcessStep {
        :>> id = "688faa56-f1f6-4bb8-afa9-b083e72ca76c";
        :>> title = "Step 6 — Hazard-bearing state is a registered state machine";
        :>> triggerCondition = "Code introduces or changes a state whose transitions can cause a hazard (connection, engine phase, mount lifecycle, transport, a multi-step irreversible user action).";
        :>> actionText = "Express the state as a machine on the shared primitive client/src/fsm.ts (defineMachine: pure, total, conservative, declared terminal states, effects as data), NAME it after the STPA process model it realizes, and register it on that ProcessModel with a `// STPA-FSM: <module>#<machine>` line in control-structure.sysml. Drive its whole table through tableCoverage in a test. A machine that cannot yet be moved is registered `// STPA-FSM-PENDING: <module> (<issue>)` with a tracked resolver. fsm-conformance.test holds both directions: every registered machine exists on the primitive and names its process model; every module that defines a machine is registered.";
        :>> producedArtifact = "A fsm.ts machine + its STPA-FSM registration + a total-table test; or a PENDING registration with its tracked issue.";
        :>> owner = Owner::ai;
    }

    // step order, native succession (D0143)
    first stpa1Purpose then stpa2Structure;
    first stpa2Structure then stpa3Ucas;
    first stpa3Ucas then stpa4Scenarios;
    first stpa4Scenarios then stpa5Reanalysis;
    first stpa5Reanalysis then stpa6Fsm;
}

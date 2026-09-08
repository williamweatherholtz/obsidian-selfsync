---
name: safety-analysis
description: |
  Deploys this project's STPA process (.engine/processes/stpa.sysml, project D0053): Steps 1–4 of
  System-Theoretic Process Analysis via the engine's `stpa` skill and its SOP (losses, hazards,
  constraints; control structure; unsafe control actions by the four guide words; loss scenarios and
  verified safety requirements), then Step 5 — reanalyse on change (D0017) — and Step 6 — every
  hazard-bearing state is a machine on client/src/fsm.ts registered on its STPA process model.
  Use when asked to "run STPA", "do a hazard analysis", "is this state safe", "add a state machine",
  "what could go wrong with this controller", or when a field report names a loss. This is the
  deploying skill for .engine/processes/stpa.sysml (D0059).
metadata:
  version: 0.1.0
  domain: [STPA, STAMP, system-safety, hazard-analysis, state-machines, MBSE, SysMLv2]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# safety-analysis

Deploys `.engine/processes/stpa.sysml`. The engine's `stpa` skill (`.engine/skills/stpa/SKILL.md`,
`references/sop.md`) is the procedure for Steps 1–4; this skill adds the project's Steps 5–6 and the
places things live.

## Where the model lives
- `.tracking/safety/stpa-hazards.sysml` — Losses, Hazards, SystemSafetyConstraints (Step 1)
- `.tracking/safety/control-structure.sysml` — Controllers, ProcessModels, ControlActions, Feedback (Step 2) and the
  `// STPA-FSM:` registrations (Step 6)
- `.tracking/safety/stpa-ucas.sysml` — UnsafeControlActions, ControllerConstraints, LossScenarios, SafetyRequirements (Steps 3–4)
- `.tracking/verification/acceptance.sysml` — the `#Verify` edges from passed Tests to SafetyRequirements (Step 4)

## Steps
1. **Purpose** — Losses, Hazards, one inverse constraint each. Edges: `#LeadsTo` (H → L), `#Inverts` (SC → H).
2. **Control structure** — every controller (humans included), its ProcessModel beliefs, ControlActions (`issuedBy`,
   `actsOn`), Feedback (`reportsTo`). Render with the `stpa-diagram` process.
3. **UCAs** — for EVERY control action, the four guide words; each hazardous cell is a UCA (`ucaType`, `context`,
   `statement` naming the hazard) with `#Analyzes` → action, `#Causes` → hazard, and one ControllerConstraint `#Inverts`.
4. **Scenarios + requirements** — both scenario classes per UCA (`#Explains`, `#LeadsTo`, `#Senses` for feedback
   causes); SafetyRequirements `#Mitigates` / `#Satisfies` / `#RealizedBy`, and a `#Verify` edge from a Test with a
   recorded PASS. No passed Test → the SR is listed as a gap, not linked.
5. **Reanalyse on change** — when a Controller / ControlAction / Feedback / ProcessModel changes, or a field report
   names a loss, redo Steps 3–4 for the linked analysis and record the commit reassessed against. Automatic
   suspicion propagation is upstream work (sysmlv2-ai-toolkit #66).
6. **State is a machine** — any hazard-bearing state goes on `client/src/fsm.ts` (`defineMachine`: pure, total,
   conservative, declared terminals, effects as data), named after its process model, registered with
   `// STPA-FSM: client/src/<module>.ts#<machine>` on that ProcessModel, with a `tableCoverage` test. Not yet
   movable → `// STPA-FSM-PENDING: <module> (<issue>)` plus a tracked resolver. `client/test/fsm-conformance.test.ts`
   enforces both directions on every run.

## Discipline
- Every element carries `id`, `createdAt`, `createdBy`; edges are typed markers, never prose.
- A UCA that is already mitigated is still recorded — the mitigation is the SR, and the SR needs its Test.
- Never record a verification the tests don't give (D0016/D0051): an SR without a passed Test stays a gap.
- Validate + gate: `keel validate . && keel guard` (marker vocabulary, attribute vocabulary, verification-trace).

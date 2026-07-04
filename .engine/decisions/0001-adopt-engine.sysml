// =====================================================================
// D0001 — adopt the SysML work-tracking engine into this project (the obsidian-livesync rebuild) as its
// management system, and bring the engine's process/workflow definitions under version control. Importing
// the engine wholesale adds every .engine/processes/*.sysml + .engine/workflows/*.sysml file, which the
// D0070 keystone guard (process-change) reads as a process-definition change requiring a co-committed
// process-change Decision. This decision IS that record: it establishes the governance baseline for the
// project so future process-def edits each carry their own decision. Marked #ProspectiveChange (applies
// going forward; not retroactive). Accepted 2026-07-02 by wweatherholtz (explicit choice to author a
// one-time bootstrap Decision rather than bypass the hook or leave the engine untracked).
// =====================================================================
package ProjectDecision0001 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0001 : Decision {
        :>> id = "a0000001-0001-4a01-8b01-000000000001";
        :>> title = "D0001: adopt the work-tracking engine into the obsidian-livesync rebuild project";
        :>> createdAt = "2026-07-02";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "This repository is a fork of vrtmrz/obsidian-livesync being rebuilt into a fresh, self-hosted, multi-tenant Obsidian sync system (a new Rust server + a lean new plugin; the original fork is archived under obsolete/). The reusable SysML work-tracking engine was dropped into the repo (.engine/, .tracking/, .githooks/, CLAUDE.md) to manage that rebuild with traceable decisions and CI-enforced honest-state guards. Committing the engine for the first time stages every .engine/processes/*.sysml and .engine/workflows/*.sysml file; the D0070 process-change guard (a hard commit gate) reads any change to those files — including an initial import — as a process-definition change that must be accompanied by a #ProspectiveChange/#SafetyChange-marked Decision co-committed in the same change. No such project decision existed (.engine/decisions/ was empty; the engine's own design rationale is read-only under .engine/reference/decisions/), so the import was blocked. This is a bootstrap edge, not a genuine process modification, but the guard cannot distinguish the two.";
        :>> decision = "Adopt the engine as this project's management system and commit its process/workflow definitions, contracts, skills, views, and the .tracking instance seed (real project actors) under version control, recorded here as a prospective process-change Decision. This establishes the governance baseline: from now on every change to a .engine/processes/*.sysml or .engine/workflows/*.sysml definition must record its own process-change Decision (D0070). The engine's shipped reference decisions (D0001–D0104) remain read-only rationale under .engine/reference/decisions/; this project authors its own fresh decisions starting from this one.";
        :>> rationale = "ALTERNATIVES: (i) commit the engine with --no-verify to bypass the pre-commit guard — REJECTED: bypassing an honesty guard is exactly what CLAUDE.md forbids absent explicit cause, and it would leave the adoption unrecorded. (ii) leave .engine/.tracking untracked — REJECTED: the management system would then have no version history in the repo it manages, undermining the traceability the engine exists to provide. (iii) CHOSEN — record the adoption as a real #ProspectiveChange Decision co-committed with the engine files: it satisfies D0070 honestly (there genuinely IS a decision to adopt these process definitions), creates the project's first governance record, and needs no code/schema change. CRITERIA: honesty (the import is recorded, not hidden) x discipline (no hook bypass) x traceability (engine under version control) x minimal-effort (one decision file).";
        :>> consequences = "The engine's process/workflow definitions, contracts, skills, views, and the .tracking seed (actors set to the real project owner) enter version control. Future edits to any .engine/processes/*.sysml or .engine/workflows/*.sysml file will each require their own process-change Decision (D0070) — expected and desired. The engine's reference decisions stay read-only under .engine/reference/decisions/. `keel` is provided by the separate sysmlv2-ai-toolkit project (on PATH) and runs as the active pre-commit gate (core.hooksPath=.githooks). No schema change; no code change. doc-sync: none required beyond this record (CLAUDE.md already describes the engine).";
    }

    verification d0001Accept : Test { :>> id = "a0000001-0001-4a01-8b01-000000000002"; :>> method = VerificationMethod::confirmation; :>> procedureText = "wweatherholtz attests acceptance of d0001 (adopt the work-tracking engine into this project and commit its process/workflow definitions as a prospective process-change) via the explicit choice 'Author a one-time bootstrap Decision' on 2026-07-02, selected over bypassing the pre-commit hook or leaving the engine untracked."; }
    part d0001AcceptR1 : TestResult { :>> id = "a0000001-0001-4a01-8b01-000000000003"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "7e3f2b2"; :>> judgedAt = "2026-07-02"; :>> judgedBy = "wweatherholtz"; }
}

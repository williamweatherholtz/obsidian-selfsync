// D0094 (PROPOSED — NOT YET ACCEPTED) — Partial engine resync onto keel 444333d: docs, claude surface and cli facts; schema left alone
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0094Accept event on sign-off.
package Decision0094 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    // #ProspectiveChange (D0070) - this Decision governs a process/schema change; the co-committed
    // change rides the process-change guard's hard lock.
    #ProspectiveChange part d0094 : Decision {
        :>> id = "2e8a3e72-4df9-453a-bb51-ce68cdb4b16e";
        :>> title = "Partial engine resync onto keel 444333d: docs, claude surface and cli facts; schema left alone";
        :>> createdAt = "2026-09-15";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::proposed;
        :>> context = "The engine surface in this repo was stamped by keel build 21e43e6 while the installed binary is 0.4.1 build 444333d, so guard cli-reference reported 45 retired command names (keel orient / validate / guard / arch / reverify / apply-review ...) across CLAUDE.md, seven skills, three contracts and one process, guard claude-surface-drift reported the keel-owned .claude surface and plugin rendering as written by a different generator, and guard cli-surface-declared reported seven .engine/cli/commands.sysml facts whose invocation text no longer matches the binary's mirror. A follower running a documented command exits 2 with a usage dump. A full keel migrate was attempted and refused itself: the binary's codeaudit module defines a narrower vocabulary than .tracking/architecture/elements.sysml uses, 555 validate errors, rolled back to 397fa2a5 byte-for-byte.";
        :>> decision = "Bring the CLI-reference, claude-surface and cli-facts layers of the engine onto build 444333d WITHOUT the schema resync: patch exactly the 45 file:line sites guard cli-reference named (driven off the guard's own output, so recorded facts in .engine/decisions are untouched), run keel sync-claude to regenerate the keel-owned .claude surface and plugin rendering, and replace .engine/cli/commands.sysml with the copy embedded in this binary. Leave .engine/schema/codeaudit and .tracking/architecture as they are; the codeaudit vocabulary conflict stays open and is decided separately.";
        :>> rationale = "These three layers are documentation and declared-surface facts: they carry no instance data, so bringing them current loses nothing and stops the engine from instructing a follower to run commands that do not dispatch. The schema layer is the opposite: resyncing it would overwrite InvariantSafety, RiskClass, StpaRole, DesignPattern and CodeElementKind with a narrower vocabulary and drop the file, name, auditRound, auditedAt, riskRationale, invariantNotes and restructure attributes that 169 recorded CodeElements use, destroying audit provenance the migration process forbids destroying. Splitting the resync at that seam takes the honest-state gate green on everything that can be current, and leaves the one genuine conflict visible instead of paying for it with deleted facts.";
        :>> consequences = "guard cli-reference, claude-surface-drift and cli-surface-declared pass; the engine surface stamp becomes 0.4.1 444333d while .engine/schema/codeaudit still diverges from the binary, so a future keel migrate will still refuse until the codeaudit conflict is decided (widen the toolkit enums, make the local module a project extension, or retire the registry). .claude/settings.json, the output style and 55 skill renderings are regenerated, so any hand-edit to a keel-owned entry there is overwritten.";
    }
}

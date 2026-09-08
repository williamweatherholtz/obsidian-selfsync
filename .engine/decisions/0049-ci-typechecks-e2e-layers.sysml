// =====================================================================
// D0049 (PROJECT numbering) — CI typechecks the Playwright e2e layers. PROPOSED, not yet accepted:
// this edits .github/workflows/ci.yml, which is part of the enforcement surface (D0209 clause 2), so
// the process-change guard rightly demands a #ProspectiveChange Decision and a HUMAN signature. The AI
// authored the change and this record; the acceptance is the owner's, via `keel accept d0049`.
// =====================================================================
package ProjectDecision0049 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0049 : Decision {
        :>> id = "b2cc3d2f-0e26-4fff-b576-cc1ab9520c74";
        :>> title = "D0049: CI typechecks the Playwright e2e layers (tsconfig.e2e.json) — code that had never been typechecked at all";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::proposed;
        :>> context = "While re-implementing the real-Obsidian e2e helpers (issueForkedE2eHelpersUnattributed) it emerged that client/tsconfig.json includes only `src` and `test`. The Playwright layers - client/e2e-obsidian/ and client/e2e-admin/ - are outside it, so `npx tsc --noEmit` has NEVER typechecked them; Playwright transpiles them at run time, and a type error could only surface when the slow, install-gated suite actually ran - a suite that skips itself wherever Obsidian is not installed, i.e. in CI. The e2e code was therefore effectively unchecked everywhere except a developer machine with Obsidian present. A new client/tsconfig.e2e.json extends the main config and includes both layers, so `npx tsc -p tsconfig.e2e.json` is a cheap gate that runs anywhere.";
        :>> decision = "Add one step to the client-tests job in .github/workflows/ci.yml, after the vitest run: `npx tsc -p tsconfig.e2e.json` (working-directory client). It runs on every push and PR to main regardless of whether Obsidian is available, so a type error in e2e code fails the build instead of hiding until someone with Obsidian runs the suite. No other workflow change.";
        :>> rationale = "Cheap, additive, and it closes a real gap: the layer that exercises the real ObsidianVaultIo and transport was the one piece of code with no static check at all. Placing it in CI rather than only in the pre-commit hook matters because the hook runs `keel validate` and `keel guard`, not tsc, and because CI is where a contributor without a local Obsidian gets any signal about that code. The change is confined to a single new step so the enforcement surface changes in exactly one, auditable place - which is also why it is recorded here as a prospective process change rather than folded into a code commit: a CI workflow is part of what enforces this project's honesty, and the guard that blocked the unsigned edit was doing its job.";
        :>> consequences = "ci.yml client-tests gains one step. The e2e layers are typechecked on every CI run (they passed clean when introduced). A future e2e type error blocks merge. The ci.yml step was co-committed with this PROPOSED record at 152f269a - the D0070 keystone shape the process-change guard accepts, so the gate ran on the change rather than the change waiting on the gate. The decision itself stays PROPOSED until the owner runs `keel accept d0049 --by wweatherholtz --note ... --date ...`; if they reject it, the step is reverted in the same commit as the rejection.";
    }

    verification d0049Accept : Test {
        :>> id = "e6343e11-ce19-4f6d-96f4-1f9c93207e77";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "The owner accepts adding the e2e typecheck step to CI. This is a HUMAN attestation: it is recorded only by the owner's explicit acceptance (keel accept), never inferred from a general instruction to continue working.";
    }
}

// D0113 (PROPOSED — NOT YET ACCEPTED) — Pre-commit guard: a staged client test imports only modules present in the tree
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0113Accept event on sign-off.
package Decision0113 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    // #ProspectiveChange (D0070) - this Decision governs a process/schema change; the co-committed
    // change rides the process-change guard's hard lock.
    #ProspectiveChange part d0113 : Decision {
        :>> id = "bdc6b28b-b6f7-4a98-9ab8-7f85c7547411";
        :>> title = "Pre-commit guard: a staged client test imports only modules present in the tree";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Sprint 3 committed the RED codec test at standup, before its module existed (a465b38). CI on main went red for that commit with Cannot find module. The RED-first discipline needs the RED evidence in the standup record, and the test file must land with its implementation. The class recurs at every standup, and manual vigilance is not a control (D0047, issue013).";
        :>> decision = "The pre-commit hook .githooks/pre-commit runs client/scripts/check-staged-test-imports.mjs before the keel gate when node is present. The script lists the staged client test files and resolves every relative import against the tree. It fails the commit and names the file and the import when one resolves to no file. A vitest test pins the resolver. The RED standup evidence stays a recorded run, and the test file is staged only with its implementation.";
        :>> rationale = "The hook is the one point every commit passes, so the control is structural, not a convention. A test that imports a missing module can never pass, so refusing it loses nothing. The script is a few lines of node, which the client build already needs, and it is non-fatal when node is absent so a contributor without node can still commit. The alternative, a vitest test over all test files, runs after the commit and would fail in CI exactly as the defect did.";
        :>> consequences = "The hook file is a locked enforcement surface (D0465), so this Decision needs the owner's acceptance before the hook line lands. Until then the script and its test exist, the task stagedTestImportGuard carries a fail result that names this Decision, and the standup convention keeps the RED file unstaged. After acceptance the hook line is a one-line edit in the sprint that lands it.";
    }
}

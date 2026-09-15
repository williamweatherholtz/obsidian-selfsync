// D0095 (PROPOSED — NOT YET ACCEPTED) — The pre-commit gate resolves keel the same way the in-loop hooks do
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0095Accept event on sign-off.
package Decision0095 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    // #ProspectiveChange (D0070) - this Decision governs a process/schema change; the co-committed
    // change rides the process-change guard's hard lock.
    #ProspectiveChange part d0095 : Decision {
        :>> id = "6015480b-b9f7-4b02-93e2-83b64499f480";
        :>> title = "The pre-commit gate resolves keel the same way the in-loop hooks do";
        :>> createdAt = "2026-09-15";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::proposed;
        :>> context = "The commit gate in .githooks/pre-commit resolved the binary as command -v keel and nothing else. keel is installed per-machine at .keel/bin/keel.exe here (gitignored, never on PATH), so every commit printed pre-commit: keel not on PATH - keel gate skipped and committed ungated - observed on 397fa2a5 and 2fe1e445 in this session. Meanwhile the in-loop Claude hooks in .claude/settings.json DID resolve it, through a four-step order: KEEL_BIN, then CLAUDE_PROJECT_DIR/.keel/bin/keel[.exe], then the .keel/bin/<engine-version> pin, then PATH. Two callers of the same binary, two different resolution rules, and the weaker one guarded the commit.";
        :>> decision = "Give the pre-commit hook the SAME resolution order the Claude hooks use: an explicit KEEL or KEEL_BIN override, then ROOT/.keel/bin/keel[.exe], then the directory named by the engine pin in .engine/contracts/engine-version.toml, then PATH. Resolve ROOT with git rev-parse --show-toplevel and pass it to gate validate and gate guard so the hook does not depend on the cwd. Keep an absent binary NON-FATAL, and make the skip message name every location searched. Leave post-commit alone.";
        :>> rationale = "One binary should have one resolution rule; two rules meant the control a human sees in the terminal was the one that did not run. A machine-local install under .keel/bin is the engine's own sanctioned layout, so a gate that cannot see it is not strict, it is blind. The skip stays non-fatal because a contributor who has not installed keel must still be able to commit, and both the turn gate and CI run the same gate validate plus gate guard - a hard failure here would block honest work to re-check what is already checked twice. Naming the searched paths in the skip line is what stops a silent skip from reading as a pass, which is how the two ungated commits happened.";
        :>> consequences = "Commits from a machine with .keel/bin/keel.exe present now run gate validate plus gate guard before the commit lands, so a red tree aborts the commit instead of reaching origin. A machine without keel installed still commits, with a skip line that names where it looked. The hook no longer depends on the cwd. Nothing else in the enforcement surface changes; post-commit push behaviour is untouched.";
    }
}

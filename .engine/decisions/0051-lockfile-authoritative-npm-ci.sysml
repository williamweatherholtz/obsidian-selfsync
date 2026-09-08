// =====================================================================
// D0051 (PROJECT numbering) — the client toolchain is reproducible: client/package-lock.json is committed
// and authoritative, and CI + release install with `npm ci`. PROPOSED, not yet accepted: this edits the CI
// and release workflows (enforcement surface, D0209 clause 2), so the process-change keystone demands a
// #ProspectiveChange Decision with a HUMAN signature. The change is applied in the same commit in the
// D0049 shape (the gate ran on the change); the owner accepts or rejects via `keel accept d0051`.
// =====================================================================
package ProjectDecision0051 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0051 : Decision {
        :>> id = "9cf9f4ae-a5bc-46eb-a7a3-f4ee2faed141";
        :>> title = "D0051: commit client/package-lock.json as the authoritative dependency tree and install with `npm ci` in CI and release";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::proposed;
        :>> context = "issueNoLockfileFloatingToolchain (lockfilePolicy): the root .gitignore excluded package-lock.json, none was ever committed, and ci.yml (two jobs) + release.yml ran `npm install`, so every fresh checkout, every CI run and every release resolved the client's dependency tree afresh against the registry. Observed consequence this sitting: @playwright/test ^1.61.1 resolved to 1.63.0 on a fresh install, and the real-Obsidian e2e layer's behaviour depended on which version happened to land. A release built on a Tuesday and one built on a Thursday could therefore ship from different dependency trees with no commit in between. Two honest options were recorded on the task: (A) commit the lockfile and switch to `npm ci`; (B) record why floating resolution is wanted and pin exact versions in package.json. The owner directed 'process whole backlog'; this decision takes (A), the conventional answer, as a PROPOSAL the owner can reject in one command.";
        :>> decision = "(1) Remove `package-lock.json` from the root .gitignore and commit client/package-lock.json, generated at HEAD by `npm install --package-lock-only` (lockfileVersion 3; @playwright/test pinned at 1.63.0, the version the e2e layer was re-implemented against). (2) ci.yml npm-audit and client-tests jobs and release.yml install with `npm ci` instead of `npm install`: npm ci installs EXACTLY the lockfile and fails if package.json and the lock disagree, so a dependency change is a reviewed diff, never a side effect of a build. (3) Dependency updates are deliberate: edit package.json, run `npm install` locally, commit both files together. No other workflow change.";
        :>> rationale = "Reproducibility is the property a release process is for: `node scripts/check-release.mjs` proves an asset was published, but without a lockfile it cannot say WHAT dependency tree produced it, and two identical source commits could build differently. `npm ci` is the standard mechanism and is cheaper than `npm install` in CI (no resolution step). Option (B) - exact pins without a lockfile - was REJECTED because it pins only direct dependencies; transitive resolution still floats, which is where the 1.61.1 -> 1.63.0 drift actually lived. Leaving the choice open was REJECTED because the task had been open as 'owner decision' since the drift was observed and the cost of the wrong default (a floating tree) accrues on every build, while the cost of this default (a lockfile diff to review) is visible and reversible. WHY PROPOSED: the change touches .github/workflows/*.yml, part of the enforcement surface this project's honesty rests on (D0209), and the D0070 keystone exists so that such a change carries a human signature; the AI applied it in the same commit so the gate ran on it, exactly as D0049 did.";
        :>> consequences = "client/package-lock.json is tracked (a ~300 KB file that changes only when dependencies change). CI and release builds are byte-reproducible against the lock; a package.json/lock mismatch fails the build with npm's own message instead of silently resolving. `npm ci --dry-run` at HEAD resolved the lock clean before this was committed. lockfilePolicy's DoD closes on the owner's acceptance. REMOVAL PATH: reject with `keel accept` refused or a superseding Decision; `git revert` restores the ignore line and the `npm install` steps. Accept with `keel accept d0051 --by wweatherholtz --note ... --date ...` from the owner's own terminal.";
    }

    verification d0051Accept : Test {
        :>> id = "b7b87953-34ab-4d7d-8da8-778e2bde4851";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "The owner accepts committing the client lockfile and installing with npm ci in CI and release. HUMAN attestation: recorded only by the owner's explicit `keel accept d0051`, never inferred from an instruction to process the backlog.";
    }
}

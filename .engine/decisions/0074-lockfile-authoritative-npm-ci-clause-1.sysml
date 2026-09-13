// =====================================================================
// d0074 (PROJECT numbering) — clause 1 of 3 of D0051 ("D0051: commit client/package-lock.json as the authoritative dependency tree and install with `npm ci` in CI and release"), recorded as its own Decision per
// D0303 option C (one Decision per clause, #DependsOn between them, the chain superseding the compound one) so the
// decision-scaffolding guard can see which clause an edge charters. The text is the parent's clause VERBATIM; the
// rationale and consequences are the parent's, which the clauses share. Status follows the parent's acceptance path:
// PROPOSED — the owner accepts each clause; the compound d0051 is retired by the #Supersede edge from clause 1.
// =====================================================================
package ProjectDecision0074 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;
    private import ProjectDecision0051::*;

    #ProspectiveChange part d0074 : Decision {
        :>> id = "20e91301-76bb-4174-a644-dacc1478b638";
        :>> title = "D0074 (D0051 clause 1/3): Remove `package-lock.json` from the root .gitignore and commit client/package-lock.json, generated at HEAD by";
        :>> createdAt = "2026-09-13";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::accepted;
        :>> context = "Clause 1 of 3 of D0051 (created 2026-09-07, proposed), split out on 2026-09-13 under keel 0.4.1's decision-scaffolding guard (D0303 option C, issue331): a compound Decision hides which clause a chartering edge delivers. The parent's context: issueNoLockfileFloatingToolchain (lockfilePolicy): the root .gitignore excluded package-lock.json, none was ever committed, and ci.yml (two jobs) + release.yml ran `npm install`, so every fresh checkout, every CI run and every release resolved the client's dependency tree afresh against the registry. Observed consequence this sitting: @playwright/test ^1.61.1 resolved to 1.63.0 on a fresh install, and the real-Obsidian e2e layer's behaviour depended on which version happened to land. A release built on a Tuesday and one built on a Thursday could therefore ship from different dependency trees with no commit in between. Two honest options were recorded on the task: (A) commit the lockfile and switch to `npm ci`; (B) record why floating resolution is wanted and pin exact versions in package.json. The owner directed 'process whole backlog'; this decision takes (A), the conventional answer, as a PROPOSAL the owner can reject in one command.";
        :>> decision = "Remove `package-lock.json` from the root .gitignore and commit client/package-lock.json, generated at HEAD by `npm install --package-lock-only` (lockfileVersion 3; @playwright/test pinned at 1.63.0, the version the e2e layer was re-implemented against).";
        :>> rationale = "Shared with D0051, whose clauses were decided together: Reproducibility is the property a release process is for: `node scripts/check-release.mjs` proves an asset was published, but without a lockfile it cannot say WHAT dependency tree produced it, and two identical source commits could build differently. `npm ci` is the standard mechanism and is cheaper than `npm install` in CI (no resolution step). Option (B) - exact pins without a lockfile - was REJECTED because it pins only direct dependencies; transitive resolution still floats, which is where the 1.61.1 -> 1.63.0 drift actually lived. Leaving the choice open was REJECTED because the task had been open as 'owner decision' since the drift was observed and the cost of the wrong default (a floating tree) accrues on every build, while the cost of this default (a lockfile diff to review) is visible and reversible. WHY PROPOSED: the change touches .github/workflows/*.yml, part of the enforcement surface this project's honesty rests on (D0209), and the D0070 keystone exists so that such a change carries a human signature; the AI applied it in the same commit so the gate ran on it, exactly as D0049 did. THE SPLIT ITSELF: recorded one Decision per clause so that partial delivery is visible to the scaffolding guard and each clause can be chartered, accepted or superseded on its own; the wording is the parent's, unchanged.";
        :>> consequences = "Those of D0051 that this clause carries: client/package-lock.json is tracked (a ~300 KB file that changes only when dependencies change). CI and release builds are byte-reproducible against the lock; a package.json/lock mismatch fails the build with npm's own message instead of silently resolving. `npm ci --dry-run` at HEAD resolved the lock clean before this was committed. lockfilePolicy's DoD closes on the owner's acceptance. REMOVAL PATH: reject with `keel accept` refused or a superseding Decision; `git revert` restores the ignore line and the `npm install` steps. Accept with `keel accept d0051 --by wweatherholtz --note ... --date ...` from the owner's own terminal.";
    }
    #Supersede dependency from d0074 to d0051;

    // acceptance event (D0121 review-queue sign-off; D0066/D0106 — human-judged, not fabricated)
    verification d0074Accept : Test { :>> id = "490f7c52-5e7d-4966-8681-09b61b113d38"; :>> method = VerificationMethod::confirmation; :>> procedureText = "owner's words: '[x] Accept all 34 clause records' (decision page digest pasted by the owner on 2026-09-13) WARN: read-back - the quoted words do not name d0074 (D0201 B); recorded as given (D0423)."; }
    part d0074AcceptR1 : TestResult { :>> id = "ce1ebdcd-2ab8-42d4-92f8-f5f52611205f"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "d7fc5711"; :>> judgedAt = "2026-09-13"; :>> judgedBy = "wweatherholtz"; :>> createdBy = "wweatherholtz"; }
}

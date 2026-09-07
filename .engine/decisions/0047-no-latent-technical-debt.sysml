// =====================================================================
// D0047 (PROJECT numbering — distinct from ENGINE D0047 'corrections become guards' in
// .engine/reference/decisions/, which this rule generalizes rather than replaces) — adopt a
// standing working rule: no latent technical debt. Anything found wrong is either fixed
// immediately (if trivial) or filed as a tracked Issue with a resolver; never noted and left.
// Owner directive + owner-accepted (2026-09-07). Process/convention change ⇒ recorded per §4.
// =====================================================================
package ProjectDecision0047 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0047 : Decision {
        :>> id = "e170e14b-8466-4e60-be31-31be9015ac39";
        :>> title = "D0047: no latent technical debt — fix it now if trivial, else file a tracked Issue with a resolver; never report a defect and move on";
        :>> createdAt = "2026-09-07";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "During the provenance-decoupling work the AI surfaced several defects incidental to the task and reported them in prose WITHOUT tracking them: client/package.json was at 1.22.0 while manifest.json was at 1.30.0; the repo's git hooks were not installed (a machine-global core.hooksPath pointed at a non-existent directory, so NEITHER the post-commit push NOR the pre-commit keel validate/guard gate ran, while CLAUDE.md asserted the push hook was running); and run.ps1 still named the retired 'new-livesync' working name. Each was mentioned in a summary and left. The owner named the pattern directly: 'don't allow technical debt to exist - if something is wrong, make a backlog item for it or fix it immediately if it's trivial (like updating 1.22.0)'. The engine already has a related rule (ENGINE D0047, corrections-become-permanent-guards), but that one is scoped to a defect revealing a RECURRABLE PROCESS GAP and explicitly exempts trivial one-off edits — so a stale name or a drifted version string fell through it, and a prose mention was treated as sufficient disposition. It is not: a defect named only in conversation history cannot be reviewed, prioritized, or computed over, which is the same dual-truth failure D0018 removed RESUME.md for.";
        :>> decision = "Adopt a standing rule, recorded in CLAUDE.md §4: anything found wrong is resolved in exactly ONE of two ways, and silence is not one of them. TRIVIAL (a stale name, a wrong version string, a typo'd doc claim — no design judgment, no behavior change) is FIXED IMMEDIATELY, in the current commit. NON-TRIVIAL (needs design, has blast radius, or is the owner's call) is filed as a tracked Issue in .tracking/issues.sysml carrying its #Resolves resolver per §3c, so the model carries it rather than memory. Applies to whatever the current task happens to surface — an unrelated find is still a find — and a LOW is never deferred merely for being small. Where the defect class could RECUR, ENGINE D0047 also applies on top, so the fix additionally carries an automated guard.";
        :>> rationale = "The two existing rules left a real gap between them. ENGINE D0047 governs recurrable process gaps and exempts trivial one-offs; §3c governs how an Issue is triaged ONCE it exists. Neither obliges the finder to do anything at all with a small, non-recurring defect — so the honest-looking move was to mention it and continue, which is exactly what happened three times in one sitting. That is worse than it sounds: prose in a transcript is invisible to `keel orient`, so the backlog UNDERSTATES the real work, and the owner cannot see or reprioritize what was found. Making the disposition BINARY (fix or file) removes the third option that was being taken by default, and choosing between them costs nothing because the test is mechanical: does resolving it require judgment or carry risk? Fixing trivia in-commit is preferred over filing it because a tracked Issue for a one-word doc fix costs more to administer than the fix, and a backlog full of trivia hides the items that matter. Filing the rest is preferred over fixing it because unbounded in-flight scope is its own hazard — the rule must not become a licence to rewrite whatever the task brushes against. This decision deliberately does NOT add a guard for itself: 'did the AI file an Issue for something it noticed' is not mechanically checkable from the repo, so this one is enforced by the rule plus the owner's review, and honesty about that is better than a guard theatre that cannot see the failure mode.";
        :>> consequences = "CLAUDE.md §4 gains the rule; the adjacent corrections-become-guards bullet is relabelled 'engine D0047' and this one 'project D0047' to fix the pre-existing collision between the two numbering spaces (the same no-debt rule applied to itself). Three defects surfaced this sitting are now dispositioned rather than merely mentioned: issueVersionRecordDrift and issueHooksNotInstalled were FIXED in-pass and carry automated guards (a scripts/check-version-sync.mjs CI job, and the hooks actually installed with the CLAUDE.md claim corrected); issueForkedE2eHelpersUnattributed is FILED OPEN because it needs an owner decision. The stale run.ps1 name and the CLAUDE.md numbering collision were fixed in-commit as trivia, per the rule. Expected cost: slightly larger commits (in-scope trivia folded in) and a longer visible Issue list — the list getting longer is the rule WORKING, since those items previously existed unrecorded. The rule constrains the AI's reporting behavior, so a lapse looks like a defect named in a summary with no Issue and no fix.";
    }

    verification d0047Accept : Test {
        :>> id = "67b15090-57c1-4359-b217-d14bd12f487a";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "The AI's provenance-decoupling summary listed three defects it had found and not tracked (the 1.22.0/1.30.0 version drift, the uninstalled git hooks with the false CLAUDE.md claim, and a stale run.ps1 name). The owner replied (2026-09-07): 'install the hooks as you've identified are missing. and fix the drift. don't allow technical debt to exist - if something is wrong, make a backlog item for it or fix it immediately if it's trivial (like updating 1.22.0)'. That is an explicit, directive statement of the standing rule recorded here, including the trivial-vs-track split and the worked example the owner chose (updating 1.22.0 as the trivial case).";
    }
    part d0047AcceptR1 : TestResult {
        :>> id = "8bac49fc-4641-45bf-a4bd-7ccf7f19e4f7";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "5e01b211";
        :>> judgedAt = "2026-09-07";
        :>> judgedBy = "wweatherholtz";
    }
}

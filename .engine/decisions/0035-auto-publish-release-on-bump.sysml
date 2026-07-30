// =====================================================================
// D0035 — make releasing AUTOMATIC so a version bump can never sit unreleased. The release-versioning
// process (D0002) had the release depend on a manual "tag + push" step (rv4): a bump could land on main,
// green, and NOT be released because the tag was never pushed. This exact miss happened with 1.9.0 — the
// redesign shipped to main but BRAT still showed 1.8.1 because no 1.9.0 tag/release existed until the owner
// noticed. D0012/D0033's nets (check-release.mjs / verify-released.yml) catch this but only DAILY, leaving a
// ~24h window where "on main" != "released". Per D0047 a recurrable gap earns a permanent automated control.
// Edits .github/workflows/release.yml + .engine/processes/release-versioning.sysml (rv4), so the D0070
// process-change guard requires this co-committed #ProspectiveChange Decision (this is that record).
// Directed + accepted 2026-07-30 by wweatherholtz ("create a procedure/process in keel to do this
// consistently. we can't be not releasing code" + "yes proceed"). Resolves issueReleaseNotAutoPublished
// (resolver action: autoPublishReleaseWorkflow).
// =====================================================================
package ProjectDecision0035 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0035 : Decision {
        :>> id = "e1f2a3b4-c035-4d10-9e20-f1a2b3c40035";
        :>> title = "D0035: auto-publish the GitHub release when a bumped manifest.json lands on main (no manual tag step)";
        :>> createdAt = "2026-07-30";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "Shipping the 1.9.0 timestamp redesign, the AI committed + pushed the bump to main but did not push the matching version tag, so .github/workflows/release.yml (which triggered ONLY on a `X.Y.Z` tag push) never ran and no GitHub release was published — BRAT continued to show 1.8.1 as latest. The owner caught it ('my device says 1.8.1 is latest. is that incorrect?') and directed a durable fix: 'create a procedure/process in keel to do this consistently. we can't be not releasing code.' Root cause: the release depended on a MANUAL step (release-versioning rv4: tag + push) that is easy to omit, and the existing assertions (D0012 check-release.mjs, D0033 currency guard, both wired into the DAILY verify-released.yml) detect the miss but only on the next daily run — a ~24h window in which a bumped-and-green main is silently unreleased. Manual vigilance already proved insufficient here, exactly the D0047 trigger.";
        :>> decision = "Change .github/workflows/release.yml to trigger on a push to `main` that changes manifest.json (plus workflow_dispatch), instead of on a version-tag push. The job reads the version from manifest.json (the single source of truth), checks whether that version is ALREADY released (`gh release view`), and — only if not — builds the plugin and runs `gh release create <version> --target <sha>` with the BRAT assets, which creates the matching tag AND the release in one step. This makes it IDEMPOTENT (a re-run, a manual re-push, or an unrelated manifest edit is a safe no-op) and AUTOMATIC (a bump landing on main publishes with no human/agent tag step). Update release-versioning rv4 to 'commit + push to main; the release auto-publishes' (the manual `git push origin <tag>` becomes an unneeded fallback) and keep rv5 (check-release.mjs) as the post-publish assertion. Deployed/described by the release-versioning + repo-push skills (doc-sync, this commit). Resolver action autoPublishReleaseWorkflow; its DoD is a bump-to-main publishing a release with no manual tag.";
        :>> rationale = "AUTOMATION over vigilance (D0047): the failure was a forgotten manual step, so the fix removes the step rather than adding another reminder. ALTERNATIVES: (i) keep tag-triggered release + add an auto-TAGGER job that pushes the tag — REJECTED: a tag pushed by the default GITHUB_TOKEN does NOT trigger other workflows (GitHub's loop-prevention), so release.yml would not fire; making it fire needs a PAT/deploy-key secret (setup friction + a standing credential). (ii) fail main CI immediately when manifest is bumped without a release — REJECTED: it catches but does not FIX (still needs a human to then tag), and it would paint main red in the window between the bump commit and the tag even in the normal flow. (iii) move the daily verify-released net to on-push — same catch-not-fix limitation as (ii). (iv) CHOSEN — a single self-contained, idempotent workflow that builds + publishes directly on the bump-to-main, so there is no second event to chain (sidesteps the token limitation entirely), no secret, and nothing to forget. check-release.mjs (D0012) + the currency guard (D0033) are retained UNCHANGED as complementary backstops (completeness + currency). CRITERIA: automated-not-vigilance x no standing secret x idempotent/safe-to-rerun x removes rather than adds a step x composes with the existing nets.";
        :>> consequences = "release.yml now fires on a manifest.json change to main (+ workflow_dispatch) and is idempotent; the version-tag-push trigger is removed (the tag is created BY the release step via `gh release create`). A manual `git tag X.Y.Z && git push` no longer publishes on its own, but is unnecessary — bumping the version on main is the release trigger; workflow_dispatch is the manual re-run. server-image.yml is UNAFFECTED — it publishes on server changes to main (and version tags) independently, so a server-touching release still gets its image via the main-push path. release-versioning rv4 is reworded (a process-definition change; future edits still each need their own Decision, D0070). The release-versioning + repo-push skills are doc-synced this commit. CLAUDE.md does not enumerate release steps, so no CLAUDE.md change. Resolves issueReleaseNotAutoPublished via the autoPublishReleaseWorkflow action; the workflow IS the permanent automated control D0047 requires.";
    }

    verification d0035Accept : Test {
        :>> id = "e1f2a3b4-c035-4d10-9e20-f1a2b3c40036";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed this change in their own words on 2026-07-30 — 'create a procedure/process in keel to do this consistently. we can't be not releasing code.' (after catching that 1.9.0 was on main but not released), and 'yes proceed' — an explicit instruction to establish a permanent, consistent release-enforcement control. The specific mechanism (auto-publish on a manifest bump landing on main, per the decision field) is the AI's implementing design chosen to fulfil that directive; it is surfaced to the owner in the same turn for veto.";
    }
    part d0035AcceptR1 : TestResult {
        :>> id = "e1f2a3b4-c035-4d10-9e20-f1a2b3c40037";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "03fa9d2";
        :>> judgedAt = "2026-07-30";
        :>> judgedBy = "wweatherholtz";
    }
}

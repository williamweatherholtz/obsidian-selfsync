// =====================================================================
// D0055 (PROJECT numbering) — AMENDS D0054 (proposed, not yet accepted) after the 2026-09-11 architecture panel's
// release-channel critique: a release is a DRAFT until its assets verify, a tag that points elsewhere is refused, the
// daily check REBUILDS the tag as the independent integrity anchor, every plugin release dispatches the version-tagged
// server image, and the workflows' supply chain is pinned. PROPOSED: release.yml / verify-released.yml /
// server-image.yml / ci.yml are the enforcement surface (D0209 clause 2), so the D0070 keystone requires a
// #ProspectiveChange Decision with a human signature. Authored as a SUPERSEDING item rather than an in-place edit of
// D0054 (D0108: a non-owner adds or supersedes, never overwrites). The owner accepts or rejects via `keel accept d0055`
// (and d0054, which this amends but does not replace: D0054's SHA256SUMS + About row + check-release digest phase stand).
// =====================================================================
package ProjectDecision0055 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;
    private import ProjectDecision0054::*;

    #ProspectiveChange part d0055 : Decision {
        :>> id = "939f3c78-704f-43b3-842d-69fbf0f42a77";
        :>> title = "D0055: a release is published only after its assets verify (draft → verify → publish), under a tag that is its own, with a rebuild-from-tag anchor in the daily check, a version-tagged server image per release, and SHA-pinned workflow actions";
        :>> createdAt = "2026-09-11";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::accepted;
        :>> context = "D0054 (2026-09-11, proposed) made 'released' mean 'these bytes': release.yml records SHA256SUMS and re-verifies the published assets; check-release.mjs verifies digests daily; the plugin shows the digest of its installed main.js. The same day's architecture panel (release-channel critic, PEDANT-1 + PESSIMIST-2) attacked that design and found four MAJOR gaps in the mechanism as shipped in 1.30.17: (RL1) the release was created non-draft and BRAT-installable BEFORE the verify step, so a mismatch left a live bad release and a partial upload counted as 'released' on re-run; (RL2) `gh release create --target` silently reuses an existing tag, so a delete-assets-and-re-run recovery would publish a build of main-HEAD under a tag pointing at another commit, with SHA256SUMS agreeing with itself; (RL3) SHA256SUMS lives in the same mutable release as the assets, so anyone with contents:write can rewrite both — the digest detects corruption, not the H-5 threat UCA-57 names, yet the code and the STPA claimed the stronger property; (RL4) the sanctioned release path never produced a version-tagged server image (a GITHUB_TOKEN-created tag does not trigger server-image.yml), so docs/deployment.md told operators to pin a tag that did not exist; plus (RL5) mutable action refs, persisted checkout credentials, no Dependabot, and (RL6) check-release.mjs hiding gh's real error and downloading every asset. The critic independently confirmed the build is reproducible (a fresh build of tag 1.30.17 was byte-identical to the published main.js), which makes a rebuild-from-tag anchor cheap and honest.";
        :>> decision = "SPLIT 2026-09-13 under D0303 option C (keel 0.4.1 decision-scaffolding): this compound Decision is superseded by one Decision per clause - d0086 through d0091 (6 clauses, #DependsOn-chained, d0086 #Supersede-s this one) - and each clause's text lives there VERBATIM and unchanged. This field is now the pointer; the original compound wording is in git history at b7cb5ddc (the text any earlier acceptance was bound to). The rationale and consequences below are unchanged.";
        :>> rationale = "A verification that runs after the artifact is already installable is a report, not a gate; making the release a draft until it verifies turns it into a gate at no cost (the verify step already existed). Reusing a tag that points elsewhere is the one path by which 'assets and tag describe the same build' could silently become false, and it was the documented recovery path — refusing it is cheaper than any check that could detect it afterwards. A digest stored beside the bytes it attests proves consistency, not origin; rebuilding the tag proves origin because the build is reproducible, and it reuses the exact steps release.yml runs. The missing version-tagged image was a documented promise the pipeline could not keep; a dispatch on the tag ref is the smallest change that keeps it. Pinning by SHA with Dependabot is standard supply-chain hygiene for workflows that hold contents:write. WHY A SEPARATE DECISION: D0054 is proposed and owned by the agent; D0108 forbids a non-owner overwriting it in place, and the amendment is substantive enough that the owner should accept it explicitly rather than find D0054's text changed under the same number. WHY PROPOSED: every touched file is enforcement surface (D0209 clause 2).";
        :>> consequences = "release.yml gains a draft phase, an asset-presence check, a tag guard, a publish step and an image dispatch (actions:write); verify-released.yml gains the rebuild-and-compare step (fails red if the build is ever not reproducible — a true signal); server-image.yml + ci.yml + release.yml + verify-released.yml pin actions by SHA; .github/dependabot.yml is new; check-release.mjs reports honestly. First exercised by the 1.30.18 release (releaseIntegrityHardeningDoD). ORDER NOTE for the owner: as with D0054, the enforcement-surface change ships in the same commit the Decision is proposed in (the standing D0049-shape convention so the gate runs on it); the panel flagged that order against CLAUDE.md §3a — surfaced, not hidden. REMOVAL PATH: `git revert` of the sprint commit restores D0054's publish-then-verify shape. Accept with `keel accept d0055` (and `keel accept d0054`) from the owner's own terminal.";
    }
    #Supersede dependency from d0055 to d0054;

    // acceptance event (D0121 review-queue sign-off; D0066/D0106 — human-judged, not fabricated)
    verification d0055Accept : Test { :>> id = "c6d36bf2-7879-436f-bcb6-af7fcdb96ca3"; :>> method = VerificationMethod::confirmation; :>> procedureText = "owner's words: 'keel accept d0054, d0055, d0056'"; }
    part d0055AcceptR1 : TestResult { :>> id = "dddab09e-99ee-48fc-8cba-fc9dd5221a70"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "b2f04889"; :>> judgedAt = "2026-09-12"; :>> judgedBy = "wweatherholtz"; }
}

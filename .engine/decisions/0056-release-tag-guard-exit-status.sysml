// =====================================================================
// D0056 (PROJECT numbering) — a correction to D0055's tag guard in release.yml, found by its FIRST run: the guard read
// the API's stdout instead of its exit status, so a MISSING tag (the normal case for a new version) produced a 404
// body that the guard took for "a SHA that is not this commit" and refused to publish 1.30.18. PROPOSED: release.yml
// is enforcement surface (D0209 clause 2), so even a one-line correction needs a co-committed #ProspectiveChange
// Decision; and D0055 is claudeOpus-owned while this change is authored under the owner's bound actor, so it is a new
// item (D0108), not an in-place edit. The owner accepts via `keel accept d0056`.
// =====================================================================
package ProjectDecision0056 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;
    private import ProjectDecision0055::*;

    #ProspectiveChange part d0056 : Decision {
        :>> id = "48579acc-4924-4fad-8196-044b0aeee20e";
        :>> title = "D0056: release.yml's tag guard decides on the API call's exit status, never on its stdout";
        :>> createdAt = "2026-09-11";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::proposed;
        :>> context = "D0055 (2026-09-11, proposed) added a guard to release.yml: refuse to publish when a tag for the version already points at a different commit. The first run of the amended workflow — the 1.30.18 release, run 34646222700 — failed in that guard with `tag 1.30.18 already points at {\"message\":\"Not Found\",...}, not at this commit`: `gh api` prints the 404 error body to STDOUT when the ref does not exist, and the capture `TAG_SHA=$(gh api … -q .object.sha 2>/dev/null || true)` took that body for a SHA. The guard therefore refused every NEW version — the common case — while the case it was written for (an existing tag) would have worked. Nothing was published or tagged (the failure was before the draft step), so 1.30.18 is simply not yet released.";
        :>> decision = "The guard tests the API call's EXIT STATUS: `if gh api …/git/ref/tags/$VER > tagref.json; then TAG_SHA=$(node -p \"require('./tagref.json').object.sha\"); fi` — a missing tag leaves TAG_SHA empty (no refusal), an existing tag yields its commit SHA and is compared to GITHUB_SHA as before. The release for 1.30.18 is then produced by re-running release.yml via workflow_dispatch on main (manifest.json already says 1.30.18; the fix commit does not touch it, so the push trigger does not fire).";
        :>> rationale = "A guard that refuses the normal case is a broken gate, and a gate on the release path blocks every release until fixed — so the fix cannot wait for a batch. Testing the exit status is the only correct way to distinguish 'no such ref' from 'ref exists' with `gh api`, whose stdout carries the error body on failure; parsing the JSON with node (already installed for the build) avoids depending on jq being present. WHY A DECISION: release.yml is enforcement surface (D0209 clause 2) and the process-change guard hard-locks it; D0055 cannot be edited in place by a non-owner actor (D0108), so the correction is its own small, honest record rather than a silent patch. WHY PROPOSED: same reason as D0054/D0055.";
        :>> consequences = "release.yml's version step no longer misreads a missing tag; the D0055 guard's intended refusal (an existing tag pointing elsewhere) is unchanged. 1.30.18 is released by a workflow_dispatch re-run after this commit; that run is the first exercise of the draft → verify → publish → image-dispatch path (releaseIntegrityHardeningDoD's evidence). REMOVAL PATH: `git revert`; the guard would then refuse every new version again, so removal is not a real option — reverting D0055 as a whole is.";
    }
    #Supersede dependency from d0056 to d0055;

    verification d0056Accept : Test {
        :>> id = "475f762d-6cc2-4007-bf10-3be830c868cc";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "The owner accepts the tag-guard correction (exit status, not stdout) in release.yml. HUMAN attestation via `keel accept d0056`; never inferred from the directive that prompted the work.";
    }
}

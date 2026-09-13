// =====================================================================
// D0054 (PROJECT numbering) — a published plugin release is verified against the digests recorded at publish
// time; presence of the assets is no longer the release's completeness criterion. PROPOSED, not yet accepted: this
// changes the release CI workflow (release.yml — an enforcement surface under D0209 clause 2) and the
// release-versioning process doc, so the D0070/D0209 process-change keystone requires a #ProspectiveChange
// Decision with a human signature. The AI applied the change in the same commit so the gate ran on it; the owner
// accepts or rejects via `keel accept d0054`.
// =====================================================================
package ProjectDecision0054 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0054 : Decision {
        :>> id = "183e084e-6861-4941-8330-b9bca6a8c135";
        :>> title = "D0054: a release records SHA256SUMS of its assets at publish, re-verifies the published assets against it, and the daily release check + the plugin's About row read the same digests";
        :>> createdAt = "2026-09-11";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::accepted;
        :>> context = "The 2026-09-10 STPA over the release-channel authority (c15ReleaseChannel, UCA-57 / SR-50, issueReleaseAssetIntegrityUnchecked) found that the release path asserted PRESENCE, never INTEGRITY: release.yml uploaded main.js / styles.css / manifest.json / versions.json, scripts/check-release.mjs and the daily verify-released.yml checked that the tag exists and the release carries assets by those NAMES, and check-release-currency bounded unreleased drift — but nothing recorded what bytes were published or compared them afterwards. BRAT installs whatever the release serves on every device; a replaced, truncated or corrupted asset would install unnoticed (H-5: code from an unauthorised source runs in the host). The owner's standing directive (2026-09-11: 'put into backlog and complete all identified work in sprints') made this the releaseAssetIntegrity sprint.";
        :>> decision = "SPLIT 2026-09-13 under D0303 option C (keel 0.4.1 decision-scaffolding): this compound Decision is superseded by one Decision per clause - d0082 through d0085 (4 clauses, #DependsOn-chained, d0082 #Supersede-s this one) - and each clause's text lives there VERBATIM and unchanged. This field is now the pointer; the original compound wording is in git history at b7cb5ddc (the text any earlier acceptance was bound to). The rationale and consequences below are unchanged.";
        :>> rationale = "A checksum recorded at publish and re-verified after publish closes the specific hazard cell found: the published bytes are tied to the build the workflow produced, and every later reader of the release (the daily check, a device) can prove it still is. It is the smallest change that makes 'released' mean 'these bytes' rather than 'these names', it needs no key management, and it reuses the tools already in the path (sha256sum in CI, gh release download, node:crypto in the script, the client's own sha256hex). ALTERNATIVES: (i) leave presence-only — REJECTED, it is the gap the analysis named and the owner directed to close; (ii) sign the assets (Sigstore keyless / minisign) — DEFERRED, not rejected: it adds a trust root and a verification step BRAT does not perform, so its value is for the daily check and audits, which the digest already serves; it stays a follow-on decision; (iii) verify only in check-release.mjs and not in release.yml — REJECTED, the publish step is where a mismatch is cheapest to catch and where the operator is present. WHY PROPOSED: release.yml is part of the enforcement surface (D0209 clause 2) and the release-versioning skill is a process document (D0070); both changed, so the gate requires a human-signed Decision.";
        :>> consequences = "release.yml gains a SHA256SUMS asset + notes block and a verify step; check-release.mjs gains a digest phase (presence-only for < 1.30.17); the plugin gains an About row (client-only; ships in 1.30.17). The process-change guard passes with this Decision co-committed. Owner-pending: `keel accept d0054`, and the first real run of the verify step is the 1.30.17 release itself — its success is the evidence for releaseAssetIntegrityDoD. REMOVAL PATH: `git revert` of the sprint commit restores presence-only checking; no data or persisted state depends on the digests.";
    }

    // acceptance event (D0121 review-queue sign-off; D0066/D0106 — human-judged, not fabricated)
    verification d0054Accept : Test { :>> id = "c2824d65-fde8-4b1c-9b46-0aae1a22827c"; :>> method = VerificationMethod::confirmation; :>> procedureText = "owner's words: 'keel accept d0054, d0055, d0056'"; }
    part d0054AcceptR1 : TestResult { :>> id = "557f2d95-a0ac-48f3-b392-e39b1fbdc9fd"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "b2f04889"; :>> judgedAt = "2026-09-12"; :>> judgedBy = "wweatherholtz"; }
}

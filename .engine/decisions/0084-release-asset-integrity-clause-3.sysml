// =====================================================================
// d0084 (PROJECT numbering) — clause 3 of 4 of D0054 ("D0054: a release records SHA256SUMS of its assets at publish, re-verifies the published assets against it, and the daily release check + the plugin's About row read the same digests"), recorded as its own Decision per
// D0303 option C (one Decision per clause, #DependsOn between them, the chain superseding the compound one) so the
// decision-scaffolding guard can see which clause an edge charters. The text is the parent's clause VERBATIM; the
// rationale and consequences are the parent's, which the clauses share. Status follows the parent's acceptance path:
// PROPOSED — the owner accepts each clause; the compound d0054 is retired by the #Supersede edge from clause 1.
// =====================================================================
package ProjectDecision0084 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;
    private import ProjectDecision0054::*;
    private import ProjectDecision0083::*;

    #ProspectiveChange part d0084 : Decision {
        :>> id = "3534a50f-d350-4284-bd95-faa26a23468b";
        :>> title = "D0084 (D0054 clause 3/4): The plugin shows, in Settings → Advanced → About, its version and the SHA-256 of the INSTALLED main.js (read t";
        :>> createdAt = "2026-09-13";
        :>> createdBy = "claudeOpus";
        :>> status = DecisionStatus::accepted;
        :>> context = "Clause 3 of 4 of D0054 (created 2026-09-11, accepted), split out on 2026-09-13 under keel 0.4.1's decision-scaffolding guard (D0303 option C, issue331): a compound Decision hides which clause a chartering edge delivers. The parent's context: The 2026-09-10 STPA over the release-channel authority (c15ReleaseChannel, UCA-57 / SR-50, issueReleaseAssetIntegrityUnchecked) found that the release path asserted PRESENCE, never INTEGRITY: release.yml uploaded main.js / styles.css / manifest.json / versions.json, scripts/check-release.mjs and the daily verify-released.yml checked that the tag exists and the release carries assets by those NAMES, and check-release-currency bounded unreleased drift — but nothing recorded what bytes were published or compared them afterwards. BRAT installs whatever the release serves on every device; a replaced, truncated or corrupted asset would install unnoticed (H-5: code from an unauthorised source runs in the host). The owner's standing directive (2026-09-11: 'put into backlog and complete all identified work in sprints') made this the releaseAssetIntegrity sprint.";
        :>> decision = "The plugin shows, in Settings → Advanced → About, its version and the SHA-256 of the INSTALLED main.js (read through the vault adapter, hashed with the existing sha256hex) with a Copy button, so a device can be audited against the release's SHA256SUMS.";
        :>> rationale = "Shared with D0054, whose clauses were decided together: A checksum recorded at publish and re-verified after publish closes the specific hazard cell found: the published bytes are tied to the build the workflow produced, and every later reader of the release (the daily check, a device) can prove it still is. It is the smallest change that makes 'released' mean 'these bytes' rather than 'these names', it needs no key management, and it reuses the tools already in the path (sha256sum in CI, gh release download, node:crypto in the script, the client's own sha256hex). ALTERNATIVES: (i) leave presence-only — REJECTED, it is the gap the analysis named and the owner directed to close; (ii) sign the assets (Sigstore keyless / minisign) — DEFERRED, not rejected: it adds a trust root and a verification step BRAT does not perform, so its value is for the daily check and audits, which the digest already serves; it stays a follow-on decision; (iii) verify only in check-release.mjs and not in release.yml — REJECTED, the publish step is where a mismatch is cheapest to catch and where the operator is present. WHY PROPOSED: release.yml is part of the enforcement surface (D0209 clause 2) and the release-versioning skill is a process document (D0070); both changed, so the gate requires a human-signed Decision. THE SPLIT ITSELF: recorded one Decision per clause so that partial delivery is visible to the scaffolding guard and each clause can be chartered, accepted or superseded on its own; the wording is the parent's, unchanged.";
        :>> consequences = "Those of D0054 that this clause carries: release.yml gains a SHA256SUMS asset + notes block and a verify step; check-release.mjs gains a digest phase (presence-only for < 1.30.17); the plugin gains an About row (client-only; ships in 1.30.17). The process-change guard passes with this Decision co-committed. Owner-pending: `keel accept d0054`, and the first real run of the verify step is the 1.30.17 release itself — its success is the evidence for releaseAssetIntegrityDoD. REMOVAL PATH: `git revert` of the sprint commit restores presence-only checking; no data or persisted state depends on the digests.";
    }
    #DependsOn dependency from d0084 to d0083;

    // acceptance event (D0121 review-queue sign-off; D0066/D0106 — human-judged, not fabricated)
    verification d0084Accept : Test { :>> id = "2679cb90-31db-40e5-b490-ab024e5b191e"; :>> method = VerificationMethod::confirmation; :>> procedureText = "owner's words: '[x] Accept all 34 clause records' (decision page digest pasted by the owner on 2026-09-13) WARN: read-back - the quoted words do not name d0084 (D0201 B); recorded as given (D0423)."; }
    part d0084AcceptR1 : TestResult { :>> id = "c5bd4de7-0e63-4609-a6bc-ab77333e5ef9"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "d7fc5711"; :>> judgedAt = "2026-09-13"; :>> judgedBy = "wweatherholtz"; :>> createdBy = "wweatherholtz"; }
}

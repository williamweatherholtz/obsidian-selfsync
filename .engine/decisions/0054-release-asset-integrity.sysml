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
        :>> status = DecisionStatus::proposed;
        :>> context = "The 2026-09-10 STPA over the release-channel authority (c15ReleaseChannel, UCA-57 / SR-50, issueReleaseAssetIntegrityUnchecked) found that the release path asserted PRESENCE, never INTEGRITY: release.yml uploaded main.js / styles.css / manifest.json / versions.json, scripts/check-release.mjs and the daily verify-released.yml checked that the tag exists and the release carries assets by those NAMES, and check-release-currency bounded unreleased drift — but nothing recorded what bytes were published or compared them afterwards. BRAT installs whatever the release serves on every device; a replaced, truncated or corrupted asset would install unnoticed (H-5: code from an unauthorised source runs in the host). The owner's standing directive (2026-09-11: 'put into backlog and complete all identified work in sprints') made this the releaseAssetIntegrity sprint.";
        :>> decision = "(1) release.yml computes SHA-256 of every asset after the build (basenames, sha256sum format), uploads it as a SHA256SUMS asset AND writes it into the release notes, then — as a separate step — downloads the published assets back and runs `sha256sum -c SHA256SUMS`; a mismatch fails the job (the release stays visible and red for the operator to delete + re-run via workflow_dispatch) rather than an altered asset installing silently. (2) scripts/check-release.mjs, for every release >= 1.30.17 (FIRST_CHECKSUMMED_VERSION), downloads the assets to a temp dir and verifies each of main.js / styles.css / manifest.json / versions.json against SHA256SUMS; a missing SHA256SUMS, a missing entry, or a digest mismatch is a failure with the recorded-vs-downloaded prefixes named. Releases older than 1.30.17 predate the asset and are checked for presence only (stated in the output). verify-released.yml runs check-release daily, so the digest check is the daily net with no workflow change. (3) The plugin shows, in Settings → Advanced → About, its version and the SHA-256 of the INSTALLED main.js (read through the vault adapter, hashed with the existing sha256hex) with a Copy button, so a device can be audited against the release's SHA256SUMS. (4) The release-versioning skill's Step 5 text is doc-synced to say what 'released' now means. Signing (Sigstore / minisign) is NOT part of this decision; it is a follow-on the owner may charter.";
        :>> rationale = "A checksum recorded at publish and re-verified after publish closes the specific hazard cell found: the published bytes are tied to the build the workflow produced, and every later reader of the release (the daily check, a device) can prove it still is. It is the smallest change that makes 'released' mean 'these bytes' rather than 'these names', it needs no key management, and it reuses the tools already in the path (sha256sum in CI, gh release download, node:crypto in the script, the client's own sha256hex). ALTERNATIVES: (i) leave presence-only — REJECTED, it is the gap the analysis named and the owner directed to close; (ii) sign the assets (Sigstore keyless / minisign) — DEFERRED, not rejected: it adds a trust root and a verification step BRAT does not perform, so its value is for the daily check and audits, which the digest already serves; it stays a follow-on decision; (iii) verify only in check-release.mjs and not in release.yml — REJECTED, the publish step is where a mismatch is cheapest to catch and where the operator is present. WHY PROPOSED: release.yml is part of the enforcement surface (D0209 clause 2) and the release-versioning skill is a process document (D0070); both changed, so the gate requires a human-signed Decision.";
        :>> consequences = "release.yml gains a SHA256SUMS asset + notes block and a verify step; check-release.mjs gains a digest phase (presence-only for < 1.30.17); the plugin gains an About row (client-only; ships in 1.30.17). The process-change guard passes with this Decision co-committed. Owner-pending: `keel accept d0054`, and the first real run of the verify step is the 1.30.17 release itself — its success is the evidence for releaseAssetIntegrityDoD. REMOVAL PATH: `git revert` of the sprint commit restores presence-only checking; no data or persisted state depends on the digests.";
    }

    verification d0054Accept : Test {
        :>> id = "87d79a24-da8a-4a70-bf14-615212f35f01";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "The owner accepts that a published release is verified against the SHA256SUMS recorded at publish (release.yml verify step + check-release.mjs digest phase + the About row), replacing presence-only release completeness. HUMAN attestation via `keel accept d0054`; never inferred from the directive that prompted the work.";
    }
}

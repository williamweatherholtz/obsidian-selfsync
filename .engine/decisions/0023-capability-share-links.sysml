// =====================================================================
// D0023 — capability share-links: share a vault by sending a single-use LINK (no username,
// in-plugin, no admin), redeemed-binds-to-account. Extends D0008. Serves Need nVaultSharing.
// Full design: docs/design/specs/2026-07-11-capability-share-links.md.
// Accepted 2026-07-11 by wweatherholtz ("proceed and accepted") after spec review.
// =====================================================================
package ProjectDecision0023 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0023 : Decision {
        :>> id = "0d23a17e-5c41-4a23-9f10-2e7b6c0a2301";
        :>> title = "D0023: capability share-links (single-use invitation, redeem-binds-to-account)";
        :>> createdAt = "2026-07-11";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "D0008 shares a vault by USERNAME (the owner must know the grantee's account name; the admin page exposes a /api/admin/usernames autocomplete). That's clumsy for end users and couples sharing to knowing account names. Users want the familiar 'send a link' sharing model (like Google Docs / Dropbox), managed in the plugin without admin involvement, and without a username-listing surface. A capability link raises the obvious question of what it grants access to and how access is attributed/revoked.";
        :>> decision = "Adopt the design in docs/design/specs/2026-07-11-capability-share-links.md: a share-link is a SINGLE-USE INVITATION to a share, not a standing bearer credential. The link carries only an opaque CSPRNG token + the server URL (no permission, no vault data). When a LOGGED-IN account redeems it, the server mints a normal D0008 grant {owner,vault,grantee=redeemer,perm} in .shares.json and consumes the link — from then on it is an ordinary username ACL grant (per-user revoke, full audit attribution). New store DATA_ROOT/.share-links.json (token sha256-hashed at rest, single-use, default TTL, permission held server-side); owner-scoped endpoints create/list/revoke + an AuthToken-gated redeem, on the shared surface; plugin UI to generate/manage/redeem (selfsync-share:// link, Copy affordance like Add-a-device). Additive over the existing ACL; reuses the invite-token machinery (D0005 filesystem JSON, no DB).";
        :>> rationale = "The core fork is what the link binds to. ANONYMOUS capability (link IS the credential, no account) was REJECTED: it loses audit attribution ('whoever held the link'), makes the link a long-lived bearer secret bypassing the per-user token/session model, and gives only per-link revocation. REDEEM-BINDS-TO-ACCOUNT was CHOSEN: it preserves audit + per-user revoke + session semantics and reuses the proven, hashed/single-use/TTL'd invite-token design. Permission is held server-side (not encoded in the link) so a leaked read link can't be escalated to read-write. Single-use + default TTL + owner-visible redeemed_by + revoke bound the leak/wrong-redeemer window. CRITERIA: end-user-friendly sharing x no username-listing surface x audit + per-user revoke preserved x additive/low-risk over D0008 x no new datastore.";
        :>> consequences = "New filesystem store .share-links.json (atomic-written, tokens hashed). Four owner-scoped/redeem endpoints on the shared surface + new audit events (SHARE_LINK_CREATE/REDEEM/REVOKE). Plugin gains create/manage/redeem UI + a selfsync-share:// link codec. The underlying D0008 ACL is unchanged (this is a redemption layer). It does NOT provide anonymous/account-less access, and does NOT address open-registration username enumeration (orthogonal, dispositioned separately). Implements a concrete slice of the Phase-2 shareClientConsume direction.";
    }

    verification d0023Accept : Test {
        :>> id = "0d23acc7-1b22-4c33-8d44-5e6f70819202";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz reviewed docs/design/specs/2026-07-11-capability-share-links.md and accepted it on 2026-07-11 with 'proceed and accepted', authorizing implementation (redeem-binds-to-account, single-use, permission server-side).";
    }
    part d0023AcceptR1 : TestResult { :>> id = "0d23ac00-9a11-4b22-8c33-4d5e6f708193"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "060c8c2"; :>> judgedAt = "2026-07-11"; :>> judgedBy = "wweatherholtz"; }
}

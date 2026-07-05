// =====================================================================
// D0008 — design for multi-user vault sharing + a server-hosted management interface.
// Serves Need nVaultSharing. Full design: docs/design/specs/2026-07-04-vault-sharing-design.md.
// Accepted 2026-07-04 by wweatherholtz ("looks good. proceed") after spec review.
// =====================================================================
package ProjectDecision0008 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0008 : Decision {
        :>> id = "6becdfba-ce84-41f1-bc5b-e2973d8a1180";
        :>> title = "D0008: vault sharing via server-side ACL + a web management interface";
        :>> createdAt = "2026-07-04";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "Users want to share a vault with other people on the same self-hosted server, and a management interface to administer it. Today vaults are strictly per-user (a tested M4 isolation invariant), so sharing is fundamentally an authorization feature — an ACL on a vault — plus an admin surface, not a small addition. Scoping (2026-07-04) settled: a server-hosted web admin UI; per-share read-only or read-write; recipients are existing accounts; account provisioning is admin-controlled (closed registration by default, with an open-registration toggle and single-use invite tokens); Phase 1 (server + web admin) ships before Phase 2 (plugin consumption).";
        :>> decision = "Adopt the design in docs/design/specs/2026-07-04-vault-sharing-design.md: (1) a central DATA_ROOT/.shares.json ACL of {owner,vault,grantee,perm} grants; (2) owner-qualified vault routes /api/v/{owner}/{vault}/... with a server-side authorization layer (owner or matching grant; writes require read-write, reads accept any grant; the isolation invariant becomes 'no access without ownership or a grant'); (3) a registration policy in DATA_ROOT/.registration.json (closed|open) plus hashed, single-use invite tokens; (4) a server-hosted web admin UI at /admin over a /api/admin/* JSON authority (dual surface) — server-admin (the bootstrap SYNC_USER) manages accounts + registration + all shares; any owner manages their own vaults' shares. No new datastore — all filesystem JSON (D0005). Phase 2 (plugin consumption of shared vaults) is deferred and tracked (shareClientConsume).";
        :>> rationale = "ALTERNATIVES weighed during scoping: management surface in-plugin vs CLI vs web — CHOSE web admin (proper multi-user surface, dual-surface with a JSON authority); read-only-only vs read-write-only vs per-share — CHOSE per-share (owner picks) for flexibility; invite/self-serve vs existing-accounts — CHOSE existing accounts with an admin-controlled registration policy + invite tokens (controlled by default, openable). Per-vault vs central ACL — CHOSE central .shares.json so 'shared with me' and 'who sees this vault' are both cheap. CRITERIA: real multi-user manageability x server-enforced safety (isolation preserved for non-grantees) x no new datastore x controlled onboarding.";
        :>> consequences = "Vault addressing gains an owner dimension (a protocol change the client adopts in Phase 2; own-vault keeps working with owner=self). A new server authorization layer gates every vault request. New filesystem stores: .shares.json + .registration.json (atomic-written, tokens hashed). A web admin UI + /api/admin/* are added to the server. The M4 isolation test is restated (no access without ownership/grant) and kept. Phase 1 is independently shippable + testable via the API/admin UI; sharing becomes end-user-usable when Phase 2 lands.";
    }

    verification d0008Accept : Test {
        :>> id = "b2e36af2-e114-416f-9405-d6b719ec0e5b";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz reviewed docs/design/specs/2026-07-04-vault-sharing-design.md and accepted it on 2026-07-04 with 'looks good. proceed', authorizing Phase 1 implementation.";
    }
    part d0008AcceptR1 : TestResult { :>> id = "85c58617-b7b2-4039-997b-49b0d8e37933"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "c199b08"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "wweatherholtz"; }
}

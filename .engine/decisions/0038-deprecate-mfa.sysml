// =====================================================================
// D0038 — DEPRECATE MFA (TOTP two-factor). Owner-directed 2026-08-05: "deprecate MFA". The plugin
// login flow cannot supply a TOTP code (issueMfaLoginUnsupported), so an MFA-enrolled account is
// LOCKED OUT of the plugin — and rather than build plugin-side TOTP, the owner chose to retire MFA.
// Scope (owner: "disable but keep the code"): DISABLE the feature behind a runtime flag (MFA off by
// default), retaining the mfa.rs/totp.rs implementation for a clean reversal — NOT a code deletion.
// Deliverable-domain product decision (no engine schema/process change), so NOT a #ProspectiveChange.
// =====================================================================
package ProjectDecision0038 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0038 : Decision {
        :>> id = "5f8a6c29-3d1b-4e7a-9c04-1a2b3c4d5e60";
        :>> title = "D0038: deprecate MFA (TOTP) — disable behind a default-off flag, keep the code for reversal";
        :>> createdAt = "2026-08-05";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "SelfSync's server fully implements TOTP MFA (self-enrol + recovery codes, verified at login, optionally REQUIRED for admins via REQUIRE_ADMIN_MFA), but the OBSIDIAN PLUGIN's login flow sends only {username,password} — it has no field for a TOTP code (issueMfaLoginUnsupported). So an account that enrols MFA can authenticate on the /admin web page but is LOCKED OUT of the plugin (login returns 401 'mfa required' and the wizard can't answer it). Faced with the choice of (a) building plugin-side TOTP support (mfaLoginSupport) or (b) retiring MFA, the owner chose to DEPRECATE MFA: it adds real friction + a lockout footgun for a single-operator self-hosted product, and its value (a second factor on a server the user already controls behind their own TLS/reverse proxy) is marginal for this threat model. The owner specified the depth: 'disable but keep the code' — turn the feature OFF but do not rip out the implementation, so it can be re-enabled cleanly if ever wanted.";
        :>> decision = "Add a runtime Config flag `mfa_enabled` (env MFA_ENABLED, DEFAULT OFF). Gate the four live MFA touch-points on it, retaining all MFA code (mfa.rs, totp.rs, the users-store TOTP fields/methods) intact and still compiled + tested behind the flag: (1) auth::login enforces the TOTP second factor ONLY when mfa_enabled — so an already-enrolled account logs in with its password alone when MFA is off (NO lockout, the key safety property); (2) admin::require_admin's REQUIRE_ADMIN_MFA enrolment gate applies only when mfa_enabled; (3) the /api/mfa/* routes (status/enroll/confirm/disable) are mounted only when mfa_enabled; (4) the admin console's Two-factor panel renders only when the server reports mfa_enabled (exposed via /api/admin/me). Default off ⇒ MFA is not offered, not enforced, and its endpoints are absent — while the code path stays live (behind the flag) so `MFA_ENABLED=1` fully restores it. Model + docs updated to match: nAccountSecurity's statement drops the 'optional second factor' clause (an accepted scope reduction — a Decision that narrows a Need, not a superseding one); the ucEnableMfa use case is retired (removed from the model, as it no longer applies while MFA is off); the CMMC posture (docs/cmmc-posture.md) records IA.3.5.3 as DEPRECATED/off-by-default for this deployment. Resolves issueMfaLoginUnsupported by MOOTING it (no plugin TOTP needed once MFA is off).";
        :>> rationale = "A flag-gated disable (vs a code deletion) is exactly the owner's 'disable but keep the code': it is a ~5-line-per-site change, fully reversible with one env var, keeps clippy green (all items stay referenced behind the runtime flag — no dead code), and keeps the MFA implementation UNDER TEST (the existing MFA tests run with the flag ON, proving both the retained feature and the reversal path). Default-OFF is correct because the plugin cannot answer a TOTP challenge, so leaving MFA enforceable is a live lockout hazard; making it opt-in via MFA_ENABLED means only an operator who has re-added plugin support (or only uses the web surface) turns it on. No-lockout for already-enrolled accounts is the load-bearing safety requirement and is met by gating the LOGIN enforcement, not just the UI. ALTERNATIVES: (i) build plugin-side TOTP (mfaLoginSupport) — REJECTED by the owner (retire, not extend); (ii) hard-DELETE mfa.rs/totp.rs — REJECTED: the owner said keep the code; deletion also loses the reversal + the tests + would ripple the users-store schema (a migration to drop TOTP fields); (iii) leave routes mounted but only disable login enforcement — REJECTED: a half-state where you can still enrol a factor that is never checked. CRITERIA: no-lockout x reversible-with-one-flag x code-retained-and-tested x clippy-clean x honest-compliance-posture.";
        :>> consequences = "PRODUCT: MFA is off by default (server redeploy required). Already-enrolled accounts sign in with their password alone (no lockout); the admin console no longer shows the Two-factor panel; /api/mfa/* is unmounted; REQUIRE_ADMIN_MFA has no effect unless MFA_ENABLED=1. SECURITY/COMPLIANCE: the CMMC/800-171 IA.3.5.3 multi-factor control is DEPRECATED for this deployment — recorded honestly in docs/cmmc-posture.md (the trusted-server + TLS-in-transit posture and all other IA/AC/AU controls stand). MODEL: nAccountSecurity narrowed (drops the second-factor clause); ucEnableMfa retired (removed from the model); issueMfaLoginUnsupported resolved by this Decision mooting it (#Resolves d0038 -> issueMfaLoginUnsupported). The mfa.rs/totp.rs code + the users-store TOTP fields REMAIN (dormant, flag-gated, still unit-tested) so a future re-enable is a one-flag change — no re-implementation. Deliverable-domain decision (no engine schema/workflow/process/skill change) ⇒ no #ProspectiveChange, no CLAUDE.md change; doc-sync updates the compliance posture + any MFA mention this commit.";
    }

    verification d0038Accept : Test {
        :>> id = "6a9b7d3a-4e2c-4f8b-a015-2b3c4d5e6f71";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed 'deprecate MFA' on 2026-08-05 and, asked how far to take it, chose 'Disable but keep the code' (stop offering + stop enforcing MFA, leave the server code dormant + reversible; already-enrolled accounts must not be locked out). The MFA_ENABLED default-off flag design + the model/compliance updates are the AI's implementing design fulfilling that directive.";
    }
    part d0038AcceptR1 : TestResult {
        :>> id = "7b0c8e4b-5f3d-4a9c-b126-3c4d5e6f7082";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "36af228";
        :>> judgedAt = "2026-08-05";
        :>> judgedBy = "wweatherholtz";
    }
}

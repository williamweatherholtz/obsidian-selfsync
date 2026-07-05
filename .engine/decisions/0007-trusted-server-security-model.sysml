// =====================================================================
// D0007 — adopt a trusted-server + TLS-in-transit security model (content E2EE deferred),
// and never sync SelfSync's own credentials into the vault. Backfilled record (D0004) of an
// architecture decision made during the build; serves Need nxSecurity.
// =====================================================================
package ProjectDecision0007 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0007 : Decision {
        :>> id = "fb56e38e-2ed1-462d-8ba0-cc239bf832e4";
        :>> title = "D0007: trusted-server security model; own credentials never sync";
        :>> createdAt = "2026-07-03";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The user hosts the server themselves, so the trust boundary differs from a third-party cloud. We need a security model that is safe and simple for self-hosting without over-engineering, while guaranteeing SelfSync's own secrets (server URL, username, password, token) never leak into synced content.";
        :>> decision = "Adopt a trusted-server model: passwords are argon2id-hashed server-side; transport is protected by TLS via a reverse proxy (shipped Caddy example); the connection string / QR carries server + username ONLY (never the password). Selective sync EXCLUDES SelfSync's own plugin folder (manifest.dir basename) and the legacy id, so credentials are never synced into the vault. Client-side end-to-end encryption is deliberately DEFERRED (a seam is left in the setup wizard for an optional encryption password later).";
        :>> rationale = "ALTERNATIVES: (i) mandatory content E2EE from day one — REJECTED for v1: adds an encryption-password step + key-management complexity before the core sync is proven; the wizard leaves room to add it. (ii) plaintext password in the connection string/QR — REJECTED: it would let a shared link grant account access. (iii) CHOSEN — trusted-server + TLS + argon2id + credentials-never-sync: safe for the self-host threat model, low friction, with a clean seam for optional E2EE. CRITERIA: safe-for-self-host x low-friction x no-secret-leakage x future-E2EE-ready.";
        :>> consequences = "Content is protected in transit (TLS) and at rest on the user's own server, but not against a compromised server (no E2EE yet) — documented honestly. Credential exclusion is enforced by the selective-sync filter (shouldSync) and covered by the config-permutation test suite. Optional E2EE remains tracked as part of B7 auth hardening.";
    }

    verification d0007Accept : Test {
        :>> id = "cc18807c-1bbb-43d9-81a6-d6fddf2ae32c";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz confirmed acceptance of d0007 (trusted-server + TLS security model; own credentials never sync) on 2026-07-04 via the explicit choice 'Accept all three' when the backfilled architecture decisions were presented for sign-off.";
    }
    part d0007AcceptR1 : TestResult { :>> id = "0db7ee35-e46f-4e07-9655-ac88f21ecfed"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "3a9a827"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "wweatherholtz"; }
}

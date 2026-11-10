// D0108 (PROPOSED — NOT YET ACCEPTED) — E2EE revocation - ACL-only in v1, rotation and password change tracked
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0108Accept event on sign-off.
package Decision0108 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0108 : Decision {
        :>> id = "120b42c1-52dc-40ea-9d5d-14cd8937b5cc";
        :>> title = "E2EE revocation - ACL-only in v1, rotation and password change tracked";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 4 of 7 of D0098. Every enrolled device and every collaborator holds VK after a join. Removing a grant stops the server from serving that user. It does not change the key. The round-1 draft promised a password change with no route behind it, which three panelists found.";
        :>> decision = "Removing a grant is the only revocation in v1. The UI copy says that a removed collaborator keeps the key for content they already pulled. Cryptographic revocation needs VK rotation and is the tracked task e2eeVaultKeyRotation. Password change needs a re-wrap route with compare-and-swap on the verifier and is the tracked task e2eePasswordChange. In v1 there is no PUT keyring.";
        :>> rationale = "A re-wrap evicts nobody, because every enrolled device already holds VK. Honest copy beats a false promise. Both follow-ups are small because the key hierarchy already makes them a 32-byte change plus a route. ALTERNATIVES: (i) ship a re-wrap route in v1 - rejected, it needs a compare-and-swap design that two devices can race. (ii) promise password change without a route - rejected by the panel.";
        :>> consequences = "The SystemRequirement on password change states the structural invariant only, tested at the library level. Two follow-up tasks carry the routes.";
    }
    #DerivedFrom dependency from d0108 to us013;
    #DependsOn dependency from d0108 to d0107;
}

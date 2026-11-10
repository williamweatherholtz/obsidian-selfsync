// D0111 (PROPOSED — NOT YET ACCEPTED) — E2EE recovery - lose the password, lose the data, with a 12-character floor
// Recorded via `keel record decision` (engine D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, engine D0106): flip status + add the d0111Accept event on sign-off.
package Decision0111 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0111 : Decision {
        :>> id = "900deb7a-8f3c-42d0-8d0d-6f9ca8a42df6";
        :>> title = "E2EE recovery - lose the password, lose the data, with a 12-character floor";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 7 of 7 of D0098. Anyone with the keyring can run Argon2id against the wrapped key offline. A weak password makes that cheap. Obsidian Sync states that a lost password is unrecoverable.";
        :>> decision = "The creation dialog refuses an encryption password under 12 characters and refuses a password equal to the login password. It asks for the password twice and states that a lost password loses the data. There is no recovery in v1. A recovery key is the tracked task e2eeRecoveryKey. The dialog shows progress during derivation. The KDF cost policy is D0112. The floor is a length, not an entropy bound.";
        :>> rationale = "The password floor and Argon2id cost are the only brakes on offline guessing. Double entry prevents a typo from locking the user out at creation. A recovery key is a second wrap and is small, but it is scope the owner did not ask for. ALTERNATIVES: (i) a recovery key in v1 - deferred. (ii) no floor - rejected, the keyring is served to every grant.";
        :>> consequences = "The create dialog gains the floor, the equality check and the warning. The KDF measurement and the release policy are D0112.";
    }
    #DerivedFrom dependency from d0111 to us013;
    #DependsOn dependency from d0111 to d0107;
}

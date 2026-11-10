// D0107 (PROPOSED — NOT YET ACCEPTED) — E2EE sharing - one vault key per grant, the ACL decides access
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0107Accept event on sign-off.
package Decision0107 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0107 : Decision {
        :>> id = "67726809-11c0-467b-9d09-04a4bcd7c55a";
        :>> title = "E2EE sharing - one vault key per grant, the ACL decides access";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 3 of 7 of D0098. A Read grant today receives every chunk (server/src/api.rs:184-197, server/src/shares.rs:67-88). A collaborator's transport is bound to the owner-qualified route family. Serving the keyring to a Read grant gives that guest an offline guessing target.";
        :>> decision = "Guests with a Read or ReadWrite grant get the same keyring and unwrap the same VK with the password. The server ACL decides who may read or write. The password decides who can decrypt. The offline guessing exposure is stated in the threat model, and the password floor of clause 7 is the brake.";
        :>> rationale = "One VK per vault for all collaborators is the simplest model that works without asymmetric crypto. The exposure is the same as Obsidian Sync's: anyone with the wrapped key can guess offline. Argon2id cost and the password floor bound it. Hiding the keyring from Read grants would stop collaborators from joining at all. ALTERNATIVES: (i) per-recipient wrapped keys - deferred with clause 2. (ii) keyring for owners only - rejected, a read-only collaborator could never decrypt.";
        :>> consequences = "GET keyring needs a Read grant. The threat model names offline password guessing as not protected. Vault key rotation stays a tracked follow-up.";
    }
    #DerivedFrom dependency from d0107 to us013;
    #DependsOn dependency from d0107 to d0106;
}

// D0102 (PROPOSED — NOT YET ACCEPTED) — E2EE clause 4 of 6 - a per-vault keyring sidecar, created atomically with the vault
// Recorded via `keel record decision` (engine D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, engine D0106): flip status + add the d0102Accept event on sign-off.
package Decision0102 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0102 : Decision {
        :>> id = "589da583-12d1-4cd1-96d9-51271460a818";
        :>> title = "E2EE clause 4 of 6 - a per-vault keyring sidecar, created atomically with the vault";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 4 of 6 of D0097. POST /api/vaults returns a bare status with no id (server/src/vaults.rs:15-41). The index meta table is integer-valued only (server/src/index_store.rs:47). The round-1 draft created the vault and then PUT a keyring, and a panelist showed the gap accepts plaintext.";
        :>> decision = "A per-vault sidecar .keyring.json holds version, vault_id, the KDF parameters and salt, the check value, the wrapped VK, and server-written provenance. POST /api/vaults takes an optional keyring field and writes the vault and its keyring in one call, under the per-key open lock, with create_new on the sidecar. A racing second create gets 409. CURRENT_SCHEMA bumps to 4 for every vault, the v2 and v3 convention, so a rolled-back pre-E2EE binary refuses any vault the E2EE server opened with the existing 503 and never serves frames to an old client. The index meta table gains encrypted=1, written at atomic create under the open lock. Vault::open refuses with a distinct path-free 503 when encrypted=1 and no .keyring.json exists, and when .keyring.json exists on a non-fresh index without the flag. A quarantine rebuild derives the flag from the sidecar. isNonGatingEndpoint and TYPE_ROLES are extended with the two GET keyring routes and the keyring type, so a new plugin keeps syncing a plaintext vault on an old server. GET keyring exists on the own-vault route and the owner-qualified route, needs a Read grant, and answers 404 when the vault is not encrypted. There is no PUT keyring and no DELETE keyring in v1. The keyring dies with the vault. After creation the client reads GET keyring and pins only when the returned vault_id is the one it sent. On 404, which means an old server, it deletes the vault, discards the generated VK and names the minimum server version. The vault_id is distinct from the salt because a later re-wrap may rotate the salt. The audit entry for creation carries the encrypted flag. A lost keyring has no in-place recovery. The Blocked card names the reason and points at delete-then-create, the delete action and the create dialog of D0109. Backups must include .keyring.json, and docs/deployment.md says so.";
        :>> rationale = "Atomic creation leaves no window in which an encrypted vault accepts plaintext. A sidecar fits the existing .version-hwm pattern (server/src/vault.rs:279-292). The owner-qualified route is what every shared-vault call uses, so a collaborator can join. The post-creation read fails closed on a server that ignored the field. ALTERNATIVES: (i) create then PUT keyring - rejected, the gap accepts plaintext and a crash leaves a plaintext vault. (ii) a keyring field on status - rejected, an old client would ignore it and an old server would not refuse. (iii) a per-vault schema target - rejected, it makes schema_version mean table shape or encrypted, and the v2 and v3 bumps already refuse rollback for every vault. (iv) a re-enrol arm that purges and re-creates - rejected, it duplicates the delete action and the create dialog and launches a purge from a Blocked card.";
        :>> consequences = "CreateVaultRequest gains an optional keyring field, additive on the wire. Two new GET routes. The plugin gains an owner-scoped 'Delete this vault on the server' action, which the migration of D0109 uses. Password change and rotation need a later re-wrap route and are tracked follow-ups.";
    }
    #DerivedFrom dependency from d0102 to us013;
    #DependsOn dependency from d0102 to d0099;
}

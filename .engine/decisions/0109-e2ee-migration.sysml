// D0109 (PROPOSED — NOT YET ACCEPTED) — E2EE migration - chosen at creation, an existing vault moves by delete, create, switch
// Recorded via `keel record decision` (engine D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, engine D0106): flip status + add the d0109Accept event on sign-off.
package Decision0109 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0109 : Decision {
        :>> id = "f997986c-7c3e-47cf-b7dd-97250ff620bb";
        :>> title = "E2EE migration - chosen at creation, an existing vault moves by delete, create, switch";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 5 of 7 of D0098. Vault purge removes the directory and is best-effort (server/src/state.rs:343-376). docs/deployment.md tells the operator to back up the whole data volume. The round-1 draft claimed no plaintext residue, and two panelists showed that is false.";
        :>> decision = "Encryption is chosen when a vault is created. An existing plaintext vault is encrypted in three steps. Delete the old vault from the plugin with the owner-scoped delete action. Create the encrypted vault under the same name. On a 409 the dialog reads GET keyring. A 200 means an encrypted vault with this name exists, and the dialog offers join only. A 404 with the keyring route in the signature means a plaintext vault with this name exists, because the delete is not complete yet or another device re-created it, and the dialog offers delete behind the warnings. A 404 without the route names the minimum server version and offers nothing. Switch to it through the existing switch and upload flow. A device still pointed at the old name then meets the 403 or the join prompt, never a plaintext re-create prompt. The base-ownership key carries the codec tag, so the base guard routes the old base through its safe merge. The delete action warns that every share grant and share link is purged, so the owner re-shares with every collaborator afterwards, and the dialog points at it. The plugin's create dialog offers the 409 delete only after a fresh /schema fetch, anchored on the /health hash, lists the keyring route, so an old server never sees the delete. The wizard offers no delete. The server-side plaintext copy is deleted, not scrubbed. Earlier operator backups still hold it. docs/deployment.md says so and tells the operator to rotate or destroy pre-encryption backups.";
        :>> rationale = "Creation-time opt-in reuses two flows that exist and are tested. In-place encryption would need history rewriting and chunk GC coordination. Honest residue copy is what the threat model promises. ALTERNATIVES: (i) in-place encrypt-this-vault - rejected for v1. (ii) claim no residue - rejected by the panel.";
        :>> consequences = "No migration code. The create dialog explains the route for an existing vault. The threat model names pre-encryption copies as not protected.";
    }
    #DerivedFrom dependency from d0109 to us013;
    #DependsOn dependency from d0109 to d0102;
    #DependsOn dependency from d0109 to d0103;
    #DependsOn dependency from d0109 to d0105;
    #DependsOn dependency from d0109 to d0106;
}

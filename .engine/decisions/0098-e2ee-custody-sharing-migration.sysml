// D0098 (PROPOSED — NOT YET ACCEPTED) — E2EE custody and sharing - vault key cached on the device, join by password, ACL-only revocation
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0098Accept event on sign-off.
package Decision0098 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0098 : Decision {
        :>> id = "9bf26b19-f350-4e21-b889-7a689bf93d37";
        :>> title = "E2EE custody and sharing - vault key cached on the device, join by password, ACL-only revocation";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "The device already keeps the login token and, optionally, the login password in data.json (client/src/settings.ts:49,64). It keeps the three-way-merge base text there too (client/src/base.ts:22-24). Obsidian exposes no keychain to plugins. A device setup link carries server and username only. A share link carries server and a single-use token (client/src/sharelink.ts:11-29). A Read grant today receives every chunk. Sharing an encrypted vault, joining it from a second device, and encrypting an existing vault all need a stated custody model.";
        :>> decision = "CUSTODY. A device that unwrapped the vault key caches VK in data.json and never the encryption password. The setup link and the share link never carry VK or the password. JOIN. A second device, or a collaborator who redeemed a share, is asked for the vault's encryption password once. The client fetches the keyring, derives the KEK, unwraps VK, verifies the check value, and caches VK. A wrong password is reported as such before any content is read. SHARING. Guests with a Read or ReadWrite grant get the same keyring and the same VK. The server ACL decides who may read or write. The password decides who can decrypt. REVOCATION. Removing a grant stops the server from serving that user. It does not change the key. Cryptographic revocation needs VK rotation and is a tracked follow-up. The UI copy says so. MIGRATION. Encryption is chosen when a vault is created. An existing plaintext vault is encrypted in three steps. Create an encrypted vault. Switch to it through the existing switch and upload flow. Delete the old vault. MOUNTS. In v1 a mount whose source vault is encrypted is refused with a message that names the reason. RECOVERY. Lose the password, lose the data. The creation dialog asks for the password twice and states this.";
        :>> rationale = "Caching VK matches the trust already placed in the device for the login token and the merge base. It is what Obsidian Sync and LiveSync do. Caching the password instead would let a stolen data.json derive every future key for that salt. Keeping key material out of links keeps the D0007 guarantee that a link never grants content access by itself. One VK per vault for all collaborators is the simplest model that works without asymmetric crypto. Asymmetric wrapping would need X25519 in WebCrypto on every supported runtime. That support matrix is unverified for Obsidian's Electron and the mobile WebViews. Creation-time opt-in reuses two flows that exist and are tested. It leaves no plaintext residue after the old vault is deleted. ALTERNATIVES: (i) carry the VK in the share link - rejected, a link pasted in chat would grant decryption. (ii) per-recipient wrapped keys with public-key crypto - deferred, it needs a runtime support matrix and a key-rotation design first. (iii) in-place encrypt-this-vault - rejected for v1, it needs history rewriting and chunk GC coordination that the create-switch-delete route avoids.";
        :>> consequences = "settings.ts gains a per-vault vault-key field, held like authToken. The wizard, the create-vault dialog and the shared-vault redeem flow gain an encryption-password step. Mount creation checks the source vault's keyring and refuses an encrypted source. Four follow-up tasks are tracked: encrypted mount sources, VK rotation, path encryption, recovery key. docs/deployment.md states the custody model in the trust section.";
    }
    #DerivedFrom dependency from d0098 to us013;
}

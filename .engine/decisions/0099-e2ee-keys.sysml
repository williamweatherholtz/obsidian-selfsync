// D0099 (PROPOSED — NOT YET ACCEPTED) — E2EE keys - random vault key under an Argon2id KEK
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0099Accept event on sign-off.
package Decision0099 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0099 : Decision {
        :>> id = "bbdbf9af-d1a8-41cb-a7eb-2eeaf4956754";
        :>> title = "E2EE keys - random vault key under an Argon2id KEK";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 1 of 6 of D0097, split per clause after the 2026-11-10 panel (SE finding 4). The owner can accept or reject each choice as a unit. The compound D0097 is retired by this chain. The login password is sent to the server (client/src/setupwizard.ts:93) and verified there with argon2 (server/Cargo.toml:26). A content key derived from that password would hand the server the key.";
        :>> decision = "A separate encryption password, never sent to the server. Argon2id with a 16-byte per-vault salt derives a 32-byte KEK. Default parameters: 64 MiB memory, three passes, one lane, stored with the record. A random 32-byte vault key VK is wrapped by the KEK with AES-256-GCM, a random nonce and a 32-byte zero commitment pad. HKDF-SHA256 derives from VK three subkeys: k_enc, k_iv, k_id. A fourth key, k_check, derives from the KEK, not from VK. The keyring stores HMAC(k_check, 'selfsync-keyring-v1') as a password verifier. A re-wrap under a new password leaves every frame valid, and a library-level test pins that.";
        :>> rationale = "A random VK under a password-derived KEK makes a password change a 32-byte re-wrap and makes sharing a key hand-over. That is the Bitwarden, Proton and Standard Notes shape. Separate subkeys keep AES and HMAC inputs apart. A verifier from the KEK tells a wrong password from a corrupt wrap before any unwrap, which is the Cryptomator shape. The round-1 draft derived it from VK, and two panelists showed that proves nothing. ALTERNATIVES: (i) a password-derived content key - rejected, every password change would re-encrypt the vault. (ii) no verifier - rejected, a wrong password and a corrupt keyring would be one error. (iii) a verifier from VK - rejected, it is never reached when the wrap fails.";
        :>> consequences = "client/src/e2ee holds deriveKek, createKeyring, openKeyring, subkeys and rewrap. The Argon2id module of noble-hashes is outside that library's Cure53 audit scope, which the spec states. The KDF runs once per device enrolment and once per wrong-password retry. The parameters live in the keyring, so a later increase is a re-wrap.";
    }
    #Supersede dependency from d0099 to d0097;
    #DerivedFrom dependency from d0099 to us013;
}

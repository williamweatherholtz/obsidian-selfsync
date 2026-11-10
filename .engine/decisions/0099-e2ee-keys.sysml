// D0099 (PROPOSED — NOT YET ACCEPTED) — E2EE keys - random vault key under an Argon2id KEK
// Recorded via `keel record decision` (engine D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, engine D0106): flip status + add the d0099Accept event on sign-off.
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
        :>> decision = "A separate encryption password, never sent to the server. Argon2id with a 16-byte per-vault KDF salt derives a 32-byte KEK. Default parameters: 64 MiB memory, three passes, one lane, stored with the record. A keyring with m_kib above 262144, t above 10 or p above 4 is corrupt keyring before any derivation, so a lying server cannot exhaust a phone. A random 32-byte vault key VK is wrapped under k_wrap, an HKDF subkey of the KEK, with AES-256-GCM, a random nonce, a 32-byte zero commitment pad, and AAD_keyring as AAD. AAD_keyring is a fixed byte layout of the public fields: the label, version, vault_id, the KDF alg and parameters, the salt and check, each length-prefixed in that order. HKDF-SHA256 with the immutable vault_id as salt derives from VK three subkeys: k_enc, k_iv, k_id. The KDF salt is never an HKDF input, so a later re-wrap that rotates it leaves every frame and every cid valid. k_wrap and k_check derive from the KEK by HKDF with salt vault_id, not from VK, so the Argon2id output is never a cipher key. The keyring stores HMAC(k_check, 'selfsync-keyring-v1') as a password verifier. openKeyring decides in this order. A record that does not parse or exceeds the ceiling is corrupt keyring. Otherwise it derives the KEK and compares check. On a mismatch it still tries the unwrap. A verifying tag is corrupt keyring, and a failing tag is wrong password. An altered salt or KDF field reads as wrong password for a joiner, which the spec states. A re-wrap under a new password leaves every frame valid. The user-facing flow is the follow-up e2eePasswordChange.";
        :>> rationale = "A random VK under a password-derived KEK makes a password change a 32-byte re-wrap and makes sharing a key hand-over. That is the Bitwarden, Proton and Standard Notes shape. Separate subkeys keep AES and HMAC inputs apart. A verifier from the KEK tells a wrong password from a corrupt wrap before any unwrap, which is the Cryptomator shape. The round-1 draft derived it from VK, and two panelists showed that proves nothing. ALTERNATIVES: (i) a password-derived content key - rejected, every password change would re-encrypt the vault. (ii) no verifier - rejected, a wrong password and a corrupt keyring would be one error. (iii) a verifier from VK - rejected, it is never reached when the wrap fails.";
        :>> consequences = "client/src/e2ee holds deriveKek, createKeyring, openKeyring and subkeys. A keyring with any public field altered fails to open. The Argon2id module of noble-hashes is outside that library's Cure53 audit scope, which the spec states. The KDF runs once per device enrolment and once per wrong-password retry. The parameters live in the keyring. A later increase needs the follow-up e2eePasswordChange, because v1 has no re-wrap route.";
    }
    #Supersede dependency from d0099 to d0097;
    #DerivedFrom dependency from d0099 to us013;
}

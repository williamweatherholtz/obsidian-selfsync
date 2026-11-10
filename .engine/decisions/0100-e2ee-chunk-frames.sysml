// D0100 (PROPOSED — NOT YET ACCEPTED) — E2EE clause 2 of 6 - deterministic AES-256-GCM frames with a synthetic IV and a commitment pad
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0100Accept event on sign-off.
package Decision0100 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0100 : Decision {
        :>> id = "033091c3-d87f-42ec-81d7-572d90610d27";
        :>> title = "E2EE clause 2 of 6 - deterministic AES-256-GCM frames with a synthetic IV and a commitment pad";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 2 of 6 of D0097. Chunks are content-addressed by sha256 of their bytes (client/src/chunker.ts:17-20, server/src/chunkstore.rs:77-82). Dedup needs the same plaintext to give the same bytes. Plain convergent encryption is brute-forceable for low-entropy content. AES-GCM is not key-committing, and password-derived keys are the exploitable case.";
        :>> decision = "Each plaintext chunk from the existing chunker is encrypted with AES-256-GCM under k_enc. The IV is HMAC-SHA256(k_iv, plaintext) truncated to 12 bytes. A 32-byte zero pad goes in front of the plaintext. The AAD is 'selfsync/e2ee/v1' plus a random 16-byte vault_id minted at creation and stored in the keyring. The frame is magic SSE1, iv, ct_len, ciphertext with tag. Overhead is 68 bytes per chunk. The chunk address is sha256 of the frame, so dedup is unchanged. decodeChunk verifies the tag, checks all 32 pad bytes, recomputes the IV from the plaintext and compares. Only then does it release plaintext.";
        :>> rationale = "A keyed synthetic IV keeps content-addressed dedup and leaks only chunk equality within one vault, because the IV key is secret. That is the DupLESS answer. The zero pad makes AES-GCM key-committing for 32 bytes per chunk. It closes the partitioning-oracle attack. The frame is self-delimiting without the key, so the server can validate, size and split without decrypting. A random vault_id gives both route families one AAD and gives a same-name recreate a new AAD. ALTERNATIVES: (i) XChaCha20-Poly1305 via a JS library - rejected, no runtime advantage and a new dependency on the hot path. (ii) random nonces per chunk - rejected, every edit would re-upload every chunk. (iii) per-chunk AAD bound to the file - rejected, it breaks cross-file dedup. (iv) no AAD - rejected, a reused VK with a changed AAD is the GCM forbidden-attack precondition.";
        :>> consequences = "The chunk-length sequence is a plaintext fingerprint for files over 2 KiB, and the spec states it. The IV collision bound is about n squared over 2 to the 97. A zero-byte file is one 68-byte frame. WebCrypto AES-GCM and HKDF are native on Electron and both mobile WebViews, so no WASM or bundle cost follows.";
    }
    #DerivedFrom dependency from d0100 to us013;
    #DependsOn dependency from d0100 to d0099;
}

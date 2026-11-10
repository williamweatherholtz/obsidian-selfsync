// D0104 (PROPOSED — NOT YET ACCEPTED) — E2EE clause 6 of 6 - one ContentCodec seam, a codec-keyed chunk cache, WebCrypto plus noble-hashes
// Recorded via `keel record decision` (engine D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, engine D0106): flip status + add the d0104Accept event on sign-off.
package Decision0104 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0104 : Decision {
        :>> id = "328ffdf0-239b-4b66-890f-7bb3619581a1";
        :>> title = "E2EE clause 6 of 6 - one ContentCodec seam, a codec-keyed chunk cache, WebCrypto plus noble-hashes";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 6 of 6 of D0097. The primary vault and every mount share one ChunkCache (client/src/main.ts:422, 3185-3188), and getVerifiedChunk returns a hit without decrypting (client/src/sync.ts:112-118). Identity sites that feed FileMeta.hash sit in reconcile.ts, sync.ts and main.ts. Client crypto today is crypto.subtle.digest only.";
        :>> decision = "One seam, ContentCodec, with a PlainCodec that reproduces today's bytes and hashes exactly and an E2eeCodec that holds the three subkeys. The cache key becomes the codec tag plus the hash. The tag is hex HMAC-SHA256(k_id, 'selfsync/e2ee/v1/tag') cut to 16 characters, and it is also the base-ownership key suffix. commitBytes caches plaintext under the frame hash after encoding. HttpTransport sends x-selfsync-e2ee: 1 on every vault-scoped request when the codec is encrypted. AES-256-GCM, HKDF and HMAC come from WebCrypto. Argon2id comes from noble-hashes, pure JS. The Sha256 class in streamhash.ts gains a raw digest so an incremental HMAC can wrap it.";
        :>> rationale = "A single seam keeps the plaintext path byte-for-byte unchanged and pinned by the existing suites. A codec-keyed cache is a namespace. The commitment pad makes frame to plaintext unique per key, so the tag is not the integrity mechanism. WebCrypto is native on every supported runtime. Pure JS for Argon2id avoids a WebAssembly instantiation path that is untested on the mobile WebViews and adds no second dependency. ALTERNATIVES: (i) an if-else at nine sites - rejected, it threads a key through every site and loses the pin. (ii) hash-wasm - deferred, WASM instantiation on the mobile WebViews is untested here. (iii) a per-scope cache - acceptable, a keyed cache is smaller.";
        :>> consequences = "client/package.json gains noble-hashes. A lint test fails on a sha256hex import outside the chunker, frontmatter.ts, the stream hash, the codec and the main.js build fingerprint. The keyring fetch runs outside the engine effect path, so a 404 never becomes a slow retry. The switch preview compares cid in an encrypted vault. The noble Argon2id module is outside that library's audit scope, which the spec states.";
    }
    #DerivedFrom dependency from d0104 to us013;
    #DependsOn dependency from d0104 to d0100;
    #DependsOn dependency from d0104 to d0101;
}

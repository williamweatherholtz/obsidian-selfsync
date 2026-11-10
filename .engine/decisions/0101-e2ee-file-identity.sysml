// D0101 (PROPOSED — NOT YET ACCEPTED) — E2EE clause 3 of 6 - FileMeta.hash stays server-verifiable, a path-bound keyed cid is additive
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0101Accept event on sign-off.
package Decision0101 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0101 : Decision {
        :>> id = "678bbf09-1867-4abd-a248-a0118ae9265c";
        :>> title = "E2EE clause 3 of 6 - FileMeta.hash stays server-verifiable, a path-bound keyed cid is additive";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 3 of 6 of D0097. The round-1 draft put a keyed HMAC into FileMeta.hash. Five panelists showed the server then cannot verify a commit (server/src/vault.rs:618) and reindex cannot rebuild a row from the mirror (vault.rs:464-482). The client reconciles by comparing three identity strings (client/src/reconcile.ts:19-21).";
        :>> decision = "Two identities. FileMeta.hash is sha256 of the frame stream. The client and the server both compute it, and the existing commit check stays unchanged. A new optional FileMeta.cid is HMAC-SHA256(k_id, length of path, path, plaintext). Only the client computes it. The client verifies it on every pull before it writes the file. FileMeta.size stays the plaintext size. For an encrypted vault the client reconciles on cid. The path in cid is the source-vault path, never a local mount path. A rename is a delete plus a create with a new cid, and its chunks dedup. The server stores cid opaquely and refuses a commit without it on an encrypted vault.";
        :>> rationale = "A server-verifiable hash keeps commit verification, classify_missing and reindex working without the key. A keyed, path-bound cid detects a chunk substituted, dropped or reordered inside a file. It also detects content served under another path. Per-chunk addresses cannot, because the server knows every frame hash. Version rollback stays unprotected, which the spec states. ALTERNATIVES: (i) keyed HMAC in FileMeta.hash - rejected, the server cannot verify or rebuild it. (ii) content-only cid without the path - rejected, a file served under another path would pass.";
        :>> consequences = "FileMeta and CommitRequest gain an optional cid field, additive on the wire. The index gains a cid column. Every client identity site routes through the codec. A lint test fails on a sha256hex import outside the chunker, the codec and the stream hash.";
    }
    #DerivedFrom dependency from d0101 to us013;
    #DependsOn dependency from d0101 to d0100;
}

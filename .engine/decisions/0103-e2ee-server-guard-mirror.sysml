// D0103 (PROPOSED — NOT YET ACCEPTED) — E2EE server - frame checks, 403 guard, mirror trailer, reindex
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0103Accept event on sign-off.
package Decision0103 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0103 : Decision {
        :>> id = "bb1360bf-cff9-4d28-8815-5d3c1af70c07";
        :>> title = "E2EE server - frame checks, 403 guard, mirror trailer, reindex";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 5 of 6 of D0097. The server writes a plaintext mirror and rebuilds a corrupt index from it (server/src/vault.rs:104-123, 464-482). The commit guard aborts when the reassembled bytes exceed req.size (vault.rs:606-617). An old client maps an unknown 4xx to a slow retry and a 403 to a blocked link (client/src/connstate.ts:90-124).";
        :>> decision = "For a vault with a keyring: PUT chunk also needs a well-formed frame, else 422. The commit guard accumulates plaintext length from the frame headers. The commit handler refuses an empty chunk list, keeps the raw byte bound of body length against size plus 68 per listed chunk, and adds the plaintext sum. Final checks: the plaintext sum equals size, sha256 of the body equals hash, cid is present. The mirror holds the frame stream followed by a trailer SSEM plus cid. Every rebuild-from-disk (the corrupt-index rebuild, the missing-chunk fallthrough and an unindexed disk file) splits a mirrored file by frame headers and takes cid from the trailer. The rebuilt row equals the committed row. A file that does not parse is classified lost, which aborts reindex unless force. The self-heal compares the mirror length with the body length plus 36. A router layer on both vault route families answers HTTP 403 to a request without the header x-selfsync-e2ee: 1. The body names the cause. Exempt: status, GET keyring, the WebSocket, DELETE /api/vault, admin and share-link routes.";
        :>> rationale = "Frame validation on PUT stops a buggy or old client from writing plaintext into an encrypted vault. The trailer lets a keyless reindex rebuild a row. Every client accepts that row. Three panelists found that missing. A router layer is a property, not a route list. A new route inherits it. 403 blocks an old client. Its card shows the fixed text 'Access to this vault was removed', and the body reaches only the plugin log, which the docs state. 428 would retry forever. ALTERNATIVES: (i) 428 - rejected, the old client classifies it as degraded and retries. (ii) a route list - rejected, the next route inherits nothing. (iii) disable the mirror for encrypted vaults - rejected, it drops reindex-from-disk.";
        :>> consequences = "The host-filesystem edit feature of the mirror is unavailable for an encrypted vault, and docs/deployment.md says so. A test enumerates the router and asserts the guard. The wire signature is regenerated, additive only.";
    }
    #DerivedFrom dependency from d0103 to us013;
    #DependsOn dependency from d0103 to d0101;
    #DependsOn dependency from d0103 to d0102;
}

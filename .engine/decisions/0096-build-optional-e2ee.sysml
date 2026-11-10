// D0096 (PROPOSED — NOT YET ACCEPTED) — Build optional per-vault end-to-end encryption of content, chosen at vault creation
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0096Accept event on sign-off.
package Decision0096 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0096 : Decision {
        :>> id = "c5b56499-bbcc-4179-9de4-44555e19e664";
        :>> title = "Build optional per-vault end-to-end encryption of content, chosen at vault creation";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "D0007 adopted a trusted-server model and deferred client-side encryption. D0009 then declined it on 2026-07-05 for a single-operator self-host. On 2026-11-10 the owner directed the opposite (st009, us012). The direction: architect an end-to-end encryption feature, compare it to published practice, put it through a panel, and carry it out. The server today writes every committed file as plaintext to its mirror (server/src/vault.rs:687-690). It rebuilds the index from that mirror (vault.rs:464-473). It verifies the whole-file sha256 at commit (vault.rs:618). A Read grant on a share receives every chunk in the clear (server/src/api.rs:184-197). The design spec docs/design/specs/2026-11-10-e2ee-design.md grounds this Decision.";
        :>> decision = "Build an OPTIONAL, per-vault, end-to-end encryption mode. A user chooses it when the vault is created. Content of every synced file, including .obsidian config, is encrypted on the device before upload. Only devices that hold the vault key can decrypt it. Paths, sizes, mtimes, versions, device names and chunk equality within one vault stay visible to the server. The chunk-length sequence can fingerprint a known document. This is content-only encryption. Obsidian Sync encrypts paths, so the boundary is this project's own choice, not a precedent. Freshness (rollback by the server) is not protected. The local device stays trusted. The feature is off by default. A plaintext vault behaves exactly as today. D0009 is retired whole. D0007 keeps every clause except the one that defers client-side encryption.";
        :>> rationale = "The owner reversed the direction. The recorded basis for D0009 (single-operator self-host, cost over benefit) no longer governs. Content-only encryption keeps the three properties the product is built on. Those are a readable mirror tree on the server, real conflict copies by name, and share and mount semantics that work on paths. Path encryption would break all three and is separable. Opt-in at creation avoids a migration mechanism. An existing vault is encrypted by creating an encrypted vault, switching to it with the existing upload flow, and deleting the old one. The old server copy is deleted, not scrubbed, and earlier operator backups still hold it. ALTERNATIVES: (i) stay on D0009 - rejected by the owner's direction. (ii) full path and structure encryption - rejected for v1, it removes the readable mirror and changes conflict naming. (iii) mandatory encryption for every vault - rejected, it imposes a lose-the-password risk on users who trust their host.";
        :>> consequences = "A new Need (nE2eeContentPrivacy) and nine SystemRequirements enter the model. The D0099 to D0104 chain records the construction and the protocol. The D0105 to D0111 chain records custody, sharing and migration. The trust model in docs/deployment.md and README.md changes from 'no E2EE' to 'optional E2EE, content only'. The CMMC posture note gains the at-rest option. Delivery is five sprints: E1 crypto core, E2 server, E3a client wiring, E3b client flows, E4 real-server e2e and release. Five follow-ups are tracked and out of v1: encrypted mount sources, password change, vault-key rotation, path encryption, recovery key.";
    }
    #Supersede dependency from d0096 to d0009;
    #SupersedeClause dependency from d0096 to d0007;
    #DerivedFrom dependency from d0096 to us012;
}

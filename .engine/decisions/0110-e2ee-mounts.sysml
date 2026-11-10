// D0110 (PROPOSED — NOT YET ACCEPTED) — E2EE mounts - an encrypted source vault is refused in v1
// Recorded via `keel record decision` (engine D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, engine D0106): flip status + add the d0110Accept event on sign-off.
package Decision0110 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0110 : Decision {
        :>> id = "7c0626e6-030b-4556-ab0f-1810baff15aa";
        :>> title = "E2EE mounts - an encrypted source vault is refused in v1";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 6 of 7 of D0098. Mounts wrap the same SyncApi and rewrite paths to the source vault (client/src/mountio.ts:69-105). The primary and every mount share one chunk cache (client/src/main.ts:422, 3185-3188). A mount of an encrypted source needs that source's VK and codec.";
        :>> decision = "In v1 a mount whose source vault holds a keyring is refused with a message that names the reason. Mounting an encrypted source is the tracked task e2eeEncryptedMountSource. The chunk cache is keyed by codec tag so a later encrypted mount never shares an entry with a plain primary.";
        :>> rationale = "A mount of an encrypted source needs a second password prompt and a per-source codec. Refusing with a named reason keeps v1 small and keeps the composed-vault Need honest. The cache key is changed now because it is cheap and closes a key-boundary crossing a panelist found. ALTERNATIVES: (i) support encrypted mounts in v1 - deferred, it adds a prompt and a codec per source. (ii) refuse silently - rejected, the mount Need demands a named reason.";
        :>> consequences = "Mount creation checks GET keyring on the source. The follow-up task carries the full support.";
    }
    #DerivedFrom dependency from d0110 to us013;
    #DependsOn dependency from d0110 to d0104;
    #DependsOn dependency from d0110 to d0102;
}

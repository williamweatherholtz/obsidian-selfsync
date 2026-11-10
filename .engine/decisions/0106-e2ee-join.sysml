// D0106 (PROPOSED — NOT YET ACCEPTED) — E2EE custody clause 2 of 7 - a device or collaborator joins by typing the password once
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0106Accept event on sign-off.
package Decision0106 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0106 : Decision {
        :>> id = "4ffedc32-1525-4a6c-babc-d96773c5da37";
        :>> title = "E2EE custody clause 2 of 7 - a device or collaborator joins by typing the password once";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 2 of 7 of D0098. A device setup link carries server and username only. A share link carries server and a single-use token (client/src/sharelink.ts:11-29). A joining device has no key material and must get the vault key without the server learning it.";
        :>> decision = "A second device, or a collaborator who redeemed a share, is asked for the encryption password once. The client fetches the keyring, derives the KEK, checks the verifier, unwraps VK and pins it. Three outcomes are told apart before any content is read: corrupt keyring, wrong password, changed keyring. The setup link and the share link gain a flag e2ee=1 and never carry VK or the password. A joining device that sees the flag and receives 404 on GET keyring fails closed with a named reason.";
        :>> rationale = "Typing the password once is the simplest join that needs no asymmetric crypto. Asymmetric wrapping would need X25519 in WebCrypto on every supported runtime, a matrix that is unverified for Obsidian's Electron and the mobile WebViews. The link flag gives a fresh device an expectation it can hold the server to, which closes the lying-server join case. ALTERNATIVES: (i) carry VK in the link - rejected, a link pasted in chat would grant decryption. (ii) per-recipient wrapped keys with public-key crypto - deferred to a later design with key rotation.";
        :>> consequences = "The join prompt distinguishes the three outcomes. devicelink.ts and sharelink.ts gain the flag. The wizard fails closed when the flag and a 404 disagree.";
    }
    #DerivedFrom dependency from d0106 to us013;
    #DependsOn dependency from d0106 to d0105;
}

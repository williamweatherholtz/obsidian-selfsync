// D0105 (PROPOSED — NOT YET ACCEPTED) — E2EE custody - vault key pinned on the device, never the password
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0105Accept event on sign-off.
package Decision0105 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0105 : Decision {
        :>> id = "ba3a360b-e15c-44f9-b283-5388dae27e5d";
        :>> title = "E2EE custody - vault key pinned on the device, never the password";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "Clause 1 of 7 of D0098, split per clause after the 2026-11-10 panel (SE finding 4). The compound D0098 is retired by this chain. The device keeps the login token and, optionally, the login password in data.json (client/src/settings.ts:49,64). Obsidian exposes no keychain to plugins. Three panelists showed that a server answer of 404 on the keyring must never switch an enrolled device to plaintext.";
        :>> decision = "At enrolment the device stores, per vault, an encrypted flag, the vault_id and VK in data.json. It never stores the encryption password. On every connect the client reads GET keyring. For a pinned vault a 404, a different vault_id or a parse failure blocks the link with a named reason. A server answer never changes the codec. Secrets never reach a log line, the audit log, an error body, a conflict-copy name or a composition recipe. A grep test pins this.";
        :>> rationale = "Caching VK matches the trust already placed in the device for the login token and the merge base. Caching the password instead would let a stolen data.json derive every future key for that salt. The pin closes the operator-deleted-keyring, restored-old-backup, same-name-recreate and lying-server cases, which the round-1 draft left open. ALTERNATIVES: (i) decide the codec from the server answer - rejected, a 404 would downgrade an enrolled device to plaintext. (ii) cache the password - rejected, it derives every future key.";
        :>> consequences = "settings.ts gains a per-vault pin. The connect path gains a keyring check before any content call. A blocked-link reason names the keyring state.";
    }
    #Supersede dependency from d0105 to d0098;
    #DerivedFrom dependency from d0105 to us013;
}

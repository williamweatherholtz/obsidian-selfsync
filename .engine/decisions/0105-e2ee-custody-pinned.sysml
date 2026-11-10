// D0105 (PROPOSED — NOT YET ACCEPTED) — E2EE custody - vault key pinned on the device, never the password
// Recorded via `keel record decision` (engine D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, engine D0106): flip status + add the d0105Accept event on sign-off.
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
        :>> context = "Clause 1 of 7 of D0098, split per clause after the 2026-11-10 panel (SE finding 4). The compound D0098 is retired by this set. The device keeps the login token and, optionally, the login password in data.json (client/src/settings.ts:49,64). Obsidian exposes no keychain to plugins. Three panelists showed that a server answer of 404 on the keyring must never switch an enrolled device to plaintext.";
        :>> decision = "At enrolment the device stores, per vault, e2eeVaultId and VK in data.json. VK presence is the encrypted flag. No digest of the keyring is pinned, so a future re-wrap never forces a re-enrol. It never stores the encryption password. On every connect GET keyring is the first vault-scoped request, through the same one-shot re-login as status. It decides only on 200, 204 and 404. A 200 on an unpinned vault routes to the join prompt before any header-bearing call. A 204 is a plaintext vault. A 404 falls through to status, which tells a deleted vault from an old server. A 503 whose body names the lost sidecar shows the missing-keyring card. Any other answer aborts the connect through the status path with no codec decision. For a pinned vault a 204, a different vault_id or a parse failure blocks the link with a named reason. The Blocked card for a changed keyring offers one gesture, Re-enrol: Reconfigure routed into the wizard join path with the pin honoured. It takes the password and joins the keyring the server holds. A missing keyring has no re-enrol arm: the card names the reason and points at delete-then-create (D0102). No purge runs from a Blocked card. There is no explicit base clear. The VaultGone re-create prompt always opens the full create dialog with Encrypt, pinned or not. A server answer never changes the codec. Secrets never reach a log line, the audit log, an error body, a conflict-copy name or a composition recipe. A runtime capture test pins this.";
        :>> rationale = "Caching VK matches the trust already placed in the device for the login token and the merge base. Caching the password instead would let a stolen data.json derive every future key for that salt. The pin closes the operator-deleted-keyring, restored-old-backup, same-name-recreate and lying-server cases, which the round-1 draft left open. ALTERNATIVES: (i) decide the codec from the server answer - rejected, a 404 would downgrade an enrolled device to plaintext. (ii) cache the password - rejected, it derives every future key.";
        :>> consequences = "settings.ts gains a per-vault pin. The base-ownership key of an encrypted vault carries the codec tag from k_id, so the existing base-mismatch guard routes a stale base through its safe merge. A plaintext vault's key stays byte-identical to the pre-E2EE key, so no existing vault merges spuriously, pinned by a test. The connect path gains a keyring check before any content call. A blocked-link reason names the keyring state.";
    }
    #Supersede dependency from d0105 to d0098;
    #DerivedFrom dependency from d0105 to us013;
    #DependsOn dependency from d0105 to d0099;
}

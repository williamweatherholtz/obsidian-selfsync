// =====================================================================
// ProjectStpaAnalysis — STPA STEP 3 (Unsafe Control Actions + Controller Constraints) and STEP 4
// (Loss Scenarios) + derived SafetyRequirements. Authored 2026-07-07, completing the STPA
// (D0016). Severity-first: full four-guideword treatment on the control actions that reach the
// high-severity losses (L-1 loss/corruption, L-2 disclosure, L-3 device harm), plus availability
// (L-4). Low-severity/internal actions (author-note, dispatch-reconcile, provision-vault,
// manage-shares, GC) were considered; their guideword cells yield no new hazard beyond those
// below (author-note is the user's own intent; dispatch/GC are internal with no loss freedom).
//
// Trace: SafetyRequirement -#Satisfies-> SC ; SafetyRequirement -#Mitigates-> UCA ;
//        C-n -#Inverts-> UCA ; UCA -#Causes-> Hazard ; Scenario -#Explains-> UCA / -#LeadsTo-> Hazard.
// KEY FINDING: nearly every derived constraint is ALREADY REALIZED by shipped work (the five
// critique rounds + the pre-release hardening) — the STPA CONFIRMS that coverage and names the
// mechanism per requirement. The few OPEN ones map to already-tracked deferred issues.
// Sorts after control-structure.sysml + stpa-hazards.sysml (keel single-pass import order).
// =====================================================================
package ProjectStpaAnalysis {
    private import EngineElement::*;
    private import EngineSafety::*;
    private import ProjectControlStructure::*; // control actions + controllers
    private import ProjectHazards::*;           // hazards h1..h8, constraints sc1..sc8

    // ================= STEP 3 — Unsafe Control Actions =================
    // Context is the ACTUAL state that makes the action unsafe (not a belief, not the outcome).
    part uca1 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d001-4a10-9b20-a1b2c3d4d001"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-1: Reconciler deletes a local file when the remote lacks it but issued no deletion tombstone";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The remote is a wrong / fresh / restored server that never held the file (no tombstone), while the local copy matches the last-agreed base.";
        :>> statement = "The Reconciler provides delete-local for a path while the server has issued no deletion tombstone for it (the file is merely absent). [H-1]";
    }
    part uca2 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d002-4a10-9b20-a1b2c3d4d002"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-2: Reconciler bulk-deletes local files against a degraded/partial manifest";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The server manifest has lost a large fraction of previously-synced paths (partial index loss / restore over an incomplete dir).";
        :>> statement = "The Reconciler provides delete-local across many paths when the remote manifest is missing a suspicious fraction of the synced history. [H-1]";
    }
    part uca3 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d003-4a10-9b20-a1b2c3d4d003"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-3: Reconciler records a base / acts on a path outside this device's accept-scope";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "A path falls outside this device's selective-sync scope (a .obsidian category it filters out) yet is present on the server or locally.";
        :>> statement = "The Reconciler provides push/base-record (or delete) for a path this device does not accept, so a filtered path later reads as a phantom deletion on the device that holds it. [H-1, H-8]";
    }
    part uca4 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d004-4a10-9b20-a1b2c3d4d004"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-4: Reconciler pulls over a local file that changed since the decision, without preserving it";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "A local save landed after the reconcile decision was taken but before the downloaded bytes are written.";
        :>> statement = "The Reconciler provides pull (overwrite local) using a stale pre-fetch snapshot, discarding a racing local edit with no preserved copy. [H-1, H-2]";
    }
    part uca5 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d005-4a10-9b20-a1b2c3d4d005"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-5: Reconciler adopts downloaded content without verifying it against its hash";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "A served chunk/file is corrupt (bit rot / bad restore) — its bytes do not match the recorded content hash.";
        :>> statement = "The Reconciler provides pull, writing downloaded bytes to the note and stamping base = claimed hash without re-verifying the reassembled bytes. [H-3]";
    }
    part uca6 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d006-4a10-9b20-a1b2c3d4d006"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-6: Reconciler deletes a file on the server when local absence is not an authorized deletion";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The file is absent locally because it was filtered/never-held on this device (or a base desync), not because the user deleted it.";
        :>> statement = "The Reconciler provides delete-remote for a path whose local absence is not evidence of a user deletion. [H-1]";
    }
    part uca7 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d007-4a10-9b20-a1b2c3d4d007"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-7: Reconciler applies config that enables plugin code from a non-owned shared vault";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The changed config carries plugin CODE (or theme/snippet CSS) that originated from an UNTRUSTED writer — a share peer, whether the local account owns the vault or not (Round-6: the untrusted writer can be a readWrite grantee on a vault the local account OWNS, not only a non-owned vault).";
        :>> statement = "The Reconciler provides apply-config that enables/loads community-plugin CODE (or applies theme/snippet CSS) received via sync from any vault that has an untrusted writer, without explicit user authorization. [H-5]";
    }
    part uca8 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d008-4a10-9b20-a1b2c3d4d008"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-8: Reconciler applies synced config over the plugin's own credential/config folder";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "A synced path targets SelfSync's own plugin folder (which stores the server URL + credentials).";
        :>> statement = "The Reconciler provides write/apply over its own config folder, overwriting this device's stored server URL + credentials with another device's. [H-1, H-4]";
    }
    part uca9 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d009-4a10-9b20-a1b2c3d4d009"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-9: Server Vault commits a version based on a stale prior version (double-first-commit)";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "Two writers both based their edit on the same version and commit concurrently; the write lock serializes them.";
        :>> statement = "The Server Vault provides commit accepting a write whose base version no longer matches the current one, silently overwriting the intervening commit. [H-2]";
    }
    part uca10 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d00a-4a10-9b20-a1b2c3d4d00a"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-10: Server Vault commits bytes that do not match the declared hash/size";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The reassembled body's hash/size differs from the commit request's declared values.";
        :>> statement = "The Server Vault provides commit without verifying that the reassembled bytes match the declared hash and size. [H-3]";
    }
    part uca11 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d00b-4a10-9b20-a1b2c3d4d00b"; :>> ucaType = UcaType::wrongTimingOrder;
        :>> title = "UCA-11: Server Vault writes the on-disk mirror before the journal entry is durable";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "A crash can occur between the mirror write and the durable journal append.";
        :>> statement = "The Server Vault provides the bind-mount mirror write before the journal is fsynced, so a crash leaves disk ahead of the index and a later reindex resurrects never-committed content. [H-1, H-3]";
    }
    part uca12 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d00c-4a10-9b20-a1b2c3d4d00c"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-12: Server Vault commits a path that aliases an existing one (case/Unicode/non-canonical)";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The path differs from an existing index key only by case, Unicode folding, or non-canonical separators, on a folding filesystem.";
        :>> statement = "The Server Vault provides commit for a path that collapses onto an existing on-disk file, silently overwriting it or desyncing the index from disk (reindex brick). [H-1, H-8]";
    }
    part uca13 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d00d-4a10-9b20-a1b2c3d4d00d"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-13: Server Vault reindexes an incomplete dir, dropping indexed files as deletions";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The vault directory is transiently incomplete (partial restore / in-flight copy) when reindex runs.";
        :>> statement = "The Server Vault provides reindex that rebuilds only from present files, dropping previously-indexed files and emitting them to clients as deletions. [H-1]";
    }
    part uca14 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d00e-4a10-9b20-a1b2c3d4d00e"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-14: Access Control authorizes on an identity/grant it has not properly verified";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The caller's identity collides with another (case-folding) or the request path is not the one the grant was checked against.";
        :>> statement = "Access Control provides authorization without a canonical identity and a grant matching the exact target, letting one principal reach another's vault. [H-4, H-8]";
    }
    part uca15 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d00f-4a10-9b20-a1b2c3d4d00f"; :>> ucaType = UcaType::stoppedTooSoonAppliedTooLong;
        :>> title = "UCA-15: Access Control keeps authorizing an open channel after the grant is revoked";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "A share is revoked or the account deleted while a change-notification channel (or an unexpired token) is still open.";
        :>> statement = "Access Control continues to authorize an already-open channel (or a still-valid token) after the grant that permitted it was withdrawn. [H-7]";
    }
    part uca16 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d010-4a10-9b20-a1b2c3d4d010"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-16: Sync Engine reconciles against a not-ready (corrupt-index) server";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The server vault's index is corrupt, so it advertises an empty/degraded manifest.";
        :>> statement = "The Sync Engine provides a reconcile against a server that is not ready, so the client acts on an empty manifest and mass-deletes. [H-1]";
    }
    part uca17 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d011-4a10-9b20-a1b2c3d4d011"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-17: Sync Engine syncs against a protocol-incompatible server";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The plugin was auto-updated to a protocol version the server does not speak (or vice versa).";
        :>> statement = "The Sync Engine provides sync against a server on an incompatible protocol/schema version, risking an undiagnosable retry loop or a misinterpreted response. [H-6]";
    }
    part uca18 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d012-4a10-9b20-a1b2c3d4d012"; :>> ucaType = UcaType::notProvided;
        :>> title = "UCA-18: no repair is available for a corrupt vault reachable only by a non-owner";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "A shared vault's index is corrupt and its owner is unavailable; only the owner could previously repair it.";
        :>> statement = "Repair (reindex) is not provided for a corrupt vault when the only reachable operator is not its owner, leaving it unsyncable indefinitely. [H-6]";
    }
    part uca19 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d013-4a10-9b20-a1b2c3d4d013"; :>> ucaType = UcaType::stoppedTooSoonAppliedTooLong;
        :>> title = "UCA-19: Session keeps presenting a token it believes valid on a stale time-based cache";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The token was revoked/expired within a time window during which the client cached 'valid' without re-checking.";
        :>> statement = "The Session manager continues presenting a token treated as valid on a time-based freshness guess after it has actually become invalid. [H-6]";
    }
    part uca20 : UnsafeControlAction {
        :>> id = "c0f1a5cc-d014-4a10-9b20-a1b2c3d4d014"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-20: Session transmits the token over a channel where it can be logged/replayed";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> context = "The session token is placed in a URL/query used to open the change channel, which proxies and servers log.";
        :>> statement = "The Session manager provides the token over a loggable channel (a URL query string), so it can be captured from logs and replayed. [H-4]";
    }

    #Causes dependency from uca1 to h1;
    #Causes dependency from uca2 to h1;
    #Causes dependency from uca3 to h1;
    #Causes dependency from uca3 to h8;
    #Causes dependency from uca4 to h1;
    #Causes dependency from uca4 to h2;
    #Causes dependency from uca5 to h3;
    #Causes dependency from uca6 to h1;
    #Causes dependency from uca7 to h5;
    #Causes dependency from uca8 to h1;
    #Causes dependency from uca8 to h4;
    #Causes dependency from uca9 to h2;
    #Causes dependency from uca10 to h3;
    #Causes dependency from uca11 to h1;
    #Causes dependency from uca11 to h3;
    #Causes dependency from uca12 to h1;
    #Causes dependency from uca12 to h8;
    #Causes dependency from uca13 to h1;
    #Causes dependency from uca14 to h4;
    #Causes dependency from uca14 to h8;
    #Causes dependency from uca15 to h7;
    #Causes dependency from uca16 to h1;
    #Causes dependency from uca17 to h6;
    #Causes dependency from uca18 to h6;
    #Causes dependency from uca19 to h6;
    #Causes dependency from uca20 to h4;

    // ============ Controller Constraints (C-n = inversion of each UCA) ============
    part cc1 : ControllerConstraint { :>> id = "c0f1a5cc-d101-4a10-9b20-a1b2c3d4d101"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-1: delete-local only on a real deletion tombstone (never on absence)";
        :>> statement = "The Reconciler must not delete a local file unless the server carries a genuine deletion tombstone for it; absence alone means restore, not delete."; }
    part cc2 : ControllerConstraint { :>> id = "c0f1a5cc-d102-4a10-9b20-a1b2c3d4d102"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-2: no bulk delete against a degraded manifest";
        :>> statement = "The Reconciler must not propagate deletions when the manifest is missing a suspicious fraction of synced history."; }
    part cc3 : ControllerConstraint { :>> id = "c0f1a5cc-d103-4a10-9b20-a1b2c3d4d103"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-3: never record base/act for an out-of-scope path";
        :>> statement = "The Reconciler must skip a path outside this device's accept-scope entirely (no base, no push, no delete)."; }
    part cc4 : ControllerConstraint { :>> id = "c0f1a5cc-d104-4a10-9b20-a1b2c3d4d104"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-4: preserve a racing local edit before overwriting on pull";
        :>> statement = "The Reconciler must re-read current local content immediately before a pull and preserve any divergent live edit as a conflict copy."; }
    part cc5 : ControllerConstraint { :>> id = "c0f1a5cc-d105-4a10-9b20-a1b2c3d4d105"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-5: verify downloaded bytes against the hash before adopting";
        :>> statement = "The Reconciler must not write or adopt downloaded content as base unless its reassembled bytes match the claimed hash."; }
    part cc6 : ControllerConstraint { :>> id = "c0f1a5cc-d106-4a10-9b20-a1b2c3d4d106"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-6: delete-remote only on evidenced user deletion";
        :>> statement = "The Reconciler must delete a file on the server only when local absence is evidence of an in-scope user deletion (base present, genuinely removed)."; }
    part cc7 : ControllerConstraint { :>> id = "c0f1a5cc-d107-4a10-9b20-a1b2c3d4d107"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-7: never auto-run plugin code from a non-owned vault";
        :>> statement = "The Reconciler must not auto-enable/execute community-plugin code arriving over a shared/non-owned vault without explicit user authorization."; }
    part cc8 : ControllerConstraint { :>> id = "c0f1a5cc-d108-4a10-9b20-a1b2c3d4d108"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-8: never sync/apply over the plugin's own config folder";
        :>> statement = "The Reconciler must exclude SelfSync's own credential/config folder from sync and application, regardless of selection."; }
    part cc9 : ControllerConstraint { :>> id = "c0f1a5cc-d109-4a10-9b20-a1b2c3d4d109"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-9: reject a commit based on a stale version (CAS)";
        :>> statement = "The Server Vault must reject a commit whose declared base version does not match the current version for that path."; }
    part cc10 : ControllerConstraint { :>> id = "c0f1a5cc-d10a-4a10-9b20-a1b2c3d4d10a"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-10: verify reassembled hash/size before committing";
        :>> statement = "The Server Vault must reject a commit whose reassembled bytes do not match the declared hash and size."; }
    part cc11 : ControllerConstraint { :>> id = "c0f1a5cc-d10b-4a10-9b20-a1b2c3d4d10b"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-11: journal durable before mirror; index authoritative";
        :>> statement = "The Server Vault must make the journal entry durable before writing the on-disk mirror, and treat the index (not the mirror) as authoritative on reindex."; }
    part cc12 : ControllerConstraint { :>> id = "c0f1a5cc-d10c-4a10-9b20-a1b2c3d4d10c"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-12: reject aliasing/non-canonical paths";
        :>> statement = "The Server Vault must reject a path that collides with an existing key under filesystem folding or is not its own canonical form."; }
    part cc13 : ControllerConstraint { :>> id = "c0f1a5cc-d10d-4a10-9b20-a1b2c3d4d10d"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-13: refuse reindex when indexed files are missing from disk";
        :>> statement = "The Server Vault must refuse (not silently drop) when a reindex finds previously-indexed files absent from the directory."; }
    part cc14 : ControllerConstraint { :>> id = "c0f1a5cc-d10e-4a10-9b20-a1b2c3d4d10e"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-14: authorize only on a canonical identity + matching grant";
        :>> statement = "Access Control must authorize only against a canonical (fold-safe) identity and a grant matching the exact target vault/access."; }
    part cc15 : ControllerConstraint { :>> id = "c0f1a5cc-d10f-4a10-9b20-a1b2c3d4d10f"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-15: enforce revocation continuously, including open channels";
        :>> statement = "Access Control must re-check authorization on each notification and revoke a principal's tokens before purging their data, so access ends when the grant does."; }
    part cc16 : ControllerConstraint { :>> id = "c0f1a5cc-d110-4a10-9b20-a1b2c3d4d110"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-16: never reconcile against a not-ready server";
        :>> statement = "The Sync Engine must not reconcile against a server reporting a not-ready (corrupt-index) status; it must surface the repair action instead."; }
    part cc17 : ControllerConstraint { :>> id = "c0f1a5cc-d111-4a10-9b20-a1b2c3d4d111"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-17: refuse sync on a protocol-version mismatch, with an actionable message";
        :>> statement = "The Sync Engine must check the server's protocol/schema version on connect and refuse to sync on a mismatch, telling the user to upgrade the older side."; }
    part cc18 : ControllerConstraint { :>> id = "c0f1a5cc-d112-4a10-9b20-a1b2c3d4d112"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-18: an authorized operator can repair any vault";
        :>> statement = "The system must let an authorized operator repair (reindex) any vault, not only its owner."; }
    part cc19 : ControllerConstraint { :>> id = "c0f1a5cc-d113-4a10-9b20-a1b2c3d4d113"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-19: token validity driven by the server, not a time guess";
        :>> statement = "The Session manager must treat a token as valid until the server rejects it (reactive re-auth), never on a time-based freshness cache."; }
    part cc20 : ControllerConstraint { :>> id = "c0f1a5cc-d114-4a10-9b20-a1b2c3d4d114"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "C-20: never transmit the token over a loggable channel";
        :>> statement = "The Session manager must carry the token only in channels not persisted to proxy/server logs (never a URL query)."; }

    #Inverts dependency from cc1 to uca1;
    #Inverts dependency from cc2 to uca2;
    #Inverts dependency from cc3 to uca3;
    #Inverts dependency from cc4 to uca4;
    #Inverts dependency from cc5 to uca5;
    #Inverts dependency from cc6 to uca6;
    #Inverts dependency from cc7 to uca7;
    #Inverts dependency from cc8 to uca8;
    #Inverts dependency from cc9 to uca9;
    #Inverts dependency from cc10 to uca10;
    #Inverts dependency from cc11 to uca11;
    #Inverts dependency from cc12 to uca12;
    #Inverts dependency from cc13 to uca13;
    #Inverts dependency from cc14 to uca14;
    #Inverts dependency from cc15 to uca15;
    #Inverts dependency from cc15 to uca19; // continuous-revocation constraint also bounds the stale-token window
    #Inverts dependency from cc16 to uca16;
    #Inverts dependency from cc17 to uca17;
    #Inverts dependency from cc18 to uca18;
    #Inverts dependency from cc19 to uca19;
    #Inverts dependency from cc20 to uca20;

    // ================= STEP 4 — Loss Scenarios (causal chains) =================
    part s1 : LossScenario { :>> id = "c0f1a5cc-d201-4a10-9b20-a1b2c3d4d201"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "process-model + missing feedback";
        :>> title = "S-1: absence read as deletion against a wrong server";
        :>> statement = "The device is pointed at a fresh server; the Reconciler's process model (base) says 'we agreed on these files' but the manifest returns none. With no tombstone feedback to distinguish 'deleted' from 'never had', the model reads absence as deletion and issues delete-local for each file [H-1]. Feedback cause: the manifest carried no positive deletion evidence. Mitigation: tombstone-authoritative delete (SR-1)."; }
    part s2 : LossScenario { :>> id = "c0f1a5cc-d202-4a10-9b20-a1b2c3d4d202"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "inadequate control algorithm (one-shot guard)";
        :>> title = "S-2: a one-shot empty-server guard disarmed by the client's own pushes";
        :>> statement = "The empty-server guard is evaluated once; the client then restores/pushes files, so the manifest is no longer empty; on the next pass the guard no longer trips and the remaining delete-locals proceed [H-1]. Mitigation: a durable positive-evidence requirement, not a one-shot heuristic (SR-1)."; }
    part s3 : LossScenario { :>> id = "c0f1a5cc-d203-4a10-9b20-a1b2c3d4d203"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "inadequate process model (stale local snapshot)";
        :>> title = "S-3: a racing save dropped by a pull using a stale snapshot";
        :>> statement = "A save lands during the multi-chunk fetch; the Reconciler decided on the pre-fetch snapshot, so the pull overwrites the newer edit and no copy is kept [H-1, H-2]. Feedback cause: local state was sensed before the fetch, not re-sensed after. Mitigation: re-read live local + conflict-copy on mismatch (SR-2)."; }
    part s4 : LossScenario { :>> id = "c0f1a5cc-d204-4a10-9b20-a1b2c3d4d204"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "unsafe input / no confirming feedback";
        :>> title = "S-4: concurrent double-first-commit loses an update";
        :>> statement = "Two devices read base v3, both decide push; the write lock serializes them and the second overwrites the first with no version precondition; the first committer later pulls it (B==L) with no conflict copy [H-2]. Mitigation: commit CAS precondition (SR-7)."; }
    part s5 : LossScenario { :>> id = "c0f1a5cc-d205-4a10-9b20-a1b2c3d4d205"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "controlled-process failure (write ordering under crash)";
        :>> title = "S-5: crash between mirror-write and journal resurrects uncommitted content";
        :>> statement = "The mirror file is written before the journal is durable; a crash in that window leaves disk ahead of the index, and a later reindex rebuilds from disk, making never-committed bytes canonical [H-1, H-3]. Mitigation: journal-before-mirror; index authoritative (SR-9)."; }
    part s6 : LossScenario { :>> id = "c0f1a5cc-d206-4a10-9b20-a1b2c3d4d206"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "inadequate process model (identity folding)";
        :>> title = "S-6: case-folding identities collapse to one store";
        :>> statement = "On a case-insensitive filesystem 'Alice' and 'alice' are distinct store keys but one directory; Access Control authorizes each against its own key, so one principal reaches the other's vault [H-8, H-4]. Mitigation: canonical lowercase identity (SR-12)."; }
    part s7 : LossScenario { :>> id = "c0f1a5cc-d207-4a10-9b20-a1b2c3d4d207"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "missing feedback (authorize-once channel)";
        :>> title = "S-7: revoked grantee keeps receiving change metadata";
        :>> statement = "A share is revoked, but the grantee's change channel authorized only at connect and never re-checks, so it keeps streaming change notifications [H-7]. Feedback cause: no per-notification re-authorization. Mitigation: continuous re-check + revoke-before-purge (SR-13)."; }
    part s8 : LossScenario { :>> id = "c0f1a5cc-d208-4a10-9b20-a1b2c3d4d208"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "inadequate control algorithm (degraded input)";
        :>> title = "S-8: reindex over a partial dir emits deletions";
        :>> statement = "Reindex over a partially-restored directory sees fewer files than the index; it rebuilds from what is present and drops the rest, which propagate to clients as deletions [H-1]. Mitigation: refuse reindex when indexed files are missing (SR-11)."; }
    part s9 : LossScenario { :>> id = "c0f1a5cc-d209-4a10-9b20-a1b2c3d4d209"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "unsafe input from another controller (untrusted peer)";
        :>> title = "S-9: a share peer's plugin code executes on the victim";
        :>> statement = "A shared vault's owner commits .obsidian/plugins/x/main.js; the config-apply algorithm enables the touched plugin, executing the peer's code on the victim's device [H-5]. Mitigation: never auto-enable plugin code from a non-owned vault (SR-5)."; }
    part s10 : LossScenario { :>> id = "c0f1a5cc-d20a-4a10-9b20-a1b2c3d4d20a"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "inadequate process model (time-based staleness)";
        :>> title = "S-10: a time-cached 'token valid' belief outlives the token";
        :>> statement = "The client caches 'token valid' for a fixed window; the token is revoked mid-window; for the rest of it the client acts as authorized, failing ops and mis-reporting state [H-6]. Mitigation: reactive validity from the server's 401, no time guess (SR-17)."; }
    part s11 : LossScenario { :>> id = "c0f1a5cc-d20b-4a10-9b20-a1b2c3d4d20b"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "control-path failure (version skew)";
        :>> title = "S-11: independent upgrade produces undiagnosable skew";
        :>> statement = "The plugin auto-updates past the server; responses parse as malformed and the client loops (or misreads the schema), with no clear cause surfaced [H-6]. Mitigation: a version handshake that refuses on mismatch with an actionable message (SR-15)."; }
    part s12 : LossScenario { :>> id = "c0f1a5cc-d20c-4a10-9b20-a1b2c3d4d20c"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> causalFactor = "missing feedback (no integrity re-check)";
        :>> title = "S-12: bit-rot laundered into known-good base";
        :>> statement = "A bit-rotted chunk is served; without re-hashing the reassembled bytes the client writes it to the note and stamps base = claimed hash, so the corruption is re-served to every device as authoritative [H-3]. Mitigation: verify reassembly hash before adopting (SR-3)."; }

    #Explains dependency from s1 to uca1;   #LeadsTo dependency from s1 to h1;
    #Explains dependency from s2 to uca2;   #LeadsTo dependency from s2 to h1;
    #Explains dependency from s3 to uca4;   #LeadsTo dependency from s3 to h1;
    #Explains dependency from s4 to uca9;   #LeadsTo dependency from s4 to h2;
    #Explains dependency from s5 to uca11;  #LeadsTo dependency from s5 to h1;
    #Explains dependency from s6 to uca14;  #LeadsTo dependency from s6 to h8;
    #Explains dependency from s7 to uca15;  #LeadsTo dependency from s7 to h7;
    #Explains dependency from s8 to uca13;  #LeadsTo dependency from s8 to h1;
    #Explains dependency from s9 to uca7;   #LeadsTo dependency from s9 to h5;
    #Explains dependency from s10 to uca19; #LeadsTo dependency from s10 to h6;
    #Explains dependency from s11 to uca17; #LeadsTo dependency from s11 to h6;
    #Explains dependency from s12 to uca5;  #LeadsTo dependency from s12 to h3;

    // ================= Derived Safety Requirements =================
    // Each #Satisfies its SC + #Mitigates its UCA(s). safetyFunction names the REALIZING mechanism
    // + status (REALIZED with the shipping evidence, or OPEN with the tracked issue).
    part sr1 : SafetyRequirement { :>> id = "c0f1a5cc-d301-4a10-9b20-a1b2c3d4d301"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-1: tombstone-authoritative deletion";
        :>> statement = "Delete a local file only on a genuine server deletion tombstone; on mere absence, restore it.";
        :>> triggeringEvent = "reconcile finds a base-present file absent from the remote";
        :>> safeState = "local content retained (restored to the server) until a real tombstone exists";
        :>> safetyFunction = "REALIZED: tombstone gate + widened bulk-delete ratio guard (0.10.25); verified by acTombstoneAuthoritativeDelete + reconcile regression tests."; }
    part sr2 : SafetyRequirement { :>> id = "c0f1a5cc-d302-4a10-9b20-a1b2c3d4d302"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-2: preserve a racing local edit on pull";
        :>> statement = "Re-read live local content immediately before a pull/merge and preserve any divergent edit as a conflict copy.";
        :>> triggeringEvent = "a local save races an in-flight download";
        :>> safeState = "both the local edit and the remote version retained";
        :>> safetyFunction = "REALIZED: conflictCopyIfRaced + liveLocal re-read (DI-3/DI-R2#5/DI-R3#1). Residual (accepted): a sub-window TOCTOU on very large streamed pulls."; }
    part sr3 : SafetyRequirement { :>> id = "c0f1a5cc-d303-4a10-9b20-a1b2c3d4d303"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-3: verify downloaded content before adopting";
        :>> statement = "Do not write or adopt downloaded bytes as base unless they match the claimed content hash.";
        :>> triggeringEvent = "a pull reassembles a file/chunk";
        :>> safeState = "corrupt download refused + skipped; good local copy untouched";
        :>> safetyFunction = "REALIZED (buffered + per-chunk streamed): fetchVerified + getVerifiedChunk. PARTIAL/OPEN: whole-file hash over a streamed reassembly (wrong chunk-LIST) — issueStreamWholeHash (deferred)."; }
    part sr4 : SafetyRequirement { :>> id = "c0f1a5cc-d304-4a10-9b20-a1b2c3d4d304"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-4: selective-sync scope gate";
        :>> statement = "A path outside this device's accept-scope is skipped entirely — no base recorded, no push, no delete.";
        :>> triggeringEvent = "reconcile encounters a filtered .obsidian path";
        :>> safeState = "no phantom deletion of a path another device holds";
        :>> safetyFunction = "REALIZED: accepts() gate in reconcileOne + switchTo manifest filter; verified by acConfigAdditiveSafe."; }
    part sr5 : SafetyRequirement { :>> id = "c0f1a5cc-d305-4a10-9b20-a1b2c3d4d305"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-5: no auto-execution/apply of untrusted synced code or CSS";
        :>> statement = "Never auto-enable community-plugin CODE, nor auto-apply theme/snippet CSS, that arrived via sync — for ANY vault; require an explicit user reload to apply.";
        :>> triggeringEvent = "config sync writes plugin code or theme/snippet CSS to disk";
        :>> safeState = "nothing is executed/applied automatically; the user reloads to apply, only if they trust the source";
        :>> safetyFunction = "REALIZED (0.10.27, Round-6): flushConfigReload never auto-enables synced plugin code nor auto-applies synced CSS for ANY vault. The prior gate keyed only on non-owned vaults — missing the owner-of-a-shared-vault RCE (a readWrite peer's main.js) and leaving CSS ungated entirely."; }
    part sr6 : SafetyRequirement { :>> id = "c0f1a5cc-d306-4a10-9b20-a1b2c3d4d306"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-6: never sync/apply the plugin's own config folder";
        :>> statement = "Exclude SelfSync's own credential/config folder from sync and application under all selections.";
        :>> triggeringEvent = "config enumeration/apply reaches the self folder";
        :>> safeState = "this device's stored server URL + credentials are never overwritten by sync";
        :>> safetyFunction = "REALIZED: case-insensitive self-folder exclusion keyed on manifest.dir (C3/SEC-R2#1)."; }
    part sr7 : SafetyRequirement { :>> id = "c0f1a5cc-d307-4a10-9b20-a1b2c3d4d307"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-7: optimistic-concurrency (CAS) on commit";
        :>> statement = "Reject a commit whose declared base version differs from the current server version; the client re-reconciles into a merge.";
        :>> triggeringEvent = "two writers commit concurrently from the same base";
        :>> safeState = "the intervening commit is preserved; the second writer merges";
        :>> safetyFunction = "REALIZED: expected_version -> 409 + CommitConflictError (0.10.26); verified by the commit_cas + reconcile CAS tests."; }
    part sr8 : SafetyRequirement { :>> id = "c0f1a5cc-d308-4a10-9b20-a1b2c3d4d308"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-8: verify reassembled hash/size before commit";
        :>> statement = "Reject a commit whose reassembled bytes do not match the declared hash and size.";
        :>> triggeringEvent = "server reassembles a committed file from chunks";
        :>> safeState = "mismatched content is rejected, never stored";
        :>> safetyFunction = "REALIZED: commit hash/size check + repeated-chunk ceiling (server vault.commit)."; }
    part sr9 : SafetyRequirement { :>> id = "c0f1a5cc-d309-4a10-9b20-a1b2c3d4d309"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-9: durable journal before mirror; index authoritative";
        :>> statement = "Make the journal entry durable before writing the on-disk mirror; treat the index as authoritative on reindex.";
        :>> triggeringEvent = "a crash between mirror write and journal append";
        :>> safeState = "never-committed content cannot be resurrected";
        :>> safetyFunction = "REALIZED: journal(fsync)-then-write_mirror(temp+rename) ordering (DI-3)."; }
    part sr10 : SafetyRequirement { :>> id = "c0f1a5cc-d30a-4a10-9b20-a1b2c3d4d30a"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-10: reject aliasing / non-canonical paths";
        :>> statement = "Reject a commit path that folds onto an existing key (case/Unicode) or is not its own canonical forward-slash form.";
        :>> triggeringEvent = "a path collides with an existing on-disk file under FS folding";
        :>> safeState = "no silent overwrite; no index/disk desync (reindex brick)";
        :>> safetyFunction = "REALIZED: safe_rel_path (canonical form, reserved/junk/trailing-dot reject) + Unicode case-collision fold."; }
    part sr11 : SafetyRequirement { :>> id = "c0f1a5cc-d30b-4a10-9b20-a1b2c3d4d30b"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-11: refuse reindex over an incomplete directory";
        :>> statement = "Refuse (do not silently drop) when a reindex finds previously-indexed files absent from disk.";
        :>> triggeringEvent = "reindex runs over a partially-restored vault dir";
        :>> safeState = "no files dropped; no spurious deletions emitted";
        :>> safetyFunction = "REALIZED: reindex missing-file abort (DI-4)."; }
    part sr12 : SafetyRequirement { :>> id = "c0f1a5cc-d30c-4a10-9b20-a1b2c3d4d30c"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-12: verified identity + per-request authorization";
        :>> statement = "Authorize only against a canonical identity and a grant matching the exact target; re-authorize every request.";
        :>> triggeringEvent = "any vault request, including on a folding filesystem";
        :>> safeState = "no cross-account/cross-vault access";
        :>> safetyFunction = "REALIZED: lowercase-canonical safe_name + per-request AuthToken + shares.authorized()."; }
    part sr13 : SafetyRequirement { :>> id = "c0f1a5cc-d30d-4a10-9b20-a1b2c3d4d30d"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-13: enforce revocation continuously";
        :>> statement = "Re-check authorization on each change notification and revoke tokens before purging data, so access ends when the grant does.";
        :>> triggeringEvent = "a share is revoked or an account deleted";
        :>> safeState = "no residual access to content or change metadata";
        :>> safetyFunction = "REALIZED: WS per-notification ACL re-check (+ Lagged arm) + revoke-before-purge on account delete."; }
    part sr14 : SafetyRequirement { :>> id = "c0f1a5cc-d30e-4a10-9b20-a1b2c3d4d30e"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-14: never reconcile against a not-ready server";
        :>> statement = "Refuse to reconcile when the server reports a not-ready (corrupt-index) status; surface the repair action.";
        :>> triggeringEvent = "connect finds the vault status not 'ready'";
        :>> safeState = "no reconcile against a degraded manifest -> no mass delete";
        :>> safetyFunction = "REALIZED: doConnect status()!=ready gate + server 503 on corrupt (ensure_ready)."; }
    part sr15 : SafetyRequirement { :>> id = "c0f1a5cc-d30f-4a10-9b20-a1b2c3d4d30f"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-15: protocol version handshake";
        :>> statement = "Check the server's protocol/schema version on connect and refuse to sync on a mismatch, with an actionable upgrade message.";
        :>> triggeringEvent = "client and server are on different API versions";
        :>> safeState = "no sync; a clear message instead of an undiagnosable loop";
        :>> safetyFunction = "REALIZED: API_VERSION on /health + status; client CLIENT_API_VERSION check in doConnect (0.10.26)."; }
    part sr16 : SafetyRequirement { :>> id = "c0f1a5cc-d310-4a10-9b20-a1b2c3d4d310"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-16: operator repair of any vault";
        :>> statement = "Provide an authorized operator a path to repair (reindex) any vault, not only its owner.";
        :>> triggeringEvent = "a shared/non-owned vault's index is corrupt";
        :>> safeState = "the vault can be recovered without its owner";
        :>> safetyFunction = "REALIZED: admin reindex route + Vault-repair panel (0.10.26)."; }
    part sr17 : SafetyRequirement { :>> id = "c0f1a5cc-d311-4a10-9b20-a1b2c3d4d311"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-17: reactive token validity";
        :>> statement = "Treat a token as valid until the server rejects it (reactive re-login on 401); never gate on a time-based freshness cache.";
        :>> triggeringEvent = "a stored token is revoked/expired";
        :>> safeState = "validity reflects the server's actual answer";
        :>> safetyFunction = "REALIZED: acquireToken optimistic + withAuth/doConnect reactive 401 re-login (0.10.26)."; }
    part sr18 : SafetyRequirement { :>> id = "c0f1a5cc-d312-4a10-9b20-a1b2c3d4d312"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-18: token never on a loggable channel";
        :>> statement = "Carry the session token only in channels not persisted to proxy/server logs (never a URL query).";
        :>> triggeringEvent = "opening the change-notification channel";
        :>> safeState = "the token cannot be harvested from logs and replayed";
        :>> safetyFunction = "REALIZED: WS token via Sec-WebSocket-Protocol, not the URL (SEC-1)."; }
    // OPEN safety requirements — derived constraint not yet fully realized (tracked deferred issues).
    part sr19 : SafetyRequirement { :>> id = "c0f1a5cc-d313-4a10-9b20-a1b2c3d4d313"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "SR-19: bound per-vault uncommitted storage (OPEN)";
        :>> statement = "Bound the uncommitted/orphan chunk bytes a principal can accumulate per vault, so a writer cannot exhaust the owner's disk (availability).";
        :>> triggeringEvent = "a read-write grantee PUTs many chunks that never commit";
        :>> safeState = "storage bounded; other tenants unaffected";
        :>> safetyFunction = "OPEN: per-vault byte quota / runtime orphan GC — issueOrphanChunkQuota (deferred; today reclaimed only at startup)."; }

    #Satisfies dependency from sr1 to sc1;   #Mitigates dependency from sr1 to uca1;  #Mitigates dependency from sr1 to uca2;
    #Satisfies dependency from sr2 to sc2;   #Mitigates dependency from sr2 to uca4;
    #Satisfies dependency from sr3 to sc3;   #Mitigates dependency from sr3 to uca5;
    #Satisfies dependency from sr4 to sc1;   #Satisfies dependency from sr4 to sc8;   #Mitigates dependency from sr4 to uca3;  #Mitigates dependency from sr4 to uca6;
    #Satisfies dependency from sr5 to sc5;   #Mitigates dependency from sr5 to uca7;
    #Satisfies dependency from sr6 to sc4;   #Mitigates dependency from sr6 to uca8;
    #Satisfies dependency from sr7 to sc2;   #Mitigates dependency from sr7 to uca9;
    #Satisfies dependency from sr8 to sc3;   #Mitigates dependency from sr8 to uca10;
    #Satisfies dependency from sr9 to sc1;   #Satisfies dependency from sr9 to sc3;   #Mitigates dependency from sr9 to uca11;
    #Satisfies dependency from sr10 to sc8;  #Mitigates dependency from sr10 to uca12;
    #Satisfies dependency from sr11 to sc1;  #Mitigates dependency from sr11 to uca13;
    #Satisfies dependency from sr12 to sc4;  #Satisfies dependency from sr12 to sc8;  #Mitigates dependency from sr12 to uca14;
    #Satisfies dependency from sr13 to sc7;  #Mitigates dependency from sr13 to uca15;
    #Satisfies dependency from sr14 to sc1;  #Mitigates dependency from sr14 to uca16;
    #Satisfies dependency from sr15 to sc6;  #Mitigates dependency from sr15 to uca17;
    #Satisfies dependency from sr16 to sc6;  #Mitigates dependency from sr16 to uca18;
    #Satisfies dependency from sr17 to sc6;  #Mitigates dependency from sr17 to uca19;
    #Satisfies dependency from sr18 to sc4;  #Mitigates dependency from sr18 to uca20;
    #Satisfies dependency from sr19 to sc6;

    // ============ ARCHITECTURE-FACING LINKAGE (for suspicion propagation, D0017) ============
    // These edges connect each analysis artifact to the control-structure element it DEPENDS ON,
    // so a change to that element can flag the artifact for reassessment. Hazards + Losses are
    // deliberately NOT linked here — they are architecture-INDEPENDENT (a controller change must
    // not make a hazard suspect; only a loss/stakeholder change does). Direction: analysis-artifact
    // -> architectural-element it analyzes/realizes/senses.
    //
    // UCA #Analyzes the control action it is an unsafe form of (change the action -> reassess its UCAs):
    #Analyzes dependency from uca1 to caDeleteLocal;
    #Analyzes dependency from uca2 to caDeleteLocal;
    #Analyzes dependency from uca3 to caPushFile;
    #Analyzes dependency from uca4 to caPullFile;
    #Analyzes dependency from uca5 to caPullFile;
    #Analyzes dependency from uca6 to caDeleteRemote;
    #Analyzes dependency from uca7 to caApplyConfig;
    #Analyzes dependency from uca8 to caApplyConfig;
    #Analyzes dependency from uca9 to caCommit;
    #Analyzes dependency from uca10 to caCommit;
    #Analyzes dependency from uca11 to caCommit;
    #Analyzes dependency from uca12 to caCommit;
    #Analyzes dependency from uca13 to caReindex;
    #Analyzes dependency from uca14 to caAuthorize;
    #Analyzes dependency from uca15 to caAuthorize;
    #Analyzes dependency from uca16 to caEstablishConn;
    #Analyzes dependency from uca17 to caEstablishConn;
    #Analyzes dependency from uca18 to caRepairVault;
    #Analyzes dependency from uca19 to caAuthenticate;
    #Analyzes dependency from uca20 to caAuthenticate;
    // SafetyRequirement #RealizedBy the controller accountable for it (change the controller ->
    // reassess whether its safety requirements still hold):
    #RealizedBy dependency from sr1 to c4Reconciler;
    #RealizedBy dependency from sr2 to c4Reconciler;
    #RealizedBy dependency from sr3 to c4Reconciler;
    #RealizedBy dependency from sr4 to c4Reconciler;
    #RealizedBy dependency from sr5 to c4Reconciler;
    #RealizedBy dependency from sr6 to c4Reconciler;
    #RealizedBy dependency from sr7 to c5ServerVault;
    #RealizedBy dependency from sr8 to c5ServerVault;
    #RealizedBy dependency from sr9 to c5ServerVault;
    #RealizedBy dependency from sr10 to c5ServerVault;
    #RealizedBy dependency from sr11 to c5ServerVault;
    #RealizedBy dependency from sr12 to c6AccessControl;
    #RealizedBy dependency from sr13 to c6AccessControl;
    #RealizedBy dependency from sr14 to c2SyncEngine;
    #RealizedBy dependency from sr15 to c2SyncEngine;
    #RealizedBy dependency from sr16 to c5ServerVault;
    #RealizedBy dependency from sr17 to c3Session;
    #RealizedBy dependency from sr18 to c3Session;
    #RealizedBy dependency from sr19 to c5ServerVault;
    // Scenario #Senses the feedback/sensor whose inadequacy drives it (change the feedback path ->
    // reassess the scenario). Only the feedback-cause scenarios carry this edge.
    #Senses dependency from s1 to fbRemoteManifest;
    #Senses dependency from s3 to fbLocalHashes;
    #Senses dependency from s7 to fbChangeNotice;
    #Senses dependency from s10 to fbAuthResponse;
    #Senses dependency from s11 to fbConnResult;
    #Senses dependency from s12 to fbRemoteManifest;
}

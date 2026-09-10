// =====================================================================
// ProjectControlStructure — STPA STEP 2 (control structure) for the SelfSync sync system.
// Authored top-down 2026-07-06 per D0016 + the delineation rule agreed in-session:
//
//   A node is a CONTROLLER iff it (a) holds a PROCESS MODEL — a belief about state it does not
//   directly own — and (b) has freedom to act WRONGLY on that belief in a way that can reach a
//   Loss (L-1..L-4). A code unit whose output is a total/pure function of its inputs, or whose
//   correctness is structurally enforced, is NOT a controller: it is a CHANNEL/actuator, pruned
//   from the analysis with a recorded justification (see the PRUNED CHANNELS block below).
//   Decomposition depth is proportional to the severity of the reachable Loss.
//
// SCOPE OF THIS STEP: the control STRUCTURE — controllers, controlled processes, control actions
// [downward], feedback [upward], each controller's process model, and (pulled forward at the
// owner's request for a comprehensiveness check — the SOP defers these to Step 4) the Sensors and
// Actuators, so each control loop is closed. The full STPA loop element classes are therefore all
// present EXCEPT: the CONTROL ALGORITHM (the in-controller decision logic — not a separate item,
// it lives in its Controller) and EXTERNAL DISTURBANCES/INPUTS (the environment assumptions
// A1-A8 in safety.sysml). Controller responsibilities traced to Safety Constraints are PENDING —
// SCs derive from Hazards, which are deferred (Hazard is the first analytical output, not an
// input). UCAs (Step 3) and loss scenarios (Step 4) are NOT authored here.
//
// COMPREHENSIVENESS AUDIT (2026-07-07, vs the client+server function inventory): the one control
// loop the first structural pass MISSED was config APPLICATION — flushConfigReload enabling/
// disabling community plugins + loading theme/snippet CSS acts on the LOCAL OBSIDIAN RUNTIME
// (p5), and that action is exactly where L-3 (device harm via sync) is realized (the SEC-3
// gate lives on it). Added below (p5LocalRuntime + caApplyConfig). Vault provisioning
// (caProvisionVault) was also added. Everything else in the inventory maps to an existing
// controller/process or a pruned channel (see the PRUNED CHANNELS block).
//
// Arrows (STPA convention): a ControlAction points DOWN (controller -> controlled process, via
// issuedBy/actsOn); a Feedback points UP (process -> controller, via sensedFrom/reportsTo). An
// arrow is information that CAN be sent — never assumed delivered or obeyed (that gap is where
// Step-4 scenarios live).
//
// PRUNED CHANNELS (NOT controllers — correctness discharged by ordinary verification, with the
// structural guarantee that justifies pruning). Each is where "correct data transfer is strongly
// enforced", so it carries no unsafe decision freedom:
//   * chunker, SHA-256 hasher, merge3, decide()'s truth table — PURITY/TOTALITY (deterministic
//     function of inputs; no external belief). NB: decide() is pure; the hazard lives in the
//     Reconciler's USE of it against a possibly-stale base — which is why the Reconciler (not
//     decide) is the controller.
//   * protocol response validators (validateChanges/validateFileMeta), Rust exhaustive match,
//     the CommitConflict/tombstone typing — ILLEGAL-STATES-UNREPRESENTABLE (a malformed/hazardous
//     value is rejected before any decision consumes it).
//   * journal-then-mirror ordering, temp-write+rename, single-flight persist, revoke-before-purge
//     — ATOMICITY/TRANSACTIONALITY (no partial-execution decision to be unsafe about).
//   * content-addressed chunk store, idempotent commit, tombstone-authoritative delete, commit CAS
//     — IDEMPOTENCE / precondition enforcement (re-execution or a stale base cannot create a new
//     loss). These are realized ENFORCEMENT mechanisms (future SafetyRequirements will point here).
//   * HTTP transport (requestUrl) — CHANNEL: it carries actions + returns results; its failures are
//     modeled as feedback (errors/401/409), not as a controller.
// OUT OF SCOPE (no L-1..L-4 reachable): admin-UI HTML rendering, the status-light glyph rendering
// (cosmetic; a rendering fault maps to no data-safety loss — the severity gate excludes it).
// =====================================================================
package ProjectControlStructure {
    private import EngineElement::*;
    private import EngineSafety::*;

    // ---- Controllers (each holds a process model it can act wrongly on) ----
    part c1User : Controller {
        :>> id = "c0f1a5cc-b101-4a10-9b20-a1b2c3d4b101";
        :>> title = "User (human — authors notes, directs sync)"; // authority: what/when to write, delete, switch, adjudicate
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part c2SyncEngine : Controller {
        :>> id = "c0f1a5cc-b102-4a10-9b20-a1b2c3d4b102";
        :>> title = "Sync Engine (client operational FSM)"; // serial event queue: connect / dispatch reconcile / teardown / reconnect
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part c3Session : Controller {
        :>> id = "c0f1a5cc-b103-4a10-9b20-a1b2c3d4b103";
        :>> title = "Session/Auth manager (client)"; // acquires + presents the session token; reactive re-login on rejection
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part c4Reconciler : Controller {
        :>> id = "c0f1a5cc-b104-4a10-9b20-a1b2c3d4b104";
        :>> title = "Reconciler (client sync-decision controller)"; // THE safety-critical node: decides push/pull/delete/merge per path
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part c5ServerVault : Controller {
        :>> id = "c0f1a5cc-b105-4a10-9b20-a1b2c3d4b105";
        :>> title = "Server Vault manager"; // commit/tombstone/serve/reindex/GC over the index + chunk store
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part c6AccessControl : Controller {
        :>> id = "c0f1a5cc-b106-4a10-9b20-a1b2c3d4b106";
        :>> title = "Server Access Control (authorization)"; // authorizes/denies each request per identity + share ACL (L-2/L-3 critical)
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part c7Operator : Controller {
        :>> id = "c0f1a5cc-b107-4a10-9b20-a1b2c3d4b107";
        :>> title = "Operator (human — server admin/repair)"; // accounts, shares, registration policy, vault repair
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }

    // ---- Controlled processes (the things acted upon) ----
    part p1LocalVault : ControlledProcess {
        :>> id = "c0f1a5cc-b301-4a10-9b20-a1b2c3d4b301";
        :>> title = "Local vault files (notes + opted-in config on the user's disk)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part p2ServerIndex : ControlledProcess {
        :>> id = "c0f1a5cc-b302-4a10-9b20-a1b2c3d4b302";
        :>> title = "Server index (files -> version + chunk list, tombstones, chunk-refs)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part p3ChunkStore : ControlledProcess {
        :>> id = "c0f1a5cc-b303-4a10-9b20-a1b2c3d4b303";
        :>> title = "Server chunk store + bind-mount mirror (content-addressed blobs + files on disk)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    part p4AccountStore : ControlledProcess {
        :>> id = "c0f1a5cc-b304-4a10-9b20-a1b2c3d4b304";
        :>> title = "Accounts + share ACL store (users, tokens, grants, registration policy)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
    }
    // Audit find (2026-07-07): the local Obsidian app runtime — enabled plugins + their CODE,
    // loaded theme/snippet CSS. Distinct from p1 (the files on disk): applying a synced config
    // file MUTATES this runtime (runs plugin code). L-3 (device harm via sync) is realized here.
    part p5LocalRuntime : ControlledProcess {
        :>> id = "c0f1a5cc-b305-4a10-9b20-a1b2c3d4b305";
        :>> title = "Local Obsidian runtime (enabled plugins + their code, loaded CSS)";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
    }

    // ---- Process models (each controller's beliefs + the feedback that maintains them) ----
    part pmUser : ProcessModel {
        :>> id = "c0f1a5cc-b201-4a10-9b20-a1b2c3d4b201";
        :>> title = "PM-User: what's current + whether it's synced";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> beliefs = "Which notes exist and are current; whether recent changes have synced; connection status. Maintained by the notes shown + the sync status indicator + conflict prompts.";
        :>> heldBy = c1User;
    }
    part pmSyncEngine : ProcessModel {
        // STPA-FSM: client/src/transportstate.ts#transportMachine
        // STPA-FSM: client/src/syncengine.ts#engineMachine
        :>> id = "c0f1a5cc-b202-4a10-9b20-a1b2c3d4b202";
        :>> title = "PM-SyncEngine: phase + pending work + liveness";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> beliefs = "Current phase (off/connecting/idle/syncing/offline); queued work; whether a connection is live. Maintained by connection results, WS change notifications, poll results, and effect success/failure.";
        :>> heldBy = c2SyncEngine;
    }
    part pmSession : ProcessModel {
        // STPA-FSM: client/src/connstate.ts#linkMachine
        :>> id = "c0f1a5cc-b203-4a10-9b20-a1b2c3d4b203";
        :>> title = "PM-Session: is the held token valid";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> beliefs = "Whether the currently-held session token is valid. Maintained REACTIVELY by auth responses (a 401 marks it invalid); there is deliberately no proactive validity probe or time-based freshness guess (the token-TTL crutch was removed, 0.10.26).";
        :>> heldBy = c3Session;
    }
    part pmReconciler : ProcessModel {
        :>> id = "c0f1a5cc-b204-4a10-9b20-a1b2c3d4b204";
        :>> title = "PM-Reconciler: last-agreed content + cursor + tombstones + scope";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> beliefs = "Last-agreed content per path (base hash/text); the server version cursor; which paths the server has TOMBSTONED; which paths this device accepts; read-only status. Maintained by local file hashes, the remote manifest, per-file metadata, deletion tombstones, and commit outcomes. STALENESS of THIS belief is the demonstrated root of the data-loss + lost-update failure family.";
        :>> heldBy = c4Reconciler;
    }
    part pmServerVault : ProcessModel {
        :>> id = "c0f1a5cc-b205-4a10-9b20-a1b2c3d4b205";
        :>> title = "PM-ServerVault: the authoritative index + its integrity";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> beliefs = "The authoritative file -> version -> chunk index (+ tombstones + chunk-refs); whether that index is intact or corrupt. Maintained by journal replay on open, chunk-store presence scans, and materialized-file state.";
        :>> heldBy = c5ServerVault;
    }
    part pmAccessControl : ProcessModel {
        :>> id = "c0f1a5cc-b206-4a10-9b20-a1b2c3d4b206";
        :>> title = "PM-AccessControl: caller identity + share grants";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> beliefs = "The caller's authenticated identity (token -> user) and the share ACL granting read/read-write on a given (owner, vault). Maintained by token validation + the shares store.";
        :>> heldBy = c6AccessControl;
    }
    part pmOperator : ProcessModel {
        :>> id = "c0f1a5cc-b207-4a10-9b20-a1b2c3d4b207";
        :>> title = "PM-Operator: vault health + account/share roster";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> beliefs = "Which vaults are healthy vs corrupt; the account + share roster. Maintained by the admin surface (status + admin API listings).";
        :>> heldBy = c7Operator;
    }

    // ---- Control actions (downward: issuedBy controller, actsOn process) ----
    // User -> local vault (the origin of all content):
    part caAuthorNote : ControlAction {
        :>> id = "c0f1a5cc-b401-4a10-9b20-a1b2c3d4b401"; :>> title = "Author or edit a note";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c1User; :>> actsOn = p1LocalVault;
    }
    part caDeleteNote : ControlAction {
        :>> id = "c0f1a5cc-b402-4a10-9b20-a1b2c3d4b402"; :>> title = "Delete a note";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c1User; :>> actsOn = p1LocalVault;
    }
    part caRequestSwitch : ControlAction {
        :>> id = "c0f1a5cc-b403-4a10-9b20-a1b2c3d4b403"; :>> title = "Request a vault switch (download/upload/merge)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c1User; // command to the engine; no direct process
    }
    part caAdjudicate : ControlAction {
        :>> id = "c0f1a5cc-b404-4a10-9b20-a1b2c3d4b404"; :>> title = "Adjudicate a config conflict (keep local / take remote)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c1User;
    }
    // Sync Engine (operational dispatch):
    part caEstablishConn : ControlAction {
        :>> id = "c0f1a5cc-b405-4a10-9b20-a1b2c3d4b405"; :>> title = "Establish/tear down the server connection";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c2SyncEngine;
    }
    part caDispatchReconcile : ControlAction {
        :>> id = "c0f1a5cc-b406-4a10-9b20-a1b2c3d4b406"; :>> title = "Dispatch a reconcile (full or single-path)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c2SyncEngine; // drives the Reconciler
    }
    // Session/Auth:
    part caAuthenticate : ControlAction {
        :>> id = "c0f1a5cc-b407-4a10-9b20-a1b2c3d4b407"; :>> title = "Authenticate (obtain/refresh a session token)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c3Session; :>> actsOn = p4AccountStore;
    }
    // Reconciler -> local vault + server index (the safety-critical actions for L-1):
    part caPushFile : ControlAction {
        :>> id = "c0f1a5cc-b408-4a10-9b20-a1b2c3d4b408"; :>> title = "Push a file version to the server (with CAS base)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c4Reconciler; :>> actsOn = p2ServerIndex;
    }
    part caPullFile : ControlAction {
        :>> id = "c0f1a5cc-b409-4a10-9b20-a1b2c3d4b409"; :>> title = "Write a downloaded file to the local vault";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c4Reconciler; :>> actsOn = p1LocalVault;
    }
    part caDeleteLocal : ControlAction {
        :>> id = "c0f1a5cc-b40a-4a10-9b20-a1b2c3d4b40a"; :>> title = "Remove a local file (only on a real tombstone)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c4Reconciler; :>> actsOn = p1LocalVault;
    }
    part caDeleteRemote : ControlAction {
        :>> id = "c0f1a5cc-b40b-4a10-9b20-a1b2c3d4b40b"; :>> title = "Delete a file on the server";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c4Reconciler; :>> actsOn = p2ServerIndex;
    }
    part caWriteConflictCopy : ControlAction {
        :>> id = "c0f1a5cc-b40c-4a10-9b20-a1b2c3d4b40c"; :>> title = "Write a merge result or conflict copy locally";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c4Reconciler; :>> actsOn = p1LocalVault;
    }
    // Server Vault manager -> index + chunk store:
    part caCommit : ControlAction {
        :>> id = "c0f1a5cc-b40d-4a10-9b20-a1b2c3d4b40d"; :>> title = "Accept + durably record a file version (CAS-gated)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c5ServerVault; :>> actsOn = p3ChunkStore;
    }
    part caTombstone : ControlAction {
        :>> id = "c0f1a5cc-b40e-4a10-9b20-a1b2c3d4b40e"; :>> title = "Record a deletion tombstone";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c5ServerVault; :>> actsOn = p2ServerIndex;
    }
    part caReindex : ControlAction {
        :>> id = "c0f1a5cc-b40f-4a10-9b20-a1b2c3d4b40f"; :>> title = "Rebuild the index from materialized files (repair)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c5ServerVault; :>> actsOn = p2ServerIndex;
    }
    part caGcChunks : ControlAction {
        :>> id = "c0f1a5cc-b410-4a10-9b20-a1b2c3d4b410"; :>> title = "Reclaim unreferenced chunks";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c5ServerVault; :>> actsOn = p3ChunkStore;
    }
    // Access Control -> gates every vault request (authorize/deny):
    part caAuthorize : ControlAction {
        :>> id = "c0f1a5cc-b411-4a10-9b20-a1b2c3d4b411"; :>> title = "Authorize or deny a request on a vault (read vs read-write)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c6AccessControl; :>> actsOn = p2ServerIndex;
    }
    // Operator -> accounts/shares + repair:
    part caManageShares : ControlAction {
        :>> id = "c0f1a5cc-b412-4a10-9b20-a1b2c3d4b412"; :>> title = "Create/delete an account; grant/revoke a share; set registration policy";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c7Operator; :>> actsOn = p4AccountStore;
    }
    part caRepairVault : ControlAction {
        :>> id = "c0f1a5cc-b413-4a10-9b20-a1b2c3d4b413"; :>> title = "Repair a vault (admin reindex of any owner's vault)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c7Operator; :>> actsOn = p2ServerIndex;
    }
    // Audit find: apply a pulled config to the running app — the L-3 locus (SEC-3 gate: NEVER
    // auto-enable plugin code arriving over a shared/non-owned vault).
    part caApplyConfig : ControlAction {
        :>> id = "c0f1a5cc-b414-4a10-9b20-a1b2c3d4b414"; :>> title = "Apply synced config to the local runtime (enable/disable plugin, load CSS)";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c4Reconciler; :>> actsOn = p5LocalRuntime;
    }
    part caProvisionVault : ControlAction {
        :>> id = "c0f1a5cc-b415-4a10-9b20-a1b2c3d4b415"; :>> title = "Provision a vault namespace (create, per-account cap enforced)";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz"; :>> issuedBy = c1User; :>> actsOn = p4AccountStore;
    }

    // ---- Feedback (upward: sensedFrom process, reportsTo controller) ----
    part fbStatusIndicator : Feedback {
        :>> id = "c0f1a5cc-b501-4a10-9b20-a1b2c3d4b501"; :>> title = "Sync status indicator (light/ribbon) + conflict prompts";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> reportsTo = c1User;
    }
    part fbNotesShown : Feedback {
        :>> id = "c0f1a5cc-b502-4a10-9b20-a1b2c3d4b502"; :>> title = "Note content displayed to the user";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p1LocalVault; :>> reportsTo = c1User;
    }
    part fbConnResult : Feedback {
        :>> id = "c0f1a5cc-b503-4a10-9b20-a1b2c3d4b503"; :>> title = "Connection result / error";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> reportsTo = c2SyncEngine;
    }
    part fbChangeNotice : Feedback {
        :>> id = "c0f1a5cc-b504-4a10-9b20-a1b2c3d4b504"; :>> title = "Server change notification (WebSocket) + poll result (version cursor)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p2ServerIndex; :>> reportsTo = c2SyncEngine;
    }
    part fbAuthResponse : Feedback {
        :>> id = "c0f1a5cc-b505-4a10-9b20-a1b2c3d4b505"; :>> title = "Auth response (token issued / 401 rejected)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p4AccountStore; :>> reportsTo = c3Session;
    }
    part fbLocalHashes : Feedback {
        :>> id = "c0f1a5cc-b506-4a10-9b20-a1b2c3d4b506"; :>> title = "Local file listing + content hashes";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p1LocalVault; :>> reportsTo = c4Reconciler;
    }
    part fbRemoteManifest : Feedback {
        :>> id = "c0f1a5cc-b507-4a10-9b20-a1b2c3d4b507"; :>> title = "Remote manifest (upserts + deletion tombstones) + per-file metadata";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p2ServerIndex; :>> reportsTo = c4Reconciler;
    }
    part fbCommitOutcome : Feedback {
        :>> id = "c0f1a5cc-b508-4a10-9b20-a1b2c3d4b508"; :>> title = "Commit outcome (accepted version / 409 version-conflict)";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p2ServerIndex; :>> reportsTo = c4Reconciler;
    }
    part fbIndexHealth : Feedback {
        :>> id = "c0f1a5cc-b509-4a10-9b20-a1b2c3d4b509"; :>> title = "Index integrity (intact/corrupt) from journal replay + chunk-presence scan";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p3ChunkStore; :>> reportsTo = c5ServerVault;
    }
    part fbCallerIdentity : Feedback {
        :>> id = "c0f1a5cc-b50a-4a10-9b20-a1b2c3d4b50a"; :>> title = "Caller identity (token -> user) + share ACL state";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p4AccountStore; :>> reportsTo = c6AccessControl;
    }
    part fbVaultHealth : Feedback {
        :>> id = "c0f1a5cc-b50b-4a10-9b20-a1b2c3d4b50b"; :>> title = "Vault health (ready/corrupt) + account/share roster";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz"; :>> sensedFrom = p2ServerIndex; :>> reportsTo = c7Operator;
    }

    // ---- Actuators (effect a control action on a process; schema type is bare, so the action +
    // process + span are named in the title). Pulled forward for the comprehensiveness check. ----
    part actLocalVaultIo : Actuator {
        :>> id = "c0f1a5cc-b601-4a10-9b20-a1b2c3d4b601"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "Obsidian VaultIo (write/remove/streamed appendWrite) — effects pull/deleteLocal/writeConflictCopy on the local vault [c4->p1]";
    }
    part actConfigReloader : Actuator {
        :>> id = "c0f1a5cc-b602-4a10-9b20-a1b2c3d4b602"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "Config applier (enable/disable plugin, load theme/snippet CSS) — effects Apply-config on the local runtime [c4->p5]; SEC-3-gated for shared-vault code";
    }
    part actClientTransport : Actuator {
        :>> id = "c0f1a5cc-b603-4a10-9b20-a1b2c3d4b603"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "HTTP transport out (chunk PUT / commit / delete) — effects push/deleteRemote on the server [c4->p2/p3]";
    }
    part actServerStore : Actuator {
        :>> id = "c0f1a5cc-b604-4a10-9b20-a1b2c3d4b604"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "Server writer: journal(fsync) + write_mirror(temp+rename) + chunk-store put/remove — effects commit/tombstone/reindex/GC [c5->p2/p3]";
    }
    part actWsBroadcast : Actuator {
        :>> id = "c0f1a5cc-b605-4a10-9b20-a1b2c3d4b605"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "WS broadcaster — emits the change notification other clients' sensors read [c5->change stream]";
    }

    // ---- Sensors (measure a process -> the feedback above). Bare schema type; association named
    // in the title. Each pairs with a Feedback item (sensor -> feedback parity). ----
    part senVaultWatcher : Sensor {
        :>> id = "c0f1a5cc-b701-4a10-9b20-a1b2c3d4b701"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "Vault event watcher (modify/create/delete/rename) + raw config watcher + content hashing — measures p1 -> local-change trigger + fbLocalHashes";
    }
    part senRemoteChannel : Sensor {
        :>> id = "c0f1a5cc-b702-4a10-9b20-a1b2c3d4b702"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "WebSocket change stream + 4s poll of changes(since) — measures p2 version -> fbChangeNotice + fbRemoteManifest";
    }
    part senCommitResponse : Sensor {
        :>> id = "c0f1a5cc-b703-4a10-9b20-a1b2c3d4b703"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "Commit/HTTP response reader — measures accept vs 409 conflict -> fbCommitOutcome; also health/version handshake -> fbConnResult";
    }
    part senIndexVerifier : Sensor {
        :>> id = "c0f1a5cc-b704-4a10-9b20-a1b2c3d4b704"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "Journal replay + verify_and_gc chunk-presence scan (on open) + status is_corrupt — measures p2/p3 integrity -> fbIndexHealth + fbVaultHealth";
    }
    part senAuthResolver : Sensor {
        :>> id = "c0f1a5cc-b705-4a10-9b20-a1b2c3d4b705"; :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> title = "AuthToken extractor + shares/permission lookup — measures p4 identity + ACL -> fbCallerIdentity + fbAuthResponse";
    }

    // ---- Conflict resolver (added 2026-09-08, STPA step 6: every hazard-bearing state machine is a controller with
    // a process model on the shared fsm.ts primitive). The Resolve-conflicts modal + resolveNoteConflict: it writes
    // and removes user files on the human's irreversible choice, outside the engine's serial queue. ----
    part c8ConflictResolver : Controller {
        :>> id = "5d447939-6da8-4f42-88f2-05171afd6735";
        :>> title = "Conflict resolver (client: Resolve-conflicts modal + resolveNoteConflict)";
        :>> createdAt = "2026-09-08"; :>> createdBy = "claudeOpus";
    }
    part pmResolver : ProcessModel {
        // STPA-FSM: client/src/resolvefsm.ts#resolveMachine
        :>> id = "0f2e98d4-3d4c-4a7f-9bb2-87ebe111bd87";
        :>> title = "PM-Resolver: which version was previewed, whether it is still current, whether a pass is running, where the resolution stands";
        :>> createdAt = "2026-09-08"; :>> createdBy = "claudeOpus";
        :>> beliefs = "The other device's version as PREVIEWED (the text the user chose against); whether that version is still what is on disk (previewStillCurrent); whether the engine is busy (busyState - a pass may be reading/writing the same path); the resolution state (resolvefsm: idle / local step / uploading / done / stale / failed). Staleness of the preview belief is what turns a keep into data loss.";
        :>> heldBy = c8ConflictResolver;
    }
    part caWriteChosenVersion : ControlAction {
        :>> id = "dda1e4c6-fb3b-4309-bfa9-e737360eb537"; :>> title = "Write the chosen version over the original (Keep + this device's)";
        :>> createdAt = "2026-09-08"; :>> createdBy = "claudeOpus"; :>> issuedBy = c8ConflictResolver; :>> actsOn = p1LocalVault;
    }
    part caRemoveConflictCopy : ControlAction {
        :>> id = "d28f2f06-6cbd-468e-a771-702fed2acdd4"; :>> title = "Remove the conflict copy (every resolution ends with it)";
        :>> createdAt = "2026-09-08"; :>> createdBy = "claudeOpus"; :>> issuedBy = c8ConflictResolver; :>> actsOn = p1LocalVault;
    }
    part caKeepBothRename : ControlAction {
        :>> id = "c2817afe-3fb0-42bf-a298-5fb8f4204042"; :>> title = "Rename the conflict copy into an ordinary note (Keep both)";
        :>> createdAt = "2026-09-08"; :>> createdBy = "claudeOpus"; :>> issuedBy = c8ConflictResolver; :>> actsOn = p1LocalVault;
    }
    part fbEngineBusy : Feedback {
        :>> id = "ff6ad806-6a58-4cc4-8425-38f6ee2ece68"; :>> title = "Engine busy state (busyState: connecting / checking / syncing, with the live stage)";
        :>> createdAt = "2026-09-08"; :>> createdBy = "claudeOpus"; :>> reportsTo = c8ConflictResolver;
    }

    // ---- Nesting (composed vaults / mounts, D0039) — Step 2, 2026-09-09. A mount is a SECOND reconcile scope
    // over a subtree, run by its own runtime with its own base/cursor/state, driven from the primary cycle
    // (D0040) plus its own source subscription. Three controllers and three controlled processes join. ----
    part c9MountEngine : Controller {
        :>> id = "a6bf1593-8830-4c84-8b07-9685373e1187";
        :>> title = "Mount engine (per-mount scope runtime: MountRuntime + mountsync loop + rebuildMountScopes)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
    }
    part c10MountConfig : Controller {
        :>> id = "018417aa-71f1-4d0c-85b9-211c056c0be4";
        :>> title = "Mount configuration (settings UI, validateMounts/validMounts, recipe import — decides the configured + ACTIVE set)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
    }
    part c11SourceOwner : Controller {
        :>> id = "d7e234d9-a8ce-47a4-8596-07fbf56fc94e";
        :>> title = "Source-vault owner / peers (environment: other writers of the mounted source; untrusted unless it is the user's own vault)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
    }
    part pmMount : ProcessModel {
        // STPA-FSM: client/src/mountfsm.ts#mountMachine
        :>> id = "56259a82-51a9-4070-b8a9-0c632fce117d";
        :>> title = "PM-Mount: this mount's base + cursor, lifecycle state, direction, the source's readiness/compatibility, the user's grant, whether the primary owns this folder";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> beliefs = "Per mount: the last-agreed content per path (its OWN base) and source-global cursor; its lifecycle state (mountMachine); its direction (pull/sync); the source's readiness + apiVersion; the user's grant on the source (read vs read-write); whether the source IS the current primary (self-referential -> dormant); the local subtree listing. Staleness of the base while dormant, or a listing taken mid-write, are the demonstrated failure roots.";
        :>> heldBy = c9MountEngine;
    }
    part pmMountConfig : ProcessModel {
        :>> id = "9adb00b9-c8d5-4e21-b7c6-fe39c5077c4d";
        :>> title = "PM-MountConfig: the configured set, which entries are valid, the maximal non-overlapping ACTIVE subset, the primary's exclusion set";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> beliefs = "The configured mounts (settings.mounts), each entry's validity (non-empty, not under .obsidian, not nested/overlapping), the ACTIVE subset (validMounts: drop only the offending entry), and therefore which local folders the PRIMARY scope must exclude. A wrong belief here moves whole folders between scopes.";
        :>> heldBy = c10MountConfig;
    }
    part p6MountFolder : ControlledProcess {
        :>> id = "a83dcbce-88dd-4051-914d-125b4aeea2ab";
        :>> title = "The local mount-point subtree (a folder of the user's vault presenting another vault's data)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
    }
    part p7SourceSubtree : ControlledProcess {
        :>> id = "df75a9d8-e08c-464b-8aff-cfa0433f6523";
        :>> title = "The mounted SOURCE subtree on the server (another vault's files — the user's own or a peer's)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
    }
    part p8MountState : ControlledProcess {
        :>> id = "fc4d831a-b3cd-4c2d-87ab-83aa46def901";
        :>> title = "Persisted mount state (settings.mounts + mountStateStore: per-mount base snapshot + cursor)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
    }
    part caMountStart : ControlAction {
        :>> id = "1627e419-30f6-4a3e-a327-4ddec8b00b4a"; :>> title = "Start / first-contact a mount scope (build its runtime, base, cursor; adopt the source subtree)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c9MountEngine; :>> actsOn = p6MountFolder;
    }
    part caMountPull : ControlAction {
        :>> id = "9412b6c2-ab6c-499a-94ef-c7ac5a8749a0"; :>> title = "Apply a source change into the mount folder (pull / delete-local within the mount)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c9MountEngine; :>> actsOn = p6MountFolder;
    }
    part caMountPush : ControlAction {
        :>> id = "df5822b2-3d60-4e8e-a87a-bbd66264fc77"; :>> title = "Commit a local change of the mount folder to the source (sync mounts only)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c9MountEngine; :>> actsOn = p7SourceSubtree;
    }
    part caMountDeleteOutgoing : ControlAction {
        :>> id = "7d5252b6-5a0e-47d3-b4c0-36620e033957"; :>> title = "Propagate a local deletion inside the mount to the source (delete-remote on the source subtree)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c9MountEngine; :>> actsOn = p7SourceSubtree;
    }
    part caComputeActiveMounts : ControlAction {
        :>> id = "59bd03a6-1011-460a-95e5-546023a9fe44"; :>> title = "Compute the ACTIVE mount set and the primary scope's exclusion (validMounts + primaryExcludes)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c10MountConfig; :>> actsOn = p8MountState;
    }
    part caMountRemove : ControlAction {
        :>> id = "56a62b46-bf5c-42be-91d9-6690dbf5b64c"; :>> title = "Remove / unmount a mount (non-destructive: files stay as ordinary notes; base + cursor dropped)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c10MountConfig; :>> actsOn = p8MountState;
    }
    part caSetMountDirection : ControlAction {
        :>> id = "64003f08-61a6-4edc-a2e1-bb3dd9c7b455"; :>> title = "Set a mount's direction (pull <-> sync)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c10MountConfig; :>> actsOn = p8MountState;
    }
    part caApplyRecipe : ControlAction {
        :>> id = "2ae78da1-681c-4074-851f-d7938195a6c6"; :>> title = "Apply an imported composition recipe (add mounts from a pasted selfsync-recipe:// string)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c10MountConfig; :>> actsOn = p8MountState;
    }
    part caSourceWrite : ControlAction {
        :>> id = "f19ac057-8932-4d2d-adf9-c6a5432bcca5"; :>> title = "A source owner/peer writes, deletes or prunes history on the mounted source (environment action)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> issuedBy = c11SourceOwner; :>> actsOn = p7SourceSubtree;
    }
    part fbMountStatus : Feedback {
        :>> id = "ef16781a-88d7-449d-a3a3-1605efbdfe82"; :>> title = "Per-mount state folded into the status light, hero and per-mount rows";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> reportsTo = c1User;
    }
    part fbSourceReady : Feedback {
        :>> id = "6bcfd8eb-9485-4691-9c83-0f003d763d8a"; :>> title = "Source readiness + apiVersion (status probe) and the user's grant on the source";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> reportsTo = c9MountEngine;
    }
    part fbSourceChanges : Feedback {
        :>> id = "cea18a20-107f-48fe-b79b-060177a097fd"; :>> title = "Source change feed (filtered manifest / delta with source-global version; per-mount WebSocket poke)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> reportsTo = c9MountEngine;
    }
    part fbMountFolderEvents : Feedback {
        :>> id = "a1f64450-8583-4a2e-8d7e-0f4db8963477"; :>> title = "Local file events + listing under the mount point (incl. the folder itself vanishing)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus"; :>> reportsTo = c9MountEngine;
    }

    // ---- Step 2 follow-up of the 2026-09-09 Step 1 refresh (2026-09-10): the four authorities the inventory named
    // NEW, modelled as ENVIRONMENT controllers. Each can change a controlled process the plugin also controls
    // (the vault files p1, the local runtime p5, the server p2) — the plugin does not command them, it must
    // COEXIST with them, so their actions are the CONTEXT of the plugin's own UCAs (stpa-authorities.sysml). ----
    part c12HostApp : Controller {
        :>> id = "799044bb-8504-4cbe-9d6c-8bf6b0f3617a";
        :>> title = "Host application (Obsidian: vault API + file events keyed by EXACT case; plugin lifecycle load / unload / update / suspend / resume; one main thread shared with the plugin)";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
    }
    part c13OtherPlugins : Controller {
        :>> id = "7f71b4b4-2b0e-4990-aa83-5a2b9cbea13f";
        :>> title = "Other plugins on this device (same-file writers - timestamp stampers, fileClass tooling, Templater - and plugin CODE that itself arrives through config sync)";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
    }
    part c14OtherSyncTools : Controller {
        :>> id = "cfaf7368-eebb-463e-a3a9-2bd4efa1772a";
        :>> title = "Other sync tools on the same directory (Syncthing, cloud drives: rewrite files, create their own conflict copies, hydrate / dehydrate placeholders, hold locks)";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
    }
    part c15ReleaseChannel : Controller {
        :>> id = "d76c9f0f-d61c-46b4-a39f-152d88c5d382";
        :>> title = "Release channel (GitHub Releases installed by BRAT for plugin code; GHCR image deployed or rolled back by the operator for the server; CI builds from tags)";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
    }
    part pmHost : ProcessModel {
        :>> id = "a62de147-759d-4028-b569-39b70c8a3806";
        :>> title = "PM-Host: the host's own picture of the vault and of this plugin";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus";
        :>> beliefs = "The file index keyed by the EXACT-case path the host first saw (not what the filesystem folds together); which plugins are enabled and which instance of ours is live; whether the app is foregrounded (mobile suspends timers while backgrounded); the minAppVersion it will load. The plugin inherits every one of these beliefs through the API it is given.";
        :>> heldBy = c12HostApp;
    }
    part caHostLifecycle : ControlAction {
        :>> id = "7d174b9d-3e5c-415c-ae23-41411fc0a54c"; :>> title = "Load / unload / update (BRAT: disable + re-enable) / suspend / resume the plugin - at ANY point of an in-flight operation";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus"; :>> issuedBy = c12HostApp; :>> actsOn = p5LocalRuntime;
    }
    part caPluginRewrite : ControlAction {
        :>> id = "e9cc4f7b-450a-485e-a6b2-cf9465cb0094"; :>> title = "Another plugin rewrites a note (frontmatter timestamp / fileClass normalisation / template expansion) on open, save, or its own timer";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus"; :>> issuedBy = c13OtherPlugins; :>> actsOn = p1LocalVault;
    }
    part caSyncToolWrite : ControlAction {
        :>> id = "d53d0952-2960-45d6-935e-759d8249e703"; :>> title = "Another sync tool writes, rewrites or deletes a file, creates its own conflict copy (`*.sync-conflict-*`, `(conflicted copy)`), or hydrates / dehydrates a placeholder";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus"; :>> issuedBy = c14OtherSyncTools; :>> actsOn = p1LocalVault;
    }
    part caReleasePluginBuild : ControlAction {
        :>> id = "4d9abd9d-7991-4ada-b7de-e57bd52c6f97"; :>> title = "Publish a plugin build (manifest + main.js + styles) that BRAT installs on every device";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus"; :>> issuedBy = c15ReleaseChannel; :>> actsOn = p5LocalRuntime;
    }
    part caReleaseServerImage : ControlAction {
        :>> id = "d10b4381-bd85-4c15-afa4-838e878ff0f4"; :>> title = "Publish a server image the operator deploys - or rolls back over a vault a newer image migrated";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus"; :>> issuedBy = c15ReleaseChannel; :>> actsOn = p2ServerIndex;
    }
    part fbVaultEvents : Feedback {
        :>> id = "793e817c-d434-4de6-9e7d-fc764bf2e4ce"; :>> title = "Host file events (modify / create / delete / rename, exact-case keyed) + raw `.obsidian` adapter events - the plugin's ONLY prompt notice of another authority's write";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus"; :>> reportsTo = c2SyncEngine;
    }
    part fbAppLifecycle : Feedback {
        :>> id = "80f9589a-ab03-4e4f-b62d-6dd441d209bb"; :>> title = "Lifecycle notices from the host: onunload, visibilitychange (resume), onLayoutReady";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus"; :>> reportsTo = c2SyncEngine;
    }
    part fbReleaseAssertion : Feedback {
        :>> id = "b089cdd4-c9dd-4a6e-ae54-fa0fec00328b"; :>> title = "Release assertions (check-release: tagged + published + assets present; check-release-currency: unreleased drift bounded; CI version-sync)";
        :>> createdAt = "2026-09-10"; :>> createdBy = "claudeOpus"; :>> reportsTo = c7Operator;
    }
    #Enforces dependency from c2SyncEngine to sc13;   // detects other writers only through fbVaultEvents; bounds its own echo
}

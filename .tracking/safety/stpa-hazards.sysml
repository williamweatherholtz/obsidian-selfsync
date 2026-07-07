// =====================================================================
// ProjectHazards — STPA STEP 1 (analytical half): system-level Hazards + System Safety
// Constraints for SelfSync. Authored 2026-07-07, completing Step 1 (the Losses + boundary in
// safety.sysml were the inputs; hazards are the first analytical output). Also wires the
// controller RESPONSIBILITY -> SC traces that the Step-2 gate left pending.
//
// A Hazard is a system STATE to be PREVENTED (not a cause or a component) that, in some worst-case
// environment (assumptions A1-A8), leads to a Loss. Form: <system condition> [links to L-n].
// A System Safety Constraint (SC) is the inversion of a hazard, stated as WHAT to enforce, never
// a solution. Trace chain: SC -> Hazard -> Loss, and Controller -> SC (who must enforce it).
// UCAs (Step 3) and loss scenarios (Step 4) remain deferred (D0016).
//
// Edges: #LeadsTo (Hazard -> Loss), #Inverts (SC -> Hazard), #Enforces (Controller -> SC).
// =====================================================================
package ProjectHazards {
    private import EngineElement::*;
    private import EngineSafety::*;
    private import ProjectSafety::*;            // Losses l1..l4
    private import ProjectControlStructure::*;  // Controllers c1..c7

    // ---- Hazards (H-n): preventable system states, each linked to >=1 Loss ----
    part h1 : Hazard {
        :>> id = "c0f1a5cc-c001-4a10-9b20-a1b2c3d4c001";
        :>> title = "H-1: local content removed/overwritten without a superseding authorized change";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "A local copy of a user's content is removed or overwritten though no authorized change has superseded it (e.g. acting on a wrong/empty/restored remote, or resolving a divergence by discarding a side). [L-1]";
    }
    part h2 : Hazard {
        :>> id = "c0f1a5cc-c002-4a10-9b20-a1b2c3d4c002";
        :>> title = "H-2: devices converge on content that drops an authored version with no preserved copy";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "When two devices hold divergent content for a path, the system converges them on one version without preserving the other, so an authored edit is silently dropped (lost update / clobbering merge). [L-1]";
    }
    part h3 : Hazard {
        :>> id = "c0f1a5cc-c003-4a10-9b20-a1b2c3d4c003";
        :>> title = "H-3: content is treated as valid though it does not match its verified hash";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "Stored or served content whose bytes do not match its recorded content hash is accepted as authoritative, so undetected corruption propagates to devices. [L-1]";
    }
    part h4 : Hazard {
        :>> id = "c0f1a5cc-c004-4a10-9b20-a1b2c3d4c004";
        :>> title = "H-4: content or credentials accessible to a principal without an authorizing grant";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "A user's note content, or a credential/token protecting it, is readable by a principal that holds no authorizing grant for it. [L-2]";
    }
    part h5 : Hazard {
        :>> id = "c0f1a5cc-c005-4a10-9b20-a1b2c3d4c005";
        :>> title = "H-5: content from an unauthorized source is applied so it can act on a device";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "Content originating from a source the user did not authorize (e.g. a shared vault's owner) is applied to a device in a form that can execute or take effect there without the user's explicit authorization. [L-3]";
    }
    part h6 : Hazard {
        :>> id = "c0f1a5cc-c006-4a10-9b20-a1b2c3d4c006";
        :>> title = "H-6: system cannot accept or deliver a user's changes for an extended period";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system is unable to accept a user's new changes or deliver changes to their devices for an extended period, and does not make the reason actionable (e.g. a vault stuck unrepairable, or an undiagnosable client/server incompatibility). [L-4]";
    }
    part h7 : Hazard {
        :>> id = "c0f1a5cc-c007-4a10-9b20-a1b2c3d4c007";
        :>> title = "H-7: access to content persists after its authorization is withdrawn";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "A principal continues to reach content (or its change metadata) after the grant that authorized them has been withdrawn or the account removed, or a reused identity inherits a prior principal's residual data. [L-2]";
    }
    part h8 : Hazard {
        :>> id = "c0f1a5cc-c008-4a10-9b20-a1b2c3d4c008";
        :>> title = "H-8: content commingled across isolation domains (accounts / vaults)";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "Content belonging to one isolation domain (an account, or a named vault) appears in another that was not granted it (e.g. two identities collapsing to one store, or a path escaping its vault). [L-1, L-2]";
    }

    #LeadsTo dependency from h1 to l1;
    #LeadsTo dependency from h2 to l1;
    #LeadsTo dependency from h3 to l1;
    #LeadsTo dependency from h4 to l2;
    #LeadsTo dependency from h5 to l3;
    #LeadsTo dependency from h6 to l4;
    #LeadsTo dependency from h7 to l2;
    #LeadsTo dependency from h8 to l1;
    #LeadsTo dependency from h8 to l2;

    // ---- System Safety Constraints (SC-n): inversion of each hazard; WHAT, not how ----
    part sc1 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c101-4a10-9b20-a1b2c3d4c101";
        :>> title = "SC-1: never remove/overwrite local content without a superseding authorized change";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system must not remove or overwrite a local copy of content unless an authorized change has provably superseded it. [H-1]";
    }
    part sc2 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c102-4a10-9b20-a1b2c3d4c102";
        :>> title = "SC-2: preserve every divergent version until resolved";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "When device contents diverge for a path, the system must preserve every divergent version until a user or a defined resolution rule reconciles them. [H-2]";
    }
    part sc3 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c103-4a10-9b20-a1b2c3d4c103";
        :>> title = "SC-3: never treat content as valid unless it matches its verified hash";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system must not write, serve, or adopt content as authoritative unless its bytes match its recorded content hash. [H-3]";
    }
    part sc4 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c104-4a10-9b20-a1b2c3d4c104";
        :>> title = "SC-4: never expose content/credentials to a principal without a grant";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system must not make note content or credentials available to a principal that lacks an authorizing grant. [H-4]";
    }
    part sc5 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c105-4a10-9b20-a1b2c3d4c105";
        :>> title = "SC-5: never let content from an unauthorized source act on a device without explicit authorization";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system must not let content from a source the user did not authorize take effect on a device (e.g. execute as plugin code) without the user's explicit authorization. [H-5]";
    }
    part sc6 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c106-4a10-9b20-a1b2c3d4c106";
        :>> title = "SC-6: remain able to accept/deliver changes, or report why not";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system must remain able to accept and deliver a user's changes; when it cannot, it must surface an actionable reason and a path to recovery. [H-6]";
    }
    part sc7 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c107-4a10-9b20-a1b2c3d4c107";
        :>> title = "SC-7: revoke access when authorization is withdrawn";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system must revoke a principal's access to content and its change metadata when the authorizing grant is withdrawn or the account removed, and must not let a reused identity inherit residual data. [H-7]";
    }
    part sc8 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c108-4a10-9b20-a1b2c3d4c108";
        :>> title = "SC-8: keep isolation domains separated";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system must keep the content of distinct isolation domains (accounts, named vaults) separated, so content of one is never reachable through another. [H-8]";
    }

    #Inverts dependency from sc1 to h1;
    #Inverts dependency from sc2 to h2;
    #Inverts dependency from sc3 to h3;
    #Inverts dependency from sc4 to h4;
    #Inverts dependency from sc5 to h5;
    #Inverts dependency from sc6 to h6;
    #Inverts dependency from sc7 to h7;
    #Inverts dependency from sc8 to h8;

    // ---- Controller responsibility -> SC (the Step-2 gate trace, now unblocked) ----
    // Who is responsible for enforcing each constraint (a controller may share an SC).
    #Enforces dependency from c4Reconciler to sc1;   // delete-local requires a real tombstone
    #Enforces dependency from c5ServerVault to sc1;  // tombstone is the deletion authority
    #Enforces dependency from c4Reconciler to sc2;   // merge / conflict-copy preserves both sides
    #Enforces dependency from c4Reconciler to sc3;   // verify downloaded bytes before adopting
    #Enforces dependency from c5ServerVault to sc3;  // commit verifies size+hash
    #Enforces dependency from c6AccessControl to sc4; // authorize every read
    #Enforces dependency from c4Reconciler to sc5;   // config-apply SEC-3 gate (no shared-vault code auto-run)
    #Enforces dependency from c2SyncEngine to sc6;   // reconnect + version handshake surface actionable state
    #Enforces dependency from c5ServerVault to sc6;  // reindex/repair path
    #Enforces dependency from c7Operator to sc6;     // admin repair of a corrupt/shared vault
    #Enforces dependency from c6AccessControl to sc7; // revoke on grant/account removal (+ WS eviction)
    #Enforces dependency from c6AccessControl to sc8; // per-(owner,vault) authorization boundary
    #Enforces dependency from c5ServerVault to sc8;  // namespace keying + path-safety isolation
}

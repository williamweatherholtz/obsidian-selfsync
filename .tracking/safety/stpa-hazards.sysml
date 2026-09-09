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
        :>> id = "1484b6b9-a334-4679-b2de-d4f2ac581f33";
        :>> title = "H-1: local content removed/overwritten without a superseding authorized change";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "A local copy of a user's content is removed or overwritten though no authorized change has superseded it (e.g. acting on a wrong/empty/restored remote, or resolving a divergence by discarding a side). [L-1]";
    }
    part h2 : Hazard {
        :>> id = "46dfb92e-0924-479a-a918-b349cbbbe4e2";
        :>> title = "H-2: devices converge on content that drops an authored version with no preserved copy";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "When two devices hold divergent content for a path, the system converges them on one version without preserving the other, so an authored edit is silently dropped (lost update / clobbering merge). [L-1]";
    }
    part h3 : Hazard {
        :>> id = "21b3df54-eb0c-44af-a19c-f16ba909543e";
        :>> title = "H-3: content is treated as valid though it does not match its verified hash";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "Stored or served content whose bytes do not match its recorded content hash is accepted as authoritative, so undetected corruption propagates to devices. [L-1]";
    }
    part h4 : Hazard {
        :>> id = "bc0f89d7-61a8-4840-9e1f-7a5a3feb776b";
        :>> title = "H-4: content or credentials accessible to a principal without an authorizing grant";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "A user's note content, or a credential/token protecting it, is readable by a principal that holds no authorizing grant for it. [L-2]";
    }
    part h5 : Hazard {
        :>> id = "2ead3d49-4f12-4d17-8ec4-b845f5305a67";
        :>> title = "H-5: content from an unauthorized source is applied so it can act on a device";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "Content originating from a source the user did not authorize (e.g. a shared vault's owner) is applied to a device in a form that can execute or take effect there without the user's explicit authorization. [L-3]";
    }
    part h6 : Hazard {
        :>> id = "6cae817e-6578-4fb3-8c28-0e6c8247a91b";
        :>> title = "H-6: system cannot accept or deliver a user's changes for an extended period";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system is unable to accept a user's new changes or deliver changes to their devices for an extended period, and does not make the reason actionable (e.g. a vault stuck unrepairable, or an undiagnosable client/server incompatibility). [L-4]";
    }
    part h7 : Hazard {
        :>> id = "2c264633-a7e9-4875-ae47-53e7ca733f8f";
        :>> title = "H-7: access to content persists after its authorization is withdrawn";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "A principal continues to reach content (or its change metadata) after the grant that authorized them has been withdrawn or the account removed, or a reused identity inherits a prior principal's residual data. [L-2]";
    }
    part h8 : Hazard {
        :>> id = "f47071d4-1153-4628-ad16-25cda89aced6";
        :>> title = "H-8: content commingled across isolation domains (accounts / vaults)";
        :>> createdAt = "2026-07-07"; :>> createdBy = "wweatherholtz";
        :>> statement = "Content belonging to one isolation domain (an account, or a named vault) appears in another that was not granted it (e.g. two identities collapsing to one store, or a path escaping its vault). [L-1, L-2]";
    }
    // ---- L-5 deepening (D0036, 2026-08-02): the feedback + connection-lifecycle loops the severity-first
    // pass treated as cosmetic. H-9 is the feedback-truthfulness state; H-10 the recovery-cessation state. ----
    part h9 : Hazard {
        :>> id = "b85b0096-8ae9-499f-8ac9-404e7f19772c";
        :>> title = "H-9: reported sync state does not match the actual system state";
        :>> createdAt = "2026-08-02"; :>> createdBy = "wweatherholtz";
        :>> statement = "The state the plugin reports to the user (status indicator/card + progress) does not match what the system is actually doing — e.g. it indicates synced/idle while it cannot reach the server or is mid-operation, or shows no intelligible progress during a long operation — so the user's understanding diverges from the actual state. [L-5]";
    }
    part h10 : Hazard {
        :>> id = "04c1bb9f-2fce-4d6f-8263-a4e1c988239a";
        :>> title = "H-10: the client ceases recovery of a recoverable connection";
        :>> createdAt = "2026-08-02"; :>> createdBy = "wweatherholtz";
        :>> statement = "The client stops attempting to recover a connection that could succeed (the link is down but the server/network is reachable again), so sync does not resume without manual intervention — while nothing in the reported state signals that it has stopped trying. [L-4, L-5]";
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
    #LeadsTo dependency from h9 to l5;
    #LeadsTo dependency from h10 to l4;
    #LeadsTo dependency from h10 to l5;

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
    part sc9 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c109-4a10-9b20-a1b2c3d4c109";
        :>> title = "SC-9: reported state must match actual state";
        :>> createdAt = "2026-08-02"; :>> createdBy = "wweatherholtz";
        :>> statement = "The state the plugin reports to the user must faithfully reflect the actual system state: it must never indicate success/synced when it is not, and must convey what it is doing — including progress on a long operation — intelligibly. [H-9]";
    }
    part sc10 : SystemSafetyConstraint {
        :>> id = "c0f1a5cc-c10a-4a10-9b20-a1b2c3d4c10a";
        :>> title = "SC-10: keep attempting recovery of a recoverable link";
        :>> createdAt = "2026-08-02"; :>> createdBy = "wweatherholtz";
        :>> statement = "While a connection is down but recoverable, the client must keep attempting recovery — including promptly on a foreground/resume — and its reported state must reflect that it is retrying. [H-10]";
    }

    #Inverts dependency from sc1 to h1;
    #Inverts dependency from sc2 to h2;
    #Inverts dependency from sc3 to h3;
    #Inverts dependency from sc4 to h4;
    #Inverts dependency from sc5 to h5;
    #Inverts dependency from sc6 to h6;
    #Inverts dependency from sc7 to h7;
    #Inverts dependency from sc8 to h8;
    #Inverts dependency from sc9 to h9;
    #Inverts dependency from sc10 to h10;

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
    #Enforces dependency from c2SyncEngine to sc9;   // the status projection (phase = pure fn of the two FSMs) is truthful
    #Enforces dependency from c1User to sc9;         // the display surfaces sync progress; the user reads the true state
    #Enforces dependency from c2SyncEngine to sc10;  // reconnect/backoff + resume re-attempt keep a recoverable link recovering

    // ---- Step 1 refresh, 2026-09-09: hazards the authority inventory exposed (each was LIVED this week before it
    // was named — the case-divergence, the 200 MB freeze, the plugin/sync-tool rewrite loops). ----
    part h11 : Hazard {
        :>> id = "2a7ed975-5834-4c0a-8039-a7ab4129f7e3";
        :>> title = "H-11: the system treats one user artefact as two, or two as one (identity divergence)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "A path whose spelling differs only in ways the user's filesystem does not distinguish (case, Unicode form, trailing dot/space), or content that differs only in ways the user cannot see (frontmatter whitespace, invisible characters), is handled as a DISTINCT file - or two distinct artefacts as ONE - so edits silently stop syncing, phantom conflicts recur on every pass, pushes are refused, or two artefacts are merged. [L-1, L-4, L-5]";
    }
    part h12 : Hazard {
        :>> id = "fd93f786-8a34-4471-a809-cca13f94645b";
        :>> title = "H-12: the plugin renders the host application unresponsive or its own controls unreachable";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "A pass, a read, a hash or a render saturates the host's single main thread, memory or disk I/O (a multi-hundred-MB file decoded as text; hundreds of unstamped binaries hashed at once; a modal whose reads queue behind the pass) so the user cannot work in Obsidian, cannot reach the plugin's own controls, or reads 'broken' where the truth is 'busy'. [L-3, L-4]";
    }
    part h13 : Hazard {
        :>> id = "75f4ae0c-53ba-4190-8bac-073e02d391d8";
        :>> title = "H-13: the plugin acts on a file another authority on the same device is writing or has reshaped";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "The user's editor, another plugin (timestamp stampers, fileClass tooling), another sync tool (Syncthing, a cloud drive) or the OS writes, moves or reshapes a file the plugin is also acting on, so one authority's write is lost or duplicated, a rewrite loop re-triggers on every pass, or a second tool's conflict file is synced as content. [L-1, L-5]";
    }
    part sc11 : SystemSafetyConstraint {
        :>> id = "832a7af4-c005-4644-93a4-16f24734231a";
        :>> title = "SC-11: one file for the user is one file for the plugin";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "The plugin must treat as one file exactly what the user's filesystem treats as one file, and must never let an identity-only difference (case, Unicode form, invisible whitespace in metadata) create, hide or merge a user artefact without telling the user. [H-11]";
    }
    part sc12 : SystemSafetyConstraint {
        :>> id = "c4bb5aa0-d0a4-4260-b0a3-171a4eb4fa93";
        :>> title = "SC-12: the host and the plugin's own controls stay usable during any pass";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "The plugin must bound its use of the host's main thread, memory and I/O on any vault size or file size, never read as text what it cannot diff, and show its state on the controls it gates while it works. [H-12]";
    }
    part sc13 : SystemSafetyConstraint {
        :>> id = "de000ca3-2ca3-4985-913c-9ab0df7c3cf1";
        :>> title = "SC-13: co-exist with other writers of the same files";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "The plugin must detect a concurrent change by another authority before acting on a file, must never overwrite a version another authority produced without preserving it, and must never re-trigger another writer's rewrite loop. [H-13]";
    }
    #LeadsTo dependency from h11 to l1;
    #LeadsTo dependency from h11 to l4;
    #LeadsTo dependency from h11 to l5;
    #LeadsTo dependency from h12 to l3;
    #LeadsTo dependency from h12 to l4;
    #LeadsTo dependency from h13 to l1;
    #LeadsTo dependency from h13 to l5;
    #Inverts dependency from sc11 to h11;
    #Inverts dependency from sc12 to h12;
    #Inverts dependency from sc13 to h13;
    #Enforces dependency from c4Reconciler to sc11;         // path identity (case-aware aliasing, content identity) is the reconciler's
    #Enforces dependency from c2SyncEngine to sc12;         // pass scheduling, busy state, bounded work
    #Enforces dependency from c8ConflictResolver to sc12;   // never reads/diffs what it cannot; gated on busy
    #Enforces dependency from c4Reconciler to sc13;         // racing-edit guards, content identity vs other writers' rewrites

    // ---- Nesting-focused STPA (composed vaults / mounts, D0039), Step 1 additions 2026-09-09. The composition
    // introduces a SCOPE dimension the flat vault never had: every file now belongs to exactly one of the primary
    // scope, a mount scope, or another mount scope, and every action must respect that attribution and the
    // per-mount DIRECTION + GRANT. Two hazards are specific to it. ----
    part h14 : Hazard {
        :>> id = "5e8d872c-5129-440e-9bb0-c7d7681fe046";
        :>> title = "H-14: content attributed to the wrong scope (primary vs mount vs another mount)";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "A file under a mount point is treated as primary-vault content (or vice versa), or one folder is claimed by two scopes, so it is synced to a vault it does not belong to, double-synced, deleted from the wrong source, or synced to nobody — the scope BOUNDARY (the primary excludes every mount point; mount points never nest or overlap) is the load-bearing invariant of composition. [L-1, L-2]";
    }
    part h15 : Hazard {
        :>> id = "e347f14d-253c-4ed4-ba92-aba92d60fb38";
        :>> title = "H-15: a write crosses a mount against its direction or the user's grant";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "A pull (read-only) mount writes, deletes or resurrects content on its source; or a sync mount writes to a source the user's grant no longer (or never) permits — a peer's vault altered by a device that was only meant to read it. [L-1, L-2]";
    }
    part sc14 : SystemSafetyConstraint {
        :>> id = "e2f4c44a-4b20-4959-9348-7774c248b84e";
        :>> title = "SC-14: every file belongs to exactly one scope, decided the way the filesystem decides identity";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "The primary scope must exclude every active mount point and mount points must never nest or overlap, with the boundary compared the way the user's filesystem compares paths (case- and Unicode-folded); each scope must own its own base, cursor and state. [H-14]";
    }
    part sc15 : SystemSafetyConstraint {
        :>> id = "c35f94c5-eaa0-42a7-b66a-8cb1e3b2d5d9";
        :>> title = "SC-15: a mount writes to its source only in its direction and within the user's grant";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> statement = "A pull mount must never commit, delete or upload to its source (refused at the adapter, not only by policy); a sync mount must write only while the user's grant on the source is read-write; configuration and recipes must fail closed to pull. [H-15]";
    }
    #LeadsTo dependency from h14 to l1;
    #LeadsTo dependency from h14 to l2;
    #LeadsTo dependency from h15 to l1;
    #LeadsTo dependency from h15 to l2;
    #Inverts dependency from sc14 to h14;
    #Inverts dependency from sc15 to h15;
    #Enforces dependency from c9MountEngine to sc14;  // per-mount isolation + the primary's exclusion of mount points
    #Enforces dependency from c10MountConfig to sc14; // validity / overlap / nesting decided at configuration
    #Enforces dependency from c9MountEngine to sc15;  // MountedApi hard-refuses writes on a pull mount
    #Enforces dependency from c10MountConfig to sc15; // direction offered only for writable sources; recipes fail closed
}

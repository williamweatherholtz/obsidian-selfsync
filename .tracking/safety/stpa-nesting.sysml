// =====================================================================
// ProjectStpaNesting — STPA Steps 3-4 for the NESTING functionality (composed vaults / mounts, D0039), authored
// 2026-09-09 under the stpa process (owner: "do an STPA focusing on the nesting functionality. be thorough").
// Step 1 additions (H-14/H-15, SC-14/SC-15) live in stpa-hazards.sysml; Step 2 (c9/c10/c11, pmMount, p6-p8, the
// control actions and feedback) in control-structure.sysml. Every UCA here is a hazardous cell of the four guide
// words over the mount engine's and mount configuration's control actions; every scenario is a REAL finding from
// the ten hardening rounds or the mount issue log, with the closing mechanism named; every requirement carries
// #Verify edges from DoDs with a recorded PASS (acceptance.sysml). UCA-41 is an owner-ACCEPTED risk (D0044) and
// is recorded so the acceptance is visible to the analysis.
// =====================================================================
package ProjectStpaNesting {
    private import EngineElement::*;
    private import EngineSafety::*;
    private import ProjectSafety::*;            // losses
    private import ProjectHazards::*;           // hazards h1..h15, constraints sc1..sc15
    private import ProjectControlStructure::*;  // c9-c11, pmMount, p6-p8, ca*, fb*


    part uca27 : UnsafeControlAction {
        :>> id = "675e972a-6cba-4967-aabf-02b1de9358f9"; :>> ucaType = UcaType::notProvided;
        :>> title = "UCA-27: the primary scope fails to exclude a mount folder whose spelling differs only in case/Unicode form";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "A mount point is configured 'Shared/Team'; the folder on disk is 'shared/team' (or NFD vs NFC). validateMounts / primaryExcludes compared exact strings.";
        :>> statement = "Compute-active-mounts does not exclude the folder from the primary scope, so the primary uploads the mounted files into the user's OWN vault while the mount syncs nothing - split-brain across two vaults, and a peer's content copied into a vault it was never granted to. Found R3-H1. [H-14, H-2, L-2]";
    }
    part cc25 : ControllerConstraint { :>> id = "f1662a0c-b329-44be-9689-74dde2398cd0"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-25: compare the scope boundary the way the filesystem does";
        :>> statement = "Boundary decisions (primaryExcludes, claimsLocal, validateMounts) must compare paths segment-wise, NFC- and case-folded, and keep the real spelling only for round-trip."; }

    part uca28 : UnsafeControlAction {
        :>> id = "604737c7-5cb0-4d56-a107-c791bd701782"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-28: a mount scope starts sharing the PRIMARY's base / io / state";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "A caller injects the primary's BaseStore or filtered io into a mount runtime; base paths from two vaults collide.";
        :>> statement = "Mount-start provided with a shared base makes every source file look deleted from the primary (and vice versa) - a phantom mass delete of the SOURCE; a mount over the primary's filtered io dropped mount writes silently and a reconnect delete-remote'd the source. Found issueMountBaseIsolation (C1 HIGH), mountEngine A1 HIGH. [H-1, H-14]";
    }
    part cc26 : ControllerConstraint { :>> id = "9aae2081-3f42-43c2-bcfb-9cabf21d6083"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-26: a mount scope owns its own base, state, cursor, guards and a data-only io";
        :>> statement = "MountRuntime must construct its own BaseStore, SyncState, DeleteRateGuard, retry budget and a mount-scoped data-only io; no caller may inject the primary's."; }

    part uca29 : UnsafeControlAction {
        :>> id = "8312b17a-5e0e-49ab-8368-31e9b656172b"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-29: first contact adopts the source over a DIFFERENT pre-existing local file with no preserved copy";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The user composes a pull mount over a folder that already holds notes; the source has a different version of a same-named note.";
        :>> statement = "Mount-pull provided at first contact via the fresh-share adopt-over-local path overwrote the user's version with no conflict copy - composing over a populated folder is the primary use case. Found R2-F1 HIGH. [H-1, H-2]";
    }
    part cc27 : ControllerConstraint { :>> id = "ae6aa458-b456-4536-8943-92f8845f30c8"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-27: first contact over a populated folder preserves every local divergence";
        :>> statement = "A no-base first-contact divergence inside a mount must keep the local version as a conflict copy and adopt the source, never adopt-over."; }

    part uca30 : UnsafeControlAction {
        :>> id = "3f8069ed-9ae3-4b3a-9243-b5fe3c758b49"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-30: a pull mount, or a mount whose grant is read-only, writes to its source";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "A read-only share is mounted; a reconcile path, a resolver, or a chunk upload reaches the source-bound API.";
        :>> statement = "Mount-push provided against a pull/read-only mount alters a peer's vault the user was only allowed to read - commit, deleteFile or putChunk reaching the source. The rail rested on reconcile policy alone until the adapter hard-refused all three (R5-LOW-1 putChunk). [H-15, H-4]";
    }
    part cc28 : ControllerConstraint { :>> id = "f2311089-f4c5-4ecb-8f7e-f9643c6b2b4f"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-28: the direction rail is enforced at the adapter";
        :>> statement = "MountedApi must hard-refuse commit, deleteFile and putChunk on a pull mount regardless of what reconcile decides; a source grant change must be re-read before any push."; }

    part uca31 : UnsafeControlAction {
        :>> id = "2fef88c7-e922-429a-95e9-16a9a1f93bdc"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-31: a mount deletes local files because a NOT-READY, partial or protocol-incompatible source manifest omitted them";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The source vault is mid-reindex, degraded, or its server is a different protocol version; its manifest is partial.";
        :>> statement = "Mount-pull (delete-local) provided against a degraded manifest removes files the source still holds. Found R4-F4 (readiness), R7-F1 (apiVersion). [H-1]";
    }
    part cc29 : ControllerConstraint { :>> id = "1d879d8f-cdff-40d4-bcfd-d9792aefea9b"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-29: never reconcile a mount against a source that is not ready and compatible";
        :>> statement = "A mount pass must be gated on the source's status()==='ready' and a compatible apiVersion; otherwise the mount is held OFFLINE, never reconciled."; }

    part uca32 : UnsafeControlAction {
        :>> id = "fb5ea4e8-f374-4159-a971-4accdc780acc"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-32: deleting the local mount-point FOLDER propagates as a deletion of the whole source subtree";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The user deletes or moves the mounted folder locally (cleanup, a mis-drag); a sync mount sees every file absent.";
        :>> statement = "Mount-delete-outgoing provided for the entire subtree wipes the SOURCE - possibly another user's vault - from one local gesture. Found issueMountFolderDeletedWipesSource. [H-1]";
    }
    part cc30 : ControllerConstraint { :>> id = "8428cc54-2733-4eb3-96b5-cbaf144ea89c"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-30: a mass local deletion inside a mount is HELD, never propagated";
        :>> statement = "When the mount folder itself vanishes or a mass local deletion is detected, the mount enters localGone and waits for an explicit Reinstate/Remove; nothing is deleted on the source."; }

    part uca33 : UnsafeControlAction {
        :>> id = "9a30d686-ca8e-4d0d-9a86-61bcc505f6f2"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-33: an outgoing deletion is decided from a TRANSIENT or partial local listing";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The adapter returns an empty/partial listing (AV lock, mid-write, unhydrated cloud placeholder); files are still on disk.";
        :>> statement = "Mount-delete-outgoing provided on a false absence deletes source files that exist locally. Found mountDeleteGuardHardening F5 (spurious localGone / false absence). [H-1]";
    }
    part cc31 : ControllerConstraint { :>> id = "8dde9f6f-bdd9-454e-a29e-504183dd1752"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-31: confirm absence before deleting on the source";
        :>> statement = "A path absent from the listing must be re-probed (exists) and treated as present when indeterminate before any delete-remote or mass-deletion hold."; }

    part uca34 : UnsafeControlAction {
        :>> id = "3eed3a4d-ee4d-46ad-8543-a89d66e0466d"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-34: a sync mount resurrects a peer's tombstone-pruned deletion onto the shared source";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "A peer deleted files on the shared source and the tombstones were pruned; this device still has them locally with no base (or a stale base).";
        :>> statement = "Mount-push (keep-and-restore of local-only files) provided re-uploads a whole deleted set to the shared source - the peer's deletion undone fleet-wide. Found issueMountSharedSourceResurrection, R2-F3. [H-2, H-14]";
    }
    part cc32 : ControllerConstraint { :>> id = "5275c776-71dc-42a6-b154-88b194f546ba"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-32: a mass push of local-only files to a SHARED source is held for review";
        :>> statement = "On a noResurrect (shared) source, local-only-new files above the user's threshold are held (reportPushGuard) until the user accepts or keeps them local; a kept set becomes an established local base, never pushed."; }

    part uca35 : UnsafeControlAction {
        :>> id = "289c71f7-dcce-4485-9bcc-7a0fc94c4cf6"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-35: a mount anchored under `.obsidian` moves config or SelfSync's own credentials across the boundary";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "A mount point or source subfolder inside `.obsidian` is configured (hand-edit or UI).";
        :>> statement = "Compute-active-mounts accepting it lets the mount pull another vault's config as data, or read this device's credential data.json and PUSH it to the source. Found R3-H2 HIGH. [H-4, H-5]";
    }
    part cc33 : ControllerConstraint { :>> id = "84c15a14-9a1c-462b-8907-45210c8fc633"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-33: no scope may cross into `.obsidian`";
        :>> statement = "validateMounts must reject any mount point or source subfolder inside `.obsidian` (case-folded), and a mount io must refuse to read or exist-probe a config path - both layers."; }

    part uca36 : UnsafeControlAction {
        :>> id = "a04e966e-4d0b-4f6d-8198-54be1d1643e8"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-36: one invalid mount entry deactivates ALL mounts, and the primary re-absorbs their folders";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "A hand-edited or corrupted entry makes the whole configured set invalid.";
        :>> statement = "Compute-active-mounts with all-or-nothing validity turns every mount dormant at once; the primary scope re-absorbs the mounted folders and uploads source-derived content into the user's own vault. Found R5-MED-3. [H-14, H-8]";
    }
    part cc34 : ControllerConstraint { :>> id = "7804c4a8-d4d8-47d9-bd2b-6b3ce1767682"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-34: an invalid entry drops only itself";
        :>> statement = "The active set is the maximal valid non-overlapping subset; one bad entry never deactivates another."; }

    part uca37 : UnsafeControlAction {
        :>> id = "3a2bedaf-1bc7-432b-b094-3ddd1f30801e"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-37: a mount whose source IS the current primary is started, or reactivated on a stale base";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The user switches the primary onto a vault that is also mounted (or back); while dormant the primary rewrote the folder.";
        :>> statement = "Mount-start provided self-referentially double-syncs one folder into itself; reactivation on the stale persisted base makes reconcile see both sides diverged -> spurious conflict copies. Found R5-LOW-3, R8-F4 / mountBaseFreshness. [H-14, H-2]";
    }
    part cc35 : ControllerConstraint { :>> id = "b1109fcc-9cd2-483a-8b2b-43862348ebeb"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-35: a self-referential mount is dormant and its base is invalidated";
        :>> statement = "A mount of the current primary is excluded from the active set; every repoint invalidates the persisted base of any mount whose source matches, so reactivation re-first-contacts non-destructively."; }

    part uca38 : UnsafeControlAction {
        :>> id = "e31fb521-8884-442a-abd8-d19a939413a7"; :>> ucaType = UcaType::notProvided;
        :>> title = "UCA-38: a mount is not polled, not retried, or its trouble is not shown - composed notes go stale behind a green light";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The primary poll is a no-op; a failed mount sits in `failed`; the status fold has no caller.";
        :>> statement = "Mount-pull NOT provided (skipped on idle polls, never retried after failure) while the light stays 'Fully synced' - notes lag ~15 min or forever with no signal. Found R6-Med-1, R4-F1/F2. [H-9, H-6]";
    }
    part cc36 : ControllerConstraint { :>> id = "f229ea34-63e7-41ff-8110-4c13392d756f"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-36: every mount is driven every cycle and its health is folded into every status surface";
        :>> statement = "Mounts reconcile on every primary cycle including no-op polls; a failed mount retries after backoff; the light, hero and rows show the WORST scope's state and name the mount."; }

    part uca39 : UnsafeControlAction {
        :>> id = "350a4d76-5f18-49e4-8cf4-f46b7d3f751a"; :>> ucaType = UcaType::wrongTimingOrder;
        :>> title = "UCA-39: a mount pass writes the disk of a mount that was just removed, or after the plugin unloaded";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "removeMount or unload races an in-flight detached mount pass.";
        :>> statement = "Mount-pull/push provided after removal/unload mutates a folder that is now ordinary notes (or a torn-down plugin) - and the token-rotation rebuild could keep a dead scope alive with a stale token. Found R1-F2/F3/F4. [H-1, H-14]";
    }
    part cc37 : ControllerConstraint { :>> id = "9f299d40-874c-4c98-a078-0679beb74ff8"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-37: a scope acts only while live";
        :>> statement = "removeMount marks the scope unmounting first; every per-scope step re-checks an isLive predicate (not unmounting, not unloading, still configured, token current) before touching disk or source."; }

    part uca40 : UnsafeControlAction {
        :>> id = "e05f5933-7d2d-414e-9f88-dd46a7fa2fc6"; :>> ucaType = UcaType::notProvided;
        :>> title = "UCA-40: local edits inside a SYNC mount are never pushed back in steady state";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The user edits a note under a sync mount; only the primary's event path fires; the mount is poll-driven.";
        :>> statement = "Mount-push NOT provided until a full scan, so the source (and peers) do not see the edit for up to a scan interval - the sync mount silently behaves as pull. Found issueMountRwPushBack. [H-6]";
    }
    part cc38 : ControllerConstraint { :>> id = "5d6c0032-d670-4f2b-990e-4bc3c48746ea"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-38: a local event under a sync mount nudges that mount's push";
        :>> statement = "A vault file event whose path a sync mount claims triggers that mount's reconcile promptly (nudgeMountForLocalPath), not the primary's."; }

    part uca41 : UnsafeControlAction {
        :>> id = "b13c24a6-42fd-456b-bb51-3d0296dc8996"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-41: moving a file OUT of a sync mount is honored as a deletion from the (possibly shared) source";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The user drags a note from the mounted folder to elsewhere in their vault.";
        :>> statement = "Mount-delete-outgoing provided for a MOVE removes the file from the source for every peer. ACCEPTED AS-IS by the owner (D0044: leaving the folder IS leaving the shared set; COPY is the gesture that keeps it) - recorded so the accepted risk is visible to the analysis, not silently absent. [H-1]";
    }
    part cc39 : ControllerConstraint { :>> id = "a9cb52f3-abef-4c02-8a34-fb098cb1f229"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-39: the move-out semantics are explicit to the user";
        :>> statement = "The mount UI must state that moving a file out of a sync mount removes it from the source (D0044), and the outgoing delete stays exact and immediate (D0043) with the receiving side's bulk-delete confirmation as the peers' net."; }

    part uca42 : UnsafeControlAction {
        :>> id = "c038ebe1-858e-40da-bee3-4a83ed91712f"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-42: an imported recipe applies a mount beyond the recipient's grant or over an existing mount";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "A recipe pasted from another user names a source the recipient holds read-only (or not at all), or a local folder that overlaps their mounts.";
        :>> statement = "Apply-recipe provided as-is would create a sync mount the grant does not permit, or an overlapping mount. composeRecipe applies only within the recipient's own grants, fails closed to pull, and validates overlap. [H-15, H-14]";
    }
    part cc40 : ControllerConstraint { :>> id = "dfb0e742-4e84-4dc9-887d-1c81f0d616ba"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-40: a recipe is a proposal reviewed against the recipient's own grants";
        :>> statement = "Import plans each mount against the recipient's grants (Sync only where read-write; foreign sources default to pull), never carries credentials, and is validated like any configured set."; }

    part uca43 : UnsafeControlAction {
        :>> id = "452ec9c9-6d71-47cd-9660-65a45239f7e9"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-43: a mount buffers a huge source file in memory on a mobile device";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "A multi-hundred-MB attachment in the source; mobile has no streamed writer and buffers whole files x FILE_CONCURRENCY.";
        :>> statement = "Mount-pull provided for an over-size file exhausts the WebView's memory and crashes Obsidian. Found R6-Med-2. [H-12]";
    }
    part cc41 : ControllerConstraint { :>> id = "ca757dd8-d2d6-4c82-a729-08cc870aaed9"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-41: a mount's per-file size cap is bounded to what the device can hold";
        :>> statement = "On mobile a mount's maxSyncBytes is clamped (50 MiB); larger files are skipped and reported, never buffered."; }

    part uca44 : UnsafeControlAction {
        :>> id = "54739131-ceec-424c-a5b6-59cc4c36d689"; :>> ucaType = UcaType::wrongTimingOrder;
        :>> title = "UCA-44: a held-review resolver mutates a mount's base while a pass over the same base is in flight";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The user accepts/keeps a held bulk push or delete from the settings tab while the poll-driven mount pass runs.";
        :>> statement = "Mount-push/keep provided from a UI callback interleaves with the pass's own base mutations (or hits a rebuilt, orphaned base) - lost or duplicated decisions. Found issueMountHeldResolverSerialization. [H-1]";
    }
    part cc42 : ControllerConstraint { :>> id = "3d8e411d-e45b-46ed-8f62-dc27a80e0589"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-42: base mutations on a scope are serialized with its passes";
        :>> statement = "Held-review resolvers and keepRoMountEdits run under the same mutex as the mount pass and re-resolve the scope's live deps inside the lock."; }

    part uca45 : UnsafeControlAction {
        :>> id = "7621a5d1-3e25-4ddf-ad0b-df169f91b4f6"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-45: a mount keeps reconciling incrementally after the source's version REWOUND";
        :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> context = "The source vault is reindexed or restored; its version epoch rewinds below the mount's cursor.";
        :>> statement = "Mount-pull provided as a delta from a cursor the source no longer knows leaves the mount stale (or acting on a nonsense delta). Found R9-C. [H-9, H-6]";
    }
    part cc43 : ControllerConstraint { :>> id = "3dc8ac66-afa5-4320-9aab-247777d06dd1"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "C-43: a source version rewind forces a full re-pull";
        :>> statement = "delta.version < cursor routes the mount through the engine reset to a full reconcile of the subtree."; }

    #Analyzes dependency from uca27 to caComputeActiveMounts;
    #Causes dependency from uca27 to h14;
    #Causes dependency from uca27 to h2;
    #Inverts dependency from cc25 to uca27;
    #Analyzes dependency from uca28 to caMountStart;
    #Causes dependency from uca28 to h1;
    #Causes dependency from uca28 to h14;
    #Inverts dependency from cc26 to uca28;
    #Analyzes dependency from uca29 to caMountPull;
    #Causes dependency from uca29 to h1;
    #Causes dependency from uca29 to h2;
    #Inverts dependency from cc27 to uca29;
    #Analyzes dependency from uca30 to caMountPush;
    #Causes dependency from uca30 to h15;
    #Causes dependency from uca30 to h4;
    #Inverts dependency from cc28 to uca30;
    #Analyzes dependency from uca31 to caMountPull;
    #Causes dependency from uca31 to h1;
    #Inverts dependency from cc29 to uca31;
    #Analyzes dependency from uca32 to caMountDeleteOutgoing;
    #Causes dependency from uca32 to h1;
    #Inverts dependency from cc30 to uca32;
    #Analyzes dependency from uca33 to caMountDeleteOutgoing;
    #Causes dependency from uca33 to h1;
    #Inverts dependency from cc31 to uca33;
    #Analyzes dependency from uca34 to caMountPush;
    #Causes dependency from uca34 to h2;
    #Causes dependency from uca34 to h14;
    #Inverts dependency from cc32 to uca34;
    #Analyzes dependency from uca35 to caComputeActiveMounts;
    #Causes dependency from uca35 to h4;
    #Causes dependency from uca35 to h5;
    #Inverts dependency from cc33 to uca35;
    #Analyzes dependency from uca36 to caComputeActiveMounts;
    #Causes dependency from uca36 to h14;
    #Causes dependency from uca36 to h8;
    #Inverts dependency from cc34 to uca36;
    #Analyzes dependency from uca37 to caMountStart;
    #Causes dependency from uca37 to h14;
    #Causes dependency from uca37 to h2;
    #Inverts dependency from cc35 to uca37;
    #Analyzes dependency from uca38 to caMountPull;
    #Causes dependency from uca38 to h9;
    #Causes dependency from uca38 to h6;
    #Inverts dependency from cc36 to uca38;
    #Analyzes dependency from uca39 to caMountPull;
    #Analyzes dependency from uca39 to caMountPush;
    #Causes dependency from uca39 to h1;
    #Causes dependency from uca39 to h14;
    #Inverts dependency from cc37 to uca39;
    #Analyzes dependency from uca40 to caMountPush;
    #Causes dependency from uca40 to h6;
    #Inverts dependency from cc38 to uca40;
    #Analyzes dependency from uca41 to caMountDeleteOutgoing;
    #Causes dependency from uca41 to h1;
    #Inverts dependency from cc39 to uca41;
    #Analyzes dependency from uca42 to caApplyRecipe;
    #Causes dependency from uca42 to h15;
    #Causes dependency from uca42 to h14;
    #Inverts dependency from cc40 to uca42;
    #Analyzes dependency from uca43 to caMountPull;
    #Causes dependency from uca43 to h12;
    #Inverts dependency from cc41 to uca43;
    #Analyzes dependency from uca44 to caMountPush;
    #Causes dependency from uca44 to h1;
    #Inverts dependency from cc42 to uca44;
    #Analyzes dependency from uca45 to caMountPull;
    #Causes dependency from uca45 to h9;
    #Causes dependency from uca45 to h6;
    #Inverts dependency from cc43 to uca45;

    part s22 : LossScenario { :>> id = "93d2bcd6-1f7c-4bdb-a4f4-502215756176"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate process model (paths compared exact-case while the filesystem folds case)";
        :>> title = "S-22: a re-capitalised mount folder leaked into the primary vault";
        :>> statement = "The boundary compare was exact-string; on a case-insensitive filesystem a case-drifted mount folder was not excluded from the primary scope, so the primary uploaded a peer's mounted content into the user's own vault while the mount synced nothing (split-brain). Closed R3-H1 by segment-wise NFC + case-folded matching; SC-14."; }
    #Explains dependency from s22 to uca27;
    #LeadsTo dependency from s22 to h14;
    #Senses dependency from s22 to fbMountFolderEvents;
    part s23 : LossScenario { :>> id = "4b6e00ba-d00d-466a-aab6-dcd2c79bffad"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (the primary's base/io reused by a second scope)";
        :>> title = "S-23: a mount scope constructed over the primary's base";
        :>> statement = "Before MountRuntime owned its isolation structurally, a mount could be assembled over the primary's BaseStore and filtered io: base paths from two vaults collided so the source looked mass-deleted, and mount writes were silently dropped while a reconnect delete-remote'd the source. Closed by construction (own base/state/guards, data-only io) - mountEngineCore + mountEngine A1."; }
    #Explains dependency from s23 to uca28;
    #LeadsTo dependency from s23 to h1;
    part s24 : LossScenario { :>> id = "fa1dc78b-cee4-4bdc-b205-ec23a3ebf1d3"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (the read-only fresh-share path reused for a populated folder)";
        :>> title = "S-24: composing a pull mount over existing notes destroyed the local versions";
        :>> statement = "readOnly first contact took the adopt-over-local path meant for a fresh share; a pre-existing different local note was overwritten with no copy. Closed R2-F1 by preserveLocalFirstContact -> readOnlyKeepCopy."; }
    #Explains dependency from s24 to uca29;
    #LeadsTo dependency from s24 to h1;
    part s25 : LossScenario { :>> id = "ec815ac4-8db6-4fd8-9c1d-a2dacb9a999e"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate feedback (the status fold existed but had no caller)";
        :>> title = "S-25: a dead mount under a green 'Fully synced'";
        :>> statement = "mountfsm's fold and mountStatusSummary were never called from the light, and a failed scope never retried, so a silently offline/failed pull mount left composed notes stale behind a green indicator. Closed R4-F1/F2 (fold wired into effectiveLightPhase + backoff retry) and R10 (hero + rows)."; }
    #Explains dependency from s25 to uca38;
    #LeadsTo dependency from s25 to h9;
    #Senses dependency from s25 to fbMountStatus;
    part s26 : LossScenario { :>> id = "e4834187-7c71-4245-92f2-d86ebeb4d059"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate process model (a vanished folder indistinguishable from many deleted files)";
        :>> title = "S-26: deleting the mounted folder would have wiped the source";
        :>> statement = "A sync mount whose local folder was deleted saw every file absent and would have propagated the whole subtree as deletions to a shared source from one local gesture. Closed by the localGone hold (mountFolderDeleteGuard) + the false-absence re-probe (mountDeleteGuardHardening)."; }
    #Explains dependency from s26 to uca32;
    #LeadsTo dependency from s26 to h1;
    #Senses dependency from s26 to fbMountFolderEvents;
    part s27 : LossScenario { :>> id = "8871ec8c-3074-4f19-ad7e-5c1b0cec56ba"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate process model (a persisted base that went stale while the scope was dormant)";
        :>> title = "S-27: switching the primary onto a mounted source and back produced spurious conflicts";
        :>> statement = "A mount of the current primary is dormant; the primary rewrites its folder; on switching back the mount restored the stale base and saw both sides diverged. Closed by mountBaseFreshness (invalidate self-referential bases on every repoint)."; }
    #Explains dependency from s27 to uca37;
    #LeadsTo dependency from s27 to h2;
    part s28 : LossScenario { :>> id = "b4945448-d2bf-4182-a241-9cb32c1462ab"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (mounts driven only from a non-idle primary pass)";
        :>> title = "S-28: composed notes lagged ~15 minutes behind the source";
        :>> statement = "reconcileAllOnce returned at mode 'noop' before reconcileMounts, so a source change did not pull until the primary changed or the 15-min full scan. Closed R6-Med-1 (mounts on the noop branch) and later the per-mount live subscription + socket recycle."; }
    #Explains dependency from s28 to uca38;
    #LeadsTo dependency from s28 to h6;
    #Senses dependency from s28 to fbSourceChanges;
    part s29 : LossScenario { :>> id = "9a0878fd-ecdc-434c-bb43-3d11ec50840a"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (no per-device resource bound on a buffered pull)";
        :>> title = "S-29: a mount buffered a 200 MB file into a mobile WebView";
        :>> statement = "The single-maxSyncMB refactor dropped the mobile cap; a mount with no streamed writer buffered whole files up to the desktop default and could OOM Obsidian mobile. Closed R6-Med-2 (50 MiB clamp for mounts on mobile)."; }
    #Explains dependency from s29 to uca43;
    #LeadsTo dependency from s29 to h12;
    part s30 : LossScenario { :>> id = "3b967622-f6f8-4b56-b483-82738d1c3fb8"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> causalFactor = "inadequate control algorithm (lifecycle race: remove/unload vs an in-flight detached pass)";
        :>> title = "S-30: a removed mount's folder written by the pass already in flight";
        :>> statement = "removeMount dropped the scope but a detached pass already running still mutated the folder (now ordinary notes) and, after unload, the vault. Closed R1-F3/F4 (unmounting first; isLive re-checked per scope; deferred re-run suppressed on unload)."; }
    #Explains dependency from s30 to uca39;
    #LeadsTo dependency from s30 to h1;

    part sr29 : SafetyRequirement { :>> id = "ea172c73-d90d-4053-a5b5-a3deb7328b32"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-29: each mount is an isolated scope and the primary excludes every active mount point, boundary compared as the filesystem does";
        :>> statement = "A mount runtime owns its own base, state, cursor, guards and data-only io; the primary scope excludes every active mount point; all boundary comparisons are segment-wise, NFC- and case-folded.";
        :>> triggeringEvent = "any composition; a case/Unicode-drifted mount folder";
        :>> safeState = "no folder belongs to two scopes; no shared base";
        :>> safetyFunction = "MountRuntime isolation by construction; primaryExcludes/claimsLocal/validateMounts folded compare"; }
    #Mitigates dependency from sr29 to uca27;
    #Mitigates dependency from sr29 to uca28;
    #Satisfies dependency from sr29 to sc14;
    #RealizedBy dependency from sr29 to c9MountEngine;
    #RealizedBy dependency from sr29 to c10MountConfig;
    part sr30 : SafetyRequirement { :>> id = "f3ffac02-8155-447b-bd64-3987cc5817bc"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-30: a pull mount never writes to its source; a sync mount writes only within a read-write grant";
        :>> statement = "MountedApi hard-refuses commit, deleteFile and putChunk on a pull mount; a sync mount is offered and kept only while the user's grant on the source is read-write.";
        :>> triggeringEvent = "any write attempt on a read-only source";
        :>> safeState = "the source untouched; the local edit kept and reported";
        :>> safetyFunction = "MountedApi write refusal; direction offered only for writable sources; composedMountPermissions rail"; }
    #Mitigates dependency from sr30 to uca30;
    #Satisfies dependency from sr30 to sc15;
    #RealizedBy dependency from sr30 to c9MountEngine;
    #RealizedBy dependency from sr30 to c10MountConfig;
    part sr31 : SafetyRequirement { :>> id = "f16d3407-296b-4e41-ae24-5ccf131fcc7b"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-31: first contact over a populated folder preserves every divergent local version";
        :>> statement = "A no-base first-contact divergence inside a mount keeps the local version as a conflict copy and adopts the source; nothing is adopted over.";
        :>> triggeringEvent = "composing a mount over an existing folder";
        :>> safeState = "both versions on disk";
        :>> safetyFunction = "preserveLocalFirstContact -> readOnlyKeepCopy"; }
    #Mitigates dependency from sr31 to uca29;
    #Satisfies dependency from sr31 to sc2;
    #RealizedBy dependency from sr31 to c9MountEngine;
    part sr32 : SafetyRequirement { :>> id = "ab0434c6-9962-4a2a-a9c9-42ab6093f882"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-32: a mount reconciles only against a READY, protocol-compatible source";
        :>> statement = "Before a first-contact or reconnect pass the mount probes the source's status and apiVersion; a not-ready or incompatible source holds the mount OFFLINE.";
        :>> triggeringEvent = "source mid-reindex / degraded / version skew";
        :>> safeState = "mount offline, no disk mutation";
        :>> safetyFunction = "sourceReady() + versionVerdict gate"; }
    #Mitigates dependency from sr32 to uca31;
    #Satisfies dependency from sr32 to sc1;
    #Satisfies dependency from sr32 to sc3;
    #RealizedBy dependency from sr32 to c9MountEngine;
    part sr33 : SafetyRequirement { :>> id = "14b2d251-c11d-4e35-a40a-d47756c924f2"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-33: a mass local deletion inside a mount is held, and absence is confirmed before any outgoing delete";
        :>> statement = "The mount-folder-gone / mass-deletion case enters localGone and waits for Reinstate/Remove; a listing-absent path is re-probed and treated present when indeterminate.";
        :>> triggeringEvent = "mount folder deleted or a transient listing";
        :>> safeState = "nothing deleted on the source";
        :>> safetyFunction = "massLocalDeletion hold + exists re-probe"; }
    #Mitigates dependency from sr33 to uca32;
    #Mitigates dependency from sr33 to uca33;
    #Satisfies dependency from sr33 to sc1;
    #RealizedBy dependency from sr33 to c9MountEngine;
    part sr34 : SafetyRequirement { :>> id = "dd324437-8031-44b9-9176-0712106b2bea"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-34: no scope crosses into `.obsidian`";
        :>> statement = "Mount points and source subfolders inside `.obsidian` are rejected at configuration (case-folded), and a mount io refuses to read or exist-probe a config path.";
        :>> triggeringEvent = "a config-anchored mount is configured or hand-edited";
        :>> safeState = "mount inactive; credentials never read";
        :>> safetyFunction = "validateMounts + ObsidianVaultIo mount-io refusal"; }
    #Mitigates dependency from sr34 to uca35;
    #Satisfies dependency from sr34 to sc4;
    #Satisfies dependency from sr34 to sc5;
    #Satisfies dependency from sr34 to sc8;
    #RealizedBy dependency from sr34 to c10MountConfig;
    #RealizedBy dependency from sr34 to c9MountEngine;
    part sr35 : SafetyRequirement { :>> id = "c57b04d9-ccbc-40b2-af44-5e1a9c03d549"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-35: a mount's health is visible on every status surface";
        :>> statement = "The status light, the settings hero and each mount row show the WORST scope's state and name the mount; `diverged` is reachable on a mounted conflict.";
        :>> triggeringEvent = "a mount offline / failed / diverged";
        :>> safeState = "the user sees which mount and why";
        :>> safetyFunction = "effectiveLightPhase fold + hero + live rows + tookConflict"; }
    #Mitigates dependency from sr35 to uca38;
    #Satisfies dependency from sr35 to sc9;
    #RealizedBy dependency from sr35 to c9MountEngine;
    part sr36 : SafetyRequirement { :>> id = "46bf9a3e-79a8-477f-92af-4271af08fa55"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-36: a mount's lifecycle changes only through its state machine, and a removed or unloading scope is never written";
        :>> statement = "mountMachine (fsm.ts) is the only lifecycle writer; removeMount marks unmounting first; each per-scope step re-checks isLive before disk or source.";
        :>> triggeringEvent = "remove/unload racing an in-flight pass";
        :>> safeState = "the pass skips the scope";
        :>> safetyFunction = "mountMachine + isLive predicate"; }
    #Mitigates dependency from sr36 to uca39;
    #Satisfies dependency from sr36 to sc14;
    #RealizedBy dependency from sr36 to c9MountEngine;
    part sr37 : SafetyRequirement { :>> id = "86b87487-093f-4feb-ad5b-a522f63429bf"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-37: a composition recipe applies only within the recipient's own grants and never carries credentials";
        :>> statement = "Import plans each mount against the recipient's grants (Sync only where read-write, foreign sources default to pull), validates overlap, and the codec never encodes a token, password or login.";
        :>> triggeringEvent = "a pasted recipe";
        :>> safeState = "only permitted, non-overlapping mounts added";
        :>> safetyFunction = "composition-recipe planner + review modal"; }
    #Mitigates dependency from sr37 to uca42;
    #Satisfies dependency from sr37 to sc15;
    #Satisfies dependency from sr37 to sc14;
    #RealizedBy dependency from sr37 to c10MountConfig;
    part sr38 : SafetyRequirement { :>> id = "5098e37d-9882-4147-aa98-0039828839ba"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-38: base mutations on a mount scope are serialized with its passes";
        :>> statement = "Held-review resolvers and keepRoMountEdits run under the same mutex as the mount reconcile pass and re-resolve the live deps inside the lock.";
        :>> triggeringEvent = "a settings-tab review action during a pass";
        :>> safeState = "one mutation at a time on a live base";
        :>> safetyFunction = "mountWork mutex + runScopeExclusive"; }
    #Mitigates dependency from sr38 to uca44;
    #Satisfies dependency from sr38 to sc1;
    #RealizedBy dependency from sr38 to c9MountEngine;
    part sr39 : SafetyRequirement { :>> id = "b50efa20-ccd3-47ac-b63b-8272a5a2e450"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-39: an invalid entry drops only itself; a self-referential mount is dormant and its base is invalidated on every repoint";
        :>> statement = "validMounts yields the maximal valid non-overlapping subset; a mount of the current primary is excluded; every repoint invalidates the persisted base of a matching mount.";
        :>> triggeringEvent = "a bad entry, or a switch onto/off a mounted source";
        :>> safeState = "other mounts unaffected; reactivation re-first-contacts non-destructively";
        :>> safetyFunction = "validMounts + activeMounts exclusion + invalidateSelfReferentialMountBases"; }
    #Mitigates dependency from sr39 to uca36;
    #Mitigates dependency from sr39 to uca37;
    #Satisfies dependency from sr39 to sc14;
    #Satisfies dependency from sr39 to sc2;
    #RealizedBy dependency from sr39 to c10MountConfig;
    #RealizedBy dependency from sr39 to c9MountEngine;
    part sr40 : SafetyRequirement { :>> id = "91712cf1-eab9-4f2e-a31e-5c87850bf4be"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-40: every mount is driven every cycle, recovers from failure, follows its source live, and re-pulls fully after a source rewind";
        :>> statement = "Mounts reconcile on every primary cycle including no-op polls; a failed scope retries after backoff; a healthy mount holds a live source subscription recycled against half-open sockets; delta.version < cursor forces a full re-pull.";
        :>> triggeringEvent = "a source change, a failure, a rewind";
        :>> safeState = "composed notes current within the poll/subscription latency";
        :>> safetyFunction = "reconcileMounts on noop; failedAt backoff; syncMountSubscriptions + recycle; rewind -> reset"; }
    #Mitigates dependency from sr40 to uca38;
    #Mitigates dependency from sr40 to uca45;
    #Satisfies dependency from sr40 to sc6;
    #Satisfies dependency from sr40 to sc10;
    #RealizedBy dependency from sr40 to c9MountEngine;
    part sr41 : SafetyRequirement { :>> id = "ba0ff0b4-f390-40ca-9db8-520867fd0baf"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-41: a mount's per-file memory use is bounded to the device";
        :>> statement = "On mobile a mount's maxSyncBytes is clamped to 50 MiB; a larger source file is skipped and reported, never buffered.";
        :>> triggeringEvent = "a huge attachment in the source on a phone";
        :>> safeState = "file skipped, notice shown";
        :>> safetyFunction = "mobile clamp in the mount runtime"; }
    #Mitigates dependency from sr41 to uca43;
    #Satisfies dependency from sr41 to sc12;
    #RealizedBy dependency from sr41 to c9MountEngine;
    part sr42 : SafetyRequirement { :>> id = "fa5acbb9-4535-4b0a-b013-5f28cc08557d"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-42: a peer's deletion is never resurrected onto a shared source without the user's review";
        :>> statement = "On a shared (noResurrect) source a mass push of local-only files is held for review, and a source deletion-history reset is detected and handled as on the primary.";
        :>> triggeringEvent = "local-only files on a shared source after a peer deleted them";
        :>> safeState = "the set is held; the user decides";
        :>> safetyFunction = "F2 bulk-push guard + mount reset detection"; }
    #Mitigates dependency from sr42 to uca34;
    #Satisfies dependency from sr42 to sc2;
    #Satisfies dependency from sr42 to sc14;
    #RealizedBy dependency from sr42 to c9MountEngine;
    part sr43 : SafetyRequirement { :>> id = "19abdcdf-3475-4313-a60d-0431cb28d4ea"; :>> createdAt = "2026-09-09"; :>> createdBy = "claudeOpus";
        :>> title = "SR-43: a local change under a sync mount reaches its source promptly, and move-out semantics are explicit";
        :>> statement = "A vault event under a sync mount nudges that mount's push; the UI states that moving a file out of a sync mount removes it from the source (D0044) while the outgoing delete stays exact (D0043).";
        :>> triggeringEvent = "an edit or a move under a sync mount";
        :>> safeState = "peers see the edit; the user knows what a move does";
        :>> safetyFunction = "nudgeMountForLocalPath + mountMoveSafety wording"; }
    #Mitigates dependency from sr43 to uca40;
    #Mitigates dependency from sr43 to uca41;
    #Satisfies dependency from sr43 to sc6;
    #RealizedBy dependency from sr43 to c9MountEngine;
    #RealizedBy dependency from sr43 to c10MountConfig;

    // ---- 2026-09-11 architecture panel (composed-vault critic + SE): cells the ten hardening rounds had NOT closed.
    // Each is fixed in sprint mountScopeBoundaryHardening (1.30.18); the #Verify edges land with its DoD. ----

    part uca58 : UnsafeControlAction {
        :>> id = "8ff4780c-01ab-4968-82f1-cb9f9563584c"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-58: the primary reconciles a just-unmounted (or just-mounted) subtree against a base FROZEN while the mount owned it";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "While a folder is mounted the primary skips its paths (accepts=false), so its base entries under the mount point keep their pre-mount values; on remove the primary owns the folder again and compares the MOUNT's content / deletions against that frozen base.";
        :>> statement = "Push-file / delete-remote provided by the primary over the frozen base: a file the mount changed reads as a plain local edit → pushed over the primary's own copy with no conflict copy; a file the mount removed reads as a local deletion → delete-remote'd from the primary vault, fleet-wide. Found by the panel (CV1). [H-1, H-14]";
    }
    part cc56 : ControllerConstraint { :>> id = "a4856b8c-d6ac-47d8-bfcc-fba4ab2cfc4e"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-56: a scope boundary crossing forgets the other scope's base";
        :>> statement = "Adding or removing a mount purges the primary's base entries under the mount point, so the primary re-first-contacts the subtree (no base ⇒ a divergence is a conflict copy, an absence is nothing)."; }

    part uca59 : UnsafeControlAction {
        :>> id = "79b0ab47-2a30-419e-92d3-851bf619a5d8"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-59: the primary uploads a mounted subtree after its FOLDER was renamed or moved";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "The user renames/moves the mount-point folder (or an ancestor). The mount holds localGone (its folder is gone); the primary no longer excludes the new path.";
        :>> statement = "Push-file provided by the primary for every file under the renamed folder — a peer's whole mounted subtree copied into the user's own vault on every device by one drag (H-14 by gesture; UCA-32 covered deletion only). Found by the panel (CV2). [H-14]";
    }
    part cc57 : ControllerConstraint { :>> id = "800218b9-f0d2-47f6-957f-3e85d4f54fb7"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-57: the mount point follows its folder";
        :>> statement = "A rename of the mount-point folder (or an ancestor) moves the mount definition with it when the destination is a valid mount point; otherwise the mount is left as it was and the user is told."; }

    part uca60 : UnsafeControlAction {
        :>> id = "e2ff5f03-d5d7-4aa8-8c43-c709e0c12d69"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-60: a note dragged INTO a pull mount is tombstoned on the primary and stranded where no scope can upload it";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "The user moves a note from the primary into a read-only mounted folder.";
        :>> statement = "Delete-remote provided for the old path (a move is a delete there) while the new path belongs to a pull mount that never pushes — the only copy sits in a folder no scope uploads, and the notice called it an 'edit that won't sync back'. Found by the panel (CV3). [H-6, H-9]";
    }
    part cc58 : ControllerConstraint { :>> id = "598bdf41-bd0e-4d4d-9ece-054cda587442"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-58: a move into a pull mount is said plainly";
        :>> statement = "The user is told that the note has left the primary vault (other devices will remove it) and will not be uploaded anywhere, with the two ways back."; }

    part uca61 : UnsafeControlAction {
        :>> id = "7ed5c934-913e-4274-869b-969c90831364"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-61: a Sync mount keeps pushing after the source's grant was downgraded mid-session";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "The write grant on a shared source is read at connect; the owner downgrades it to read-only during the session.";
        :>> statement = "Mount-push provided per file, each refused 403, while the mount reports 'In sync' (per-file isolation lands the pass live) — the edits are neither uploaded nor kept as read-only edits. Found by the panel (CV4). [H-15, H-9]";
    }
    part cc59 : ControllerConstraint { :>> id = "72f03ce6-cd7e-436f-b941-8156a582b04a"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-59: a refused write re-reads the grant";
        :>> statement = "A 401/403 on a mount write re-reads the source grants immediately; the read-only rail follows on the next pass and the edit is kept and shown as a read-only edit."; }

    part uca62 : UnsafeControlAction {
        :>> id = "4586d3ce-a8e2-4563-8360-786cf15b73f5"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-62: a mount lifecycle state is written outside its machine";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "Three direct `scope.state = …` assignments (localGone, diverged/live after a pass, failed→detached, unmounting) sat beside mountTransition().";
        :>> statement = "Mount-start / mount-pull provided under a state the machine's table has no edge into — the table the analysis reads (SR-36) was not the table the code ran, so Step 6's guarantee was false for mounts. Found by the panel (CV5) and the SE critic. [H-9]";
    }
    part cc60 : ControllerConstraint { :>> id = "dbc9c0c1-674d-4553-af25-d25ef5a1849e"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-60: one writer for the mount lifecycle";
        :>> statement = "Every mount state write goes through mountTransition(); the machine carries localGone / conflict / reset edges; a source grep in the conformance test forbids literal state assignment."; }

    part uca63 : UnsafeControlAction {
        :>> id = "0e680b52-7279-444c-aa39-0111635a4f6f"; :>> ucaType = UcaType::provided;
        :>> title = "UCA-63: a mount's direction is set to Sync while the source grant is read-only";
        :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> context = "The user (or a hand-edit) flips a shared read-only source's mount to `sync`.";
        :>> statement = "Set-mount-direction provided against a read grant: every push 403s and the read-only UX is lost — the rail must key on the GRANT, not the user-editable direction. The composedMountPermissions rail (direction offered only for writable sources; mountSourceReadOnly per pass) closes it; recorded so the control action is analysed, not silent (SE3). [H-15]";
    }
    part cc61 : ControllerConstraint { :>> id = "007313d8-5a7f-4356-b1a9-aee4e2191b9c"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "C-61: direction cannot exceed the grant";
        :>> statement = "Sync is offered only for sources the account may write; the read-only rail is evaluated per pass from the grant, whatever the direction says."; }

    #Analyzes dependency from uca58 to caMountRemove;
    #Analyzes dependency from uca58 to caMountStart;
    #Causes dependency from uca58 to h1;
    #Causes dependency from uca58 to h14;
    #Analyzes dependency from uca59 to caPushFile;
    #Causes dependency from uca59 to h14;
    #Analyzes dependency from uca60 to caDeleteRemote;
    #Causes dependency from uca60 to h6;
    #Causes dependency from uca60 to h9;
    #Analyzes dependency from uca61 to caMountPush;
    #Causes dependency from uca61 to h15;
    #Causes dependency from uca61 to h9;
    #Analyzes dependency from uca62 to caMountStart;
    #Causes dependency from uca62 to h9;
    #Analyzes dependency from uca63 to caSetMountDirection;
    #Causes dependency from uca63 to h15;
    #Inverts dependency from cc56 to uca58;
    #Inverts dependency from cc57 to uca59;
    #Inverts dependency from cc58 to uca60;
    #Inverts dependency from cc59 to uca61;
    #Inverts dependency from cc60 to uca62;
    #Inverts dependency from cc61 to uca63;

    part sr52 : SafetyRequirement { :>> id = "fb033c2f-df7f-4009-b66a-0eebe95f0d88"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-52: the primary forgets a mounted subtree's base at both boundary crossings, the mount point follows its folder, and a move into a pull mount is said plainly";
        :>> statement = "addMount and removeMount purge the primary's base entries under the mount point; a rename of the mount-point folder or an ancestor moves the mount (refused + explained when the destination is invalid); a note moved into a pull mount raises a notice naming what happened and the ways back.";
        :>> triggeringEvent = "a mount added or removed; the mount folder renamed; a note dragged into a pull mount";
        :>> safeState = "no silent overwrite or phantom delete-remote on unmount; the primary never sees a mounted subtree; the user knows a moved note left the vault";
        :>> safetyFunction = "forgetPrimaryBaseUnder + followMountPointRename + noteMoveIntoPullMount (main.ts)"; }
    part sr53 : SafetyRequirement { :>> id = "80482e4f-99e2-4b3d-90f8-20bab8704044"; :>> createdAt = "2026-09-11"; :>> createdBy = "claudeOpus";
        :>> title = "SR-53: a mount's write rail follows the LIVE grant, and its lifecycle has one writer";
        :>> statement = "A refused mount write (401/403) re-reads the source grants at once so the read-only rail flips on the next pass; every mount state write goes through mountTransition(), whose table carries localGone / conflict / reset, enforced by a source grep in fsm-conformance.";
        :>> triggeringEvent = "a grant downgraded mid-session; any lifecycle write";
        :>> safeState = "edits kept + shown as read-only edits, never lost in 403s; the table the analysis reads is the table the code runs";
        :>> safetyFunction = "onFileError grant refresh (main.ts) + mountMachine edges + the SR-36 grep guard"; }
    #Mitigates dependency from sr52 to uca58;
    #Mitigates dependency from sr52 to uca59;
    #Mitigates dependency from sr52 to uca60;
    #Mitigates dependency from sr53 to uca61;
    #Mitigates dependency from sr53 to uca62;
    #Mitigates dependency from sr53 to uca63;
    #Satisfies dependency from sr52 to sc14;
    #Satisfies dependency from sr52 to sc2;
    #Satisfies dependency from sr53 to sc15;
    #Satisfies dependency from sr53 to sc14;
    #RealizedBy dependency from sr52 to c9MountEngine;
    #RealizedBy dependency from sr52 to c10MountConfig;
    #RealizedBy dependency from sr53 to c9MountEngine;
    #RealizedBy dependency from sr53 to c10MountConfig;
    #Verify dependency from composedMountPermissionsDoD to sr53; // the grant-keyed rail (UCA-63) was already verified there

}

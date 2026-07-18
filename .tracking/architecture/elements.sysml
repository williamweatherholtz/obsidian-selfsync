// =====================================================================
// ProjectCodeElements — the authored code-element registry (D0029, architecture-audit).
// Seeded 2026-07-18 with elements already audited in rounds 1-2 (they carry a real
// // @audit-hash codeHash). criticality, coupling (Ca/Ce/instability/distance-from-
// main-sequence) and drift are COMPUTED VIEWS (keel arch ...), never authored here.
// PRIMARY lens = invariantSafety + coupling; `pattern` is a descriptive tag only;
// stpaRole/actions/#Controls/#Feedback are captured INPUTS for the later STPA process.
// This is the SEED (proves the model end-to-end); the full file-by-file registry is
// the follow-on ("focus on each element").
// =====================================================================
package ProjectCodeElements {
    private import EngineElement::*;
    private import EngineCodeAudit::*;
    private import EngineRelationships::*;

    part ceDecide : CodeElement {
        :>> id = "c4eabebf-4ba1-44f6-b992-b32be111ce65";
        :>> title = "decide — reconcile 3-way truth table";
        :>> createdAt = "2026-07-18";
        :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts";
        :>> name = "decide";
        :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:1ae58db0a0f63902";
        :>> auditRound = "r1";
        :>> auditedAt = "2026-07-17";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Decides push/pull/merge/delete for every path; a wrong verdict is a data-integrity event. But it is a PURE total function of (local,base,remote) hashes — the hazard lives in the Reconciler's USE of it against a possibly-stale base, not here.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Total over its input space (Presence x Presence x Presence); never silently clobbers when both sides changed (divergence -> merge/conflict-copy). Exemplary functional core.";
        :>> pattern = DesignPattern::functionalCoreImperativeShell;
        :>> stpaRole = StpaRole::channel; // pruned pure function per control-structure.sysml (no process model, no unsafe freedom)
    }

    part ceVaultCommit : CodeElement {
        :>> id = "d796514d-63a6-4c51-8f00-f58c1872adbd";
        :>> title = "Vault::commit — durable file commit (CAS + chunk GC)";
        :>> createdAt = "2026-07-18";
        :>> createdBy = "ai";
        :>> file = "server/src/vault.rs";
        :>> name = "commit";
        :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:49bebda97232adf1"; // NB: this hash is the api::commit handler; Vault::commit will get its own on re-audit (seed placeholder from the audited commit path)
        :>> auditRound = "r1";
        :>> auditedAt = "2026-07-17";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "The single durable-write path; an atomicity or ordering error loses or corrupts an acked commit. Highest-consequence write on the server.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Durability ordering (index put = all-or-nothing boundary; version advanced only after Ok; mirror after durable index; deref'd chunks touched-not-removed to dodge the rename/dedup TOCTOU). Runtime-enforced (SQLite tx + explicit ordering), not type-enforced.";
        :>> pattern = DesignPattern::singleWriter;
        :>> stpaRole = StpaRole::controlledProcess; // the vault index/store it mutates
    }
    part ceReconcilePath : CodeElement {
        :>> id = "652f0c49-8037-4339-abe1-f24757ab81aa";
        :>> title = "reconcilePath — single-path event reconcile";
        :>> createdAt = "2026-07-18";
        :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts";
        :>> name = "reconcilePath";
        :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:e9a08a0dfa9d3dbf";
        :>> auditRound = "r2";
        :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "The live-editing event path; a bad decision here can delete-remote/delete-local a real file (the false-absence + coalesce-stale-size classes both lived here). Highest data-loss exposure on the client.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "confirmedAbsent + live-stat gate + per-pass ratio guard are runtime checks; the deletion decision is not yet type-enforced. Candidate for tightening (a Presence type that can't be forged from a failed read).";
        :>> pattern = DesignPattern::functionalCoreImperativeShell;
        :>> stpaRole = StpaRole::controller; // holds a belief (base) about state it doesn't own; can act wrongly toward a Loss
        :>> actions = "delete-remote, delete-local, pull, push, conflict-copy";
    }

    part ceContentStorePut : CodeElement {
        :>> id = "0344e688-3926-485d-a0ec-c319e5bd6e88";
        :>> title = "ContentStore::put — content-addressed blob write";
        :>> createdAt = "2026-07-18";
        :>> createdBy = "ai";
        :>> file = "server/src/chunkstore.rs";
        :>> name = "put";
        :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:d32e5537318339bd";
        :>> auditRound = "r2";
        :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "An acked commit references chunks this wrote; a non-durable write loses committed content on power loss (the missing-dir-fsync defect, now fixed).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "content-address verified before store; atomic temp+rename+fsync(file)+fsync(dir). Durability is runtime-ordered, not type-enforced.";
        :>> pattern = DesignPattern::singleWriter;
        :>> stpaRole = StpaRole::channel; // content-addressed + verified => correct-by-construction transfer, a pruned channel
    }

    part ceSyncEngineHandle : CodeElement {
        :>> id = "ed37dc68-57a4-4732-bf2e-127e6aaedc7e";
        :>> title = "SyncEngine.handle — per-event state machine step";
        :>> createdAt = "2026-07-18";
        :>> createdBy = "ai";
        :>> file = "client/src/syncengine.ts";
        :>> name = "handle";
        :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:2c9ea45b2a8cd0de";
        :>> auditRound = "r2";
        :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::concurrency;
        :>> riskRationale = "The run-to-completion processor; a state/transition error re-introduces the redial-vs-reconnect race class (two live recovery paths).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "single `running` guard + coalescing enforce one processor; states are a string union, not a typestate (a typestate would make illegal transitions uncompilable — a tightening target).";
        :>> pattern = DesignPattern::serializedActor;
        :>> stpaRole = StpaRole::controller;
        :>> actions = "connect, reconcile, rews, failToOffline, teardown";
    }

    part ceSharesAuthorized : CodeElement {
        :>> id = "b07298fb-8bc5-437f-ba87-aed4d4905bc6";
        :>> title = "ShareStore::authorized — the access-control decision";
        :>> createdAt = "2026-07-18";
        :>> createdBy = "ai";
        :>> file = "server/src/shares.rs";
        :>> name = "authorized";
        :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:a91a0ea7965ba55a";
        :>> auditRound = "r2";
        :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The single authZ choke-point for every vault operation; a wrong verdict is cross-tenant data exposure. Highest security consequence on the server.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Fail-closed by construction: exhaustive match, None => false, a Read grant strictly gates Access::Write; the Perm(stored) vs Access(requested) two-enum split prevents category confusion at compile time. Exemplary.";
        :>> pattern = DesignPattern::makeIllegalStatesUnrepresentable;
        :>> stpaRole = StpaRole::controller; // guards the controlled process (vault); a wrong belief (grant) reaches a Loss
        :>> actions = "authorize, deny";
    }

    // ---- Frontier tranche 1 (High criticality: dataLoss client reconcile core + security server core) ----

    part ceReconcileOne : CodeElement {
        :>> id = "614e4fec-eeff-42da-900c-5a683eece8a5";
        :>> title = "reconcileOne — per-path reconcile dispatcher";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "reconcileOne"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:4ed0f4047d933671"; :>> auditRound = "r1"; :>> auditedAt = "2026-07-17";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "The per-path action executor: every destructive op (delete-local/delete-remote/overwrite) flows through its switch. A wrong branch or a defeated guard is direct data loss.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Decision itself is via the pure decide(); the destructive arms are runtime-guarded (accepts() gate, size gate, C1 present-but-unreadable guard, tombstone requirement, confirmedAbsent). Not type-enforced — a Presence type that can't be forged from a failed read would raise it to typeEnforced.";
        :>> pattern = DesignPattern::functionalCoreImperativeShell;
        :>> stpaRole = StpaRole::controller;
        :>> actions = "in-sync, push, pull, delete-local, delete-remote, merge, conflict-copy";
    }
    part ceReconcileAll : CodeElement {
        :>> id = "69018203-065d-417d-a23b-69ae30732217";
        :>> title = "reconcileAll — whole-vault reconcile + bulk-delete guard";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "reconcileAll"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:fb0b9b96ab1e061a"; :>> auditRound = "r1"; :>> auditedAt = "2026-07-17";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "The full-scan authority: carries the bulk-delete guard against a partial/empty server manifest and the cursor-hold. A guard error here mass-deletes across every device.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "runDeleteGuard (per-pass ratio OR cumulative DeleteRateGuard) + isolatedPass error isolation + advanceCursor assign-not-max — all runtime-enforced.";
        :>> stpaRole = StpaRole::controller;
        :>> actions = "reconcile-all, bulk-delete-guard, advance-cursor";
    }
    part ceReconcileDelta : CodeElement {
        :>> id = "cb92b57a-d81b-43b1-993e-a40459390e5e";
        :>> title = "reconcileDelta — incremental poll reconcile";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "reconcileDelta"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:92e22edf2ccacce6"; :>> auditRound = "r1"; :>> auditedAt = "2026-07-17";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Applies server tombstones on the hot poll path; the C1 locallyPresent guard MUST be supplied here or a transient-unreadable file is mis-decided as deleted (a fixed keystone bug).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Shares runDeleteGuard + isolatedPass + advanceCursor with reconcileAll (B1 DRY); supplies locallyPresent via io.exists.";
        :>> stpaRole = StpaRole::controller;
        :>> actions = "apply-delta, apply-tombstone, bulk-delete-guard";
    }
    part ceConfirmedAbsent : CodeElement {
        :>> id = "bee8920d-670f-4342-bbfc-e9d5e5ff3fd0";
        :>> title = "confirmedAbsent — positive-absence probe";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "confirmedAbsent"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:7d0b8fc8d35871fa"; :>> auditRound = "r1"; :>> auditedAt = "2026-07-17";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "The gate that decides whether a delete-remote may fire; a false 'absent' tombstones a still-present file fleet-wide (the false-absence class).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Boundary discipline: returns true only on POSITIVE evidence (io.exists false, or a read confirming null); ANY uncertainty (throw / no probe) => false (never tombstone on doubt). Exemplary parse-don't-validate of 'is it gone'.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::sensor; // senses on-disk presence for the reconcile controller
    }
    part ceScoped : CodeElement {
        :>> id = "d1340cfc-19a2-479f-bfe0-db69856d40a0";
        :>> title = "scoped — per-request authZ + vault resolution";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/api.rs"; :>> name = "scoped"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:b16af38af5dbfcb2"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Every sync route funnels through here for authorization + vault handle; a bypass is cross-tenant access. The isolation choke-point.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Delegates the decision to the (type-enforced) authorized(); adds vault_exists gating + a spawn_blocking open (audited to return Internal not 404 on a real open error). The guard sequencing is runtime.";
        :>> stpaRole = StpaRole::controller; // guards the vault controlled process
        :>> actions = "authorize, resolve-vault, deny";
    }
    part ceSafeRelPath : CodeElement {
        :>> id = "d4e61225-d5a9-4f48-a54e-06d4eda06dd7";
        :>> title = "safe_rel_path — path-traversal validator";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vault.rs"; :>> name = "safe_rel_path"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:ede8d8e63bba9c77"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Turns an untrusted client path into a safe on-disk rel path; a bypass is arbitrary-file write/read outside the vault.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Textbook parse-don't-validate: returns Option<PathBuf>; per-component Normal-only + `..`/absolute/control-char/reserved-name rejects PLUS a canonical round-trip equality (segs.join('/')==path) that rejects the whole //, ./, separator-alias class. A None can't be misused.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::channel; // pure total validator — pruned
    }
    part ceAppStateVault : CodeElement {
        :>> id = "85c0a7d8-e46e-4375-a3ca-5223ea5bbe5c";
        :>> title = "AppState::vault — per-(user,vault) handle open + cache";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/state.rs"; :>> name = "vault"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:3153864cf1eeed07"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::concurrency;
        :>> riskRationale = "Concurrent first-access to one cold vault must open it EXACTLY once; a race opens it twice → SQLITE_BUSY → a corrupt handle can win the cache → every op 503s (the double-open race). Also enforces per-user isolation of handles.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Per-key open mutex + double-checked cache (correct DCL); the per-key `opens` lock is now bounded (release-when-last-holder). Runtime-enforced concurrency; not type-level.";
        :>> stpaRole = StpaRole::controller;
        :>> actions = "open, cache-hit, evict, serialize-open";
    }

    // ---- coupling (#DependsOn) + STPA-input (#Controls/#Feedback) edges ----
    #DependsOn dependency from ceReconcileOne to ceDecide;             // reconcileOne dispatches on decide()
    #DependsOn dependency from ceReconcileOne to ceConfirmedAbsent;    // delete-remote gate
    #DependsOn dependency from ceReconcileAll to ceReconcileOne;       // per-file executor
    #DependsOn dependency from ceReconcileDelta to ceReconcileOne;
    #DependsOn dependency from ceReconcilePath to ceReconcileOne;
    #DependsOn dependency from ceReconcilePath to ceDecide;
    #DependsOn dependency from ceScoped to ceSharesAuthorized;         // scoped delegates the authZ decision
    #Controls dependency from ceScoped to ceVaultCommit;              // scoped gates access to the vault write path
    #Controls dependency from ceReconcilePath to ceVaultCommit;       // issues commit/delete control actions
    #Controls dependency from ceReconcileOne to ceVaultCommit;
    #Feedback dependency from ceContentStorePut to ceVaultCommit;     // reports store success/failure upward
    #Feedback dependency from ceConfirmedAbsent to ceReconcileOne;    // presence signal feeds the decision

    part ceIdxPut : CodeElement {
        :>> id = "0acdeb3f-a29d-437e-9b6c-e3c13ca7e0aa";
        :>> title = "SqliteIndex::put â€” upsert file version + decref";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "put"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:d9b96f7e95318082"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Upserts a file version + its chunk list and returns now-unreferenced chunks (drives blob GC); an atomicity or decref error loses data or leaks/over-GCs chunks.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Single SQLite tx (all-or-nothing); version-monotonic MAX guard; decref via shared dereferenced_after (old captured before insert, EXISTS probed after). Runtime, not type-enforced.";
        :>> pattern = DesignPattern::singleWriter;
        :>> stpaRole = StpaRole::controlledProcess;
    }
    part ceIdxChanges : CodeElement {
        :>> id = "27ecfe99-de30-4031-ab17-f313aae4de2d";
        :>> title = "SqliteIndex::changes â€” since-delta / full manifest";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "changes"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:8503eabaf0ab8b16"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Produces the upsert+tombstone manifest clients reconcile against; a wrong/incomplete manifest mis-syncs every device.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Batched JOIN groups chunks by path (seq order); output identical to the old per-row path. Version indexes keep it O(changed).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceIdxDelete : CodeElement {
        :>> id = "aa3a0374-28b4-4232-b9c9-08cb4014ad3c";
        :>> title = "SqliteIndex::delete â€” tombstone + decref";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "delete"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:1f738781736ce5a2"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Removes a file row, records a tombstone, returns unreferenced chunks; a mis-decref leaks or drops shared blobs.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Single tx; presence signalled by DELETE rows-affected (no redundant EXISTS); shared dereferenced_after (empty keep).";
        :>> pattern = DesignPattern::singleWriter;
        :>> stpaRole = StpaRole::controlledProcess;
    }
    part ceIdxReplaceFiles : CodeElement {
        :>> id = "44378463-4f8d-419c-a71b-b7f59872184f";
        :>> title = "SqliteIndex::replace_files â€” reindex rebuild";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "replace_files"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:bfc01846bd4b3019"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Atomically replaces all file rows on reindex; must PRESERVE the deletions table or a rebuild resurrects tombstoned files.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Single tx; deliberately keeps deletions + MAX version bump; shared insert_file (fold single-sourced).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controlledProcess;
    }
    part ceIdxCollidingKey : CodeElement {
        :>> id = "aa51c919-42f8-4379-a652-cb961a92b0c3";
        :>> title = "SqliteIndex::colliding_key â€” fold-collision guard";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "colliding_key"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:bf81af5026ff1dab"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Detects a case/Unicode-fold collision commit uses to refuse a path that would collapse to another on a folding FS (a phantom-deletion vector).";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "fold=?1 AND path<>?2 LIMIT 1 + .optional(); the stored `fold` column reuses the same to_lowercase as the write path (soundness rests on that lockstep).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceIdxFileMeta : CodeElement {
        :>> id = "fc518f26-14d5-4236-8d24-799d659ad456";
        :>> title = "SqliteIndex::file_meta â€” single-path lookup";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "file_meta"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:1ce4a047e7add330"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Reads one file's meta; the idempotent-commit + CAS checks depend on it being accurate.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Row -> typed FileMeta via row_to_meta; .optional() distinguishes absent from error.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceIdxPruneTombstones : CodeElement {
        :>> id = "3db65f16-8458-4fd6-8f61-81cb5701bfde";
        :>> title = "SqliteIndex::prune_tombstones â€” history prune";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "prune_tombstones"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:e3f019cedc48ba94"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Operator prune drops tombstones below a floor + raises history_floor; a wrong floor loses deletion history a client needs to converge.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Single tx; caller clamps floor to [current,version]; D0019 horizon semantics.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controlledProcess;
    }
    part ceIdxSetHistoryFloor : CodeElement {
        :>> id = "e8eab45e-7097-4f97-94ad-40a2972c0a22";
        :>> title = "SqliteIndex::set_history_floor â€” floor raise";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "set_history_floor"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:faef17bd70514536"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Raises the persisted history floor (drives client reset detection D0019); a spurious bump causes false 'history reset' churn.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Simple persisted meta write; only reindex-of-empty-index raises it (had_tombstones guard lives in the caller).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controlledProcess;
    }
    part ceIdxAllRefChunks : CodeElement {
        :>> id = "42147639-4b7e-49b0-99ee-5d80da2bf80e";
        :>> title = "SqliteIndex::all_referenced_chunks â€” GC input";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "all_referenced_chunks"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:066e8870a7886dfd"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The referenced-set that reindex/GC diffs against to reclaim blobs; an omission GCs a live chunk (missing-chunk on reboot).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "SELECT DISTINCT chunk -> Vec; total read of the reference relation.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceIdxOpen : CodeElement {
        :>> id = "c15eb628-ed7a-4aa0-b7cd-82707177b094";
        :>> title = "SqliteIndex::open â€” open / migrate / quarantine";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/index_store.rs"; :>> name = "open"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:ace861ef0ee76098"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Opens the index, runs migrations, and classifies corruption; a mis-classification either quarantines a healthy index or trusts a corrupt one.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "synchronous=FULL WAL, busy_timeout; migrate() reaches for a distinct ErrorKind so callers can branch on corruption.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controlledProcess;
    }

    part ceVaultReindex : CodeElement {
        :>> id = "c077dacc-d9a5-4d02-921b-71be63e82498";
        :>> title = "Vault::reindex â€” rebuild index from disk/store";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vault.rs"; :>> name = "reindex"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:c7d1371832230237"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "The whole-vault recovery path; a mis-classification drops a recoverable file or resurrects a tombstoned ghost, or rebuilds from a stale mirror.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "classify -> guard -> re-materialize -> rebuild -> publish -> GC; tombstone ghost-skip, prefer-store-over-stale-mirror, DI-4 no-silent-drop (abort-unless-force). Runtime-ordered.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceVaultVerifyGc : CodeElement {
        :>> id = "373a76ee-3ac8-42a5-8bd8-785388ece7e5";
        :>> title = "Vault::verify_and_gc â€” corruption + orphan detect";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vault.rs"; :>> name = "verify_and_gc"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:4c3f48c80b6b140e"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Classifies the index as healthy/dangling/corrupt on open and reclaims orphans; a wrong verdict trusts a corrupt index or quarantines a healthy one.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Distinguishes dangling-chunk auto-repair (intact rows) from true corruption so the tombstone ghost-skip + prefer-store guards stay active.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceVaultCollectFiles : CodeElement {
        :>> id = "27cbe621-d408-4192-a3b4-e8a2896b3bc0";
        :>> title = "collect_files â€” recursive vault walk";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vault.rs"; :>> name = "collect_files"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:805e2c9e124e52ab"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Enumerates on-disk files for reindex; an omission mis-classifies a present file as missing.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Recursive dir walk into (rel,abs) pairs; sorted for deterministic version assignment.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceVaultWriteMirror : CodeElement {
        :>> id = "8526ceff-2ce1-47aa-aa05-de64f7f3b2b5";
        :>> title = "write_mirror â€” atomic bind-mount mirror write";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vault.rs"; :>> name = "write_mirror"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:9b123875ab886113"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Writes the bind-mount mirror; a torn/zero-length mirror is ingested as authoritative if the index is ALSO lost.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "R14-DI4 atomic temp -> fsync(file) -> rename -> fsync(dir); best-effort (the store is the authority).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceVaultClassifyMissing : CodeElement {
        :>> id = "bb0be39f-4a80-4618-8b3a-74aebdc2c290";
        :>> title = "classify_missing â€” recovered vs lost";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vault.rs"; :>> name = "classify_missing"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:9af7628b72c978cf"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Splits index-present-disk-absent files into recoverable (reassemble+verify from store) vs lost; a false 'recovered' launders corruption into authoritative state.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Returns (key,meta,VERIFIED body) or lost; hash-verifies before calling a file recovered.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceVaultConflicting : CodeElement {
        :>> id = "6022d5d3-1c32-43f4-b16a-606cb44ea842";
        :>> title = "conflicting_or_unsafe_rels â€” reindex key guard";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vault.rs"; :>> name = "conflicting_or_unsafe_rels"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:d90167b763f614b4"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Rejects reindex keys that are unsafe or fold-collide (would mint a phantom-deletion collision).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Whole-path to_lowercase matches commit's colliding_key fold; within-batch scope for a full rebuild.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceVaultDelete : CodeElement {
        :>> id = "5623c0ae-84c7-4cb8-a6c3-965cc3380e65";
        :>> title = "Vault::delete â€” delete path + tombstone";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vault.rs"; :>> name = "delete"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:3f932351b032f42e"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Deletes a file, records a tombstone, mirror-removes; must delete by RAW key (legacy invalid names) or a client's delete 404-loops forever.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Durable-before-mirror-removal; delete-by-exact-key regardless of name validity; mirror removal quiet on NotFound.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controlledProcess;
    }
    part ceCsSweepOrphans : CodeElement {
        :>> id = "fdc99599-99c7-4946-b5e8-55a234588597";
        :>> title = "ContentStore::sweep_orphans â€” runtime orphan GC";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/chunkstore.rs"; :>> name = "sweep_orphans"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:15289dcc8215b6ab"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Reclaims unreferenced blobs; a premature reclaim drops a chunk about to be committed (missing-chunk on reboot).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Fail-safe age gate (mtime error -> spared); safe under the read lock (commit holds the write lock). Correct concurrency reasoning.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceCsGet : CodeElement {
        :>> id = "64a4d1ba-6d15-4273-9121-f5e1ad5217fa";
        :>> title = "ContentStore::get â€” read a blob";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/chunkstore.rs"; :>> name = "get"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:3404e574371e5963"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Serves chunk bytes for reassembly; caller content-verifies, so a wrong blob is caught downstream.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Returns Option<Vec<u8>> (absent vs error distinguished).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceCsHas : CodeElement {
        :>> id = "c15ff372-3e43-4aa7-803f-3a0d65f01aa3";
        :>> title = "ContentStore::has â€” presence check";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/chunkstore.rs"; :>> name = "has"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:cb0b9e7b5db8b29c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Backs the missing() dedup; a wrong 'has' would skip an upload of an absent chunk (caught by commit's 404).";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure existence check -> bool.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceCsRemove : CodeElement {
        :>> id = "bcab82dd-e16b-4284-a686-c28e2fdd115b";
        :>> title = "ContentStore::remove â€” reclaim a blob";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/chunkstore.rs"; :>> name = "remove"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:4b8b12db3871059a"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Physically drops a blob; only called for chunks the durable index no longer references (publish-then-GC ordering).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Best-effort remove; the ordering guarantee lives in the caller (index put before GC).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceCsTouch : CodeElement {
        :>> id = "967777aa-12d5-44ae-8bde-6d17ad98b723";
        :>> title = "ContentStore::touch â€” TTL bump (GC deferral)";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/chunkstore.rs"; :>> name = "touch"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:d2bb47eb12b525ed"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Bumps a de-referenced chunk's mtime so the sweep's TTL measures age-since-orphaned â€” the rename/dedup TOCTOU dodge.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Best-effort mtime touch; underpins the touch-not-remove decref discipline.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceCsListHashes : CodeElement {
        :>> id = "34cf4b5f-1592-42f0-8249-351721562236";
        :>> title = "ContentStore::list_hashes â€” enumerate blobs";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/chunkstore.rs"; :>> name = "list_hashes"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:9f1cb15dc0ef4efb"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The on-disk blob set the startup GC diffs against the referenced set.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Two-level shard walk -> Vec (valid-hash filtered).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceCsOpen : CodeElement {
        :>> id = "22afa15e-f11f-48fc-bc84-c62677073903";
        :>> title = "ContentStore::open â€” open + temp sweep";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/chunkstore.rs"; :>> name = "open"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:f26cf725dc7b8cc0"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::durability;
        :>> riskRationale = "Opens the store and reclaims leaked temp files from interrupted puts.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "sweep_temp on open reclaims .tmp.* left by a crashed rename.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceChunkerChunk : CodeElement {
        :>> id = "0041b0f3-3f86-466e-9a43-68605b2f8f2a";
        :>> title = "chunker::chunk â€” content-defined chunking";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/chunker.rs"; :>> name = "chunk"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:110eec4c914d9ee4"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Splits bytes into content-defined chunks; MUST match the client chunker byte-for-byte or dedup breaks + a large file stores as one blob.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure total function; pinned to the client by a byte-for-byte golden-parity test.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
}

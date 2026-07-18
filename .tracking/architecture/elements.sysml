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

    part ceAuthLogin : CodeElement {
        :>> id = "391ee4a3-d672-46e3-801b-96a0a85a2529";
        :>> title = "auth::login â€” credential + MFA login handler";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/auth.rs"; :>> name = "login"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:a8ce63b72108e87c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The internet-facing front door; a flaw is account takeover. Must not leak user existence via timing and must enforce lockout + MFA.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "dummy-hash timing-oracle defense (absent user does equal argon2 work); login throttle; must_change gate; TOTP second factor. Runtime-enforced.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAuthRegister : CodeElement {
        :>> id = "e64094f5-63d6-435d-ad29-06ab88e3ac7e";
        :>> title = "auth::register â€” account creation handler";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/auth.rs"; :>> name = "register"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:a4ac280fec8b47e1"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Creates accounts; must enforce the invite/registration policy + password policy or it's open registration / weak creds.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Registration policy + validate_password_policy + argon2 on the blocking pool.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAuthLogout : CodeElement {
        :>> id = "3cce15b7-a648-41ec-8234-58c8dc536ec6";
        :>> title = "auth::logout â€” session revoke handler";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/auth.rs"; :>> name = "logout"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:671d24cfa5c26c26"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Server-side session termination; a no-op leaves a revoked device authenticated.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Resolves + revokes the bearer token; audited.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceAuthChangePassword : CodeElement {
        :>> id = "42cf3cbc-d013-43ff-8d00-84c5e88590fe";
        :>> title = "auth::change_password â€” self-service change";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/auth.rs"; :>> name = "change_password"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:c033e6d572ce3fc5"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Changes a password, checks reuse history, and REVOKES other sessions; a flaw allows reuse or leaves stale sessions live.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Verifies current (argon2), is_password_reused cap, rotate + revoke-others, returns a fresh token.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAuthPolicy : CodeElement {
        :>> id = "0f479fcd-a573-44fb-83ab-79f03a8e12c0";
        :>> title = "validate_password_policy â€” strength gate";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/auth.rs"; :>> name = "validate_password_policy"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:b3bf1cfffc2c0c1d"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The password-strength predicate; too weak admits guessable creds.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Length + composition (or long-passphrase) -> Result; total predicate at the boundary.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::channel;
    }
    part ceTokIssueTtl : CodeElement {
        :>> id = "756fdad1-120d-47c2-9bee-b831fb264659";
        :>> title = "TokenStore::issue_ttl â€” mint session token";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/tokens.rs"; :>> name = "issue_ttl"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:c66dfc930b683a85"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Mints a bearer token with absolute expiry; a weak token or wrong TTL is a session-security failure.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Random token, hashed at rest; absolute + idle expiry enforced in resolve.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceTokRevoke : CodeElement {
        :>> id = "2b08838a-9d12-47c2-868d-ce5f455c5964";
        :>> title = "TokenStore::revoke â€” single-session revoke";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/tokens.rs"; :>> name = "revoke"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:2bdbae5ef78e25a2"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Revokes one session; idempotent so an unknown token is a no-op success.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Removes the hashed token; persists.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceTokRevokeUser : CodeElement {
        :>> id = "5873c3c0-0137-48c4-b118-7f40c77e797b";
        :>> title = "TokenStore::revoke_user â€” revoke all sessions";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/tokens.rs"; :>> name = "revoke_user"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:94b69c392737d7c7"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Revokes every session for a user (account delete / password change); a miss leaves live sessions.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Drops all of a user's hashed tokens at once.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceUsersVerifyPassword : CodeElement {
        :>> id = "be6515f3-2c0c-491b-976c-c43987cbb642";
        :>> title = "verify_password â€” argon2 verify";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/users.rs"; :>> name = "verify_password"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:ea53cc5315a924fb"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The password check; free-standing SO the caller runs it on spawn_blocking (never blocks the async worker).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Parses the stored PHC then Argon2::verify_password; total over (phc,password).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceUsersRegister : CodeElement {
        :>> id = "a337cc8e-e033-4118-bfd5-021861887325";
        :>> title = "UserStore::register â€” persist a new user";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/users.rs"; :>> name = "register"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:4f81f97ed44dd68c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Persists a user with an argon2id hash; a weak hash config or plaintext leak is catastrophic.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "argon2id PHC at rest; name validated by safe_name.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceUsersSetPassword : CodeElement {
        :>> id = "13808d5b-148c-4e21-ad5e-c19a933dc52f";
        :>> title = "UserStore::set_password â€” rotate hash";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/users.rs"; :>> name = "set_password"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:0551702c1fb101ec"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Rotates the stored hash; feeds reuse history.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "New argon2id PHC; history append (reuse cap enforced by caller).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceUsersVerify : CodeElement {
        :>> id = "447f8f7d-f874-43ac-b9ad-e614d3a7a0b8";
        :>> title = "UserStore::verify â€” test-only convenience";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/users.rs"; :>> name = "verify"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:ec95aa4b7d4c6f2c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Test-only helper (tests/sync.rs); NOT on the production auth path (which uses phc_for + verify_password on spawn_blocking).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Same dummy-hash timing discipline as the live path; kept for tests.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceUsersSafeName : CodeElement {
        :>> id = "8aa4ac0d-ca3b-4a83-af86-5c7a87fdb2e0";
        :>> title = "safe_name â€” user/vault name validator";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/users.rs"; :>> name = "safe_name"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:4f87225c0efe9eda"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Gates every user/vault name that becomes a filesystem path segment / namespace key; a bypass is path traversal / namespace collision.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Parse-don't-validate: total predicate rejecting unsafe names before they reach the FS.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::channel;
    }
    part ceUsersTotpVerify : CodeElement {
        :>> id = "00485e29-d1e8-43ed-b2f9-c35bdbb11fb7";
        :>> title = "totp_verify_second_factor â€” MFA verify + replay guard";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/users.rs"; :>> name = "totp_verify_second_factor"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:4a22b70c9b727ad6"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The MFA second-factor check; a replay window or accepted stale code weakens MFA.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "RFC6238 verify_step + a last-step replay guard (reject a code from a consumed step) + single-use recovery codes.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceTotpVerifyStep : CodeElement {
        :>> id = "16f9ce40-27aa-4161-b85a-4ad2b60293d8";
        :>> title = "totp::verify_step â€” RFC6238 window verify";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/totp.rs"; :>> name = "verify_step"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:752888389ad0aa4e"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The TOTP time-window check; too wide a window or wrong math accepts invalid codes.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Pure; pinned to RFC6238 vectors; returns the matched step (for the replay guard).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceTotpHotp : CodeElement {
        :>> id = "bf3aec59-5cdb-44a4-bdd2-cb5213507074";
        :>> title = "totp::hotp â€” HMAC-OTP core";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/totp.rs"; :>> name = "hotp"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:57afe3a70a770b35"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The HOTP/HMAC-SHA1 primitive underpinning TOTP; a bug silently weakens MFA.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure total function; pinned to RFC4231/6238 test vectors.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceThrottleCheck : CodeElement {
        :>> id = "b6d5df86-f789-43b4-8c3a-a95aab5417ab";
        :>> title = "LoginThrottle::check â€” brute-force lockout";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/throttle.rs"; :>> name = "check"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:34f65268aea147cf"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Per-account login throttle; a flaw removes brute-force protection on the front door.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Windowed failure count -> lockout; the FR9 rate-limit.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAudit : CodeElement {
        :>> id = "7acdbe82-a31c-4234-abf0-efe1418405d7";
        :>> title = "audit::audit â€” security audit trail";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/audit.rs"; :>> name = "audit"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:c395538ecb9df86a"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The attributable AU.3.3.x audit log; unsanitized fields allow log-forgery / injection, and a miss loses the security signal.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Structured line with control-char stripping on WHO/WHAT (R20/R21 log-injection defense).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }

    part ceAdminRequire : CodeElement {
        :>> id = "f64647e1-9fb1-4dec-875a-a0fa05dd3b60";
        :>> title = "require_admin â€” admin authZ + MFA gate";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/admin.rs"; :>> name = "require_admin"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:7eb5c6bb76d65517"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The admin choke-point; a bypass grants server-admin. Enforces MFA for privileged accounts (REQUIRE_ADMIN_MFA).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Checks admin membership + (when required) TOTP enrollment before any admin action.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAdminShareCreate : CodeElement {
        :>> id = "2669bc50-aae0-47a9-9fd1-3f476753d1e9";
        :>> title = "admin::share_create â€” grant vault access";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/admin.rs"; :>> name = "share_create"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:d6fa46fbeda29942"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Grants another account access to a vault; a flaw is unauthorized sharing / privilege grant.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Owner-scoped; writes a grant via the (rollback-guarded) ShareStore.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAdminShareDelete : CodeElement {
        :>> id = "8b682348-f1a2-49cd-a8b1-6c4ff8c628c1";
        :>> title = "admin::share_delete â€” revoke vault access";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/admin.rs"; :>> name = "share_delete"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:5ee54afb486da6c8"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Revokes a grant; a miss leaves stale access to another user's vault.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Owner-scoped revoke.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAdminLinkCreate : CodeElement {
        :>> id = "515512d1-a4cd-4d06-98cd-c6fa0b5113d8";
        :>> title = "admin::share_link_create â€” mint capability link";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/admin.rs"; :>> name = "share_link_create"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:e237e7f7187ef84f"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Mints a capability share-link (bearer grant); a weak/over-scoped link leaks vault access.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Owner-scoped; opaque token, optional TTL; stored hashed.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAdminLinkRedeem : CodeElement {
        :>> id = "b1ef6ce6-42e5-44f9-be71-8854e483f4f1";
        :>> title = "admin::share_link_redeem â€” redeem link";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/admin.rs"; :>> name = "share_link_redeem"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:9725bcea98edab62"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Binds a link to the caller as a grant; must be single-use or a link is replayable.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Delegates to the single-use redeem (unredeem rollback on a failed grant).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAdminLinkRevoke : CodeElement {
        :>> id = "af3f7cf9-f4b3-4a92-b0dc-3986afe828c2";
        :>> title = "admin::share_link_revoke â€” revoke link";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/admin.rs"; :>> name = "share_link_revoke"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:0a5c4943b141f396"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Revokes a pending link; a miss leaves a live capability outstanding.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Owner-scoped revoke.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceMfaEnroll : CodeElement {
        :>> id = "9285a811-2910-4c01-be8c-5e46d39a7c42";
        :>> title = "mfa::enroll â€” begin TOTP enrollment";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/mfa.rs"; :>> name = "enroll"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:1afbb1b239f3e0db"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Starts MFA enrollment (secret + recovery codes); a flaw weakens or bypasses MFA setup.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Self-service; audited (AU.3.3.1).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceMfaConfirm : CodeElement {
        :>> id = "2268fb23-c1b5-47c6-8fd7-a2af0e526b84";
        :>> title = "mfa::confirm â€” confirm TOTP enrollment";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/mfa.rs"; :>> name = "confirm"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:5cffaa9a4bfc148a"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Confirms enrollment by verifying a code; a flaw enrolls an unverified factor.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Requires a valid TOTP before activating the factor.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceMfaDisable : CodeElement {
        :>> id = "8ccad57f-6b45-4bd0-b811-6b116cb87a3d";
        :>> title = "mfa::disable â€” disable MFA";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/mfa.rs"; :>> name = "disable"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:fd96213dc21932ce"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Disables MFA; must be authenticated + audited or it's an MFA-removal bypass.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Audited MFA disable (AU.3.3.1).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceLinkCreate : CodeElement {
        :>> id = "71e1882e-bd9a-46f7-ba03-a5d8d4f2469c";
        :>> title = "ShareLinkStore::create â€” persist a link";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/sharelinks.rs"; :>> name = "create"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:88473b00fabb4e71"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Persists a capability link; the token must be unguessable + stored safely.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Random token; optional expiry; owner-scoped record.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceLinkRedeem : CodeElement {
        :>> id = "bdb49f68-9cf1-4e9b-8629-4feeafffb630";
        :>> title = "ShareLinkStore::redeem â€” single-use redeem";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/sharelinks.rs"; :>> name = "redeem"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:d227b40f96ec85b1"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Consumes a link exactly once; a double-redeem or expired-accept is a capability-replay.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Marks redeemed_by atomically; expiry + revoke checked; paired with unredeem rollback.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceLinkRevoke : CodeElement {
        :>> id = "ada64180-0830-4fb1-850d-034c5539e5b1";
        :>> title = "ShareLinkStore::revoke â€” revoke a link";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/sharelinks.rs"; :>> name = "revoke"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:f15dd90441bbb9d4"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Revokes a pending link; only the owner may.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Owner-checked; returns false for a non-owner (tested).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceLinkUnredeem : CodeElement {
        :>> id = "34af8052-11b2-4117-b52d-b110b73548ea";
        :>> title = "ShareLinkStore::unredeem â€” redeem rollback";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/sharelinks.rs"; :>> name = "unredeem"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:5b9c8e42a7b12811"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Rolls back a claim so a FAILED grant does not burn the link (the redeem's compensating action).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Restores pending state; the tested single-use-with-rollback contract.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceConfigFromEnv : CodeElement {
        :>> id = "a98a80fe-8825-401d-9f1e-1efa3371938c";
        :>> title = "Config::from_env â€” load config + weak-cred guard";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/config.rs"; :>> name = "from_env"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:3ab087264b55c9fa"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Loads deployment config; MUST refuse a weak/default admin password at boot (CM.3.4.2) or the front door ships with known creds.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Refuses the known-weak/short bootstrap-password class unless ALLOW_WEAK_ADMIN=1.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part cePurgeUserData : CodeElement {
        :>> id = "2f3dfbe2-ca57-4798-9059-1c9b2b0cb636";
        :>> title = "AppState::purge_user_data â€” account-delete purge";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/state.rs"; :>> name = "purge_user_data"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:fd9b98087116e32a"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Removes ALL of a user's data (cached handles + disk) so a recreated username can't inherit prior notes (SEC-MED-2 data remanence).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Drops ns + opens entries + removes the dir; best-effort on the dir.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part cePurgeVault : CodeElement {
        :>> id = "bde33137-7f0e-49d0-b9e9-7b22adb69790";
        :>> title = "AppState::purge_vault â€” per-vault purge";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/state.rs"; :>> name = "purge_vault"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:5f079ce2bcf647da"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Removes one vault's data AND its share grants FIRST, or a lingering grant silently reactivates if a same-named vault is recreated (re-exposure).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Fails loud on a poisoned shares lock (no half-state); drops grants -> ns -> opens -> dir.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceVaultExists : CodeElement {
        :>> id = "f6f7dbfa-4409-4258-831f-ac92bac448d1";
        :>> title = "AppState::vault_exists â€” provisioning gate";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/state.rs"; :>> name = "vault_exists"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:b681b368bb78df28"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Gates sync routes to EXISTING vaults so a GET can't lazily provision an arbitrary vault dir in the caller's namespace (protocol-6).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "safe_name + is_dir; total predicate.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }

    part ceApiStatus : CodeElement {
        :>> id = "ff330b66-2338-4b20-8587-b5e1de618f70";
        :>> title = "api::status â€” per-vault health handler";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/api.rs"; :>> name = "status"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:a80f2d903fae69d7"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Reports vault health; clients pause on 'error' â€” a wrong status acts on a degraded manifest or blocks a healthy vault.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "scoped authZ + ensure_ready; surfaces corrupt-index as error.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceApiChanges : CodeElement {
        :>> id = "d417fd28-5116-4a80-9665-c01abec6c4bf";
        :>> title = "api::changes â€” manifest/delta handler";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/api.rs"; :>> name = "changes"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:0fe37fab40da6805"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Serves the upsert+tombstone manifest clients reconcile against; must refuse a degraded index.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "scoped authZ + ensure_ready (503 not an empty manifest on degraded).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceApiFileMeta : CodeElement {
        :>> id = "d46b2408-2d0b-4124-a9a6-e939ee7bc797";
        :>> title = "api::file_meta â€” single-path meta handler";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/api.rs"; :>> name = "file_meta"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:c174217f7a151e2e"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Backs the client event path's single-path fetch; 404 vs meta drives delete-vs-sync decisions.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "scoped authZ; 404 for absent.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceApiGetChunk : CodeElement {
        :>> id = "cd32cbb5-3ae4-4946-a04a-563a2f9c2a6d";
        :>> title = "api::get_chunk â€” serve a blob";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/api.rs"; :>> name = "get_chunk"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:cd3d09aa429a67e2"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::availability;
        :>> riskRationale = "Serves chunk bytes for reassembly; the client content-verifies, so integrity is enforced downstream.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "scoped Read authZ; blocking-pool read; 404 for absent.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceApiPutChunk : CodeElement {
        :>> id = "09f72feb-6d81-4a78-a0b0-2275189c115f";
        :>> title = "api::put_chunk â€” accept a blob upload";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/api.rs"; :>> name = "put_chunk"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:98dc33174abac12a"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Accepts client-uploaded chunk bytes; must bound size + content-address or a client stores giant/forged blobs.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "scoped Write authZ; 1 MiB in-handler cap; content-addressed store on the blocking pool. (Deferred: a route-scoped body limit so the â‰¤16 MiB pre-check buffer matches the semantic 1 MiB.)";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceApiDeleteFile : CodeElement {
        :>> id = "d3aa3961-990d-4869-92f3-9a32c547ed82";
        :>> title = "api::delete_file â€” delete endpoint";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/api.rs"; :>> name = "delete_file"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:c2a23e02d958c745"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "The remote-delete endpoint; a flaw deletes another tenant's file or accepts an unsafe path.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "scoped Write authZ; Vault::delete (delete-by-raw-key, durable-before-mirror); 404-or-200 idempotent.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceWsServeSocket : CodeElement {
        :>> id = "e9dfecef-2d28-423c-a15f-4b5f7289b430";
        :>> title = "ws::serve_socket â€” per-connection WS loop";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/ws.rs"; :>> name = "serve_socket"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:a6bd31335e193859"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::availability;
        :>> riskRationale = "The change-notification socket loop; a ping/pong or teardown bug drops healthy clients or leaks sockets/tasks.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Keepalive ping with MissedTickBehavior::Delay (CONC-4 no false-drop); ConnGuard teardown; per-user cap.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceVaultsCreate : CodeElement {
        :>> id = "fee65cd4-7340-44c1-81a7-1bd72a2980f6";
        :>> title = "vaults::create_vault â€” provision a vault";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vaults.rs"; :>> name = "create_vault"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:ab89313b0203884b"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Provisions a vault in the caller's namespace; must validate the name + enforce the per-user vault cap.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "safe_name + per-user cap; the ONLY provisioning path (sync routes never lazily create).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceVaultsList : CodeElement {
        :>> id = "90e0c31c-3fda-40b0-926d-13949963561d";
        :>> title = "vaults::list_vaults â€” list own vaults";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/vaults.rs"; :>> name = "list_vaults"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:f21e92053c6c9c64"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Lists the caller's vaults for the switcher.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Namespace-scoped dir listing.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }

    part ceReconcileMergeConflict : CodeElement {
        :>> id = "6274ce30-6e59-484a-a303-f6e0e15c5a26";
        :>> title = "reconcileMergeOrConflict â€” merge/conflict arm";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "reconcileMergeOrConflict"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:0a4f77778097193a"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Both-sides-changed handling; a bug drops a racing edit or clobbers a divergence without a conflict copy.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Re-reads live local after fetch (DI-R3#1); cosmetic-EOL adopt; 3-way merge else conflict-copy; read-only preserves reader copy only for a known-base divergence.";
        :>> pattern = DesignPattern::functionalCoreImperativeShell;
        :>> stpaRole = StpaRole::controller;
    }
    part ceReconcilePluginList : CodeElement {
        :>> id = "890805ed-150f-4a7c-b9ef-0dd1ad5da118";
        :>> title = "reconcileEnabledPluginList â€” community-plugins union";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "reconcileEnabledPluginList"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:eeb045751ee45b58"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "community-plugins.json is a SET; a whole-side adopt would DISABLE a locally-enabled plugin (the vanish class).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Grow-only union of enabled ids; enables propagate, disables do not; null-merge falls through to opaque handling.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceSwitchTo : CodeElement {
        :>> id = "515bec30-0835-4e24-b3ac-32e0e91657a9";
        :>> title = "switchTo â€” vault switch dispatcher";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "switchTo"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:250801ce5e418f63"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "A one-shot authoritative overwrite of local or remote; the highest-blast-radius user action.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Snapshots+clears base (R19), read-only guard, selective-sync filter, dispatches download/upload/merge.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceSwitchDownload : CodeElement {
        :>> id = "278271a1-ede2-49de-a1e5-49b8644d2198";
        :>> title = "switchDownload â€” mirror target into local";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "switchDownload"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:0decc731cbf580da"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Mirrors the target, removing local-only files; a partial ready manifest could mass-delete local notes.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Per-file isolation (R17); R19 restore-base on a failed adopt; bulk-delete ratio guard on the removals.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceSwitchUpload : CodeElement {
        :>> id = "57676a5f-b7a1-44e1-ad3a-75b2a6f9e8d1";
        :>> title = "switchUpload â€” make local authoritative";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "switchUpload"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:91af157a99652a3c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Overwrites the target with local; a failed push must NOT silently let the target overwrite the kept local file.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "R20 leave-base-null on failed push (retry conflict-copies, no silent overwrite); drops remote files local lacks.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceReconcileLocalConfig : CodeElement {
        :>> id = "abb8df83-2a33-45ac-bbb9-a134867c7fff";
        :>> title = "reconcileLocalConfig â€” cheap config scan";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "reconcileLocalConfig"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:2214c4df6a182d77"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Detects local config edits mobile fires no event for; runs often, so must be cheap + not mis-delete.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Stat-skip fast path (baseStatUnchanged); per-file error isolation; sequential (config is small).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceApplyPull : CodeElement {
        :>> id = "a0d895cd-ea81-4b01-a44e-046ba605950b";
        :>> title = "applyPull â€” bring a remote file down";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "applyPull"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:1e8a08aafb5ca7e2"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Overwrites local with remote; must preserve a racing local edit as a conflict copy and never write unverified bytes.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Streams large / buffers small; conflictCopyIfRaced guard; whole-file hash verified before the atomic rename (R17).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceFetchVerified : CodeElement {
        :>> id = "bb3d80c7-15f6-42f1-a819-471a55d1d152";
        :>> title = "fetchVerified â€” verify-before-use fetch";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "fetchVerified"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:cb14f84e78b940d8"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Reassembles + verifies a remote file hash before it is written/merged/adopted; a corrupt blob must never be laundered into base.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Throws on hash mismatch; the per-file guard skips + keeps the good local copy.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceConflictCopyIfRaced : CodeElement {
        :>> id = "bcb30d21-9fbb-444e-9b97-ad3621a3bd5e";
        :>> title = "conflictCopyIfRaced â€” preserve a racing edit";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "conflictCopyIfRaced"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:eed0d1050462882f"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Detects a local edit that raced a pull and preserves it as a copy; a miss silently loses the racing edit.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Re-reads current bytes; config-race routes to adjudication (marker), never a note-style copy.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceResolveConfigConflict : CodeElement {
        :>> id = "624de6d1-fd74-4784-9e5c-7b2da71a0a75";
        :>> title = "resolveConfigConflict â€” user-chosen config resolution";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "resolveConfigConflict"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:339b122c600cafdc"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "The ONLY place a config removal/divergence is acted on destructively/resurrectively â€” and only because the user chose it.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "local: push (or propagate removal); remote: pull (or adopt removal); base set to the winner.";
        :>> pattern = DesignPattern::command;
        :>> stpaRole = StpaRole::controller;
    }
    part ceIsolatedPass : CodeElement {
        :>> id = "e6550fbf-0ba4-4979-a9eb-a7ef4938090a";
        :>> title = "isolatedPass â€” per-file error-isolation loop";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "isolatedPass"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:d92356534e9f793b"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::concurrency;
        :>> riskRationale = "The shared reconcile loop: a whole-connection error must ABORT the pass; any other error must stay isolated + hold the cursor.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "connAbort short-circuit; isConnectionError => abort; else per-file hold via holdForRetry. Bounded concurrency (mapPool).";
        :>> pattern = DesignPattern::boundedPool;
        :>> stpaRole = StpaRole::channel;
    }
    part ceRunDeleteGuard : CodeElement {
        :>> id = "482a3b4a-3db1-4d20-9f05-071a85919199";
        :>> title = "runDeleteGuard â€” bulk-delete guard";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "runDeleteGuard"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:ac7f7f58f68e9b4d"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "The SEC-DATA guard that refuses a mass delete from a partial/empty manifest or a paced drain.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Per-pass ratio OR the cumulative DeleteRateGuard; records deletes only when let through.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceIsConnectionError : CodeElement {
        :>> id = "0f214070-4c75-4818-8d15-419e6ad6976c";
        :>> title = "isConnectionError â€” abort-vs-isolate classifier";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "isConnectionError"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:db4b9d755cab04ee"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Decides whether one error aborts the whole pass (server down) or is isolated per-file; a mis-classification floods errors or wrongly aborts.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Deliberately narrow regex (host-resolution/connection only, never a per-file read/timeout).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceSameIgnoringEol : CodeElement {
        :>> id = "82762ab8-5155-410e-875f-c648e919ecfe";
        :>> title = "sameIgnoringEol â€” cosmetic-EOL equality";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/reconcile.ts"; :>> name = "sameIgnoringEol"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:ea4c6a95e50c29ca"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Prevents spurious conflict copies for the same note saved with different line endings (the false-conflict class).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Normalizes EOL + trailing newlines; TEXT-only (isMergeable-gated so binaries are not lossily decoded).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part cePushFile : CodeElement {
        :>> id = "52087ec2-36b9-442f-a39a-76ac823bb0ef";
        :>> title = "pushFile â€” chunk + upload-missing + commit";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/sync.ts"; :>> name = "pushFile"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:c11a35dbaf0197d9"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Uploads a local file (chunk, upload only missing, CAS commit); the write path to the server.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "CAS via expectedVersion (409 -> merge); returns COMMITTED bytes (DI-5) so base cannot desync.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part cePushBytes : CodeElement {
        :>> id = "7101957a-ed82-46fd-841c-14ba585dadfd";
        :>> title = "pushBytes â€” write bytes then push";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/sync.ts"; :>> name = "pushBytes"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:bb0fda45b9ca31d3"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Writes merged/conflict bytes then pushes; returns committed bytes so base (bytes,hash) cannot disagree.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "DI-5 committed-bytes contract. (Deferred: 7 positional args -> a SyncCtx bundle, Part-B step 8.)";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceFetchFileBytes : CodeElement {
        :>> id = "504efe13-b07c-4ad5-b61b-02bf78a624b9";
        :>> title = "fetchFileBytes â€” fetch + reassemble";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/sync.ts"; :>> name = "fetchFileBytes"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:950a3d74958997a2"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Reassembles a file from its chunk list (cache-first, order-preserving).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Bounded-concurrency verified fetch; order delegated to mapPool.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceGetVerifiedChunk : CodeElement {
        :>> id = "b66969ae-136c-4c6a-8d2f-0ec080ad8e59";
        :>> title = "getVerifiedChunk â€” verify-before-cache chunk fetch";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/sync.ts"; :>> name = "getVerifiedChunk"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:09334a79b717a030"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Only authenticated bytes enter the cache, so a later cache hit is trusted; a bypass launders a corrupt blob.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Content-address verified before cachePut (DI-2). (Deferred: cache HIT aliases the buffer -> read-only contract note.)";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceMapPool : CodeElement {
        :>> id = "3e685548-43a7-43d7-84b5-59425264fd1e";
        :>> title = "mapPool â€” bounded-concurrency pool";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/sync.ts"; :>> name = "mapPool"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:fca9d2dc3c1b27bf"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::concurrency;
        :>> riskRationale = "The shared concurrency primitive; a limit<=0 previously returned a sparse array of undefined (silent-wrong).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Order-preserving pre-sized results; limit clamped >=1.";
        :>> pattern = DesignPattern::boundedPool;
        :>> stpaRole = StpaRole::channel;
    }
    part ceStreamFileToDisk : CodeElement {
        :>> id = "267fe862-7937-49af-9692-a7305c16fa67";
        :>> title = "streamFileToDisk â€” stream large download to disk";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/sync.ts"; :>> name = "streamFileToDisk"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:72e6c752ecbcfb6f"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Streams a large file straight to disk (mobile OOM avoidance); a size-preserving bad manifest must never overwrite the target.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Incremental whole-file hash verified BEFORE the atomic rename (R17); mid-stream failure aborts + discards partial.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceMerge3 : CodeElement {
        :>> id = "88126f5e-5f00-430c-9f11-922b84a81713";
        :>> title = "merge3 â€” diff3 three-way merge";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/merge.ts"; :>> name = "merge3"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:0cc312e0db2e47f0"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The auto-merge; a bug drops an edit or manufactures conflicts (the CRLF class exploded cross-platform merges).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Normalizes CRLF->LF before comparison; LCS anchors; conflict regions on overlap. Pure over its inputs.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceIsMergeable : CodeElement {
        :>> id = "af6e27fb-dde3-4d8b-8880-f83a88e8621c";
        :>> title = "isMergeable â€” mergeable-text gate";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/merge.ts"; :>> name = "isMergeable"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:d96f0f71ffd2380d"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Gates which files may be 3-way merged / EOL-normalized; a binary slipping through is lossily decoded + clobbered.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Extension-gated AND fatal-UTF-8-gated (excludes binaries / invalid UTF-8).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceChunkerChunkClient : CodeElement {
        :>> id = "1d6713e6-3e89-40cb-9ddb-eecae9d458e5";
        :>> title = "chunker::chunk (client) â€” CDC chunker";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/chunker.ts"; :>> name = "chunk"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:b76c9230aa05596a"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The reference CDC chunker; MUST match the Rust port byte-for-byte or dedup breaks.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure; gear-hash boundaries; pinned by the cross-language golden-parity test.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceSha256hexClient : CodeElement {
        :>> id = "0691dd1f-3af5-4023-b02a-6fd2d3860120";
        :>> title = "chunker::sha256hex (client) â€” content hash";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/chunker.ts"; :>> name = "sha256hex"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:4cc12db4c34edc7d"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The content-address primitive underpinning dedup + integrity verification.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure; subarray hashing without copies.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceShouldSync : CodeElement {
        :>> id = "e8cf4dcc-9ad6-4580-975f-139429d29273";
        :>> title = "shouldSync â€” config-surface allowlist";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/configsync.ts"; :>> name = "shouldSync"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:6acac1553ec266b4"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Decides which .obsidian/ paths sync; must never sync SelfSync own secrets and fail safe on unknown paths.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Case-insensitive self-folder exclusion; category/allowlist gate; unknown -> false (fail-safe).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceConfigSurfaceOf : CodeElement {
        :>> id = "89b61afe-af5a-4480-a8ad-b93b97db0dc7";
        :>> title = "configSurfaceOf â€” surface classifier";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/configsync.ts"; :>> name = "configSurfaceOf"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:b84fc44f832c35d4"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Classifies a config path surface (kept in lockstep with shouldSync); drift mis-routes a file.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Total classification of .obsidian/ paths to surfaces.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceMergeEnabledPlugins : CodeElement {
        :>> id = "0ba2d341-ae14-49b7-979e-0c47e8cedd3d";
        :>> title = "mergeEnabledPluginsJson â€” enabled-set union";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/configsync.ts"; :>> name = "mergeEnabledPluginsJson"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:a3dee11908be264a"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Unions two enabled-plugin id lists so a sync can never disable a locally-enabled plugin.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Grow-only sorted union; null on a non-string[] (falls back to opaque handling).";
        :>> pattern = DesignPattern::makeIllegalStatesUnrepresentable;
        :>> stpaRole = StpaRole::channel;
    }
    part ceIsSafeVaultPath : CodeElement {
        :>> id = "759ec6af-374a-48c9-a8c1-97a5ec28dee1";
        :>> title = "isSafeVaultPath â€” client path guard";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/pathsafe.ts"; :>> name = "isSafeVaultPath"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:8f87291b4ba23082"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Refuses a traversing/absolute server-supplied path before the client touches the filesystem.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Parse-don't-validate: total predicate mirroring the server safe_rel_path discipline.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::channel;
    }
    part ceIsInsecureRemote : CodeElement {
        :>> id = "d01bd6b2-8815-4442-91fb-fc16607688e0";
        :>> title = "isInsecureRemote â€” cleartext-remote refusal";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/connstr.ts"; :>> name = "isInsecureRemote"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:f3f01be976554e1c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "The predicate behind refusing to send tokens/passwords over http to a remote host (SC.3.13.8); loopback allowed.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Total classification of a URL as insecure-remote.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::channel;
    }

    part ceTxCommit : CodeElement {
        :>> id = "adbbbdca-598c-4ae3-bcdb-166c71a0ef2b";
        :>> title = "HttpTransport.commit â€” commit wire call";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "commit"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:f025b45ddf1f500c"; :>> auditRound = "r1"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The client write call; must distinguish 409 (CAS conflict -> merge) from 404 (missing chunk -> re-upload) from a real error, or the engine flaps OFFLINE on a routine conflict.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "409/404 -> CommitConflictError (retryable, isolatable); snake_case expected_version wired only when set.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceTxDiagnose : CodeElement {
        :>> id = "d2e75ff9-e99e-4fe3-9ed0-eb99ac268721";
        :>> title = "HttpTransport.diagnose â€” layered connection diagnosis";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "diagnose"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:215a2e0d7eca6816"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The never-throws diagnostic; must survive a non-JSON 200 (proxy/captive-portal HTML) since that is exactly when it is run.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Layered ladder (unreachable/version/auth/vault/degraded); reads bodies via tryJson so a non-JSON 200 does not throw.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceTxApiJson : CodeElement {
        :>> id = "4d35f3e3-2f7c-4f61-b61c-e662fd87b41e";
        :>> title = "apiJson â€” shared request/status/parse";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "apiJson"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:2602e4a0467c7bec"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The shared 200-or-throw JSON path; centralizes errText surfacing + the safe .json read across ~15 endpoints.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "errText on non-200; tryJson body read (getter throws on non-JSON). Bespoke-status endpoints opt out.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceTxHttpReq : CodeElement {
        :>> id = "9e8adf46-b8a8-46e7-8559-216865057857";
        :>> title = "httpReq â€” timeout race + cleartext backstop";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "httpReq"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:7c0324a9fe52d6ad"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::availability;
        :>> riskRationale = "Every request goes through here; without the timeout a half-open connection wedges the serial engine forever.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "30s timeout race -> a stall becomes a normal rejection; centralized cleartext-remote refusal (SC.3.13.8).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceTxLogin : CodeElement {
        :>> id = "1bd6e480-2ca4-448e-8965-f97861877162";
        :>> title = "HttpTransport.login â€” client login";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "login"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:a31787a5fb315cf0"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Sends the password; must refuse cleartext-remote before transmitting it.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "isInsecureRemote refusal at the top + httpReq backstop; returns token + mustChange.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceTxChangePassword : CodeElement {
        :>> id = "801a09b4-a60d-433d-b4a1-067eb0d6532b";
        :>> title = "HttpTransport.changePassword â€” change password";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "changePassword"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:8f041398d690b90b"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Changes the password + returns a fresh token; 401 must map to a clear message.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "401 -> specific message; bearer auth; errText fallback.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceTxStatus : CodeElement {
        :>> id = "5c809cc5-8233-4843-9fc0-c29c12a5aaf7";
        :>> title = "HttpTransport.status â€” vault status";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "status"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:f07c8da9a277ed3e"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Fetches vault health the engine gates on (degraded -> pause).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "validateStatus (shape + api_version mapping) on the 200 body.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceTxChanges : CodeElement {
        :>> id = "5dcb541e-3294-48b0-b99c-bb94102c4510";
        :>> title = "HttpTransport.changes â€” fetch manifest/delta";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "changes"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:66c520dafbba5018"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Fetches the reconcile manifest; a malformed body must be rejected, not acted on.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "validateChanges on the 200 body.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceTxFileMeta : CodeElement {
        :>> id = "e04ce250-d0f7-4181-bd15-da37901929ac";
        :>> title = "HttpTransport.fileMeta â€” single-path meta";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "fileMeta"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:36aae9abdd3a582c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "404 vs meta drives the event path's delete-vs-sync decision.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "404 -> null (bespoke); validateFileMeta on 200.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceTxMissing : CodeElement {
        :>> id = "2c885532-c00f-480c-932d-7b158f2228c7";
        :>> title = "HttpTransport.missing â€” which chunks to upload";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "missing"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:cb18217fe6a8edb6"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Drives dedup (upload only missing chunks); a malformed response must be rejected.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Rejects a non-string[] response explicitly.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceTxGetChunk : CodeElement {
        :>> id = "16dfabb6-c9d2-4754-a56c-cc9e70393a65";
        :>> title = "HttpTransport.getChunk â€” fetch a chunk";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "getChunk"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:b3148a45aedd7e4b"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Fetches chunk bytes; the caller content-verifies before use.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Binary arrayBuffer; non-200 throws.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceTxPutChunk : CodeElement {
        :>> id = "6602829c-51ae-47eb-90c9-09e0e9557635";
        :>> title = "HttpTransport.putChunk â€” upload a chunk";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "putChunk"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:6083e5b24ad50c53"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Uploads a chunk; content-addressed so a corrupt upload is caught server-side.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Binary body; non-200 throws.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceTxDeleteFile : CodeElement {
        :>> id = "37334c16-f184-45d3-9628-6316f44e149d";
        :>> title = "HttpTransport.deleteFile â€” delete call";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "deleteFile"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:a224de6104157c2e"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Issues the remote delete; 404 is acceptable (idempotent).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "200-or-404 accepted; other -> throw.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceTxConnectWs : CodeElement {
        :>> id = "6087ae39-503d-4617-a088-354bc2a8aaf6";
        :>> title = "HttpTransport.connectWs â€” change-notify socket";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "connectWs"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:adea1c9ba879979f"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Opens the WS; the token must not land in URLs/logs.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Token via Sec-WebSocket-Protocol subprotocol (SEC-1), never the URL; onmessage guarded.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceTxTestConnection : CodeElement {
        :>> id = "5f64ac94-232e-4721-9c9d-1ff76a1024e4";
        :>> title = "HttpTransport.testConnection â€” setup probe";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/transport.ts"; :>> name = "testConnection"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:227e05ae40b7ac8e"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "A best-effort setup-wizard reachability probe.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Returns true iff /health answers 200; swallows errors.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceEngEnqueue : CodeElement {
        :>> id = "087c0a3d-4ea6-4a3a-96a8-9c0637722eee";
        :>> title = "SyncEngine.enqueue â€” event coalescing";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/syncengine.ts"; :>> name = "enqueue"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:a2d4edee4c8b574c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::concurrency;
        :>> riskRationale = "Bounds the queue by coalescing; a path keeps the larger size (so a grow-past-cap is not judged on a stale small size).";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Coalesces remote/connect/rews/path; terminal states swallow input; typed path-variant predicate.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceEngPump : CodeElement {
        :>> id = "0328abd0-758e-4004-acca-0703171679fa";
        :>> title = "SyncEngine.pump â€” run-to-completion processor";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/syncengine.ts"; :>> name = "pump"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:58e604032dacf6e9"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::concurrency;
        :>> riskRationale = "The single processor; the running guard is what kills the redial-vs-reconnect race class.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "One processor at a time (running flag); settles to idle only when connected + queue empty.";
        :>> pattern = DesignPattern::serializedActor;
        :>> stpaRole = StpaRole::controller;
    }
    part ceEngFailToOffline : CodeElement {
        :>> id = "69a6f33b-541c-4960-9eae-91c1d4a0019e";
        :>> title = "SyncEngine.failToOffline â€” recovery collapse";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/syncengine.ts"; :>> name = "failToOffline"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:19faff0c2fb0f81e"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::concurrency;
        :>> riskRationale = "On any effect failure: go offline, drop in-flight path/remote/rews (the reconnect subsumes them), keep disconnect/unload; a wrong drop loses recovery or double-recovers.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Sets connected=false (load-bearing), filters the queue, schedules one backoff reconnect.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceBaseToJson : CodeElement {
        :>> id = "e4167a3b-9f1e-46a3-9b67-c563ebee9dfc";
        :>> title = "BaseStore.toJSON â€” persist base";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/base.ts"; :>> name = "toJSON"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:cf51b498ceae2c8d"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Persists the last-synced ancestor; must not persist a stale scan-skip stat hint across a restart.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Persists only hash+text; drops the (size,mtime) hint so a restart rebuilds it from a fresh scan.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceBaseStampStat : CodeElement {
        :>> id = "e5cdda76-1aa3-47bb-ac75-d663731e0dd9";
        :>> title = "BaseStore.stampStat â€” cache scan-skip hint";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/base.ts"; :>> name = "stampStat"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:694c3641dda26c80"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Records the (size,mtime) at which a file equalled base, so a later scan can skip re-hashing it.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Session-only stat stamp (dropped by toJSON); the scan-skip fast path input.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceConflictCopyName : CodeElement {
        :>> id = "840a288d-7e4f-4186-bd01-90baa3251910";
        :>> title = "conflictCopyName â€” conflict-copy naming";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/base.ts"; :>> name = "conflictCopyName"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:e21a356484137fba"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Names a conflict copy deterministically (device + timestamp + hash tag) so it round-trips to its original.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure; the 14-digit-timestamp anchor lets originalOfConflictCopy invert it without false matches.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceOriginalOfConflictCopy : CodeElement {
        :>> id = "af8f0ec8-6cc6-458b-b874-9b56289c2640";
        :>> title = "originalOfConflictCopy â€” conflict derivation";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/base.ts"; :>> name = "originalOfConflictCopy"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:75ba3087132b1750"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Derives the conflict set from the vault file list (no cached array to go stale).";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Pure total inverse of conflictCopyName; anchored regex avoids matching a user's own (conflict ...) file.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceValidateChanges : CodeElement {
        :>> id = "325f6e0e-a684-4616-8f63-5b7653196d61";
        :>> title = "validateChanges â€” wire-shape parser";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/protocol.ts"; :>> name = "validateChanges"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:07153715c0e0aeb4"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Parses the untrusted changes response into a typed ChangesResponse; a bad shape must be rejected, not reconciled on.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Parse-don't-validate the wire into a proven type at the boundary.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::channel;
    }
    part ceValidateFileMeta : CodeElement {
        :>> id = "a17dc1fd-1470-45f9-b271-cdf9ee7b5cee";
        :>> title = "validateFileMeta â€” wire-shape parser";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/protocol.ts"; :>> name = "validateFileMeta"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:bc9901d25f8446a7"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Parses an untrusted FileMeta; a malformed meta must not drive a sync decision.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Parse-don't-validate at the boundary.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::channel;
    }
    part ceValidateStatus : CodeElement {
        :>> id = "ba44b9c7-c5ec-4acc-a594-c97809af084d";
        :>> title = "validateStatus â€” wire-shape parser";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/protocol.ts"; :>> name = "validateStatus"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:5c7e1d70b9c4c7be"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Parses status + maps snake_case api_version -> apiVersion.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Parse-don't-validate + field mapping at the boundary.";
        :>> pattern = DesignPattern::parseDontValidate;
        :>> stpaRole = StpaRole::channel;
    }

    part ceMainDoConnect : CodeElement {
        :>> id = "4a6d1c78-b572-4359-bf26-3f1f59a1e047";
        :>> title = "SelfSyncPlugin.doConnect â€” connect effect + initial reconcile";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "doConnect"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:17556f420af04ae5"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::availability;
        :>> riskRationale = "The connect effect: health-check, WS spin-up, and the full initial reconcile; a flaw wedges sync or double-connects.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Health check -> markReconciling -> reconcileAll; re-stamps scan windows on success; teardown-safe.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceMainDoReconcileAll : CodeElement {
        :>> id = "0550783e-dfbc-4447-8c6a-82d321801896";
        :>> title = "SelfSyncPlugin.doReconcileAll â€” reconcile driver";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "doReconcileAll"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:a29e1be4f50e47d3"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "The poll/poke effect: idle short-circuit, D0019 history-reset detection, and the full-vs-delta decision; drives every destructive reconcile.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Stamps scan windows AFTER the awaited scan (a mid-scan throw leaves them due); routes reset -> full reconcileAll.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceMainScheduleReconnect : CodeElement {
        :>> id = "5c324c63-b8b1-4e06-a552-af9400e7a63e";
        :>> title = "SelfSyncPlugin.scheduleReconnect â€” backoff reconnect";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "scheduleReconnect"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:7335fd8a42bc4c83"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::availability;
        :>> riskRationale = "Arms the jittered backoff reconnect; stops the poll while offline so the two do not retry in parallel.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Equal-jitter delay; single reconnectTimer; unloading guard.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceMainStartPolling : CodeElement {
        :>> id = "1b10d599-03f4-4e2d-a1bf-2f7fef57a6e1";
        :>> title = "SelfSyncPlugin.startPolling â€” poll timer";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "startPolling"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:b162da782c24e078"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::availability;
        :>> riskRationale = "The 4s safety-net poll (an event source); must never re-arm during teardown or it leaks a timer per disable/enable.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "unloading guard (critique F4) + clears any prior interval before arming.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceMainPersist : CodeElement {
        :>> id = "c58fcfc3-1669-436a-afe7-0539eb3f2545";
        :>> title = "SelfSyncPlugin.persist â€” base persistence";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "persist"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:c785d10023b1f8d3"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Persists the base (last-synced ancestor); an out-of-order write loses base and reads as mass change.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Single-flight + trailing-write coalescing; snapshots inside the loop so the final write reflects the newest base.";
        :>> pattern = DesignPattern::singleWriter;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceMainEnumerateConfig : CodeElement {
        :>> id = "8a06004c-c7db-4d5a-b739-04aff21af984";
        :>> title = "SelfSyncPlugin.enumerateConfig â€” config listing";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "enumerateConfig"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:9b336ccb315ffe6b"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Lists .obsidian/ for the config scan; a swallowed dir-list failure treated as empty is the false-absence enumerate vector.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "LOGS a dir-list failure instead of silently returning empty (post-audit fix).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceMainSwitchToVault : CodeElement {
        :>> id = "87047ca2-542e-4feb-8ffd-095485429253";
        :>> title = "SelfSyncPlugin.switchToVault â€” vault-switch orchestration";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "switchToVault"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:9f251215ae3fda8f"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Orchestrates a user vault switch (durable pending flag + switchTo); a crash mid-switch must resume, not lose data.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Durable pendingSwitch flag (cleared only after switchTo succeeds); persistent Switching state survives suspend.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceMainLoadSettings : CodeElement {
        :>> id = "cfe76ce1-81a5-4182-a315-dcb2f431359c";
        :>> title = "SelfSyncPlugin.loadSettings â€” settings load/migrate";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "loadSettings"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:1be28f7656ab8d06"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Loads + migrates persisted settings; a bad migration loses config or mis-defaults selective sync.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Merges defaults; keeps a fresh per-plugin pluginDir; token-only mode handling.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceMainSaveSettings : CodeElement {
        :>> id = "c12a447b-185e-4bab-9f33-b69be3be1d5b";
        :>> title = "SelfSyncPlugin.saveSettings â€” settings persist";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "saveSettings"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:2f94b83c996b4598"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Persists settings; must not drop fields on write.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Obsidian saveData of the settings object.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceMainResolveNoteConflict : CodeElement {
        :>> id = "c5fe4a18-75a8-40f9-9d64-747ec6f2ff9f";
        :>> title = "SelfSyncPlugin.resolveNoteConflict â€” note conflict resolution";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "resolveNoteConflict"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:b22cb2706d150ea1"; :>> auditRound = "r1"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::dataLoss;
        :>> riskRationale = "Applies the user's mine/theirs choice on an irreversible content conflict; a stale-preview accept discards the other side.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Double-checked stale-preview guard (TOCTOU narrowing); theirs shares the tail with no clobber-risk; purely-derived conflict model.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceMainSpinUpWs : CodeElement {
        :>> id = "0c090b36-9001-4b12-bb5c-8754ee4b0e81";
        :>> title = "SelfSyncPlugin.spinUpWs â€” WS lifecycle";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "spinUpWs"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:9cf35809152ac5e9"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::availability;
        :>> riskRationale = "Opens/replaces the change-notify socket; a leak pins a socket per reconnect.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "unloading guard; replaces any prior socket; returns false on failure to signal the caller.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceMainHistoryReset : CodeElement {
        :>> id = "cee6fef6-e92f-420a-ac58-964ed503f7e5";
        :>> title = "SelfSyncPlugin.historyResetDetected â€” D0019 reset detect";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "historyResetDetected"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:acabd0c0d33fed6f"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Detects a server deletion-history reset from the persisted floor+version; a false negative silently resurrects pruned deletions.";
        :>> invariantSafety = InvariantSafety::parsed;
        :>> invariantNotes = "Compares delta.version/history_floor against the persisted per-vault floor (survives restart).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::sensor;
    }
    part ceMainNoteHistory : CodeElement {
        :>> id = "7bc80edb-1928-4c51-b265-defa1c1abd3d";
        :>> title = "SelfSyncPlugin.noteHistory â€” floor/version tracking + notify";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "noteHistory"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:6b79a491fc9276e7"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Records the floor/version each pass and turns a reset into ONE user notice (kept-absent batch); a miss loses reset detectability.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Persists floor/version; batches kept-absent files into a single review notice.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceMainOnload : CodeElement {
        :>> id = "216345d5-8b53-4fd4-9b33-ecea68a6488e";
        :>> title = "SelfSyncPlugin.onload â€” plugin bootstrap";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "onload"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:f4aaa0afc819c65c"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The plugin entry: wires settings, commands, the engine, and event handlers; a wiring error breaks sync or leaks handlers.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Loads settings, registers commands + vault events, constructs the engine, auto-connects if configured.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceMainOnunload : CodeElement {
        :>> id = "798b5728-468b-4bd5-9b45-f7c9a0ca5336";
        :>> title = "SelfSyncPlugin.onunload â€” teardown";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/main.ts"; :>> name = "onunload"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:c5f487f5d1d27937"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::concurrency;
        :>> riskRationale = "Teardown; must stop timers + sockets + the engine or it leaks the plugin instance per disable/enable.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Enqueues unload (synchronous terminal); tears down timers/WS.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }

    part ceSsTransition : CodeElement {
        :>> id = "c450ffb2-bd41-4298-81de-0e07dd8ca33e";
        :>> title = "syncstate::transition â€” engine phase transition";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/syncstate.ts"; :>> name = "transition"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:90208173143a1508"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The pure phase-transition function of the sync state machine; a wrong transition shows a stale/false status or mis-sequences recovery.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure total (Phase,SyncEvent)->Phase; the testable core the SyncEngine effects wrap.";
        :>> pattern = DesignPattern::state;
        :>> stpaRole = StpaRole::channel;
    }
    part ceSsIsWsStale : CodeElement {
        :>> id = "e087dcb1-3eb7-4114-8c89-827b6b99e6a1";
        :>> title = "syncstate::isWsStale â€” WS staleness predicate";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/syncstate.ts"; :>> name = "isWsStale"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:9570b18bbb79d355"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Decides whether a websocket is dead (drives fallback to polling); a wrong verdict sits at a permanent spinner or drops a healthy socket.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure predicate over (lastActivity,now,threshold).";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceSsSyncMachine : CodeElement {
        :>> id = "53b0c4c3-f5fc-401d-a523-e6e98015d8a5";
        :>> title = "syncstate::SyncMachine â€” state-machine wrapper";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/syncstate.ts"; :>> name = "SyncMachine"; :>> kind = CodeElementKind::class;
        :>> codeHash = "sha256:fa3a4025175a8f91"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "Holds the current Phase and applies transition(); the single source of the displayed sync state.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Thin holder over the pure transition(); no effects.";
        :>> pattern = DesignPattern::state;
        :>> stpaRole = StpaRole::controlledProcess;
    }
    part ceSsLight : CodeElement {
        :>> id = "47a3deb7-2fac-4ac1-ac1c-2fbe15e25bc8";
        :>> title = "syncstate::light â€” status light spec";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/syncstate.ts"; :>> name = "light"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:de23ba609ee71dc0"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "Maps a phase to a status glyph/colour/detail; purely presentational.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure (phase,detail,realtime)->LightSpec.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceRegIssue : CodeElement {
        :>> id = "53a82132-02b3-4fe0-a8e5-12fa4e8e0d81";
        :>> title = "RegistrationStore::issue â€” mint invite token";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/registration.rs"; :>> name = "issue"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:819b37ec9bdeb399"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Mints an invite token gating registration; a weak/over-broad token opens registration.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Random token, optional TTL, persisted.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::actuator;
    }
    part ceRegSetMode : CodeElement {
        :>> id = "12ca0ca9-f948-47e9-835e-8ae45d8ba006";
        :>> title = "RegistrationStore::set_mode â€” registration policy";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/registration.rs"; :>> name = "set_mode"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:bf010ea2ce304b3d"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Sets open/invite/closed registration; wrong mode is open registration.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Persists the policy mode.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceAdminsGrant : CodeElement {
        :>> id = "194df849-222c-46bd-a098-a4f5e70edd4c";
        :>> title = "AdminStore::grant â€” promote to server-admin";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/admins.rs"; :>> name = "grant"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:cd3ae61aaf307409"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Promotes an account to server-admin (beyond bootstrap); a flaw is privilege escalation.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Persisted admin set; paired with require_admin at the gate.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceThrottleFail : CodeElement {
        :>> id = "26756284-568a-414d-9332-c706aaeb641f";
        :>> title = "LoginThrottle::fail_at â€” record a failed login";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/throttle.rs"; :>> name = "fail_at"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:d5fa56e18ae6cb2f"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Accrues failed-login counts toward lockout; a miss removes brute-force protection.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Windowed count keyed by user + time.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceThrottleSuccess : CodeElement {
        :>> id = "a4c5a138-55db-4f49-b432-bcd5107d1e74";
        :>> title = "LoginThrottle::success â€” reset on success";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/throttle.rs"; :>> name = "success"; :>> kind = CodeElementKind::method;
        :>> codeHash = "sha256:884ce32dfc0492d6"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::security;
        :>> riskRationale = "Clears the failure count on a good login; a miss would keep a legit user locked out.";
        :>> invariantSafety = InvariantSafety::runtimeGuarded;
        :>> invariantNotes = "Resets the per-user window.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::controller;
    }
    part ceHashSha256 : CodeElement {
        :>> id = "8b8a30fa-26f3-4d11-a6dc-ae14af277960";
        :>> title = "hash::sha256_hex â€” server content hash";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/hash.rs"; :>> name = "sha256_hex"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:ccb9c1809bc96fe3"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::correctness;
        :>> riskRationale = "The server content-address primitive (chunk verify, file hash, tokens); a bug breaks integrity + dedup.";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure hex of SHA-256.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceAuditRfc3339 : CodeElement {
        :>> id = "390e3884-6ea1-4d08-af9e-7c7822d2efbe";
        :>> title = "audit::rfc3339_from_epoch â€” audit timestamp format";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "server/src/audit.rs"; :>> name = "rfc3339_from_epoch"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:125dd177c01a2fc1"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "Formats the audit-line timestamp; purely presentational (the civil-from-days math).";
        :>> invariantSafety = InvariantSafety::typeEnforced;
        :>> invariantNotes = "Pure; verified against known epochs.";
        :>> pattern = DesignPattern::none;
        :>> stpaRole = StpaRole::channel;
    }
    part ceUiSetupWizard : CodeElement {
        :>> id = "53881e73-17cd-4eb5-a544-6e7853479cf4";
        :>> title = "setupwizard::SetupWizard â€” connection setup UI";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/setupwizard.ts"; :>> name = "SetupWizard"; :>> kind = CodeElementKind::class;
        :>> codeHash = "sha256:8fb0cf8dcb1bbaf2"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "The setup wizard modal; drives login/register but is presentational over the transport.";
        :>> pattern = DesignPattern::none;
    }
    part ceUiSettings : CodeElement {
        :>> id = "506e1405-db00-4947-8ead-c003ebe2bc55";
        :>> title = "settings::SettingsTab â€” settings UI";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/settings.ts"; :>> name = "SettingsTab"; :>> kind = CodeElementKind::class;
        :>> codeHash = "sha256:82154722c8622d71"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "The grouped settings tab; presentational over persisted settings.";
        :>> pattern = DesignPattern::none;
    }
    part ceUiVaultSwitch : CodeElement {
        :>> id = "33775f6d-d27c-4d80-939d-c54188e7d96e";
        :>> title = "vaultswitch::SwitchModal â€” vault switch UI";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/vaultswitch.ts"; :>> name = "SwitchModal"; :>> kind = CodeElementKind::class;
        :>> codeHash = "sha256:e582a7d6e00978f8"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "The switch/fork modal; confirms then delegates to switchToVault (the destructive logic lives there).";
        :>> pattern = DesignPattern::none;
    }
    part ceUiNoteConflict : CodeElement {
        :>> id = "121e4098-079a-4ee5-808c-bb23c56aaefc";
        :>> title = "noteconflict::NoteConflictModal â€” conflict UI";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/noteconflict.ts"; :>> name = "NoteConflictModal"; :>> kind = CodeElementKind::class;
        :>> codeHash = "sha256:da8af49f4138ddea"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "The note-conflict picker; presentational over resolveNoteConflict (which holds the guards).";
        :>> pattern = DesignPattern::none;
    }
    part ceUiConfigDir : CodeElement {
        :>> id = "57a3274b-ce16-4df5-ab3a-e78df7c1cc12";
        :>> title = "configdir::ConfigDirectionModal â€” config direction UI";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/configdir.ts"; :>> name = "ConfigDirectionModal"; :>> kind = CodeElementKind::class;
        :>> codeHash = "sha256:1d3f8022fd9e95e9"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "The first-contact config direction modal; sets an intent consumed by the reconcile layer.";
        :>> pattern = DesignPattern::none;
    }
    part ceUiConfirm : CodeElement {
        :>> id = "70f7ab3b-d8a0-4bdd-83d9-1673645df074";
        :>> title = "confirm::confirmModal â€” in-app confirm dialog";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/confirm.ts"; :>> name = "confirmModal"; :>> kind = CodeElementKind::function;
        :>> codeHash = "sha256:634e0219549405fb"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "The styled in-app confirmation (replaced native confirm); presentational guard prompt.";
        :>> pattern = DesignPattern::none;
    }
    part ceUiAccount : CodeElement {
        :>> id = "9e5fd326-2874-468c-923c-ea5a83d79c54";
        :>> title = "accountui::AccountModal â€” account UI";
        :>> createdAt = "2026-07-18"; :>> createdBy = "ai";
        :>> file = "client/src/accountui.ts"; :>> name = "AccountModal"; :>> kind = CodeElementKind::class;
        :>> codeHash = "sha256:009a7c34bafa68f7"; :>> auditRound = "r2"; :>> auditedAt = "2026-07-18";
        :>> riskClass = RiskClass::cosmetic;
        :>> riskRationale = "Account management UI (password change, shares); presentational over the transport.";
        :>> pattern = DesignPattern::none;
    }
}

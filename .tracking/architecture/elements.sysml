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
}

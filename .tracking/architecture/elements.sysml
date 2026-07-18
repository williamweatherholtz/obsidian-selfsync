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

    // Coupling + STPA-input edge examples (illustrative; the full graph is authored in the per-element audit):
    #DependsOn dependency from ceReconcilePath to ceDecide;          // reconcilePath uses decide() (coupling)
    #Controls dependency from ceReconcilePath to ceVaultCommit;      // issues commit/delete control actions
    #Feedback dependency from ceContentStorePut to ceVaultCommit;    // reports store success/failure upward
}

// =====================================================================
// D0005 — replace CouchDB with a custom single-binary Rust sync server backed by a
// content-addressed chunk store. Backfilled record (D0004) of an architecture decision made
// during the build; serves Need goal2SimpleBackend / n2NoCouchDB.
// =====================================================================
package ProjectDecision0005 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0005 : Decision {
        :>> id = "ce554180-0c79-49aa-b6f8-5627a86065f6";
        :>> title = "D0005: no CouchDB — a single-binary Rust server with a content-addressed chunk store";
        :>> createdAt = "2026-07-02";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "obsidian-livesync's dependency on CouchDB is its single biggest operational burden: users must provision, secure, and maintain a database (Fly.io/self-host friction, replication quirks). Goal #2 requires a self-hosted backend that is simple to run and fast, without an external DBMS.";
        :>> decision = "Build a purpose-built sync server as one Rust (axum + tokio) binary that persists all state to its own filesystem: a content-addressed chunk store (blake3-sharded), a persistent JSON index (file->chunks, refcounts, version, tombstones), snapshot-rollback durability, startup orphan GC, and per-(user,vault) namespaces behind vault-scoped routes. No CouchDB, no external database.";
        :>> rationale = "ALTERNATIVES: (i) keep CouchDB/PouchDB — REJECTED: it is the very pain we set out to remove. (ii) use object storage (S3) as the backend — REJECTED for v1: adds a cloud dependency and complicates the single-binary self-host story. (iii) CHOSEN — an own-storage Rust binary: one artifact to run (container or exe), no DBMS to operate, native performance, full control of the dedup/merge protocol. CRITERIA: operational simplicity x self-host-ability x performance x protocol control.";
        :>> consequences = "We own durability and concurrency ourselves (addressed via RwLock per-vault + snapshot-rollback + verify_and_gc), rather than inheriting a database's guarantees. Distribution is a single binary/container. Server storage layout: DATA_ROOT/<user>/<vault>/{vault,.chunks,.sync-index.json}. Enables the dedup (n2Dedup) and concurrency (n2Performance) work.";
    }

    verification d0005Accept : Test {
        :>> id = "af9c8af1-16a4-46a7-9a7b-1bee23d2f84e";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz confirmed acceptance of d0005 (no CouchDB — a single-binary Rust server with a content-addressed chunk store) on 2026-07-04 via the explicit choice 'Accept all three' when the backfilled architecture decisions were presented for sign-off.";
    }
    part d0005AcceptR1 : TestResult { :>> id = "e4af1579-f1eb-451d-a4bf-e55bab87102f"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "3a9a827"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "wweatherholtz"; }
}

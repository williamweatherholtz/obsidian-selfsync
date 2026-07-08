// =====================================================================
// D0022 — AUTO-REINDEX on open where safe, replacing the "fail loud, require manual reindex" default.
// When a vault opens with an index that doesn't match its authoritative files/chunk store (empty
// index with files present — e.g. after the SQLite format change; a corrupt/unreadable DB; a dangling
// chunk reference recoverable from the bind-mount mirror), the server now rebuilds the index
// automatically and proceeds. It stays in ERROR only when a rebuild genuinely CAN'T fix it: files
// lost from BOTH disk and the chunk store (RC-2), or unsafe/colliding filenames — cases that need a
// human (Force, or fixing the names). Also: a one-click admin Reindex/Force per vault (with health
// surfaced) for that residue, instead of blind owner/vault text entry. Deliverable (server) change.
// Accepted 2026-07-08 by wweatherholtz ("i thought it would auto reindex" + chose "auto-repair where
// safe, fail-loud otherwise").
// =====================================================================
package ProjectDecision0022 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0022 : Decision {
        :>> id = "c0f1a5cc-f150-4a10-9b20-a1b2c3d40f60";
        :>> title = "D0022: auto-reindex on open where safe (fail-loud only when unrecoverable)";
        :>> createdAt = "2026-07-08";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The server opened a vault in a locked ERROR state — refusing all sync until an operator manually ran reindex — whenever the index didn't match the files on disk: an empty index with materialized files (which the SQLite index migration produced for EVERY pre-existing vault, since it did no data migration per 'nuke away'), a corrupt/unreadable index DB, or a referenced chunk missing on disk. That 'fail loud, require explicit repair' model dates to before tombstone-authoritative delete: the fear was that a blank/rebuilt index would be read by clients as 'the vault is empty → delete everything'. The owner hit NUMEROUS reindex errors (every pre-existing vault went ERROR at once on the SQLite upgrade) and expected auto-repair. Reindex's downsides are minor and self-correcting: it re-ingests files as whole-file chunks (transient dedup loss until a file is next edited — issueReindexSingleChunk), a corrupt rebuild raises the history floor (connected clients get the D0019 'history reset' notice + repopulate), and a one-time re-hash I/O cost; a HEALTHY reindex is cheaper still (keeps store content + tombstones, version-preserving).";
        :>> decision = "Auto-reindex on open where safe. When a vault is detected corrupt/empty-with-data, Vault::open now ATTEMPTS reindex(force=false) automatically; on success the vault opens clean (logged), on failure it STAYS in ERROR. The recoverable cases (empty index + files, corrupt DB quarantined + rebuilt from disk, a dangling chunk reference re-ingested from the bind-mount mirror) auto-repair. The vault stays ERROR only when the rebuild genuinely can't fix it: an indexed file missing from BOTH disk and the chunk store (RC-2 abort), or unsafe/colliding filenames on disk (InvalidInput abort) — a human must Force-drop the lost entries or fix the names. Additionally, surface each vault's health in the admin/My-vaults view with a one-click Reindex (and Force) button, replacing the blind owner/vault text-entry repair.";
        :>> rationale = "The 'fail loud' rationale is obsolete: since tombstone-authoritative delete (0.10.25) + the history horizon (D0019), a blank or rebuilt index can NO LONGER make a client delete anything — absence is never a deletion, only a real tombstone is, and a client repopulates from its own copy anything a rebuilt index is missing. So the danger the manual gate guarded against is gone, and auto-repair is safe. It is also the behavior the operator expects and vastly better UX (no per-vault manual step after a format change or a transient corruption). The chosen 'auto where safe, fail-loud otherwise' keeps a guard exactly where it still matters: a rebuild that would have to DROP provably-lost data, or that trips on filenames a rebuild can't reconcile, still stops for a human rather than silently discarding — so auto-repair never destroys anything a human didn't confirm. ALTERNATIVES CONSIDERED: (a) always auto-repair incl. force-dropping truly-lost files — DECLINED by the owner (silently drops provably-lost index entries without confirmation; slightly surprising). (b) keep manual, just make it one-click — DECLINED (still a manual step per vault for the common recoverable case the owner hit; doesn't meet the 'i thought it would auto reindex' expectation). Auto-repair is logged + surfaced in admin, so it is not invisible.";
        :>> consequences = "Tracked as autoReindex (delivery). Vault::open attempts reindex(false) when corrupt; open-behavior tests updated (empty-index-with-data and corrupt-DB-with-files auto-repair; a dangling ref recovers from the mirror; only a file lost from BOTH disk and store, or an unsafe name, stays ERROR). Admin: my_vaults surfaces per-vault health + a one-click Reindex/Force. Server-only (redeploy). doc-sync: deployment.md reindex note (auto-repairs on open; manual only for the unrecoverable residue). Resolves the operator-facing 'numerous reindex errors' friction.";
    }

    verification d0022Accept : Test {
        :>> id = "c0f1a5cc-f151-4a10-9b20-a1b2c3d40f61";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz, on learning the server did NOT auto-reindex ('i thought it would auto reindex, no?') and asking why numerous reindex errors occurred + whether reindex has significant downsides, chose (2026-07-08) 'Auto-repair where safe, fail-loud otherwise' over 'always auto-repair incl. force-drop' and 'keep manual, one-click'.";
    }
    part d0022AcceptR1 : TestResult { :>> id = "c0f1a5cc-f152-4a10-9b20-a1b2c3d40f62"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "fe14aa1"; :>> judgedAt = "2026-07-08"; :>> judgedBy = "wweatherholtz"; }
}

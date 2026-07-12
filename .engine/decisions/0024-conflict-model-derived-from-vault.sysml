// =====================================================================
// D0024 — conflict tracking: ONE model, views derived, nothing patched after the fact. Note conflicts
// are DERIVED PURELY FROM THE VAULT (the conflict-copy file IS the record); config conflicts stay a
// reconcile-refreshed store. Fixes the dual-source-of-truth that caused stale entries, dual-truth
// counts, "File does not exist", and the blank modal. Accepted 2026-07-12 by wweatherholtz
// ("architect the code better so conflict tracking is done robustly" + chose "Pure vault derivation").
// =====================================================================
package ProjectDecision0024 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0024 : Decision {
        :>> id = "0d24b28f-6d52-4b34-a021-3f8c7d1b3402";
        :>> title = "D0024: conflict state is DERIVED, not cached — note conflicts are their vault files";
        :>> createdAt = "2026-07-12";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "Conflict state had TWO sources of truth kept in sync by side-effect callbacks during reconcile: persisted arrays (settings.noteConflicts / settings.configConflicts) AND the real vault files (the '(conflict …)' copies). The UI read the arrays, not reality. They drifted — the array said 15 while the files said 0 (dual-truth count); an already-removed copy stayed listed then threw 'File does not exist' on resolve, aborting the whole modal (blank body); listNoteConflicts prune-on-read and resolveNoteConflict catch-on-write were band-aids ON the cache. Note and config conflicts were two parallel ad-hoc systems. The user diagnosed it as weak state structure causing 'surprises' and asked for a holistic re-architecture where the views fall out of the data.";
        :>> decision = "Make conflict state DERIVED, with one authoritative source per kind and every view a pure projection. NOTE conflicts: pure vault derivation (deriveNoteConflicts over the vault file list) — a note conflict IS an owned conflict-copy file, recognized by the strict naming scheme (<orig> (conflict <device> <14-digit-ts>[-hash])<ext>, validated by originalOfConflictCopy); NO persisted array (settings.noteConflicts retired). CONFIG conflicts (no artifact by design — never written as copies): keep a small store (settings.configConflicts) that the reconcile is the SOLE writer of and RE-EVALUATES every pass (raise/clear), self-healing. The list, count, badge, and modal are ALL computed from these sources at render time — never a separately-maintained number. Resolution is total/idempotent: resolving a conflict whose copy is already gone is a no-op success (io.remove no-ops, the 'mine' promote guards existence), never a throw. Detection stays content-aware (sameIgnoringEol) so cosmetic line-ending diffs never raise.";
        :>> rationale = "The dual-source cache was the root cause of every conflict 'surprise'; a cache that must be kept in sync with the vault by side effects WILL drift. Deriving from the vault removes the cache entirely for notes — the thing the user SEES (the copy files) is the single truth, so the count/list/modal cannot disagree with it or reference a vanished file. The FORK (offered to the user) was ownership: (a) keep a persisted ownership index + derive, vs (b) PURE vault derivation recognized only by the naming scheme. The user chose (b) for the cleanest 'views fall out of the vault', accepting that a user's own file named to EXACTLY match the strict scheme (base + ' (conflict <device> <14-digit timestamp>)' + ext) could be treated as a copy; the 14-digit-timestamp requirement makes accidental collision effectively impossible, and resolution only ever deletes the COPY (the note is never destroyed) and is shown in the diff first. Config can't be derived from an artifact (there is none — writing config copies is exactly what crashed sync pre-0.10.4), so it stays a reconcile-refreshed store. This mirrors the engine's own first principle — text/state is truth, everything else is a computed view — applied to the deliverable.";
        :>> consequences = "settings.noteConflicts is removed (loadSettings drops it; old persisted values are ignored — existing on-disk copies are re-derived, so no migration and nothing orphaned). recordNoteConflict/clearNoteConflict deleted; onConflict just logs + refreshes the projected count. listNoteConflicts = deriveNoteConflicts(vault file paths). resolveNoteConflict is idempotent. The NoteConflictModal auto-dismiss is per-entry isolated. A user file matching the exact strict conflict-copy scheme would be listed as a conflict (accepted tradeoff). Config-conflict handling is unchanged in storage but is documented as the reconcile-refreshed store half of the one model. Net: the classes of bug — stale entries, dual-truth counts, 'File does not exist' on resolve, blank modal — are eliminated by construction rather than patched.";
    }

    verification d0024Accept : Test {
        :>> id = "0d24acc7-2b33-4c44-9d55-6e7f80912303";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed the re-architecture ('we need a way better holistic design for conflict tracking … architect the code better so conflict tracking is done robustly, and the display and views fall out correctly from the data and we're not trying to patch the conflict data after the fact', 2026-07-12) and, when offered the source-of-truth fork, selected 'Pure vault derivation' — authorizing note conflicts to be derived purely from the vault's conflict-copy files with no persisted array.";
    }
    part d0024AcceptR1 : TestResult { :>> id = "0d24ac00-ab22-4c33-9d44-5e6f70819304"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "208d85b"; :>> judgedAt = "2026-07-12"; :>> judgedBy = "wweatherholtz"; }
}

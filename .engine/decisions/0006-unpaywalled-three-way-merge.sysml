// =====================================================================
// D0006 — resolve concurrent edits with a base-aware three-way merge that never silently
// clobbers, and gate none of it behind payment. Backfilled record (D0004) of an architecture
// decision made during the build; serves Need goal3ConflictMerge.
// =====================================================================
package ProjectDecision0006 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0006 : Decision {
        :>> id = "c04237e8-2d75-4a9b-9336-16c5b82d951d";
        :>> title = "D0006: un-paywalled three-way merge + never-clobber conflict-copy";
        :>> createdAt = "2026-07-03";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "obsidian-livesync gates its strongest conflict/diff-merge behind sponsorship, and last-write-wins loses data. Goal #3 requires strong conflict resolution that (a) merges non-conflicting concurrent edits, (b) never silently loses data, and (c) is free for everyone.";
        :>> decision = "The client keeps a per-file base (last-synced ancestor) and reconciles via a pure decision table (decide): equal->in-sync, one-sided->push/pull, both-changed-with-base->three-way (diff3) merge, and no-common-base or unmergeable/binary->conflict-copy that preserves BOTH versions. No branch ever overwrites when both sides changed. Every capability ships free — no licence check, sponsorship gate, or feature flag.";
        :>> rationale = "ALTERNATIVES: (i) last-write-wins — REJECTED: silent data loss. (ii) CRDT text — REJECTED for v1: heavier and unnecessary for note-scale three-way merge. (iii) CHOSEN — base-aware diff3 with conflict-copy fallback: merges the common case, and when unsure keeps both rather than guessing. Free-for-all is a deliberate differentiator vs LiveSync. CRITERIA: never-lose-data x auto-merge-the-easy-case x testable pure logic x no paywall.";
        :>> consequences = "The client must persist a base store and carry it correctly across operations (this is exactly why the vault-switch bug — stale base — mattered, fixed in 0.6.0). Conflict copies surface to the user by filename. The decision logic is a pure, unit-tested module (reconcile.decide + merge3).";
    }

    verification d0006Accept : Test {
        :>> id = "1296da13-1203-403e-819e-1124fc8f0858";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz confirmed acceptance of d0006 (un-paywalled three-way merge + never-clobber conflict-copy) on 2026-07-04 via the explicit choice 'Accept all three' when the backfilled architecture decisions were presented for sign-off.";
    }
    part d0006AcceptR1 : TestResult { :>> id = "bf54e482-b716-45ca-a4bf-e12624549602"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "3a9a827"; :>> judgedAt = "2026-07-04"; :>> judgedBy = "wweatherholtz"; }
}

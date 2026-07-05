// =====================================================================
// D0010 — scope B9 (durability/streaming): build the append-only index JOURNAL now; DEFER
// streamed reassembly. B9 bundled two independent problems; walking the remaining needs the
// owner chose the journal (large note-vault write cost) and deferred streaming (not hitting
// the large-file memory ceiling). Design: specs/2026-07-05-durability-streaming-design.md.
// Accepted 2026-07-05 by wweatherholtz ("Journal matters (large vault)").
// =====================================================================
package ProjectDecision0010 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0010 : Decision {
        :>> id = "fe30a04c-c57a-48d9-96b0-eca925b9f35b";
        :>> title = "D0010: B9 — build the index journal now, defer streamed reassembly";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "B9 combined two unrelated problems: (A) the server rewrites the whole .sync-index.json on every change (O(index) per mutation — costly for large vaults), and (B) file reassembly holds the whole file in RAM (the reason for the 200 MiB size gate; a mobile-memory risk). Both touch the data-integrity path, so they were designed before building. Walking the remaining needs, the owner weighed which actually bites.";
        :>> decision = "Build Part A (append-only index journal) now — a large note vault pays the per-change rewrite cost. DEFER Part B (streamed reassembly): the owner isn't syncing large attachments, so the 200 MiB gate + in-memory reassembly are fine for now. Part B is tracked as the streamingReassembly task with its design retained (specs/2026-07-05-durability-streaming-design.md).";
        :>> rationale = "Journal = high value (cheaper large-vault writes + crash-safe replay), low risk (absolute records + recomputed chunk_refs make it delta-free). Streaming = real risk on the reassembly path for a benefit the owner isn't hitting, so shelve the higher-risk change rather than build speculatively. ALTERNATIVES: build both (rejected — streaming risk without payoff), streaming-only (rejected — journal is what bites), defer both (rejected — the journal win is real now).";
        :>> consequences = "The append-only journal ships (server-only; deployed as the Rust binary, not via BRAT). streamingReassembly stays open (deferred) with its design; the 200 MiB client size gate remains until streaming lands. No client/protocol change.";
    }

    verification d0010Accept : Test {
        :>> id = "31fc4a45-a6a4-4e91-a33f-0eda112d0333";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz chose 'Journal matters (large vault)' on 2026-07-05 when walked through the remaining needs — build the index journal, defer streamed reassembly.";
    }
    part d0010AcceptR1 : TestResult { :>> id = "59b57342-a87e-4530-a0af-56f3620fbc04"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "2b42a58"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "wweatherholtz"; }
}

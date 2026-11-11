// D0116 (PROPOSED — NOT YET ACCEPTED) — The server's same-file rule folds Unicode normalisation (NFC) before case
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0116Accept event on sign-off.
package Decision0116 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0116 : Decision {
        :>> id = "e81c032c-56e9-4925-a50a-73f981c5296b";
        :>> title = "The server's same-file rule folds Unicode normalisation (NFC) before case";
        :>> createdAt = "2026-11-11";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "issue006 (2026-09-29): the server index stores fold = path.to_lowercase() and refuses a commit whose fold matches an existing key. It does not normalise Unicode. An NFC and an NFD spelling of one name commit as two files. A macOS or iOS device treats them as one file and holds both until one is removed. The client already folds NFC on macOS and iOS (pathIdentityFailLoud, st004 and st005).";
        :>> decision = "One function computes the server fold key: NFC-normalise the path, then to_lowercase. It is used by insert_file, colliding_key, the fold backfill and the reindex collision scan. Schema version 5 recomputes every fold row with that function on open. Rows that already collide under the new rule are kept and logged as a warning, never dropped. The commit refusal names the Unicode form in its message.";
        :>> rationale = "A single fold function keeps the write path, the guard and the migration in lockstep, the same lesson as the ASCII-only backfill defect. NFC before lower-case is the rule macOS and iOS apply, so the server refuses the state that those devices cannot hold. A migration that dropped a row would destroy a note the owner may still need, so twins are reported, not resolved.";
        :>> consequences = "Existing twin rows survive the upgrade and still hold on a Mac until one is removed by hand. The server gains the unicode-normalization crate. The client error text changes from 'differing only in case' to 'differing only in case or Unicode form'.";
    }
}

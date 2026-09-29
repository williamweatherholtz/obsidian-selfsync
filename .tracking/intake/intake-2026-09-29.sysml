// Intake for 2026-09-29 — their words, my translation, the triage verdict (D0166/D0216).
// Written by `keel record statement` / `keel record story` (D0236): a Statement's text is
// VERBATIM, so it is escaped for the literal and otherwise untouched.
package ProjectIntake20260929 {
    private import EngineElement::*;
    private import EngineIntake::*;
    private import EngineRelationships::*;

    part st002 : Statement {
        :>> id = "eb4b1adb-9e53-46a0-8089-7b7f851acbb3";
        :>> title = "Status light still stalls on Syncing";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> text = "still get the ''selfsync - syncing...'' stall on the update icon in the IDE.  has root cause been identified?";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-09-29"; :>> channel = StatementChannel::console;
    }

    part us002 : UserStory {
        :>> id = "24677eeb-720f-4dd5-ba8b-b067656aab9c";
        :>> title = "Status indicator leaves Syncing once sync completes";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> asA = "SelfSync user";
        :>> iWant = "the SelfSync status indicator to leave the Syncing state once the vault has finished syncing, instead of staying on 'SelfSync - Syncing...'";
        :>> soThat = "the indicator only says Syncing while something is actually syncing";
        :>> implication = ImplicationKind::bug;
        :>> triageNote = "bug, not designChange: the owner describes observed behaviour ('still get ... stall') that contradicts the indicator's existing contract (a pure projection of the sync FSM, statusDisplayPureProjection). 'still' says it recurs after earlier status fixes. Reading 'update icon in the IDE' as the Obsidian status-bar / editor sync indicator is MY interpretation, not their words. No repeatable reproduction exists yet: the one run of client/e2e-obsidian/statuslatch.pwspec.ts on 2026-09-25 never synced (trail ['0.0s connecting']). Route to an Issue once a run of that probe gives a repeatable result.";
    }
    #DerivedFrom dependency from us002 to st002;

    part us003 : UserStory {
        :>> id = "1f84a2d0-9243-4d89-a3ed-283c6553ebcc";
        :>> title = "Has the Syncing stall root cause been found";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> asA = "SelfSync owner";
        :>> iWant = "to know whether the root cause of the Syncing stall has been identified";
        :>> implication = ImplicationKind::question;
        :>> triageNote = "question, not bug: this second clause asks for an answer and requests no change by itself. Answered in the same session (2026-09-29): no. No tracked item covered the report, and the latch probe had no recorded result. The change it implies is carried by the sibling bug story.";
    }
    #DerivedFrom dependency from us003 to st002;
    #Implicates dependency from us002 to issue005;
}

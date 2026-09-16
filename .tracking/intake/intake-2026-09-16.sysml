// Intake for 2026-09-16 — their words, my translation, the triage verdict (D0166/D0216).
// Written by `keel record statement` / `keel record story` (D0236): a Statement's text is
// VERBATIM, so it is escaped for the literal and otherwise untouched.
package ProjectIntake20260916 {
    private import EngineElement::*;
    private import EngineIntake::*;
    private import EngineRelationships::*;

    part st001 : Statement {
        :>> id = "71c034ce-4533-4344-bffb-8386e12895aa";
        :>> title = "The UI must be null or honest, never inaccurate";
        :>> createdAt = "2026-09-16"; :>> createdBy = "claudeOpus";
        :>> text = "ok that's fine.  I don't want to be pedantic, i just want the UI to be null or honest, not inaccurate.";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-09-16"; :>> channel = StatementChannel::chat;
    }

    part us001 : UserStory {
        :>> id = "f6db4579-50ad-4faa-8fdb-db871e6e9abd";
        :>> title = "A status surface is honest or silent, never inaccurate";
        :>> createdAt = "2026-09-16"; :>> createdBy = "claudeOpus";
        :>> asA = "vault owner relying on sync";
        :>> iWant = "every status surface to show either the true state or NOTHING (an explicit unknown), and never a state that is not true - a green Fully synced over an unsynced change is worse than no indicator at all, and precision of wording matters less than never asserting something false";
        :>> soThat = "I can trust the indicator without verifying it, so I do not have to open the log or the settings card to find out whether my edit actually reached the server";
        :>> implication = ImplicationKind::need;
        :>> triageNote = "Stated as a standing UX principle, not a bug report, so it governs every current and future status surface: the status bar, the ribbon, the editor icon, the settings status hero, the busy gate and the Diagnose affordance. It DECIDES the residual left open on keystrokeLatencyIndicator (a path event from a source other than the editor runs its pre-flight under the previous, possibly green, phase) in favour of raising the indicator for any locally-originated change - and it is the same rule already recorded in issueDiagnoseFalseAllClear (a FALSE all-good) and issueStatusIndicatorMisleads. Implication need: it constrains the product, is not satisfied by one code change, and downstream requirements should derive from it.";
    }
    #DerivedFrom dependency from us001 to st001;
}

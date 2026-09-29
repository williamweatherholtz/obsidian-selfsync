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

    part st003 : Statement {
        :>> id = "da1f4c80-1f93-49dd-8558-8a15d1ff43e6";
        :>> title = "1.30.35 seemed to solve the Syncing latch";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> text = "seemed to sovle the issue. nj";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-09-29"; :>> channel = StatementChannel::console;
    }

    part us004 : UserStory {
        :>> id = "009e932e-7ea4-419e-ab1e-056d69a64e4a";
        :>> title = "Owner reports 1.30.35 stopped the Syncing latch";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> asA = "SelfSync owner";
        :>> iWant = "the Syncing latch to be gone on my own vault after installing 1.30.35";
        :>> implication = ImplicationKind::attestation;
        :>> triageNote = "attestation, not correction or bug: the owner reports field behaviour after installing 1.30.35 on the vault where they saw the latch. 'seemed to' is their hedge and is kept - this is an observation that the symptom stopped, not a sign-off on any specific claim, so it records no confirmation TestResult. It is the first field evidence that the case-alias mechanism in issue005 was the cause on their vault, which the Issue recorded as not verified.";
    }
    #DerivedFrom dependency from us004 to st003;
    #Implicates dependency from us004 to issue005;

    part st004 : Statement {
        :>> id = "5d426c9b-1fe3-43c6-8699-a81a1db94a97";
        :>> title = "Path case handling: assert, log, fail early and loud";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> text = "this issue, case mismatching between server and client, and intelligent handlign of it, has bitten us multiple times now.  Identify relevant functions that handle pathnames, put in proper debugigng logs to indicate if assertiosn are failing (or just !assert ?), and otherwise make our program fail early and fail loud to issues.";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-09-29"; :>> channel = StatementChannel::console;
    }

    part us005 : UserStory {
        :>> id = "b7dadf7a-69ac-40b7-bd0f-b67853069613";
        :>> title = "Path identity checks itself and fails loud";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> asA = "SelfSync owner";
        :>> iWant = "every function that decides path identity (case folding, aliasing, keying) to check its own assumptions, log a violated one loudly, and fail early instead of carrying a silent mismatch";
        :>> soThat = "a path-identity mismatch shows up the moment it happens, with the path and the site named, instead of surfacing weeks later as a latch, a phantom delete or a duplicate";
        :>> implication = ImplicationKind::implementationChange;
        :>> triageNote = "implementationChange, not bug or designChange: no single new defect is reported. The ask is instrumentation and fail-fast behaviour across existing path-handling code, and the recurrence it cites is real: about ten recorded case or path-identity issues (issueCasePathDivergence, issueCaseRenamePairDeletesOnFoldingPeer, issueFoldBackfillAsciiOnly, issueMountCaseSensitiveClaimMismatch, issueNoncanonicalPath, issueSelfFolderCase, issueUnicodeCaseCollision, issueUserCaseCollision, issueUsernameNotCanonicalized, issueBootstrapSyncUserNotLowercased) plus issue005. 'fail early and fail loud' is a direction; how loud in production (throw, halt the pass, or log plus surface) is left open for the owner, since halting sync on a detected mismatch trades one failure for another.";
    }
    #DerivedFrom dependency from us005 to st004;

    part st005 : Statement {
        :>> id = "13c3d681-b816-4538-b06a-608d44f0f5ce";
        :>> title = "Path-identity violation policy on a device";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> text = "Loud, halt only risky writes (Recommended)";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-09-29"; :>> channel = StatementChannel::console;
    }

    part us006 : UserStory {
        :>> id = "30474354-c948-41ad-a8d4-c73ad7ce2193";
        :>> title = "Violation policy: loud, halt only the risky write";
        :>> createdAt = "2026-09-29"; :>> createdBy = "claudeOpus";
        :>> asA = "SelfSync owner";
        :>> iWant = "a path-identity violation on a real device to be logged as an ERROR and shown once, with sync continuing except for the delete or overwrite of the ambiguous path, while tests and CI throw";
        :>> implication = ImplicationKind::designChange;
        :>> triageNote = "designChange, not attestation: the owner picked one of three offered failure policies (the labelled option text is recorded verbatim, including its Recommended tag, since that is exactly what they selected). It fixes how loud and how blocking the us005 checks are on a device. The option description they selected read: Tests and CI throw on every violation. On a device: log an ERROR naming the site and both spellings, and show it once on the status card. Sync continues, except that a delete or overwrite on an ambiguous path is refused for that path only. Deviation to record: the once-only surface is a Notice, not the status card, because the card shows link state (lastIssue) and a held file is not a link failure.";
    }
    #DerivedFrom dependency from us006 to st005;
    #Implicates dependency from us005 to pathIdentityFailLoud;
    #Implicates dependency from us006 to pathIdentityFailLoud;
}

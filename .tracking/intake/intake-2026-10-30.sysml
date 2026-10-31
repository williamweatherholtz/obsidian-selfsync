// Intake for 2026-10-30 — their words, my translation, the triage verdict (D0166/D0216).
// Written by `keel record statement` / `keel record story` (D0236): a Statement's text is
// VERBATIM, so it is escaped for the literal and otherwise untouched.
package ProjectIntake20261030 {
    private import EngineElement::*;
    private import EngineIntake::*;
    private import EngineRelationships::*;

    part st006 : Statement {
        :>> id = "06cd85bc-bd65-456d-b6f3-b682093ecf8e";
        :>> title = "Glyph basically always yellow; is it accurate or wrong; second clone double-dipping";
        :>> createdAt = "2026-10-30"; :>> createdBy = "ai";
        :>> text = "is there another selfsync folder somewhere?  e.g. ../obsidian-livesync? Don't want to be double-dipping here.\n\nRegardless, the self-sync glyph in the IDE is basically always yellow.  Not sure why, but it seems incorrect.  Can we differentiate whether it's accurate or whether it's wrong?  I don't think we're really spending a lot of time syncing - i'm barely writing any changes and it stays ''Selfsync...syncing''.  Help me get through";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-10-30"; :>> channel = StatementChannel::console;
    }

    part st007 : Statement {
        :>> id = "bac55796-5c69-4b9f-926f-cf8e70fd87d0";
        :>> title = "Fix with TDD and e2e tests";
        :>> createdAt = "2026-10-30"; :>> createdBy = "ai";
        :>> text = "Fix with TDD, e2e tests";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-10-30"; :>> channel = StatementChannel::console;
    }

    part us007 : UserStory {
        :>> id = "a9916873-6db3-46bc-b2a8-d5b846789111";
        :>> title = "Is there a second clone of this repo on this machine";
        :>> createdAt = "2026-10-30"; :>> createdBy = "ai";
        :>> asA = "SelfSync owner";
        :>> iWant = "to know whether a second checkout of this repo exists on this machine (for example ../obsidian-livesync), so that work is not spread across two clones";
        :>> implication = ImplicationKind::question;
        :>> triageNote = "question, not process: the first clause asks for a fact and requests no change by itself. Answered in the same session (2026-10-30): yes. ../obsidian-livesync is a second clone of the same remote at the same HEAD 219ecf4, with the keel actor bound (claudeOpus), the commit gate armed, and 123 lines of uncommitted work from 2026-09-21..29 (deferBufferDirty / editorBufferDiffers, two new e2e specs) that the installed 1.31.0 main.js does not contain. This clone had no .keel binding at all. Which clone to keep is the owner's call and is not made here.";
    }
    #DerivedFrom dependency from us007 to st006;

    part us008 : UserStory {
        :>> id = "3135b451-0591-405a-a3fa-2231d41c0a38";
        :>> title = "Glyph is yellow only while an edit of mine is genuinely unsynced";
        :>> createdAt = "2026-10-30"; :>> createdBy = "ai";
        :>> asA = "SelfSync user";
        :>> iWant = "the SelfSync glyph to be yellow only while an edit of mine is genuinely not yet on the server, and to return to green once it is, instead of sitting on 'Selfsync...syncing' while I am barely writing";
        :>> soThat = "the indicator only says Syncing while something of mine is actually not on the server";
        :>> implication = ImplicationKind::bug;
        :>> triageNote = "bug, not designChange: the owner describes observed behaviour on their vault ('basically always yellow', 'it stays Selfsync...syncing') that contradicts the indicator's contract (yellow = real pending work or an in-scope edit the server has not seen). It recurs after the issue005 fix shipped in 1.30.35/1.31.0 (us002/us004 on 2026-09-29). Evidence read 2026-10-30 from the vault's info-level log and the server change feed: 339 'remote change -> reconciled' lines in bursts at ~2 s spacing, every one of which is this laptop's own autosave echoing back (all 30 upserts since v12882 carry deviceId 9b1934cf..., the vault's own). So during note-taking the yellow is honest by design (a keystroke claim lasts up to 15 s, a painted syncing is held 2.5 s). Whether it ALSO stays yellow while idle cannot be read from an info log: the claim-raised syncing paints no detail (main.ts:1977 returns an empty detail when syncPending is 0) and logs nothing. Routed with us009 to one action: make the yellow name its holder, and re-run the latch probe against 1.31.0.";
    }
    #DerivedFrom dependency from us008 to st006;

    part us009 : UserStory {
        :>> id = "a8dc54f4-a1ea-4274-ad54-540e0bfbe51c";
        :>> title = "A yellow light says what holds it, so accurate and wrong can be told apart";
        :>> createdAt = "2026-10-30"; :>> createdBy = "ai";
        :>> asA = "SelfSync owner";
        :>> iWant = "a way to tell, from the indicator itself and from the log, whether a yellow 'Syncing...' is accurate (a named edit or transfer is outstanding) or wrong (nothing is outstanding and the light is latched)";
        :>> soThat = "a latch can be attributed to a path from the surface or the log, instead of inferred";
        :>> implication = ImplicationKind::implementationChange;
        :>> triageNote = "implementationChange, not bug: this clause asks for a diagnostic property the surface does not have today, independent of whether a latch exists. 'Honest or silent, never inaccurate' is the owner's standing rule (st001/us001); a bare 'Syncing...' with no count and no path asserts work without evidence, which is neither. The change: when unsynced-edit claims raise the light, the status detail and tooltip name the claimed paths and their age; a disk-backed claim that outlives a bound with no pass settling it is logged at info/warn with its path, so the next report carries the holder's name instead of a guess. The log line that labels this device's own echoed saves as 'remote change' is corrected in the same change (it misled this investigation).";
    }
    #DerivedFrom dependency from us009 to st006;

    part us010 : UserStory {
        :>> id = "864a7113-17d1-4a47-bf11-91c0dd39ffea";
        :>> title = "Fix test-first and verify end to end in real Obsidian";
        :>> createdAt = "2026-10-30"; :>> createdBy = "ai";
        :>> asA = "SelfSync owner";
        :>> iWant = "the fix to be driven test-first (a failing unit test before each change) and to be verified end to end against real Obsidian and a real server, not only by headless unit tests";
        :>> implication = ImplicationKind::process;
        :>> triageNote = "process, not implementationChange: the owner constrains HOW the fix is made and verified, not what it does. Bound into the action's DoD: each unit test is recorded RED before its change; client/e2e-obsidian/statuslatch.pwspec.ts gains an arm for the self-explaining detail and all arms are run against the built plugin, with the trail quoted in the result's evidence.";
    }
    #DerivedFrom dependency from us010 to st007;
    #Implicates dependency from us008 to statusLightSelfExplaining;
    #Implicates dependency from us009 to statusLightSelfExplaining;
    #Implicates dependency from us010 to statusLightSelfExplaining;
}

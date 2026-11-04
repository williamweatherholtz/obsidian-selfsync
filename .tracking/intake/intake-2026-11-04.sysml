// Intake for 2026-11-04 — their words, my translation, the triage verdict (D0166/D0216).
// Written by `keel record statement` / `keel record story` (D0236): a Statement's text is
// VERBATIM, so it is escaped for the literal and otherwise untouched.
package ProjectIntake20261104 {
    private import EngineElement::*;
    private import EngineIntake::*;
    private import EngineRelationships::*;

    part st008 : Statement {
        :>> id = "8e638c79-7d7b-416e-8d9f-18b40f88aa73";
        :>> title = "SelfSync regurgitates the same 11 unsynced items";
        :>> createdAt = "2026-11-04"; :>> createdBy = "ai";
        :>> text = "selfsync keeps regurgitating the same 11 unsynced items over and over again.  why?";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-04"; :>> channel = StatementChannel::console;
    }

    part us011 : UserStory {
        :>> id = "8ee23078-9e9c-48ce-a6ac-b9985f6bafb6";
        :>> title = "The same eleven unsynced items recur without any edit";
        :>> createdAt = "2026-11-04"; :>> createdBy = "ai";
        :>> asA = "SelfSync user";
        :>> iWant = "the unsynced-edit list to name only edits I or a plugin actually made, and never the same eleven .obsidian folders again and again when nothing in them changed";
        :>> soThat = "a yellow light means an outstanding change, not a watcher artefact";
        :>> implication = ImplicationKind::bug;
        :>> triageNote = "bug, not designChange: the owner reports observed behaviour (the same eleven items, repeatedly, with no edit) that the 1.32.0 detail made visible. Every item is a FOLDER under .obsidian (eight synced plugin folders, two themes), never a file. Found 2026-11-04, check named: client/e2e-obsidian/configclaim.pwspec.ts ARM B against real Obsidian 1.12 on Windows 11 with NTFS last-access updates enabled (fsutil behavior query disablelastaccess = 2). Listing a synced plugin folder whose stored last-access time is over an hour old, with no write, makes Obsidian emit raw with the FOLDER path (eight events for five listings); the plugin records an unsynced-edit claim for the folder, a change nobody made. A connected per-path pass settles it in about a second (corrected by the panel 2026-11-04; the first note said no pass can settle it). The config scan lists every synced folder at most every 30 s, so the claims recur as NTFS persists each folder's access time. Routed to issue007 and its resolver.";
    }
    #DerivedFrom dependency from us011 to st008;
    #Implicates dependency from us011 to issue007;
}

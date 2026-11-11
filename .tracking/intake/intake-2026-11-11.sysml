// Intake for 2026-11-11 — their words, my translation, the triage verdict (D0166/D0216).
// Written by `keel record statement` / `keel record story` (D0236): a Statement's text is
// VERBATIM, so it is escaped for the literal and otherwise untouched.
package ProjectIntake20261111 {
    private import EngineElement::*;
    private import EngineIntake::*;
    private import EngineRelationships::*;

    part st010 : Statement {
        :>> id = "4653ad7b-c506-4133-8222-af569f7cf66c";
        :>> title = "No iOS KDF measurement, proceed";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "Not gonna do ios. Proceed";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part st011 : Statement {
        :>> id = "32ed5f6e-a419-4444-ad94-33e7bd122b08";
        :>> title = "Assume iOS KDF cost similar to Android";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "Assume similar";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part us015 : UserStory {
        :>> id = "b905b352-76fa-47b9-b4af-f0a30464c6da";
        :>> title = "Ship the KDF default on the Android Measurement alone";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> asA = "SelfSync owner";
        :>> iWant = "the encryption password cost fixed from my one Android timing, with iOS assumed similar, and the Encrypt option released";
        :>> soThat = "the feature ships now instead of waiting on an iOS measurement I will not run";
        :>> implication = ImplicationKind::scopeConstraint;
        :>> triageNote = "scopeConstraint: D0112 asked for four Measurements on two devices. The owner drops the iOS device and the memory readout (st010, st011). The route is a default Decision that depends on d0112 and states the amended basis, D0115, proposed by the AI. Acceptance stays the owner's explicit sign-off, which the build check reads. The define flip and the release follow that acceptance in this sprint.";
    }
    #DerivedFrom dependency from us015 to st010;
    #DerivedFrom dependency from us015 to st011;
    #Implicates dependency from us015 to d0115;

    part st012 : Statement {
        :>> id = "17326f85-d1d5-458f-abbf-231c98136a6d";
        :>> title = "D0115 accepted";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "115 accepted";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part st013 : Statement {
        :>> id = "fee2337a-db64-4406-a8d1-22560fb040c6";
        :>> title = "More local testing: a test vault, encryption on, measured, real e2e, never the owner's real vaults";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "you need to do more local testing, create a test vault, try encryption, measure.   i can make a test vault on the real server if you need. want real e2e testing, not with my real vaults.";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part us016 : UserStory {
        :>> id = "6ac53e01-08e6-41a6-a6b5-d5ed6d470753";
        :>> title = "Real end-to-end test of an encrypted vault through real Obsidian, measured, on a throwaway vault";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> asA = "SelfSync owner";
        :>> iWant = "the Encrypt feature driven through the real plugin in real Obsidian on two devices against a real server, with a throwaway test vault, the server volume checked for plaintext, and the key derivation and sync times measured";
        :>> soThat = "I know the shipped 1.34.0 works end to end before I touch my real vaults";
        :>> implication = ImplicationKind::verifiedRequirement;
        :>> triageNote = "verifiedRequirement: E4 proved the E2EE engine against the real server through the test transport, not through the plugin in Obsidian (E4 result R1 named that deviation). The route is a delivery sprint under d0112 whose task verifies srE2eeServerNeverSeesPlaintext and srE2eeDedupPreserved through the real-Obsidian Playwright layer, plus Measurements of the desktop KDF and the encrypted convergence time. The owner's real vaults are never touched: the spec spawns its own server and vault, and the optional real-server mode creates and deletes a vault named for the run.";
    }
    #DerivedFrom dependency from us016 to st013;

    part st014 : Statement {
        :>> id = "ca631c6f-f050-4907-a5ed-bdda49b23ac0";
        :>> title = "Owner makes the AI an account on the containerized server for the real-server e2e run";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "i'll just make you an account, you're presumign i have this running on a desktop when it's containerized on a server.";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part st015 : Statement {
        :>> id = "aaf197e4-bd43-4ae3-bf5d-e867d75c59af";
        :>> title = "Owner wants a short summary and next steps, not narrative";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "too much talk, not enough clear summary and next steps.";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part st016 : Statement {
        :>> id = "63e08c4c-3b79-47e8-b9d1-8eb8fb7ec4f1";
        :>> title = "Find the 62 s cause before any release, skip the sitting review, continue until the issues are resolved";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "Find the 62s cause before cutting a problematic release.\n\nIgnore sprint review acceptance - continue until issues are resolved";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part us017 : UserStory {
        :>> id = "3e851630-e7a2-4240-b9ed-7756bba52188";
        :>> title = "Find and fix the 62 second live change latency against the real server before any release";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> asA = "SelfSync owner";
        :>> iWant = "the cause of the 62 second live change latency on my containerized server named from evidence and fixed, before 1.34.1 is cut";
        :>> soThat = "the release I update my devices to is not a problematic one";
        :>> implication = ImplicationKind::bug;
        :>> triageNote = "bug: issue020 already tracks the latency with the resolver task e2eeRemoteLiveLatency. The route is sprint 8 on that task, chartered by d0096. The owner also waives the per-sitting review until the open issues are resolved, which is recorded here as their words and not as a process change.";
    }
    #DerivedFrom dependency from us017 to st016;

    part st017 : Statement {
        :>> id = "10c236a5-295b-4113-a631-60d9680bc669";
        :>> title = "Owner redid the server, asks for the full test run again";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "just redid server.  try full test suite again? seems to be no issue but this is a new version now";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part st018 : Statement {
        :>> id = "9ab73700-4a49-4235-aa3a-1ef236b140a0";
        :>> title = "Owner confirms a server restart near 17:33 UTC, the window of the 62 second run";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "yes i restarted";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part st019 : Statement {
        :>> id = "9fa7691e-e70c-4edc-8a64-60e96680e433";
        :>> title = "Owner accepts the restart recovery latency as a risk and says continue";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "accept risk is fine.  continue";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }

    part st020 : Statement {
        :>> id = "bef3d176-f4fe-4dcb-8660-97551018ef30";
        :>> title = "Owner says take the next ready frontier item";
        :>> createdAt = "2026-11-11"; :>> createdBy = "ai";
        :>> text = "go ahead with next frontier";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-11"; :>> channel = StatementChannel::console;
    }
}

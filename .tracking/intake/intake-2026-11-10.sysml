// Intake for 2026-11-10 — their words, my translation, the triage verdict (D0166/D0216).
// Written by `keel record statement` / `keel record story` (D0236): a Statement's text is
// VERBATIM, so it is escaped for the literal and otherwise untouched.
package ProjectIntake20261110 {
    private import EngineElement::*;
    private import EngineIntake::*;
    private import EngineRelationships::*;

    part st009 : Statement {
        :>> id = "3c48f0c1-99e6-4f3d-9b71-c253954b474d";
        :>> title = "Architect E2EE, diagram, compare to best practice, panel, then carry out";
        :>> createdAt = "2026-11-10"; :>> createdBy = "ai";
        :>> text = "architect end to end encryption feature and write a diagram of how it would work.  Then compare yhour architecture to other technical best practices and revise.  Then have a panel critique the plan, and carry out";
        :>> saidBy = "wweatherholtz"; :>> saidAt = "2026-11-10"; :>> channel = StatementChannel::console;
    }

    part us012 : UserStory {
        :>> id = "1012442d-9f2d-4d6c-a210-56947150ae4c";
        :>> title = "Notes unreadable by the server";
        :>> createdAt = "2026-11-10"; :>> createdBy = "ai";
        :>> asA = "SelfSync user who self-hosts";
        :>> iWant = "note content that a compromised or curious server cannot read: encrypted on my devices before upload, decrypted only on my devices";
        :>> soThat = "I can run SelfSync on a host I do not fully trust and keep my notes private";
        :>> implication = ImplicationKind::need;
        :>> triageNote = "need, not architecture: the owner names an outcome (end to end encryption) that no accepted Need covers. nxSecurity covers transit and credentials only. D0009 declined this outcome on 2026-07-05 for a single-operator self-host. This statement reverses that direction, so a new Need plus a Decision that supersedes D0009 are the route. The owner did not state a threat model or a threshold. Both are recorded as the AI's proposal, not as elicited.";
    }
    #DerivedFrom dependency from us012 to st009;

    part us013 : UserStory {
        :>> id = "723509f1-ea39-4d18-804d-c7a3971c4c7e";
        :>> title = "E2EE architecture, diagram, best-practice comparison and panel critique";
        :>> createdAt = "2026-11-10"; :>> createdBy = "ai";
        :>> asA = "SelfSync owner";
        :>> iWant = "an architecture for the encryption feature, a diagram of how it works, a comparison of that architecture against published best practice with revisions, and an adversarial panel critique of the plan before any code";
        :>> soThat = "a cryptographic protocol is not shipped blind on one author's judgment";
        :>> implication = ImplicationKind::architecture;
        :>> triageNote = "architecture, not designChange: there is no accepted E2EE design to change. The 2026-07-05 spec was declined under D0009. The owner asks for the Business then Architecture workflow (business-architecture skill), with two named rigor steps inside it: a best-practice comparison with revision, and the adversarial-panel-review process (D0187). Routed to the superseding Decision and the architecture Decisions it charters. The diagram is a design artifact for the panel, not a committed view.";
    }
    #DerivedFrom dependency from us013 to st009;

    part us014 : UserStory {
        :>> id = "4d8f2e5d-9e3b-4d44-98a6-b603528cb7d8";
        :>> title = "Carry out the E2EE plan";
        :>> createdAt = "2026-11-10"; :>> createdBy = "ai";
        :>> asA = "SelfSync owner";
        :>> iWant = "the panel-hardened plan carried out: the encryption feature built, tested and released";
        :>> soThat = "the design becomes a working feature, not a shelved spec like the 2026-07-05 one";
        :>> implication = ImplicationKind::implementationChange;
        :>> triageNote = "implementationChange: the owner says carry out. Substantive delivery work goes through sprints (D0064). The work is chartered by the superseding Decision and sized at refine. Human acceptance of the Decisions stays an explicit gate at the per-sitting review (D0049). The AI does not record that acceptance.";
    }
    #DerivedFrom dependency from us014 to st009;
    #Implicates dependency from us012 to nE2eeContentPrivacy;
    #Implicates dependency from us013 to d0096;
    #Implicates dependency from us014 to e2eeCapability;
}

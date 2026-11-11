// D0114 (PROPOSED — NOT YET ACCEPTED) — Release notes state the E2EE define state (D0112)
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0114Accept event on sign-off.
package Decision0114 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    // #ProspectiveChange (D0070) - this Decision governs a process/schema change; the co-committed
    // change rides the process-change guard's hard lock.
    #ProspectiveChange part d0114 : Decision {
        :>> id = "04b3f8fb-9b3e-402a-935c-376f5c330949";
        :>> title = "Release notes state the E2EE define state (D0112)";
        :>> createdAt = "2026-11-11";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "D0112 says a release cut before the accepted KDF default Decision ships with the Encrypt option hidden, and that the release notes say so. release.yml writes the notes from a fixed template with the asset digests and holds no such sentence. The workflow is a locked enforcement surface under D0465, so the AI reverted its edit and records it here for the owner.";
        :>> decision = "release.yml gains one step before the NOTES line. It greps client/esbuild.config.mjs for the literal const SELFSYNC_E2EE = true. When present the note says the Encrypt option is ON in this build. Otherwise the note says the option is HIDDEN until the owner records the phone KDF measurements and accepts the KDF default Decision, that an enrolled device keeps syncing, and that the server side is complete. The sentence goes between the BRAT line and the SHA-256 block. The diff is client-side only in the workflow file, recorded in the sprint 5 implement evidence as release-notes-e2ee.diff.";
        :>> rationale = "The committed literal is the only source of the define state, and the build refuses true without the accepted Decision, so a note read from it can never disagree with the bytes BRAT installs. ALTERNATIVES: (i) write the sentence by hand per release - rejected, it drifts. (ii) read the state from main.js - rejected, the literal is the source and the grep is one line.";
        :>> consequences = "After acceptance the AI lands the diff in a sprint chartered by this Decision. Until then the release notes say nothing about the hidden option, tracked as issue016 with the resolver task e2eeReleaseNotesDefineState.";
    }
}

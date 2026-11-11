// =====================================================================
// ProjectReleases — the authored release milestones of SelfSync (EngineBaseline::Release, D0042).
// One item per tagged release that a sprint records. The baseline view is computed from git at
// the commit, never authored here. Earlier tags (1.0.0 to 1.32.2) predate this file and stay
// unrecorded: history, forward-only from 1.33.0.
// =====================================================================
package ProjectReleases {
    private import EngineElement::*;
    private import EngineBaseline::*;

    occurrence release1330 : Release {
        :>> id = "0f6d2c8a-7b1e-4d2f-9a53-6c1e8b2f4a10";
        :>> title = "SelfSync 1.33.0: the E2EE server side and the plugin flows, Encrypt hidden (D0112)";
        :>> createdAt = "2026-11-11";
        :>> createdBy = "ai";
        :>> commit = "3bd97c802c3f1e60486671a35951ef89e9c99934";
        :>> tag = "1.33.0";
        :>> purpose = "The first release whose server stamps index schema 4, stores the keyring sidecar, serves GET keyring and enforces the x-selfsync-e2ee guard. The plugin carries the E2EE flows with the Encrypt option hidden behind the SELFSYNC_E2EE define until the owner accepts the KDF default Decision. Published by release.yml run 42941138290; the server image 1.33.0 by server-image.yml run 42941169424 at digest sha256:59adfd83d14bbbeccadcddd49c29ce274190ef85d5774efe26205fe0701ac77d.";
    }
}

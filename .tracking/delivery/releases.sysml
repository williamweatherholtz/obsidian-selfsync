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

    occurrence release1340 : Release {
        :>> id = "6b1f0e2d-3c4a-4f5b-8e6d-7a8b9c0d1e2f";
        :>> title = "SelfSync 1.34.0: the Encrypt option visible, KDF default 32 MiB t=3 p=1 (D0115 accepted)";
        :>> createdAt = "2026-11-11";
        :>> createdBy = "ai";
        :>> commit = "80094eb";
        :>> tag = "1.34.0";
        :>> purpose = "The first release with SELFSYNC_E2EE true. The Encrypt option shows in the setup wizard and the Switch dialog, Join and Re-enrol work, and new keyrings use the D0115 default of 32 MiB, three passes, one lane. The server is unchanged from 1.33.0. Published by release.yml run 43028163537 and verified by check-release; the server image 1.34.0 by server-image.yml run 43028208136 at index digest sha256:fb95a3decbd6383a058c15e004247ca22742b530db6f14a15acbb37cec49e1d1.";
    }

    occurrence release1341 : Release {
        :>> id = "18f2c183-49dc-44f9-ba54-5169195933e6";
        :>> title = "SelfSync 1.34.1: a second device can join an encrypted vault (issue019), restart recovery documented (issue020)";
        :>> createdAt = "2026-11-11";
        :>> createdBy = "ai";
        :>> commit = "4abf7cf";
        :>> tag = "1.34.1";
        :>> purpose = "Patch release. The 1.34.0 status probe sent no x-selfsync-e2ee header before the pin, so the server guard answered 403 and the Join dialog never opened on a second device. The probe now sets the header when the keyring is found, verified by the real-Obsidian e2ee spec in loopback and real-server mode. The live change latency after a server restart is the reconnect backoff, documented in docs/deployment.md on the owner's accept-risk (st019). The server is unchanged from 1.34.0. Published by release.yml run 43103494822 and verified by check-release; the server image 1.34.1 by server-image.yml run 43103534474 at digest sha256:7ef48dc88e92df7d3576857317686b5a2eaf621c62b70b3cd47aba043f9db605.";
    }
}

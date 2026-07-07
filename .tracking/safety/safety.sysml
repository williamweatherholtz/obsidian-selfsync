// =====================================================================
// ProjectSafety — STPA Step-1 NON-ARCHITECTURAL INPUTS (D0016; deferred analysis).
// This file holds ONLY the prerequisite inputs that precede the control structure and do NOT
// depend on the architecture: the Losses (typed), plus the two documented scoping inputs the
// STPA Handbook Step 1 requires — the stakeholder map and the system boundary/environment.
// HAZARDS ARE NOT HERE: a hazard is the first ANALYTICAL output (it needs the boundary + a
// worst-case judgement), so hazards, safety constraints, the control structure, UCAs, loss
// scenarios, and safety requirements are all authored later, during the end-of-project STPA pass
// (delivery action stpaSafetyAnalysis). Losses are the ROOT of the trace chain
// (Loss <- Hazard <- SC/UCA <- C <- Scenario); prepared here so hazards `dependency`-> Loss later.
//
// STAKEHOLDERS (Step-1 input; already modeled as personas — losses trace to their values):
//   * selfHoster       — owns the notes AND runs the server; values: never lose what I write,
//                        keep it private, keep it available, don't let the tool harm my device.
//   * collaborator     — a share peer on someone else's vault; values: my edits aren't lost, I
//                        can't see/alter what I wasn't granted.
//   * selfHostOperator — runs/repairs the server for others; values: can keep tenants' data
//                        intact + isolated, can repair without data loss.
//
// SYSTEM BOUNDARY (Step-1 input — controllable vs environment):
//   IN SCOPE (controllable): the SelfSync plugin (client), the server binary, the sync protocol
//     between them, the local vault files the plugin manages, and the server's index + chunk store.
//   ENVIRONMENT (not controllable; worst-case conditions hazards will invoke):
//     A1 a device may be pointed at the WRONG / a fresh / a restored server that lacks our files
//        and has issued no deletion tombstones;
//     A2 the network may drop, delay, or reorder at any point (mid-transfer, mid-commit);
//     A3 the plugin (auto-updated via BRAT) and the server may be upgraded independently → version skew;
//     A4 the filesystem may be case-insensitive / Unicode-folding / trailing-dot-stripping (cross-platform);
//     A5 two devices may edit concurrently; a shared vault may have multiple writers;
//     A6 the server OPERATOR is trusted (D0009), but share PEERS and synced CONTENT are NOT trusted;
//     A7 a device may be offline for arbitrary periods;
//     A8 storage (disk / index) may be lost, restored from backup, or only partially present.
// =====================================================================
package ProjectSafety {
    private import EngineElement::*;
    private import EngineSafety::*;

    // Losses (L-n): unacceptable outcomes, stakeholder-valued, worst-case. No component/cause
    // reference (that belongs in a Step-4 scenario), no "unsafe/unintended/accidental" wording.
    part l1 : Loss {
        :>> id = "c0f1a5cc-a001-4a10-9b20-a1b2c3d4a001";
        :>> title = "L-1: Loss or corruption of note content";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> statement = "Note content a user created — including a specific edit or version — is permanently lost, silently corrupted, or overwritten so the stored content no longer reflects what the user wrote. This is INDUCED, USER-PERCEIVED loss: the SYSTEM making a note gone or wrong from the user's vantage — which also covers RESURRECTING content the user deliberately deleted (the deletion is undone). Raw byte durability (disk / backups) is out of scope for L-1; the concern is what the sync system itself induces. Priority: highest (the core value: never lose or silently alter what I write). Traces to selfHoster + collaborator.";
    }
    part l2 : Loss {
        :>> id = "c0f1a5cc-a002-4a10-9b20-a1b2c3d4a002";
        :>> title = "L-2: Disclosure of private information";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> statement = "A user's private note content, or a credential/token that protects it, becomes accessible to a party the user did not intend to share it with. Priority: high (privacy). Traces to selfHoster + collaborator.";
    }
    part l3 : Loss {
        :>> id = "c0f1a5cc-a003-4a10-9b20-a1b2c3d4a003";
        :>> title = "L-3: Harm to the user's device or environment via sync";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> statement = "A user's device or environment is harmed — for example, code the user did not choose runs on it — as a consequence of using the sync system. Priority: high (the tool must be safe to run; bounded by A6 — peers/content untrusted, server operator trusted). Traces to selfHoster.";
    }
    part l4 : Loss {
        :>> id = "c0f1a5cc-a004-4a10-9b20-a1b2c3d4a004";
        :>> title = "L-4: Inability to access or sync notes";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> statement = "A user is unable to capture, retrieve, or reconcile their notes when they need them. Priority: medium (availability). Traces to selfHoster + collaborator.";
    }
}

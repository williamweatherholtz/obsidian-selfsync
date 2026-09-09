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
// SYSTEM BOUNDARY (Step-1 input) — REDRAWN 2026-09-09 (owner: "our system boundary is our plugin"):
//   SYSTEM UNDER ANALYSIS: the SelfSync PLUGIN (client) — its sync engine, reconciler, session manager,
//     conflict resolver and config sync — and the local vault files + `.obsidian/` config it manages.
//   OWNED, TRUSTED ENVIRONMENT (same author, analysed as environment controllers whose behaviour the plugin
//     depends on — their SRs are commitments we make to ourselves, not plugin requirements): the SelfSync
//     server (vault manager, access control, index + chunk store), its operator (D0009), and the sync protocol.
//   Until this date the server sat INSIDE the boundary; its controllers/UCAs/SRs (c5-c7, UCA-10..15/18, SR-7..13/16/19)
//   are kept unchanged — the redraw changes what is a REQUIREMENT ON THE PLUGIN vs an ASSUMPTION ABOUT ITS ENVIRONMENT.
//
// AUTHORITIES (Step-1 inventory — every party that can change the plugin's controlled processes, i.e. the
// local vault files, the plugin's own config/code, or the server's data). Each is a controller in Step 2;
// the ones marked NEW have no controller yet and are the Step 2 follow-up of this refresh:
//   INSIDE the plugin:      sync engine (c2), session (c3), reconciler (c4), conflict resolver (c8), config sync.
//   THE USER (c1):          edits/renames/deletes files through the Obsidian editor; resolves conflicts; changes settings.
//   THE HOST APP — NEW:     Obsidian itself: vault API + file events (exact-case keyed), plugin lifecycle
//                           (load / unload / update mid-operation), settings UI; the plugin runs ON ITS MAIN THREAD.
//   OTHER PLUGINS — NEW:    write the SAME files (Metadata Menu fileClass frontmatter, Linter / timestamp stampers,
//                           Templater) — observed 2026-09-07 as recurring trailing-space + `updated:` conflicts.
//   OTHER SYNC TOOLS — NEW: Syncthing / cloud drives operating on the same directory (`.sync-conflict-*` files are
//                           present in the owner's vault; cloud placeholders hydrate on read).
//   THE OS / FILESYSTEM:    case-insensitive + Unicode-folding + mtime-granular semantics; antivirus locks;
//                           observed 2026-09-07 as ~500 paths differing from the server only in capitalisation.
//   OTHER DEVICES + PEERS:  the user's other devices (concurrent writers, trusted); share peers (untrusted, A6).
//   THE SERVER + OPERATOR:  owned + trusted (above); authoritative index, tombstones, versions, grants; repair.
//   THE RELEASE CHANNEL — NEW: GitHub Releases via BRAT (plugin code) and GHCR (server image) — the authority that
//                           changes the plugin's OWN CODE; integrity is checked by scripts/check-release.mjs + CI.
//   THE NETWORK PATH:       reverse proxy (Caddy) / TLS / DNS between plugin and server.
//   TIME:                   device clocks (mtimes, frontmatter timestamps, backoff timers).
//
// ENVIRONMENT ASSUMPTIONS (worst-case conditions hazards invoke):
//     A1 a device may be pointed at the WRONG / a fresh / a restored server that lacks our files
//        and has issued no deletion tombstones;
//     A2 the network may drop, delay, or reorder at any point (mid-transfer, mid-commit);
//     A3 the plugin (auto-updated via BRAT) and the server may be upgraded independently → version skew;
//     A4 the filesystem may be case-insensitive / Unicode-folding / trailing-dot-stripping (cross-platform);
//     A5 two devices may edit concurrently; a shared vault may have multiple writers;
//     A6 the server OPERATOR is trusted (D0009), but share PEERS and synced CONTENT are NOT trusted;
//     A7 a device may be offline for arbitrary periods;
//     A8 storage (disk / index) may be lost, restored from backup, or only partially present;
//     A9 (2026-09-09) other plugins rewrite the same files at any time, including on every open/save (timestamp
//        stampers, fileClass tooling), so a file may change between the plugin's read and its write;
//     A10 (2026-09-09) another sync tool may be operating on the same directory, creating its own conflict
//        files and rewriting ours;
//     A11 (2026-09-09) the host may unload, update or suspend the plugin at ANY point of an in-flight operation,
//        and the host's file API keys paths by exact case while the filesystem does not;
//     A12 (2026-09-09) a vault may hold files of any size (multi-hundred-MB media) and any count (thousands);
//        the plugin shares the host's single main thread and a mobile device's memory;
//     A13 (2026-09-09) the plugin's own code arrives through a release channel that could be stale, skipped,
//        or altered; the server image may be behind or ahead of the plugin;
//     A14 (2026-09-09) the user acts on what the plugin SHOWS (a diff, a status, a button) and may act while the
//        plugin is mid-operation.
// =====================================================================
package ProjectSafety {
    private import EngineElement::*;
    private import EngineSafety::*;

    // Losses (L-n): unacceptable outcomes, stakeholder-valued, worst-case. No component/cause
    // reference (that belongs in a Step-4 scenario), no "unsafe/unintended/accidental" wording.
    part l1 : Loss {
        :>> id = "6cd56144-859b-4cf8-8014-52508cde0140";
        :>> title = "L-1: Loss or corruption of note content";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> statement = "Note content a user created — including a specific edit or version — is permanently lost, silently corrupted, or overwritten so the stored content no longer reflects what the user wrote. This is INDUCED, USER-PERCEIVED loss: the SYSTEM making a note gone or wrong from the user's vantage — which also covers RESURRECTING content the user deliberately deleted (the deletion is undone). Raw byte durability (disk / backups) is out of scope for L-1; the concern is what the sync system itself induces. Priority: highest (the core value: never lose or silently alter what I write). Traces to selfHoster + collaborator.";
    }
    part l2 : Loss {
        :>> id = "979520ca-f3be-4d3b-bc89-c53f1d6e2bf6";
        :>> title = "L-2: Disclosure of private information";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> statement = "A user's private note content, or a credential/token that protects it, becomes accessible to a party the user did not intend to share it with. Priority: high (privacy). Traces to selfHoster + collaborator.";
    }
    part l3 : Loss {
        :>> id = "36079df2-9099-4078-9801-9117f425dbd1";
        :>> title = "L-3: Harm to the user's device or environment via sync";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> statement = "A user's device or environment is harmed — for example, code the user did not choose runs on it — as a consequence of using the sync system. Priority: high (the tool must be safe to run; bounded by A6 — peers/content untrusted, server operator trusted). Traces to selfHoster.";
    }
    part l4 : Loss {
        :>> id = "a44c7f76-c65f-4b15-9bf3-12f96a40d668";
        :>> title = "L-4: Inability to access or sync notes";
        :>> createdAt = "2026-07-06"; :>> createdBy = "wweatherholtz";
        :>> statement = "A user is unable to capture, retrieve, or reconcile their notes when they need them. Priority: medium (availability). Traces to selfHoster + collaborator.";
    }
    // L-5 (added 2026-08-02, D0036): the loss is a STATE — the user misled — NOT its consequences. A given
    // divergence's damage (trust in unsafe data, wasted effort, abandonment) is DERIVED by analysing which
    // UCAs/scenarios reach it, never pre-judged in the loss. Distinct from L-4: L-4 is the system unable to
    // do its job; L-5 is the user's UNDERSTANDING of the system being wrong, even when the system works.
    part l5 : Loss {
        :>> id = "d430229c-1c85-4d35-ad34-1e4a862fe2ce";
        :>> title = "L-5: The user is misled by the plugin's UX";
        :>> createdAt = "2026-08-02"; :>> createdBy = "wweatherholtz";
        :>> statement = "The user's understanding of the system diverges from its actual state because the plugin's UX conveys a false or unintelligible picture of what it is doing, whether an operation succeeded, or how to act. The USER is a controller and the UX is feedback to their process model — any feedback capable of misrepresenting state affects this loss. Priority: medium (informed control + trust — the D0054 adoption risk). Traces to selfHoster + collaborator.";
    }
    // SCOPE DECISION (2026-08-03, owner): a resource/efficiency loss — a would-be "L-6": battery / mobile
    // data / storage / CPU — is deliberately NOT modeled as a Loss. Rationale: (1) LIMITED CONTROL AUTHORITY
    // — these ride mostly on the user's device, network, and vault SIZE, outside the plugin's control, so a
    // Loss (which asserts we must prevent the outcome) overstates our authority; (2) it would MUDDY the
    // otherwise clean, owned loss set (L-1..L-5 are outcomes we genuinely own). It stays a QUALITY concern —
    // a candidate monitored INDICATOR (D0088/D0089: a direction-goal measure with no enforced threshold)
    // IF/WHEN performance regresses — but is NOT added as an indicator now either: perf is not a current
    // concern after the connect-phase + scan-skip-persist + config-walk-parallel + hashing tightening
    // (1.12.0-1.12.6). If a justified concern emerges, promote it to an INDICATOR, not a Loss (avoids the
    // Goodhart trap, D0088). The owner considered L-6 on 2026-08-03 and chose to keep it out.
}

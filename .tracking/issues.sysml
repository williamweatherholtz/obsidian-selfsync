// =====================================================================
// ProjectIssues — tracked problems (D0077/D0078: every Issue must be TRIAGED with a #Resolves
// edge from a resolving action or a mooting Decision; resolution is COMPUTED, never prose).
// =====================================================================
package ProjectIssues {
    private import EngineElement::*;
    private import EngineWork::*;
    private import ProjectDelivery::*; // requirementTraceabilityBackfill — the resolver

    // The test-escape retrospective (2026-07-05): "plugin sync doesn't work at all" shipped
    // despite a large test suite. Root cause is two-layered and recorded here so the class is
    // guarded, not just patched (D0047).
    part issueTraceabilityGap : Issue {
        :>> id = "c0f1a5cc-8001-4a10-9b20-a1b2c3d40071";
        :>> title = "Config-sync feature shipped unrooted, with zero requirement->test traceability";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> description = "The multi-device config divergence/removal defects (0.10.4: a crash on a divergent community-plugins.json + a phantom-base deletion of a peer's plugin) escaped a 125-test suite. Two-layer cause: (1) the config/customization-sync feature was implemented in code with NO Need or SystemRequirement behind it (an orphan capability), so there were no behavioral acceptance criteria and no use case enumerating the 'two already-configured devices' scenario; (2) tier-satisfaction showed SR-verified-by-Test at 0/15 — every automated test was divorced from the requirements model, so nothing enforced that a requirement carried a behavioral test. Tests were written bottom-up from the code (filter combos, single-file one-way config sync) and never exercised config conflict-copy or removal.";
        :>> discoveredInField = true;
        :>> relatedTask = "requirementTraceabilityBackfill";
        :>> severity = Severity::High;
    }

    // Triage: resolved by the CR d0011 traceability backfill (roots the feature as a #Capability,
    // adds the #Verify acceptance layer for every SR incl. the two scenarios that catch this class).
    #Resolves dependency from requirementTraceabilityBackfill to issueTraceabilityGap;

    // Owner attestation (2026-07-05): settings functionality is right, but the layout atomizes
    // every setting into its own container instead of grouping intelligently like comparable
    // plugins. Cosmetic, not functional; deferred to an end-of-project polish pass to avoid
    // repeated cosmetic rework. srSettingsOneHome's top-level 4-group structure holds; this is
    // the finer within-group organization.
    part issueSettingsGrouping : Issue {
        :>> id = "c0f1a5cc-8002-4a10-9b20-a1b2c3d40072";
        :>> title = "Settings are atomized, not intelligently grouped like comparable plugins";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> description = "Owner review: every setting sits in its own little container rather than being organized into sensible sub-groups the way well-designed Obsidian plugins do. Functionality is present and correct; the grouping is a cosmetic weakness, and the comparable-plugin study that should have informed it was not done properly. Deferred to a single end-of-project cosmetic pass (explicit owner instruction: don't keep reworking cosmetics mid-build).";
        :>> discoveredInField = true;
        :>> relatedTask = "settingsGroupingPolish";
        :>> severity = Severity::Low;
    }
    #Resolves dependency from settingsGroupingPolish to issueSettingsGrouping;

    // =====================================================================
    // Findings from the 3-lens adversarial critique (data-integrity / security / correctness),
    // by independent critics, 2026-07-05. Each carries a severity + a #Resolves resolver:
    // the 5 client fixes shipped in 0.10.14 (critiqueClientWave, done); the server/coordinated
    // fixes + the Low backlog are triaged to critiqueServerHardening (open).
    // =====================================================================
    // ---- client data-integrity / correctness (fixed in 0.10.14) ----
    part issueBulkDeleteGuard : Issue { :>> id = "c0f1a5cc-9101-4a10-9b20-a1b2c3d49101"; :>> title = "Bulk-delete guard only fired at exactly-empty; a partial manifest shrink deleted the missing files"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "DI-1: guardBulkDelete = remote.size===0 only, so a partial index (restore/reindex over an incomplete dir) advertising some files and dropping others propagated real delete-local on every device. Fixed: ratio guard (>= half of base missing from a non-empty manifest, min 6)."; :>> discoveredInField = false; :>> relatedTask = "critiqueClientWave"; :>> severity = Severity::High; }
    part issueDownloadIntegrity : Issue { :>> id = "c0f1a5cc-9102-4a10-9b20-a1b2c3d49102"; :>> title = "Downloaded file content was never re-hashed; a corrupt chunk was laundered into known-good state"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "DI-2: applyPull set base = claimed hash without verifying the reassembled bytes, so a bit-rotted blob was written to the note and re-served to every device. Fixed: verify sha256(bytes)==rmeta.hash; refuse + skip on mismatch."; :>> discoveredInField = false; :>> relatedTask = "critiqueClientWave"; :>> severity = Severity::High; }
    part issueStaleBaseRecreate : Issue { :>> id = "c0f1a5cc-9103-4a10-9b20-a1b2c3d49103"; :>> title = "Both-absent left a stale base, so recreating a file with identical content deleted it"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "CO-1: the in-sync handler never cleared base when both sides were absent, so a recreate with content equal to the old base hash read as delete-local and wiped the note. Fixed: clear stale base on both-absent."; :>> discoveredInField = false; :>> relatedTask = "critiqueClientWave"; :>> severity = Severity::High; }
    part issueOfflineStuck : Issue { :>> id = "c0f1a5cc-9104-4a10-9b20-a1b2c3d49104"; :>> title = "A transient per-file error pinned the status light 'Offline' forever"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "CO-2: the FSM cleared 'offline' only on 'connected', which the poll path never emits, so one failed edit left it red while sync kept working. Fixed: offline recovers to idle on a successful sync (syncDone)."; :>> discoveredInField = false; :>> relatedTask = "critiqueClientWave"; :>> severity = Severity::High; }
    part issueConfigEditVsDelete : Issue { :>> id = "c0f1a5cc-9105-4a10-9b20-a1b2c3d49105"; :>> title = "Config edit-vs-delete silently resurrected a removed config file / reverted a removal"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "CO-3: config edit-wins-* fell through instead of adjudicating, contradicting the never-resurrect invariant (edit-wins-pull pulled a locally-deleted config back). Fixed: config edit-vs-delete is adjudicated like divergence."; :>> discoveredInField = false; :>> relatedTask = "critiqueClientWave"; :>> severity = Severity::Medium; }
    // ---- server + coordinated (open; SEC-2 coded + cargo-green, awaiting redeploy) ----
    part issueDefaultAdminCreds : Issue { :>> id = "c0f1a5cc-9201-4a10-9b20-a1b2c3d49201"; :>> title = "Server seeds a publicly-known admin/admin account by default"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "SEC-2: SYNC_USER/SYNC_PASSWORD default to admin/admin, seeding the server-admin account; an exposed default server is trivially taken over. Fix (coded, cargo-green): refuse to start when the admin password is unset/'admin' unless ALLOW_WEAK_ADMIN=1 (LAN/dev opt-in). Needs operator redeploy."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::High; }
    part issueWsTokenInUrl : Issue { :>> id = "c0f1a5cc-9202-4a10-9b20-a1b2c3d49202"; :>> title = "Session bearer token is passed in the WebSocket URL query string"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "SEC-1: the 30-day token rides as ?token=... on the /api/ws upgrade, so it lands in reverse-proxy/LB logs and can be replayed. Fix: authenticate the WS via Sec-WebSocket-Protocol or a short-lived single-use ticket (coordinated client+server change)."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::High; }
    part issueSharePluginRce : Issue { :>> id = "c0f1a5cc-9203-4a10-9b20-a1b2c3d49203"; :>> title = "A read-write share grantee can push plugin code the owner's device auto-loads (cross-share RCE)"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "SEC-3: the server stores any committed path and the client auto-enables community-plugin code; a RW grantee committing .obsidian/plugins/x/main.js executes code on the owner's device. Fix: never auto-enable plugin code received over a shared (non-owned) vault; require explicit per-plugin confirmation."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::High; }
    part issueAcctDeleteRemanence : Issue { :>> id = "c0f1a5cc-9204-4a10-9b20-a1b2c3d49204"; :>> title = "Deleting an account leaves its vault data on disk; reusing the username inherits it"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "SEC-MED-2: users_delete removes the record + shares + tokens but never removes DATA_ROOT/<name>/, so recreating the name silently adopts the prior owner's notes. Fix: remove/quarantine the data dir on delete (or refuse to reuse a name with residual data)."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::Medium; }
    part issueRegisterEnumeration : Issue { :>> id = "c0f1a5cc-9205-4a10-9b20-a1b2c3d49205"; :>> title = "Username enumeration via /api/register (409 exists vs 403 closed) before the invite gate"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "SEC-MED-1: the exists() check returns 409 before the closed-mode/invite 403, so an unauthenticated caller harvests the account list on a closed server. Fix: enforce the invite/mode gate before the existence check; uniform error."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::Medium; }
    part issueLoginRateLimit : Issue { :>> id = "c0f1a5cc-9206-4a10-9b20-a1b2c3d49206"; :>> title = "No rate-limiting on /api/login (+ open /api/register); each attempt runs argon2"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "SEC-MED-3: unauthenticated auth endpoints run a full argon2 verify/hash per request with no throttle, enabling online brute force + CPU/RAM-exhaustion DoS. Fix: per-IP + per-account rate limiting/backoff + a concurrency cap."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::Medium; }
    part issueCommitOrdering : Issue { :>> id = "c0f1a5cc-9207-4a10-9b20-a1b2c3d49207"; :>> title = "commit writes the bind-mount file before the durable journal; a crash + reindex resurrects uncommitted content"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "DI-3: std::fs::write precedes the journal append; a crash/rollback in that window leaves disk ahead of the index, and reindex (which rebuilds from disk) then makes the never-committed body canonical. Fix: write the file after the journal is durable (temp + rename post-journal)."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::Medium; }
    part issueReindexDestructive : Issue { :>> id = "c0f1a5cc-9208-4a10-9b20-a1b2c3d49208"; :>> title = "reindex over an incomplete vault dir drops absent files from the manifest and GCs their chunks"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "DI-4: reindex rebuilds solely from present files and GCs unreferenced blobs, so a transiently-incomplete dir (partial restore / in-flight copy) becomes permanent loss — feeding DI-1's client deletions. Fix: refuse/preserve when a previously-indexed path is missing from disk during a repair; never GC blobs for prior-index paths."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::Medium; }
    part issueCritiqueLows : Issue { :>> id = "c0f1a5cc-9209-4a10-9b20-a1b2c3d49209"; :>> title = "Low-severity critique backlog (path double-separator, switch TOCTOU/streaming, self-write window, CORS, dead invite config)"; :>> createdAt = "2026-07-05"; :>> createdBy = "wweatherholtz"; :>> description = "Lumped Lows: CO-5 (a//b vs a/b distinct index entries — reject empty separators), DI-5 (switchTo upload pairs base with a re-read after the hash — return hashed bytes), DI-6 (switchTo download doesn't stream + skips large files), CO-6 (self-write suppression window swallows a genuine external edit within 4s — make it one-shot), SEC-LOW-2 (permissive CORS on /api/admin — restrict origin), SEC-LOW-1 (dead INVITE_CODE config — implement or remove)."; :>> discoveredInField = false; :>> relatedTask = "critiqueServerHardening"; :>> severity = Severity::Low; }

    #Resolves dependency from critiqueClientWave to issueBulkDeleteGuard;
    #Resolves dependency from critiqueClientWave to issueDownloadIntegrity;
    #Resolves dependency from critiqueClientWave to issueStaleBaseRecreate;
    #Resolves dependency from critiqueClientWave to issueOfflineStuck;
    #Resolves dependency from critiqueClientWave to issueConfigEditVsDelete;
    #Resolves dependency from critiqueServerHardening to issueDefaultAdminCreds;
    #Resolves dependency from critiqueServerHardening to issueWsTokenInUrl;
    #Resolves dependency from critiqueServerHardening to issueSharePluginRce;
    #Resolves dependency from critiqueServerHardening to issueAcctDeleteRemanence;
    #Resolves dependency from critiqueServerHardening to issueRegisterEnumeration;
    #Resolves dependency from critiqueServerHardening to issueLoginRateLimit;
    #Resolves dependency from critiqueServerHardening to issueCommitOrdering;
    #Resolves dependency from critiqueServerHardening to issueReindexDestructive;
    #Resolves dependency from critiqueServerHardening to issueCritiqueLows;
}

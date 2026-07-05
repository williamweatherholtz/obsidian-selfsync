// =====================================================================
// D0009 — decline optional client-side E2E encryption; keep the trusted-server + TLS-in-
// transit model (reaffirms D0007). E2EE was designed (docs/design/specs/2026-07-05-e2ee-
// design.md) as an optional enhancement; on walking through the remaining needs the owner
// chose not to build it. A "won't do" is a first-class Decision (CLAUDE.md §2.4). Accepted
// 2026-07-05 by wweatherholtz ("Skip E2EE — keep trusted-server").
// =====================================================================
package ProjectDecision0009 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0009 : Decision {
        :>> id = "9960d9ff-2557-4c07-a84b-66f157375aba";
        :>> title = "D0009: decline client-side E2EE — keep the trusted-server + TLS model";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "SelfSync uses a trusted-server + TLS-in-transit model (D0007): a compromised server can read note content. Optional client-side E2EE was designed (specs/2026-07-05-e2ee-design.md) to close that gap and tracked as the e2eEncryption task. Walking through the remaining work, the owner weighed it against the model's cost.";
        :>> decision = "Do NOT build client-side E2EE. Keep the trusted-server + TLS-in-transit model. Drop the e2eEncryption delivery task; retain the E2EE design spec as rationale (status: declined) so a future untrusted-host scenario can pick it up.";
        :>> rationale = "The owner self-hosts on a controlled box, so TLS in transit + data at rest on their own infrastructure suffices for the threat model. E2EE would add a lose-your-password data-loss risk, an audited-crypto + WASM/CSP surface, and forced trade-offs (browsable-files-vs-hidden-structure; dedup-vs-equality-leak) — cost outweighs benefit for a single-operator self-host. ALTERNATIVES: content-only encryption (paths visible) and full encryption (structure hidden) were both REJECTED in favor of no E2EE. Revisit if SelfSync is ever run as a multi-tenant/untrusted host.";
        :>> consequences = "The threat model stays as documented (trusted-server; the server can read content — stated in docs/deployment.md). The e2eEncryption task is removed from the backlog; the design spec is kept as declined-design history. nxSecurity remains satisfied by TLS + credentials-never-sync + hashed passwords/tokens. No code change.";
    }

    verification d0009Accept : Test {
        :>> id = "a57898f4-d4b3-4b2f-adca-812571737bd3";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz chose 'Skip E2EE — keep trusted-server' on 2026-07-05 when walked through the remaining needs, declining client-side E2EE.";
    }
    part d0009AcceptR1 : TestResult { :>> id = "37528163-7457-487a-aa65-1710a4ed4521"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "f09fb2c"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "wweatherholtz"; }
}

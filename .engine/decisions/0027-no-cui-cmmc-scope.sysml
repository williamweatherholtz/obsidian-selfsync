// =====================================================================
// D0027 — This deployment does NOT store CUI. Therefore the two CUI-DATA-specific NIST 800-171 / CMMC
// L2 controls — SC.3.13.11 (FIPS-validated cryptography) and SC.3.13.16 (CUI encrypted at rest) — are
// NOT APPLICABLE to the current scope and are formally accepted-deferred, not open gaps. Controls that
// protect the SERVICE regardless of CUI stay in force. Accepted 2026-07-15 by wweatherholtz.
// =====================================================================
package ProjectDecision0027 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0027 : Decision {
        :>> id = "0d270a1c-7e34-4b55-9a11-2f3c4d5e6a27";
        :>> title = "D0027: this deployment stores no CUI — SC.3.13.11 (FIPS crypto) + SC.3.13.16 (CUI-at-rest) are Not Applicable / accepted-deferred";
        :>> createdAt = "2026-07-15";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The project incorporated NIST SP 800-171 rev2 / CMMC L2 (110 controls) as a checkable standard. Two of the remaining open items are CUI-DATA-specific — their applicability depends entirely on whether the deployment actually stores Controlled Unclassified Information: SC.3.13.11 (cryptography must be FIPS-validated) and SC.3.13.16 (CUI must be encrypted at rest). The 'no genuine CUI' premise was ALREADY stated in prose — docs/cmmc-posture.md ('this deployment stores no genuine CUI, so FIPS … deferred'), the 800-171 3.13.11 control's rationale field ('poam, DEFERRED (accepted)'), and the issueCmmcFips/issueCmmcAtRest descriptions — but it was NEVER elevated to a first-class Decision. So the scope boundary lived as an assumption threaded through a posture doc + a control's disposition field, and the two Issues stayed wired to an OPEN implementation action (cmmcComplianceBacklog) rather than a mooting Decision, which is why they persisted as 'open' in the backlog. That is precisely the 'prose/commit-message/doc is NOT a decision record' lapse CLAUDE.md §4 warns about (and which was a prior HIGH critique finding). The owner reconfirmed on 2026-07-15 that this deployment does not store CUI; this Decision records that scope call as the authority the two controls hang off.";
        :>> decision = "Record as an accepted scope decision: this SelfSync deployment does NOT store CUI. Consequently the two CUI-DATA-specific 800-171/CMMC controls are NOT APPLICABLE to the current scope and are formally accepted-deferred (not gaps): SC.3.13.11 — FIPS-validated cryptography; SC.3.13.16 — CUI encrypted at rest. This scoping does NOT relax any control that protects the SERVICE and its credentials regardless of CUI — authentication (argon2id, MFA, lockout), TLS/in-transit confidentiality (SC.3.13.8, enforced), access control, session management, and audit all remain in force. REOPEN TRIGGER: if genuine CUI is ever stored in a deployment, both controls become applicable and must be implemented — SC.3.13.11 via a FIPS-validated crypto provider, SC.3.13.16 via CUI-at-rest encryption (operator volume-encryption near-term; E2EE evaluated against its dedup/merge tradeoff). This Decision is the recorded basis; a CUI-in-scope change supersedes it.";
        :>> rationale = "800-171/CMMC scope is DEFINED by CUI presence: a control requiring CUI-at-rest encryption or FIPS-validated crypto has no applicable asset when no CUI is stored, so 'not applicable' is the correct disposition, not 'open gap' or 'won't fix'. Recording it as a Decision (rather than leaving it in a posture doc + a control's rationale field) makes the scope boundary auditable, gives the two Issues a proper MOOTING resolver so they resolve honestly instead of dangling against an open action, and creates the single authority a future CUI-in-scope change reopens. Elevating a scoping assumption to a Decision is exactly what §4 requires — the prose-not-Decision gap this fixes was itself a recorded HIGH finding, so leaving it in prose would repeat that class of lapse.";
        :>> consequences = "issueCmmcFips + issueCmmcAtRest are re-homed to #Resolves from THIS Decision (a mooting Decision, D0077) instead of the open cmmcComplianceBacklog action → both resolve (computed); open backlog issues go to 0. cmmcComplianceBacklog (whose sole scope was these two POA&M items) is mooted — its comment now cites D0027 and it carries no remaining code work. docs/cmmc-posture.md and the 800-171 SC.3.13.11 / SC.3.13.16 control dispositions now cite D0027 as the authority for the not-applicable call (doc-sync). No code change. A deployment that stores CUI reopens both controls per the trigger above.";
    }

    verification d0027Accept : Test {
        :>> id = "0d27acc7-2b33-4c44-9d55-6e7f80912327";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz confirmed the scope on 2026-07-15: 'no we don't store CUI. record this decision and rationale.' — an explicit attestation that this deployment stores no CUI, directing that the not-applicable disposition of SC.3.13.11 (FIPS) and SC.3.13.16 (CUI-at-rest) be recorded as a first-class Decision with its rationale (having noted the premise had only been captured in prose before).";
    }
    part d0027AcceptR1 : TestResult { :>> id = "0d27ac00-ab22-4c33-9d44-5e6f70819327"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "71f9f1e"; :>> judgedAt = "2026-07-15"; :>> judgedBy = "wweatherholtz"; }
}

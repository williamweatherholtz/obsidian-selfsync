// =====================================================================
// ProjectCompliance — NIST SP 800-171 rev2 / CMMC Level 2 as a GOVERNING STANDARD we implement and
// check against (adopted per Decision D0023). The 110 controls are tracked SystemRequirements
// (kind=security, the control number is the id-title), each `satisfy`-linked to the regulatory
// compliance Need. DISPOSITION per control: met (SelfSync code satisfies it -> a #Verify Test now),
// partial (software half met + operator attests the rest), operator (operator is the verifier;
// PENDING attestation), poam (open Issue). Statements are PARAPHRASED summaries of 800-171 rev2,
// not verbatim. Compliance status is COMPUTED: a control with no #Verify is a gap in the coverage/
// orphans views. GENERATED from scratchpad/gen_nist.py (authoring aid); the .sysml is the truth.
// =====================================================================
package ProjectCompliance {
    private import EngineElement::*;
    private import EngineRequirements::*;
    private import EngineNeeds::*;
    private import EngineVerification::*;

    requirement nComply800171 : Need {
        :>> id = "c0f1a5cc-8f00-4a10-9b20-a1b2c3d48f00";
        :>> title = "Comply with NIST SP 800-171 rev2 / CMMC Level 2";
        :>> source = NeedSource::regulatory;
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "The system and its operation shall satisfy the 110 security requirements of NIST SP 800-171 rev2 (CMMC Level 2), each tracked as a control requirement with a disposition and, where met, a verifying test.";
        :>> priority = Priority::must;
    }

    // ---- 3.1 Access Control (AC) ----
    requirement sr_3_1_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f01-4a10-9b20-a1b2c3d48f01"; :>> title = "3.1.1 Limit system access to authorized users/processes";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Limit information system access to authorized users, processes acting on behalf of users, and devices.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.1 (paraphrased). Disposition: met. Every route AuthToken-gated; scoped() re-authorizes per request on HTTP+WS (api.rs, ws.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f02-4a10-9b20-a1b2c3d48f02"; :>> title = "3.1.2 Limit access to permitted transactions/functions";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Limit system access to the types of transactions and functions that authorized users are permitted to execute.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.2 (paraphrased). Disposition: met. read vs read-write ACL (shares.rs); admin funcs behind require_admin (admin.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f03-4a10-9b20-a1b2c3d48f03"; :>> title = "3.1.3 Control flow of CUI";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control the flow of CUI in accordance with approved authorizations.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.3 (paraphrased). Disposition: partial. In-boundary: server-enforced owner/grant ACL per op. Cross-boundary flow = operator network/proxy policy.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f04-4a10-9b20-a1b2c3d48f04"; :>> title = "3.1.4 Separate duties";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Separate the duties of individuals to reduce risk of malevolent activity without collusion.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.4 (paraphrased). Disposition: operator. Code supports distinct admin vs user accounts; duty separation is an operator/SSP policy.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f05-4a10-9b20-a1b2c3d48f05"; :>> title = "3.1.5 Least privilege";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Employ the principle of least privilege, including for specific security functions and privileged accounts.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.5 (paraphrased). Disposition: met. Bootstrap + explicit admin set only; non-admins 403 on all admin routes; admin set purged on delete.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f06-4a10-9b20-a1b2c3d48f06"; :>> title = "3.1.6 Non-privileged accounts for nonsecurity functions";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Use non-privileged accounts or roles when accessing nonsecurity functions.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.6 (paraphrased). Disposition: operator. Accounts default non-admin; operator must use a non-privileged account for daily note-taking (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_7 : SystemRequirement {
        :>> id = "c0f1a5cc-8f07-4a10-9b20-a1b2c3d48f07"; :>> title = "3.1.7 Restrict + audit privileged functions";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Prevent non-privileged users from executing privileged functions and capture the execution of such functions in audit logs.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.7 (paraphrased). Disposition: met. Privileged endpoints require_admin; every privileged action emits an audit event (audit.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_8 : SystemRequirement {
        :>> id = "c0f1a5cc-8f08-4a10-9b20-a1b2c3d48f08"; :>> title = "3.1.8 Limit unsuccessful logon attempts";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Limit unsuccessful logon attempts.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.8 (paraphrased). Disposition: met. Per-account throttle: 10 fails / 5 min -> 429 + Retry-After, checked before argon2 (throttle.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_9 : SystemRequirement {
        :>> id = "c0f1a5cc-8f09-4a10-9b20-a1b2c3d48f09"; :>> title = "3.1.9 Privacy & security notices";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Provide privacy and security notices consistent with applicable CUI rules.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.9 (paraphrased). Disposition: met. SYNC_LOGIN_BANNER shown pre-auth in the admin page + setup wizard via /health.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_10 : SystemRequirement {
        :>> id = "c0f1a5cc-8f0a-4a10-9b20-a1b2c3d48f0a"; :>> title = "3.1.10 Session lock";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Use session lock with pattern-hiding displays to prevent access/viewing after inactivity.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.10 (paraphrased). Disposition: operator. Endpoint OS / Obsidian screen-lock; not a sync-server control (operator/SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_11 : SystemRequirement {
        :>> id = "c0f1a5cc-8f0b-4a10-9b20-a1b2c3d48f0b"; :>> title = "3.1.11 Terminate session after inactivity";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Terminate (automatically) a user session after a defined condition (inactivity).";
        :>> rationale = "NIST SP 800-171 rev2 3.1.11 (paraphrased). Disposition: met. Token idle-expiry SESSION_IDLE_TIMEOUT_SECS (default 30 min) + 30-day absolute cap (tokens.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_12 : SystemRequirement {
        :>> id = "c0f1a5cc-8f0c-4a10-9b20-a1b2c3d48f0c"; :>> title = "3.1.12 Monitor/control remote access";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Monitor and control remote access sessions.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.12 (paraphrased). Disposition: partial. All remote access token-gated, audited, revocable; WS re-auth every ping/msg. Central monitoring = operator SIEM.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_13 : SystemRequirement {
        :>> id = "c0f1a5cc-8f0d-4a10-9b20-a1b2c3d48f0d"; :>> title = "3.1.13 Cryptographic protection of remote access";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Employ cryptographic mechanisms to protect the confidentiality of remote access sessions.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.13 (paraphrased). Disposition: partial. Client refuses cleartext http to remote (whole channel). TLS termination itself = operator reverse proxy.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_14 : SystemRequirement {
        :>> id = "c0f1a5cc-8f0e-4a10-9b20-a1b2c3d48f0e"; :>> title = "3.1.14 Route remote access via managed access points";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Route remote access via managed access control points.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.14 (paraphrased). Disposition: operator. The reverse proxy / firewall is the managed access point (operator/SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_15 : SystemRequirement {
        :>> id = "c0f1a5cc-8f0f-4a10-9b20-a1b2c3d48f0f"; :>> title = "3.1.15 Authorize remote privileged commands";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Authorize remote execution of privileged commands and remote access to security-relevant information.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.15 (paraphrased). Disposition: met. Privileged/admin operations require an authenticated admin token; admin surface localhost-split by default.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_1_16 : SystemRequirement {
        :>> id = "c0f1a5cc-8f10-4a10-9b20-a1b2c3d48f10"; :>> title = "3.1.16 Authorize wireless access";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Authorize wireless access prior to allowing such connections.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.16 (paraphrased). Disposition: operator. Network/wireless authorization is an operator infrastructure control (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_17 : SystemRequirement {
        :>> id = "c0f1a5cc-8f11-4a10-9b20-a1b2c3d48f11"; :>> title = "3.1.17 Protect wireless access";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Protect wireless access using authentication and encryption.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.17 (paraphrased). Disposition: operator. Operator network control (WPA2/3, etc.) — out of application scope (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_18 : SystemRequirement {
        :>> id = "c0f1a5cc-8f12-4a10-9b20-a1b2c3d48f12"; :>> title = "3.1.18 Control mobile device connection";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control connection of mobile devices.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.18 (paraphrased). Disposition: operator. MDM / device enrollment is an operator control; SelfSync runs on the device the operator authorizes.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_19 : SystemRequirement {
        :>> id = "c0f1a5cc-8f13-4a10-9b20-a1b2c3d48f13"; :>> title = "3.1.19 Encrypt CUI on mobile devices";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Encrypt CUI on mobile devices and mobile computing platforms.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.19 (paraphrased). Disposition: operator. Device full-disk encryption (iOS/Android/desktop) is an operator/OS control (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_20 : SystemRequirement {
        :>> id = "c0f1a5cc-8f14-4a10-9b20-a1b2c3d48f14"; :>> title = "3.1.20 Control connections to external systems";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Verify and control/limit connections to and use of external systems.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.20 (paraphrased). Disposition: operator. Firewall/proxy exposure + safe defaults (localhost admin split, no CORS) support this; policy = SSP.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_21 : SystemRequirement {
        :>> id = "c0f1a5cc-8f15-4a10-9b20-a1b2c3d48f15"; :>> title = "3.1.21 Limit use of portable storage on external systems";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Limit use of portable storage devices on external systems.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.21 (paraphrased). Disposition: operator. Portable-media policy is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_1_22 : SystemRequirement {
        :>> id = "c0f1a5cc-8f16-4a10-9b20-a1b2c3d48f16"; :>> title = "3.1.22 Control CUI on publicly accessible systems";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control CUI posted or processed on publicly accessible systems.";
        :>> rationale = "NIST SP 800-171 rev2 3.1.22 (paraphrased). Disposition: partial. Registration closed by default; no CUI on any public/anonymous surface. Publication policy = operator.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    // ---- 3.2 Awareness and Training (AT) ----
    requirement sr_3_2_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f17-4a10-9b20-a1b2c3d48f17"; :>> title = "3.2.1 Security awareness";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Ensure managers/administrators/users are aware of security risks and applicable policies/standards/procedures.";
        :>> rationale = "NIST SP 800-171 rev2 3.2.1 (paraphrased). Disposition: operator. Security awareness program is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_2_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f18-4a10-9b20-a1b2c3d48f18"; :>> title = "3.2.2 Role-based training";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Ensure personnel are trained to carry out their assigned security-related duties.";
        :>> rationale = "NIST SP 800-171 rev2 3.2.2 (paraphrased). Disposition: operator. Role-based training is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_2_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f19-4a10-9b20-a1b2c3d48f19"; :>> title = "3.2.3 Insider-threat awareness";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Provide security awareness training on recognizing and reporting potential indicators of insider threat.";
        :>> rationale = "NIST SP 800-171 rev2 3.2.3 (paraphrased). Disposition: operator. Insider-threat training is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    // ---- 3.3 Audit and Accountability (AU) ----
    requirement sr_3_3_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f1a-4a10-9b20-a1b2c3d48f1a"; :>> title = "3.3.1 Create and retain audit logs";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Create and retain system audit logs and records to enable monitoring/analysis/investigation/reporting of unlawful or unauthorized activity.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.1 (paraphrased). Disposition: partial. Structured JSON audit events at ~25 sites (audit.rs); operator routes target=audit to an append-only sink + sets retention.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_3_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f1b-4a10-9b20-a1b2c3d48f1b"; :>> title = "3.3.2 Traceable to individual users";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Ensure the actions of individual users can be uniquely traced so they can be held accountable.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.2 (paraphrased). Disposition: met. Each audit event carries actor/action/target/outcome/UTC-timestamp/source-IP (audit.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_3_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f1c-4a10-9b20-a1b2c3d48f1c"; :>> title = "3.3.3 Review and update logged events";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Review and update logged event types.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.3 (paraphrased). Disposition: met. Closed `action` enum in audit.rs is the reviewable event catalog.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_3_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f1d-4a10-9b20-a1b2c3d48f1d"; :>> title = "3.3.4 Alert on audit logging failure";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Alert in the event of an audit logging process failure.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.4 (paraphrased). Disposition: operator. Log-pipeline health (journald/Docker) is a runtime/operator concern (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_3_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f1e-4a10-9b20-a1b2c3d48f1e"; :>> title = "3.3.5 Correlate audit records";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Correlate audit record review, analysis, and reporting for investigation/response.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.5 (paraphrased). Disposition: partial. Single-line JSON is SIEM-parseable; correlation/response = operator SIEM.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_3_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f1f-4a10-9b20-a1b2c3d48f1f"; :>> title = "3.3.6 Audit reduction and report generation";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Provide audit record reduction and report generation to support analysis/reporting.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.6 (paraphrased). Disposition: operator. SIEM ingestion/reporting = operator; the structured format supports it.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_3_7 : SystemRequirement {
        :>> id = "c0f1a5cc-8f20-4a10-9b20-a1b2c3d48f20"; :>> title = "3.3.7 Authoritative time source";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Provide a system capability that compares/synchronizes internal clocks to an authoritative source for timestamps.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.7 (paraphrased). Disposition: partial. Audit events carry in-app UTC RFC-3339 ms; host NTP sync = operator.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_3_8 : SystemRequirement {
        :>> id = "c0f1a5cc-8f21-4a10-9b20-a1b2c3d48f21"; :>> title = "3.3.8 Protect audit information";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Protect audit information and logging tools from unauthorized access, modification, and deletion.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.8 (paraphrased). Disposition: partial. Log-injection hardening prevents forged lines; at-rest sink protection = operator perms (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_3_9 : SystemRequirement {
        :>> id = "c0f1a5cc-8f22-4a10-9b20-a1b2c3d48f22"; :>> title = "3.3.9 Limit audit management";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Limit management of audit logging functionality to a subset of privileged users.";
        :>> rationale = "NIST SP 800-171 rev2 3.3.9 (paraphrased). Disposition: operator. No in-app log-management surface; host/container perms restrict it (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    // ---- 3.4 Configuration Management (CM) ----
    requirement sr_3_4_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f23-4a10-9b20-a1b2c3d48f23"; :>> title = "3.4.1 Baseline configuration & inventory";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Establish and maintain baseline configurations and inventories of systems throughout the SDLC.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.1 (paraphrased). Disposition: partial. Shipped compose is the baseline w/ safe defaults; env config documented. Inventory = operator.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_4_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f24-4a10-9b20-a1b2c3d48f24"; :>> title = "3.4.2 Enforce security configuration settings";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Establish and enforce security configuration settings for IT products.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.2 (paraphrased). Disposition: met. Env config with safe defaults; refuses to boot on the default admin password (main.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_4_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f25-4a10-9b20-a1b2c3d48f25"; :>> title = "3.4.3 Track/review/approve config changes";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Track, review, approve/disapprove, and log changes to systems.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.3 (paraphrased). Disposition: operator. Change control is organizational; the repo's decision/CR record supports it.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_4_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f26-4a10-9b20-a1b2c3d48f26"; :>> title = "3.4.4 Analyze security impact of changes";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Analyze the security impact of changes prior to implementation.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.4 (paraphrased). Disposition: operator. Security-impact analysis is a process/SSP control (the critique campaigns evidence it).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_4_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f27-4a10-9b20-a1b2c3d48f27"; :>> title = "3.4.5 Access restrictions for change";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Define/document/approve/enforce physical and logical access restrictions associated with changes.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.5 (paraphrased). Disposition: operator. Deployment/change access control is operator (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_4_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f28-4a10-9b20-a1b2c3d48f28"; :>> title = "3.4.6 Least functionality";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Employ the principle of least functionality by configuring systems to provide only essential capabilities.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.6 (paraphrased). Disposition: met. Single static binary; non-root uid 10001; slim image; admin surface split; only required ports.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_4_7 : SystemRequirement {
        :>> id = "c0f1a5cc-8f29-4a10-9b20-a1b2c3d48f29"; :>> title = "3.4.7 Restrict nonessential functions";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Restrict, disable, or prevent the use of nonessential programs, functions, ports, protocols, and services.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.7 (paraphrased). Disposition: met. Admin split off the public port (MERGE opt-out); no CORS; minimal runtime deps.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_4_8 : SystemRequirement {
        :>> id = "c0f1a5cc-8f2a-4a10-9b20-a1b2c3d48f2a"; :>> title = "3.4.8 Application allow/deny listing";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Apply deny-by-exception or permit-by-exception policy for authorized software.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.8 (paraphrased). Disposition: met. Community-plugin propagation is default-OFF with a per-plugin allowlist (configsync.ts).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_4_9 : SystemRequirement {
        :>> id = "c0f1a5cc-8f2b-4a10-9b20-a1b2c3d48f2b"; :>> title = "3.4.9 Control user-installed software";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control and monitor user-installed software.";
        :>> rationale = "NIST SP 800-171 rev2 3.4.9 (paraphrased). Disposition: met. New plugins stay device-local until opted in; self-folder hijack hardening (configsync.ts).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    // ---- 3.5 Identification and Authentication (IA) ----
    requirement sr_3_5_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f2c-4a10-9b20-a1b2c3d48f2c"; :>> title = "3.5.1 Identify users/processes/devices";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Identify system users, processes acting on behalf of users, and devices.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.1 (paraphrased). Disposition: met. Username accounts + per-request token identity (auth.rs, users.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_5_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f2d-4a10-9b20-a1b2c3d48f2d"; :>> title = "3.5.2 Authenticate identities";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Authenticate (or verify) the identities of users/processes/devices as a prerequisite to access.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.2 (paraphrased). Disposition: met. argon2id password -> bearer token, verified on every request.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_5_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f2e-4a10-9b20-a1b2c3d48f2e"; :>> title = "3.5.3 Multifactor authentication";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Use multifactor authentication for local and network access to privileged accounts and network access to non-privileged accounts.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.3 (paraphrased). Disposition: poam. No MFA yet — the top open IA item (issueCmmcMfa). Interim: VPN/mTLS/SSO proxy compensating control.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::analyze;
    }
    requirement sr_3_5_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f2f-4a10-9b20-a1b2c3d48f2f"; :>> title = "3.5.4 Replay-resistant authentication";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Employ replay-resistant authentication mechanisms for network access to privileged/non-privileged accounts.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.4 (paraphrased). Disposition: partial. Random 122-bit tokens over TLS; not a challenge-response. Full replay-resistance = MFA/mTLS (with 3.5.3).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_5_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f30-4a10-9b20-a1b2c3d48f30"; :>> title = "3.5.5 Prevent identifier reuse";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Prevent reuse of identifiers for a defined period.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.5 (paraphrased). Disposition: met. Account deletion purges data + admin membership; a re-created name never inherits prior state (admin.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_5_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f31-4a10-9b20-a1b2c3d48f31"; :>> title = "3.5.6 Disable identifiers after inactivity";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Disable identifiers after a defined period of inactivity.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.6 (paraphrased). Disposition: operator. Account-lifecycle policy (disable stale accounts) is operator; sessions idle-expire in-app (3.1.11).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_5_7 : SystemRequirement {
        :>> id = "c0f1a5cc-8f32-4a10-9b20-a1b2c3d48f32"; :>> title = "3.5.7 Password complexity";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Enforce a minimum password complexity and change of characters when new passwords are created.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.7 (paraphrased). Disposition: met. validate_password_policy: length + >=2 classes or a 15+ char passphrase, on every set path (auth.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_5_8 : SystemRequirement {
        :>> id = "c0f1a5cc-8f33-4a10-9b20-a1b2c3d48f33"; :>> title = "3.5.8 Prohibit password reuse";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Prohibit password reuse for a specified number of generations.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.8 (paraphrased). Disposition: poam. No password history yet (issueCmmcPwReuse); interim: complexity + rotation policy (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::analyze;
    }
    requirement sr_3_5_9 : SystemRequirement {
        :>> id = "c0f1a5cc-8f34-4a10-9b20-a1b2c3d48f34"; :>> title = "3.5.9 Temporary password / forced change";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Allow temporary password use for system logons with an immediate change to a permanent password.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.9 (paraphrased). Disposition: poam. Admin reset revokes sessions but sets no must-change flag yet (issueCmmcForcedChange).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::analyze;
    }
    requirement sr_3_5_10 : SystemRequirement {
        :>> id = "c0f1a5cc-8f35-4a10-9b20-a1b2c3d48f35"; :>> title = "3.5.10 Protect stored/transmitted passwords";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Store and transmit only cryptographically-protected passwords.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.10 (paraphrased). Disposition: met. argon2id at rest, tokens sha256-hashed, TLS-in-transit; client defaults to token-only (no plaintext at rest).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_5_11 : SystemRequirement {
        :>> id = "c0f1a5cc-8f36-4a10-9b20-a1b2c3d48f36"; :>> title = "3.5.11 Obscure authentication feedback";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Obscure feedback of authentication information.";
        :>> rationale = "NIST SP 800-171 rev2 3.5.11 (paraphrased). Disposition: met. De-oracled login/register (dummy-hash constant work; uniform 401/403).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    // ---- 3.6 Incident Response (IR) ----
    requirement sr_3_6_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f37-4a10-9b20-a1b2c3d48f37"; :>> title = "3.6.1 Incident-handling capability";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Establish an operational incident-handling capability (preparation/detection/analysis/containment/recovery/response).";
        :>> rationale = "NIST SP 800-171 rev2 3.6.1 (paraphrased). Disposition: operator. IR program is organizational; the audit trail + brute-force throttle support detection (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_6_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f38-4a10-9b20-a1b2c3d48f38"; :>> title = "3.6.2 Track and report incidents";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Track, document, and report incidents to designated officials/authorities.";
        :>> rationale = "NIST SP 800-171 rev2 3.6.2 (paraphrased). Disposition: operator. Incident tracking/reporting is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_6_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f39-4a10-9b20-a1b2c3d48f39"; :>> title = "3.6.3 Test incident response";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Test the organizational incident response capability.";
        :>> rationale = "NIST SP 800-171 rev2 3.6.3 (paraphrased). Disposition: operator. IR testing is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    // ---- 3.7 Maintenance (MA) ----
    requirement sr_3_7_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f3a-4a10-9b20-a1b2c3d48f3a"; :>> title = "3.7.1 Perform maintenance";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Perform maintenance on organizational systems.";
        :>> rationale = "NIST SP 800-171 rev2 3.7.1 (paraphrased). Disposition: operator. System maintenance is operator (container updates, patching) — SSP; CI dep-scanning supports it.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_7_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f3b-4a10-9b20-a1b2c3d48f3b"; :>> title = "3.7.2 Control maintenance tools/personnel";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Provide effective controls on the tools, techniques, mechanisms, and personnel used for maintenance.";
        :>> rationale = "NIST SP 800-171 rev2 3.7.2 (paraphrased). Disposition: operator. Maintenance tooling/access control is operator (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_7_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f3c-4a10-9b20-a1b2c3d48f3c"; :>> title = "3.7.3 Sanitize equipment for off-site maintenance";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Ensure equipment removed for off-site maintenance is sanitized of any CUI.";
        :>> rationale = "NIST SP 800-171 rev2 3.7.3 (paraphrased). Disposition: operator. Media sanitization is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_7_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f3d-4a10-9b20-a1b2c3d48f3d"; :>> title = "3.7.4 Check media for malicious code";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Check media containing diagnostic/test programs for malicious code before use.";
        :>> rationale = "NIST SP 800-171 rev2 3.7.4 (paraphrased). Disposition: operator. Operator media control (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_7_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f3e-4a10-9b20-a1b2c3d48f3e"; :>> title = "3.7.5 Multifactor for nonlocal maintenance";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Require multifactor authentication to establish nonlocal maintenance sessions and terminate them when complete.";
        :>> rationale = "NIST SP 800-171 rev2 3.7.5 (paraphrased). Disposition: operator. Nonlocal maintenance (SSH/VPN + MFA) is operator infrastructure (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_7_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f3f-4a10-9b20-a1b2c3d48f3f"; :>> title = "3.7.6 Supervise maintenance personnel";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Supervise the maintenance activities of personnel without required access authorization.";
        :>> rationale = "NIST SP 800-171 rev2 3.7.6 (paraphrased). Disposition: operator. Personnel supervision is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    // ---- 3.8 Media Protection (MP) ----
    requirement sr_3_8_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f40-4a10-9b20-a1b2c3d48f40"; :>> title = "3.8.1 Protect media containing CUI";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Protect (physically) system media containing CUI, both paper and digital.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.1 (paraphrased). Disposition: operator. Physical media protection is organizational; digital-at-rest = volume encryption (SSP, see 3.13.16).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_8_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f41-4a10-9b20-a1b2c3d48f41"; :>> title = "3.8.2 Limit access to CUI on media";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Limit access to CUI on system media to authorized users.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.2 (paraphrased). Disposition: partial. On-server data access = the ACL + filesystem perms (non-root); physical/media access = operator.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_8_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f42-4a10-9b20-a1b2c3d48f42"; :>> title = "3.8.3 Sanitize media before disposal";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Sanitize or destroy system media containing CUI before disposal or reuse.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.3 (paraphrased). Disposition: operator. Media sanitization/destruction is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_8_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f43-4a10-9b20-a1b2c3d48f43"; :>> title = "3.8.4 Mark media with CUI markings";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Mark media with necessary CUI markings and distribution limitations.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.4 (paraphrased). Disposition: operator. CUI marking is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_8_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f44-4a10-9b20-a1b2c3d48f44"; :>> title = "3.8.5 Control media access & accountability";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control access to media containing CUI and maintain accountability during transport.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.5 (paraphrased). Disposition: operator. Media transport control is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_8_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f45-4a10-9b20-a1b2c3d48f45"; :>> title = "3.8.6 Cryptographic protection during transport";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Implement cryptographic mechanisms to protect the confidentiality of CUI on media during transport.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.6 (paraphrased). Disposition: operator. Encrypted transport media is organizational; in-transit network encryption is 3.13.8 (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_8_7 : SystemRequirement {
        :>> id = "c0f1a5cc-8f46-4a10-9b20-a1b2c3d48f46"; :>> title = "3.8.7 Control removable media";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control the use of removable media on system components.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.7 (paraphrased). Disposition: operator. Removable-media control is organizational/endpoint (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_8_8 : SystemRequirement {
        :>> id = "c0f1a5cc-8f47-4a10-9b20-a1b2c3d48f47"; :>> title = "3.8.8 Prohibit unidentified-owner portable storage";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Prohibit the use of portable storage devices when such devices have no identifiable owner.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.8 (paraphrased). Disposition: operator. Portable-storage policy is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_8_9 : SystemRequirement {
        :>> id = "c0f1a5cc-8f48-4a10-9b20-a1b2c3d48f48"; :>> title = "3.8.9 Protect backups";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Protect the confidentiality of backup CUI at storage locations.";
        :>> rationale = "NIST SP 800-171 rev2 3.8.9 (paraphrased). Disposition: operator. Backup protection (encrypt the /data backup) is operator (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    // ---- 3.9 Personnel Security (PS) ----
    requirement sr_3_9_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f49-4a10-9b20-a1b2c3d48f49"; :>> title = "3.9.1 Screen individuals";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Screen individuals prior to authorizing access to systems containing CUI.";
        :>> rationale = "NIST SP 800-171 rev2 3.9.1 (paraphrased). Disposition: operator. Personnel screening is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_9_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f4a-4a10-9b20-a1b2c3d48f4a"; :>> title = "3.9.2 Protect CUI during personnel actions";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Ensure CUI and systems are protected during and after personnel actions (e.g., terminations, transfers).";
        :>> rationale = "NIST SP 800-171 rev2 3.9.2 (paraphrased). Disposition: operator. Deprovisioning is organizational; account/session revoke + admin demote support it (admin.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    // ---- 3.10 Physical Protection (PE) ----
    requirement sr_3_10_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f4b-4a10-9b20-a1b2c3d48f4b"; :>> title = "3.10.1 Limit physical access";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Limit physical access to systems, equipment, and operating environments to authorized individuals.";
        :>> rationale = "NIST SP 800-171 rev2 3.10.1 (paraphrased). Disposition: operator. Physical access control is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_10_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f4c-4a10-9b20-a1b2c3d48f4c"; :>> title = "3.10.2 Protect physical plant";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Protect and monitor the physical facility and support infrastructure.";
        :>> rationale = "NIST SP 800-171 rev2 3.10.2 (paraphrased). Disposition: operator. Facility protection is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_10_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f4d-4a10-9b20-a1b2c3d48f4d"; :>> title = "3.10.3 Escort visitors";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Escort visitors and monitor visitor activity.";
        :>> rationale = "NIST SP 800-171 rev2 3.10.3 (paraphrased). Disposition: operator. Visitor control is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_10_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f4e-4a10-9b20-a1b2c3d48f4e"; :>> title = "3.10.4 Maintain physical access logs";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Maintain audit logs of physical access.";
        :>> rationale = "NIST SP 800-171 rev2 3.10.4 (paraphrased). Disposition: operator. Physical access logging is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_10_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f4f-4a10-9b20-a1b2c3d48f4f"; :>> title = "3.10.5 Control physical access devices";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control and manage physical access devices.";
        :>> rationale = "NIST SP 800-171 rev2 3.10.5 (paraphrased). Disposition: operator. Physical key/badge control is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_10_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f50-4a10-9b20-a1b2c3d48f50"; :>> title = "3.10.6 Safeguard CUI at alternate work sites";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Enforce safeguarding measures for CUI at alternate work sites.";
        :>> rationale = "NIST SP 800-171 rev2 3.10.6 (paraphrased). Disposition: operator. Alternate-work-site policy is organizational (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    // ---- 3.11 Risk Assessment (RA) ----
    requirement sr_3_11_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f51-4a10-9b20-a1b2c3d48f51"; :>> title = "3.11.1 Assess risk";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Periodically assess the risk to operations/assets/individuals from operating systems that process CUI.";
        :>> rationale = "NIST SP 800-171 rev2 3.11.1 (paraphrased). Disposition: operator. Risk assessment is organizational; the 24-round critique + audit evidence support it (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_11_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f52-4a10-9b20-a1b2c3d48f52"; :>> title = "3.11.2 Scan for vulnerabilities";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Scan for vulnerabilities in systems and applications periodically and when new vulnerabilities are identified.";
        :>> rationale = "NIST SP 800-171 rev2 3.11.2 (paraphrased). Disposition: partial. CI runs cargo-audit + npm-audit on push/PR/weekly (dependency vulns); infra scanning = operator.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_11_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f53-4a10-9b20-a1b2c3d48f53"; :>> title = "3.11.3 Remediate vulnerabilities";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Remediate vulnerabilities in accordance with risk assessments.";
        :>> rationale = "NIST SP 800-171 rev2 3.11.3 (paraphrased). Disposition: partial. Documented remediation discipline (tracked fixes); operator applies updates + tracks POA&M.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    // ---- 3.12 Security Assessment (CA) ----
    requirement sr_3_12_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f54-4a10-9b20-a1b2c3d48f54"; :>> title = "3.12.1 Assess controls periodically";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Periodically assess the security controls to determine effectiveness.";
        :>> rationale = "NIST SP 800-171 rev2 3.12.1 (paraphrased). Disposition: partial. This posture assessment + the critique campaigns; ongoing assessment cadence = operator (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_12_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f55-4a10-9b20-a1b2c3d48f55"; :>> title = "3.12.2 Plan of action (POA&M)";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Develop and implement plans of action to correct deficiencies and reduce/eliminate vulnerabilities.";
        :>> rationale = "NIST SP 800-171 rev2 3.12.2 (paraphrased). Disposition: met. docs/cmmc-posture.md carries a POA&M; open Issues track each deficiency (this model).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_12_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f56-4a10-9b20-a1b2c3d48f56"; :>> title = "3.12.3 Monitor controls";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Monitor security controls on an ongoing basis to ensure continued effectiveness.";
        :>> rationale = "NIST SP 800-171 rev2 3.12.3 (paraphrased). Disposition: partial. CI + audit trail + this compliance model; continuous monitoring program = operator (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_12_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f57-4a10-9b20-a1b2c3d48f57"; :>> title = "3.12.4 System security plan";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Develop, document, and periodically update system security plans.";
        :>> rationale = "NIST SP 800-171 rev2 3.12.4 (paraphrased). Disposition: operator. The SSP is the operator's document; this posture doc + compliance model are engineering inputs to it.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    // ---- 3.13 System and Communications Protection (SC) ----
    requirement sr_3_13_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f58-4a10-9b20-a1b2c3d48f58"; :>> title = "3.13.1 Monitor/control communications at boundaries";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Monitor, control, and protect communications at external boundaries and key internal boundaries.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.1 (paraphrased). Disposition: met. public/admin router split; body cap; per-connection WS budget (lib.rs, ws.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f59-4a10-9b20-a1b2c3d48f59"; :>> title = "3.13.2 Architectural security design";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Employ architectural designs, software development techniques, and systems engineering principles that promote effective information security.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.2 (paraphrased). Disposition: met. ASoT/SysML engineering; content-addressed store; typed error boundary; 24-round adversarial review.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f5a-4a10-9b20-a1b2c3d48f5a"; :>> title = "3.13.3 Separate user & system management functionality";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Separate user functionality from system management functionality.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.3 (paraphrased). Disposition: met. Sync (user) vs /admin (management) are separate routers; admin binds localhost by default (lib.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f5b-4a10-9b20-a1b2c3d48f5b"; :>> title = "3.13.4 Prevent unauthorized info transfer via shared resources";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Prevent unauthorized and unintended information transfer via shared system resources.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.4 (paraphrased). Disposition: met. Per-(user,vault) SQLite index + per-vault chunk store; no shared chunk pool; scoped() isolation.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f5c-4a10-9b20-a1b2c3d48f5c"; :>> title = "3.13.5 Separate public-access subnetworks";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Implement subnetworks for publicly accessible system components that are separated from internal networks.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.5 (paraphrased). Disposition: partial. Admin localhost-split by default; DMZ/subnet placement = operator (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f5d-4a10-9b20-a1b2c3d48f5d"; :>> title = "3.13.6 Deny by default";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Deny network communications traffic by default and allow by exception.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.6 (paraphrased). Disposition: met. Registration closed by default; ACL deny-by-default; no CORS (lib.rs, registration.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_7 : SystemRequirement {
        :>> id = "c0f1a5cc-8f5e-4a10-9b20-a1b2c3d48f5e"; :>> title = "3.13.7 Prevent split tunneling";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Prevent remote devices from simultaneously establishing non-remote connections and communicating via another connection.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.7 (paraphrased). Disposition: operator. Split-tunnel prevention is an endpoint/VPN control (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_13_8 : SystemRequirement {
        :>> id = "c0f1a5cc-8f5f-4a10-9b20-a1b2c3d48f5f"; :>> title = "3.13.8 Encrypt CUI in transit";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Implement cryptographic mechanisms to prevent unauthorized disclosure of CUI during transmission unless otherwise protected.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.8 (paraphrased). Disposition: partial. Client refuses cleartext http to a remote host on the whole channel; TLS termination + HSTS = operator proxy.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_9 : SystemRequirement {
        :>> id = "c0f1a5cc-8f60-4a10-9b20-a1b2c3d48f60"; :>> title = "3.13.9 Terminate network connections";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Terminate network connections at the end of sessions or after a defined period of inactivity.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.9 (paraphrased). Disposition: met. WS session re-checked every ping/msg and torn down on expiry/revoke; token idle-expiry (3.1.11).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_10 : SystemRequirement {
        :>> id = "c0f1a5cc-8f61-4a10-9b20-a1b2c3d48f61"; :>> title = "3.13.10 Cryptographic key management";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Establish and manage cryptographic keys for cryptography employed in the system.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.10 (paraphrased). Disposition: met. Random UUID tokens hashed at rest; per-user OsRng salts; env-rotatable bootstrap key (tokens.rs, users.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_11 : SystemRequirement {
        :>> id = "c0f1a5cc-8f62-4a10-9b20-a1b2c3d48f62"; :>> title = "3.13.11 FIPS-validated cryptography";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Employ FIPS-validated cryptography when used to protect the confidentiality of CUI.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.11 (paraphrased). Disposition: poam. argon2/sha2 crates + client SHA-256 are not FIPS-validated modules (issueCmmcFips); decision in posture doc.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::analyze;
    }
    requirement sr_3_13_12 : SystemRequirement {
        :>> id = "c0f1a5cc-8f63-4a10-9b20-a1b2c3d48f63"; :>> title = "3.13.12 Restrict collaborative computing devices";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Prohibit remote activation of collaborative computing devices and provide indication of use.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.12 (paraphrased). Disposition: operator. N/A to a sync server (no camera/mic); endpoint control if any (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_13_13 : SystemRequirement {
        :>> id = "c0f1a5cc-8f64-4a10-9b20-a1b2c3d48f64"; :>> title = "3.13.13 Control mobile code";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control and monitor the use of mobile code.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.13 (paraphrased). Disposition: met. Sync-delivered plugin code is never auto-executed (trust-prompt gate); community-code off by default.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_14 : SystemRequirement {
        :>> id = "c0f1a5cc-8f65-4a10-9b20-a1b2c3d48f65"; :>> title = "3.13.14 Control VoIP";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Control and monitor the use of Voice over Internet Protocol technologies.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.14 (paraphrased). Disposition: operator. N/A to SelfSync; any VoIP is operator network scope (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_13_15 : SystemRequirement {
        :>> id = "c0f1a5cc-8f66-4a10-9b20-a1b2c3d48f66"; :>> title = "3.13.15 Protect communications authenticity";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Protect the authenticity of communications sessions.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.15 (paraphrased). Disposition: met. Bearer token off-URL (WS subprotocol); live WS re-authorization every ping/message (ws.rs).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_13_16 : SystemRequirement {
        :>> id = "c0f1a5cc-8f67-4a10-9b20-a1b2c3d48f67"; :>> title = "3.13.16 Protect CUI at rest";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Protect the confidentiality of CUI at rest.";
        :>> rationale = "NIST SP 800-171 rev2 3.13.16 (paraphrased). Disposition: poam. Notes stored plaintext (no E2EE); operator volume encryption is the near-term control (issueCmmcAtRest).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::analyze;
    }
    // ---- 3.14 System and Information Integrity (SI) ----
    requirement sr_3_14_1 : SystemRequirement {
        :>> id = "c0f1a5cc-8f68-4a10-9b20-a1b2c3d48f68"; :>> title = "3.14.1 Flaw remediation";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Identify, report, and correct system flaws in a timely manner.";
        :>> rationale = "NIST SP 800-171 rev2 3.14.1 (paraphrased). Disposition: met. CI runs server+client tests, cargo-audit, npm-audit on push/PR/weekly (ci.yml).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_14_2 : SystemRequirement {
        :>> id = "c0f1a5cc-8f69-4a10-9b20-a1b2c3d48f69"; :>> title = "3.14.2 Malicious-code protection";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Provide protection from malicious code at designated locations.";
        :>> rationale = "NIST SP 800-171 rev2 3.14.2 (paraphrased). Disposition: partial. Community-plugin code off-by-default + allowlist; endpoint AV = operator (SSP).";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_14_3 : SystemRequirement {
        :>> id = "c0f1a5cc-8f6a-4a10-9b20-a1b2c3d48f6a"; :>> title = "3.14.3 Monitor security alerts";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Monitor system security alerts and advisories and take action in response.";
        :>> rationale = "NIST SP 800-171 rev2 3.14.3 (paraphrased). Disposition: partial. cargo-audit/npm-audit surface advisories in CI; acting on them = operator maintenance.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_14_4 : SystemRequirement {
        :>> id = "c0f1a5cc-8f6b-4a10-9b20-a1b2c3d48f6b"; :>> title = "3.14.4 Update malicious-code protection";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Update malicious-code protection mechanisms when new releases are available.";
        :>> rationale = "NIST SP 800-171 rev2 3.14.4 (paraphrased). Disposition: operator. Endpoint AV updates = operator; the plugin-code gate needs no signature updates.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_14_5 : SystemRequirement {
        :>> id = "c0f1a5cc-8f6c-4a10-9b20-a1b2c3d48f6c"; :>> title = "3.14.5 Periodic + real-time scans";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Perform periodic scans and real-time scans of files from external sources as they are downloaded/opened/executed.";
        :>> rationale = "NIST SP 800-171 rev2 3.14.5 (paraphrased). Disposition: operator. Endpoint AV scanning = operator; content chunks are hash-verified for integrity, not AV-scanned.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::confirmation;
    }
    requirement sr_3_14_6 : SystemRequirement {
        :>> id = "c0f1a5cc-8f6d-4a10-9b20-a1b2c3d48f6d"; :>> title = "3.14.6 Monitor for attacks/indicators";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Monitor systems, including inbound/outbound traffic, to detect attacks and indicators of potential attacks.";
        :>> rationale = "NIST SP 800-171 rev2 3.14.6 (paraphrased). Disposition: partial. Audit trail + brute-force throttle + authz-denial events; SIEM/IDS correlation = operator.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }
    requirement sr_3_14_7 : SystemRequirement {
        :>> id = "c0f1a5cc-8f6e-4a10-9b20-a1b2c3d48f6e"; :>> title = "3.14.7 Identify unauthorized use";
        :>> createdAt = "2026-07-10"; :>> createdBy = "wweatherholtz";
        :>> statement = "Identify unauthorized use of organizational systems.";
        :>> rationale = "NIST SP 800-171 rev2 3.14.7 (paraphrased). Disposition: partial. Audit events (authz denials, logins, admin actions) enable detection; investigation = operator SIEM.";
        :>> kind = RequirementKind::security; :>> priority = Priority::must; :>> verificationMethod = VerificationMethod::inspect;
    }

    // ---- satisfy: each control satisfies the compliance Need (tier-satisfaction: 110 SRs) ----
    satisfy nComply800171 by sr_3_1_1;
    satisfy nComply800171 by sr_3_1_2;
    satisfy nComply800171 by sr_3_1_3;
    satisfy nComply800171 by sr_3_1_4;
    satisfy nComply800171 by sr_3_1_5;
    satisfy nComply800171 by sr_3_1_6;
    satisfy nComply800171 by sr_3_1_7;
    satisfy nComply800171 by sr_3_1_8;
    satisfy nComply800171 by sr_3_1_9;
    satisfy nComply800171 by sr_3_1_10;
    satisfy nComply800171 by sr_3_1_11;
    satisfy nComply800171 by sr_3_1_12;
    satisfy nComply800171 by sr_3_1_13;
    satisfy nComply800171 by sr_3_1_14;
    satisfy nComply800171 by sr_3_1_15;
    satisfy nComply800171 by sr_3_1_16;
    satisfy nComply800171 by sr_3_1_17;
    satisfy nComply800171 by sr_3_1_18;
    satisfy nComply800171 by sr_3_1_19;
    satisfy nComply800171 by sr_3_1_20;
    satisfy nComply800171 by sr_3_1_21;
    satisfy nComply800171 by sr_3_1_22;
    satisfy nComply800171 by sr_3_2_1;
    satisfy nComply800171 by sr_3_2_2;
    satisfy nComply800171 by sr_3_2_3;
    satisfy nComply800171 by sr_3_3_1;
    satisfy nComply800171 by sr_3_3_2;
    satisfy nComply800171 by sr_3_3_3;
    satisfy nComply800171 by sr_3_3_4;
    satisfy nComply800171 by sr_3_3_5;
    satisfy nComply800171 by sr_3_3_6;
    satisfy nComply800171 by sr_3_3_7;
    satisfy nComply800171 by sr_3_3_8;
    satisfy nComply800171 by sr_3_3_9;
    satisfy nComply800171 by sr_3_4_1;
    satisfy nComply800171 by sr_3_4_2;
    satisfy nComply800171 by sr_3_4_3;
    satisfy nComply800171 by sr_3_4_4;
    satisfy nComply800171 by sr_3_4_5;
    satisfy nComply800171 by sr_3_4_6;
    satisfy nComply800171 by sr_3_4_7;
    satisfy nComply800171 by sr_3_4_8;
    satisfy nComply800171 by sr_3_4_9;
    satisfy nComply800171 by sr_3_5_1;
    satisfy nComply800171 by sr_3_5_2;
    satisfy nComply800171 by sr_3_5_3;
    satisfy nComply800171 by sr_3_5_4;
    satisfy nComply800171 by sr_3_5_5;
    satisfy nComply800171 by sr_3_5_6;
    satisfy nComply800171 by sr_3_5_7;
    satisfy nComply800171 by sr_3_5_8;
    satisfy nComply800171 by sr_3_5_9;
    satisfy nComply800171 by sr_3_5_10;
    satisfy nComply800171 by sr_3_5_11;
    satisfy nComply800171 by sr_3_6_1;
    satisfy nComply800171 by sr_3_6_2;
    satisfy nComply800171 by sr_3_6_3;
    satisfy nComply800171 by sr_3_7_1;
    satisfy nComply800171 by sr_3_7_2;
    satisfy nComply800171 by sr_3_7_3;
    satisfy nComply800171 by sr_3_7_4;
    satisfy nComply800171 by sr_3_7_5;
    satisfy nComply800171 by sr_3_7_6;
    satisfy nComply800171 by sr_3_8_1;
    satisfy nComply800171 by sr_3_8_2;
    satisfy nComply800171 by sr_3_8_3;
    satisfy nComply800171 by sr_3_8_4;
    satisfy nComply800171 by sr_3_8_5;
    satisfy nComply800171 by sr_3_8_6;
    satisfy nComply800171 by sr_3_8_7;
    satisfy nComply800171 by sr_3_8_8;
    satisfy nComply800171 by sr_3_8_9;
    satisfy nComply800171 by sr_3_9_1;
    satisfy nComply800171 by sr_3_9_2;
    satisfy nComply800171 by sr_3_10_1;
    satisfy nComply800171 by sr_3_10_2;
    satisfy nComply800171 by sr_3_10_3;
    satisfy nComply800171 by sr_3_10_4;
    satisfy nComply800171 by sr_3_10_5;
    satisfy nComply800171 by sr_3_10_6;
    satisfy nComply800171 by sr_3_11_1;
    satisfy nComply800171 by sr_3_11_2;
    satisfy nComply800171 by sr_3_11_3;
    satisfy nComply800171 by sr_3_12_1;
    satisfy nComply800171 by sr_3_12_2;
    satisfy nComply800171 by sr_3_12_3;
    satisfy nComply800171 by sr_3_12_4;
    satisfy nComply800171 by sr_3_13_1;
    satisfy nComply800171 by sr_3_13_2;
    satisfy nComply800171 by sr_3_13_3;
    satisfy nComply800171 by sr_3_13_4;
    satisfy nComply800171 by sr_3_13_5;
    satisfy nComply800171 by sr_3_13_6;
    satisfy nComply800171 by sr_3_13_7;
    satisfy nComply800171 by sr_3_13_8;
    satisfy nComply800171 by sr_3_13_9;
    satisfy nComply800171 by sr_3_13_10;
    satisfy nComply800171 by sr_3_13_11;
    satisfy nComply800171 by sr_3_13_12;
    satisfy nComply800171 by sr_3_13_13;
    satisfy nComply800171 by sr_3_13_14;
    satisfy nComply800171 by sr_3_13_15;
    satisfy nComply800171 by sr_3_13_16;
    satisfy nComply800171 by sr_3_14_1;
    satisfy nComply800171 by sr_3_14_2;
    satisfy nComply800171 by sr_3_14_3;
    satisfy nComply800171 by sr_3_14_4;
    satisfy nComply800171 by sr_3_14_5;
    satisfy nComply800171 by sr_3_14_6;
    satisfy nComply800171 by sr_3_14_7;

    // ---- #Verify Tests for MET / PARTIAL controls (self-evidencing inspection of the cited code). ----
    // operator controls carry NO passing verification yet (PENDING the operator's attestation); poam
    // controls carry an open Issue (below) and no verification. Both surface as gaps in coverage.
    verification v_3_1_1 : Test { :>> id = "c0f1a5cc-9001-4a10-9b20-a1b2c3d49001"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.1: Every route AuthToken-gated; scoped() re-authorizes per request on HTTP+WS (api.rs, ws.rs)."; }
    verification v_3_1_2 : Test { :>> id = "c0f1a5cc-9002-4a10-9b20-a1b2c3d49002"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.2: read vs read-write ACL (shares.rs); admin funcs behind require_admin (admin.rs)."; }
    verification v_3_1_3 : Test { :>> id = "c0f1a5cc-9003-4a10-9b20-a1b2c3d49003"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.3: In-boundary: server-enforced owner/grant ACL per op. Cross-boundary flow = operator network/proxy policy."; }
    verification v_3_1_5 : Test { :>> id = "c0f1a5cc-9004-4a10-9b20-a1b2c3d49004"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.5: Bootstrap + explicit admin set only; non-admins 403 on all admin routes; admin set purged on delete."; }
    verification v_3_1_7 : Test { :>> id = "c0f1a5cc-9005-4a10-9b20-a1b2c3d49005"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.7: Privileged endpoints require_admin; every privileged action emits an audit event (audit.rs)."; }
    verification v_3_1_8 : Test { :>> id = "c0f1a5cc-9006-4a10-9b20-a1b2c3d49006"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.8: Per-account throttle: 10 fails / 5 min -> 429 + Retry-After, checked before argon2 (throttle.rs)."; }
    verification v_3_1_9 : Test { :>> id = "c0f1a5cc-9007-4a10-9b20-a1b2c3d49007"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.9: SYNC_LOGIN_BANNER shown pre-auth in the admin page + setup wizard via /health."; }
    verification v_3_1_11 : Test { :>> id = "c0f1a5cc-9008-4a10-9b20-a1b2c3d49008"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.11: Token idle-expiry SESSION_IDLE_TIMEOUT_SECS (default 30 min) + 30-day absolute cap (tokens.rs)."; }
    verification v_3_1_12 : Test { :>> id = "c0f1a5cc-9009-4a10-9b20-a1b2c3d49009"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.12: All remote access token-gated, audited, revocable; WS re-auth every ping/msg. Central monitoring = operator SIEM."; }
    verification v_3_1_13 : Test { :>> id = "c0f1a5cc-900a-4a10-9b20-a1b2c3d4900a"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.13: Client refuses cleartext http to remote (whole channel). TLS termination itself = operator reverse proxy."; }
    verification v_3_1_15 : Test { :>> id = "c0f1a5cc-900b-4a10-9b20-a1b2c3d4900b"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.15: Privileged/admin operations require an authenticated admin token; admin surface localhost-split by default."; }
    verification v_3_1_22 : Test { :>> id = "c0f1a5cc-900c-4a10-9b20-a1b2c3d4900c"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.1.22: Registration closed by default; no CUI on any public/anonymous surface. Publication policy = operator."; }
    verification v_3_3_1 : Test { :>> id = "c0f1a5cc-900d-4a10-9b20-a1b2c3d4900d"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.3.1: Structured JSON audit events at ~25 sites (audit.rs); operator routes target=audit to an append-only sink + sets retention."; }
    verification v_3_3_2 : Test { :>> id = "c0f1a5cc-900e-4a10-9b20-a1b2c3d4900e"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.3.2: Each audit event carries actor/action/target/outcome/UTC-timestamp/source-IP (audit.rs)."; }
    verification v_3_3_3 : Test { :>> id = "c0f1a5cc-900f-4a10-9b20-a1b2c3d4900f"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.3.3: Closed `action` enum in audit.rs is the reviewable event catalog."; }
    verification v_3_3_5 : Test { :>> id = "c0f1a5cc-9010-4a10-9b20-a1b2c3d49010"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.3.5: Single-line JSON is SIEM-parseable; correlation/response = operator SIEM."; }
    verification v_3_3_7 : Test { :>> id = "c0f1a5cc-9011-4a10-9b20-a1b2c3d49011"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.3.7: Audit events carry in-app UTC RFC-3339 ms; host NTP sync = operator."; }
    verification v_3_3_8 : Test { :>> id = "c0f1a5cc-9012-4a10-9b20-a1b2c3d49012"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.3.8: Log-injection hardening prevents forged lines; at-rest sink protection = operator perms (SSP)."; }
    verification v_3_4_1 : Test { :>> id = "c0f1a5cc-9013-4a10-9b20-a1b2c3d49013"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.4.1: Shipped compose is the baseline w/ safe defaults; env config documented. Inventory = operator."; }
    verification v_3_4_2 : Test { :>> id = "c0f1a5cc-9014-4a10-9b20-a1b2c3d49014"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.4.2: Env config with safe defaults; refuses to boot on the default admin password (main.rs)."; }
    verification v_3_4_6 : Test { :>> id = "c0f1a5cc-9015-4a10-9b20-a1b2c3d49015"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.4.6: Single static binary; non-root uid 10001; slim image; admin surface split; only required ports."; }
    verification v_3_4_7 : Test { :>> id = "c0f1a5cc-9016-4a10-9b20-a1b2c3d49016"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.4.7: Admin split off the public port (MERGE opt-out); no CORS; minimal runtime deps."; }
    verification v_3_4_8 : Test { :>> id = "c0f1a5cc-9017-4a10-9b20-a1b2c3d49017"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.4.8: Community-plugin propagation is default-OFF with a per-plugin allowlist (configsync.ts)."; }
    verification v_3_4_9 : Test { :>> id = "c0f1a5cc-9018-4a10-9b20-a1b2c3d49018"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.4.9: New plugins stay device-local until opted in; self-folder hijack hardening (configsync.ts)."; }
    verification v_3_5_1 : Test { :>> id = "c0f1a5cc-9019-4a10-9b20-a1b2c3d49019"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.5.1: Username accounts + per-request token identity (auth.rs, users.rs)."; }
    verification v_3_5_2 : Test { :>> id = "c0f1a5cc-901a-4a10-9b20-a1b2c3d4901a"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.5.2: argon2id password -> bearer token, verified on every request."; }
    verification v_3_5_4 : Test { :>> id = "c0f1a5cc-901b-4a10-9b20-a1b2c3d4901b"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.5.4: Random 122-bit tokens over TLS; not a challenge-response. Full replay-resistance = MFA/mTLS (with 3.5.3)."; }
    verification v_3_5_5 : Test { :>> id = "c0f1a5cc-901c-4a10-9b20-a1b2c3d4901c"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.5.5: Account deletion purges data + admin membership; a re-created name never inherits prior state (admin.rs)."; }
    verification v_3_5_7 : Test { :>> id = "c0f1a5cc-901d-4a10-9b20-a1b2c3d4901d"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.5.7: validate_password_policy: length + >=2 classes or a 15+ char passphrase, on every set path (auth.rs)."; }
    verification v_3_5_10 : Test { :>> id = "c0f1a5cc-901e-4a10-9b20-a1b2c3d4901e"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.5.10: argon2id at rest, tokens sha256-hashed, TLS-in-transit; client defaults to token-only (no plaintext at rest)."; }
    verification v_3_5_11 : Test { :>> id = "c0f1a5cc-901f-4a10-9b20-a1b2c3d4901f"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.5.11: De-oracled login/register (dummy-hash constant work; uniform 401/403)."; }
    verification v_3_8_2 : Test { :>> id = "c0f1a5cc-9020-4a10-9b20-a1b2c3d49020"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.8.2: On-server data access = the ACL + filesystem perms (non-root); physical/media access = operator."; }
    verification v_3_11_2 : Test { :>> id = "c0f1a5cc-9021-4a10-9b20-a1b2c3d49021"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.11.2: CI runs cargo-audit + npm-audit on push/PR/weekly (dependency vulns); infra scanning = operator."; }
    verification v_3_11_3 : Test { :>> id = "c0f1a5cc-9022-4a10-9b20-a1b2c3d49022"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.11.3: Documented remediation discipline (tracked fixes); operator applies updates + tracks POA&M."; }
    verification v_3_12_1 : Test { :>> id = "c0f1a5cc-9023-4a10-9b20-a1b2c3d49023"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.12.1: This posture assessment + the critique campaigns; ongoing assessment cadence = operator (SSP)."; }
    verification v_3_12_2 : Test { :>> id = "c0f1a5cc-9024-4a10-9b20-a1b2c3d49024"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.12.2: docs/cmmc-posture.md carries a POA&M; open Issues track each deficiency (this model)."; }
    verification v_3_12_3 : Test { :>> id = "c0f1a5cc-9025-4a10-9b20-a1b2c3d49025"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.12.3: CI + audit trail + this compliance model; continuous monitoring program = operator (SSP)."; }
    verification v_3_13_1 : Test { :>> id = "c0f1a5cc-9026-4a10-9b20-a1b2c3d49026"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.1: public/admin router split; body cap; per-connection WS budget (lib.rs, ws.rs)."; }
    verification v_3_13_2 : Test { :>> id = "c0f1a5cc-9027-4a10-9b20-a1b2c3d49027"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.2: ASoT/SysML engineering; content-addressed store; typed error boundary; 24-round adversarial review."; }
    verification v_3_13_3 : Test { :>> id = "c0f1a5cc-9028-4a10-9b20-a1b2c3d49028"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.3: Sync (user) vs /admin (management) are separate routers; admin binds localhost by default (lib.rs)."; }
    verification v_3_13_4 : Test { :>> id = "c0f1a5cc-9029-4a10-9b20-a1b2c3d49029"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.4: Per-(user,vault) SQLite index + per-vault chunk store; no shared chunk pool; scoped() isolation."; }
    verification v_3_13_5 : Test { :>> id = "c0f1a5cc-902a-4a10-9b20-a1b2c3d4902a"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.5: Admin localhost-split by default; DMZ/subnet placement = operator (SSP)."; }
    verification v_3_13_6 : Test { :>> id = "c0f1a5cc-902b-4a10-9b20-a1b2c3d4902b"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.6: Registration closed by default; ACL deny-by-default; no CORS (lib.rs, registration.rs)."; }
    verification v_3_13_8 : Test { :>> id = "c0f1a5cc-902c-4a10-9b20-a1b2c3d4902c"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.8: Client refuses cleartext http to a remote host on the whole channel; TLS termination + HSTS = operator proxy."; }
    verification v_3_13_9 : Test { :>> id = "c0f1a5cc-902d-4a10-9b20-a1b2c3d4902d"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.9: WS session re-checked every ping/msg and torn down on expiry/revoke; token idle-expiry (3.1.11)."; }
    verification v_3_13_10 : Test { :>> id = "c0f1a5cc-902e-4a10-9b20-a1b2c3d4902e"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.10: Random UUID tokens hashed at rest; per-user OsRng salts; env-rotatable bootstrap key (tokens.rs, users.rs)."; }
    verification v_3_13_13 : Test { :>> id = "c0f1a5cc-902f-4a10-9b20-a1b2c3d4902f"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.13: Sync-delivered plugin code is never auto-executed (trust-prompt gate); community-code off by default."; }
    verification v_3_13_15 : Test { :>> id = "c0f1a5cc-9030-4a10-9b20-a1b2c3d49030"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.13.15: Bearer token off-URL (WS subprotocol); live WS re-authorization every ping/message (ws.rs)."; }
    verification v_3_14_1 : Test { :>> id = "c0f1a5cc-9031-4a10-9b20-a1b2c3d49031"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.14.1: CI runs server+client tests, cargo-audit, npm-audit on push/PR/weekly (ci.yml)."; }
    verification v_3_14_2 : Test { :>> id = "c0f1a5cc-9032-4a10-9b20-a1b2c3d49032"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.14.2: Community-plugin code off-by-default + allowlist; endpoint AV = operator (SSP)."; }
    verification v_3_14_3 : Test { :>> id = "c0f1a5cc-9033-4a10-9b20-a1b2c3d49033"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.14.3: cargo-audit/npm-audit surface advisories in CI; acting on them = operator maintenance."; }
    verification v_3_14_6 : Test { :>> id = "c0f1a5cc-9034-4a10-9b20-a1b2c3d49034"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.14.6: Audit trail + brute-force throttle + authz-denial events; SIEM/IDS correlation = operator."; }
    verification v_3_14_7 : Test { :>> id = "c0f1a5cc-9035-4a10-9b20-a1b2c3d49035"; :>> method = VerificationMethod::inspect; :>> procedureText = "3.14.7: Audit events (authz denials, logins, admin actions) enable detection; investigation = operator SIEM."; }
    #Verify dependency from v_3_1_1 to sr_3_1_1;
    #Verify dependency from v_3_1_2 to sr_3_1_2;
    #Verify dependency from v_3_1_3 to sr_3_1_3;
    #Verify dependency from v_3_1_5 to sr_3_1_5;
    #Verify dependency from v_3_1_7 to sr_3_1_7;
    #Verify dependency from v_3_1_8 to sr_3_1_8;
    #Verify dependency from v_3_1_9 to sr_3_1_9;
    #Verify dependency from v_3_1_11 to sr_3_1_11;
    #Verify dependency from v_3_1_12 to sr_3_1_12;
    #Verify dependency from v_3_1_13 to sr_3_1_13;
    #Verify dependency from v_3_1_15 to sr_3_1_15;
    #Verify dependency from v_3_1_22 to sr_3_1_22;
    #Verify dependency from v_3_3_1 to sr_3_3_1;
    #Verify dependency from v_3_3_2 to sr_3_3_2;
    #Verify dependency from v_3_3_3 to sr_3_3_3;
    #Verify dependency from v_3_3_5 to sr_3_3_5;
    #Verify dependency from v_3_3_7 to sr_3_3_7;
    #Verify dependency from v_3_3_8 to sr_3_3_8;
    #Verify dependency from v_3_4_1 to sr_3_4_1;
    #Verify dependency from v_3_4_2 to sr_3_4_2;
    #Verify dependency from v_3_4_6 to sr_3_4_6;
    #Verify dependency from v_3_4_7 to sr_3_4_7;
    #Verify dependency from v_3_4_8 to sr_3_4_8;
    #Verify dependency from v_3_4_9 to sr_3_4_9;
    #Verify dependency from v_3_5_1 to sr_3_5_1;
    #Verify dependency from v_3_5_2 to sr_3_5_2;
    #Verify dependency from v_3_5_4 to sr_3_5_4;
    #Verify dependency from v_3_5_5 to sr_3_5_5;
    #Verify dependency from v_3_5_7 to sr_3_5_7;
    #Verify dependency from v_3_5_10 to sr_3_5_10;
    #Verify dependency from v_3_5_11 to sr_3_5_11;
    #Verify dependency from v_3_8_2 to sr_3_8_2;
    #Verify dependency from v_3_11_2 to sr_3_11_2;
    #Verify dependency from v_3_11_3 to sr_3_11_3;
    #Verify dependency from v_3_12_1 to sr_3_12_1;
    #Verify dependency from v_3_12_2 to sr_3_12_2;
    #Verify dependency from v_3_12_3 to sr_3_12_3;
    #Verify dependency from v_3_13_1 to sr_3_13_1;
    #Verify dependency from v_3_13_2 to sr_3_13_2;
    #Verify dependency from v_3_13_3 to sr_3_13_3;
    #Verify dependency from v_3_13_4 to sr_3_13_4;
    #Verify dependency from v_3_13_5 to sr_3_13_5;
    #Verify dependency from v_3_13_6 to sr_3_13_6;
    #Verify dependency from v_3_13_8 to sr_3_13_8;
    #Verify dependency from v_3_13_9 to sr_3_13_9;
    #Verify dependency from v_3_13_10 to sr_3_13_10;
    #Verify dependency from v_3_13_13 to sr_3_13_13;
    #Verify dependency from v_3_13_15 to sr_3_13_15;
    #Verify dependency from v_3_14_1 to sr_3_14_1;
    #Verify dependency from v_3_14_2 to sr_3_14_2;
    #Verify dependency from v_3_14_3 to sr_3_14_3;
    #Verify dependency from v_3_14_6 to sr_3_14_6;
    #Verify dependency from v_3_14_7 to sr_3_14_7;
}

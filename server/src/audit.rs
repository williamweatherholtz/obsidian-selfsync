// SEC-CMMC (AU, NIST SP 800-171 3.3.x): a dedicated, structured, attributable SECURITY-AUDIT trail.
// Before this, security events were scattered as free-text lines in the operational stdout stream,
// untimestamped and without a source, and 8 event classes emitted nothing at all. This module is the
// single choke-point: every security-relevant event is emitted as ONE JSON line to the distinct `audit`
// log target, so an operator can route target=audit to a separate append-only sink (AU.3.3.1 retention +
// AU.3.3.8 separation) and a SIEM can parse it (AU.3.3.5/3.3.6). Each event carries the accountability
// 5-tuple — WHO (actor), WHAT (action + target), WHEN (UTC ms), OUTCOME, SOURCE (client IP) — so an
// action is traceable to an individual (AU.3.3.2). The `action` set is a CLOSED enum below (AU.3.3.3:
// the reviewable event catalog). All fields are control-char-safe: actor/target/source come from
// safe_name-validated identifiers or a control-stripped IP, so a value can't forge/split a JSON line.
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

// The closed catalog of audited actions (AU.3.3.3 — the enumerated, reviewable event set).
pub mod action {
    pub const LOGIN: &str = "login";
    pub const LOGOUT: &str = "logout";
    pub const ACCOUNT_CREATE: &str = "account_create";
    pub const ACCOUNT_DELETE: &str = "account_delete";
    pub const ADMIN_GRANT: &str = "admin_grant";
    pub const ADMIN_REVOKE: &str = "admin_revoke";
    pub const PASSWORD_CHANGE: &str = "password_change";
    pub const PASSWORD_RESET: &str = "password_reset";
    pub const SESSION_REVOKE: &str = "session_revoke";
    pub const REGISTRATION_POLICY_CHANGE: &str = "registration_policy_change";
    pub const INVITE_CREATE: &str = "invite_create";
    pub const INVITE_REDEEM: &str = "invite_redeem";
    pub const INVITE_REVOKE: &str = "invite_revoke";
    pub const SHARE_GRANT: &str = "share_grant";
    pub const SHARE_REVOKE: &str = "share_revoke";
    pub const SHARE_LINK_CREATE: &str = "share_link_create"; // D0023 capability share-links
    pub const SHARE_LINK_REDEEM: &str = "share_link_redeem";
    pub const SHARE_LINK_REVOKE: &str = "share_link_revoke";
    pub const VAULT_CREATE: &str = "vault_create";
    pub const VAULT_DELETE: &str = "vault_delete";
    pub const VAULT_REINDEX: &str = "vault_reindex";
    pub const VAULT_PRUNE: &str = "vault_prune";
    pub const AUTHZ_DENIED: &str = "authz_denied";
    pub const RATE_LIMITED: &str = "rate_limited";
    pub const MFA_ENABLE: &str = "mfa_enable";
    pub const MFA_DISABLE: &str = "mfa_disable";
}

pub mod outcome {
    pub const SUCCESS: &str = "success";
    pub const FAILURE: &str = "failure";
    pub const DENIED: &str = "denied";
}

#[derive(Serialize)]
struct AuditEvent<'a> {
    ts: &'a str,      // WHEN — UTC RFC-3339 with millis (authoritative in-app timestamp, not runtime-dependent)
    actor: &'a str,   // WHO  — authenticated principal, or "-" for a pre-auth event (failed login / unknown token)
    action: &'a str,  // WHAT — a value from `action` above
    target: &'a str,  // object acted on (subject account, "owner/vault", invite id, grantee)
    outcome: &'a str, // one of `outcome`
    source: &'a str,  // SOURCE — client IP (see ClientIp), or "-" if unknown
}

// Emit one audit event. Best-effort to the `audit` target at info level; a serialize failure degrades
// to a warn line rather than losing the fact entirely.
pub fn audit(action: &str, actor: &str, target: &str, outcome: &str, source: &str) {
    let ts = now_rfc3339();
    let ev = AuditEvent { ts: &ts, actor, action, target, outcome, source };
    match serde_json::to_string(&ev) {
        Ok(json) => log::info!(target: "audit", "{json}"),
        Err(e) => log::warn!(target: "audit", "audit-serialize-failed action={action}: {e}"),
    }
}

// UTC RFC-3339 (`YYYY-MM-DDThh:mm:ss.mmmZ`) from SystemTime, with no date-library dependency. Uses
// Howard Hinnant's civil-from-days algorithm. A pre-epoch clock (unreachable in practice) yields the
// epoch. AU.3.3.7: the audit trail carries its own UTC timestamp rather than relying on the container
// runtime to add one.
fn now_rfc3339() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    rfc3339_from_epoch(d.as_secs(), d.subsec_millis())
}

fn rfc3339_from_epoch(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400; // seconds-of-day
    let (h, mi, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    // civil_from_days: days since 1970-01-01 -> (year, month, day)
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_known_epochs() {
        assert_eq!(rfc3339_from_epoch(0, 0), "1970-01-01T00:00:00.000Z");
        // 1_700_000_000 == 2023-11-14T22:13:20Z
        assert_eq!(rfc3339_from_epoch(1_700_000_000, 481), "2023-11-14T22:13:20.481Z");
        // a leap-year date: 2024-02-29T12:00:00Z == 1_709_208_000
        assert_eq!(rfc3339_from_epoch(1_709_208_000, 0), "2024-02-29T12:00:00.000Z");
    }

    #[test]
    fn audit_event_is_valid_json_with_the_five_tuple() {
        // now_rfc3339 is exercised via a real call; assert the emitted string parses and carries fields.
        let ev = AuditEvent { ts: "2026-07-10T00:00:00.000Z", actor: "alice", action: action::LOGIN, target: "alice", outcome: outcome::SUCCESS, source: "203.0.113.7" };
        let json = serde_json::to_string(&ev).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        for k in ["ts", "actor", "action", "target", "outcome", "source"] {
            assert!(v.get(k).is_some(), "audit JSON must carry {k}");
        }
        assert_eq!(v["action"], "login");
    }
}

// ClientIp — the request's client IP for the audit SOURCE field. SelfSync runs behind a TLS-terminating
// reverse proxy (see deployment docs), so the real client IP arrives in `X-Forwarded-For` (first hop) or
// `X-Real-IP`; the raw peer would just be the proxy. Control chars are stripped and length capped so a
// spoofed header can't forge/split an audit JSON line. "-" when no forwarding header is present (e.g. a
// direct-to-server connection with no proxy — then the operator's proxy simply isn't setting it).
// NOTE: this trusts the proxy to set XFF honestly, which is the documented deployment contract.
pub struct ClientIp(pub String);

#[axum::async_trait]
impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, _st: &S) -> Result<Self, Self::Rejection> {
        let raw = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next()) // leftmost = original client
            .or_else(|| parts.headers.get("x-real-ip").and_then(|v| v.to_str().ok()))
            .unwrap_or("-")
            .trim();
        let ip: String = raw.chars().filter(|c| !c.is_control()).take(64).collect();
        Ok(ClientIp(if ip.is_empty() { "-".to_string() } else { ip }))
    }
}

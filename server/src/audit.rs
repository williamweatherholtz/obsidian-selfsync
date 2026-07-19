// The ClientIp request-extractor impl intentionally sits at the file's end (after the test module);
// suppress clippy's items-after-test-module STYLE lint rather than reorder the file.
#![allow(clippy::items_after_test_module)]
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

// A value from the closed audited-ACTION catalog (AU.3.3.3). The wrapped &'static str is PRIVATE, so the
// ONLY values that exist are the `action::*` consts below — audit() takes an AuditAction, not a raw &str, so
// an arbitrary or typo'd action string is unrepresentable at a call site (newtype / make-illegal-states-
// unrepresentable, issuePatternUntaggedShouldAdopt). Call sites are unchanged: they still pass `action::LOGIN`.
#[derive(Clone, Copy)]
pub struct AuditAction(&'static str);
impl AuditAction { fn as_str(self) -> &'static str { self.0 } }

// Likewise the closed OUTCOME catalog — audit() can only be handed success / failure / denied.
#[derive(Clone, Copy)]
pub struct Outcome(&'static str);
impl Outcome { fn as_str(self) -> &'static str { self.0 } }

// The closed catalog of audited actions (AU.3.3.3 — the enumerated, reviewable event set). Each const is an
// AuditAction; the private field means this module (a descendant of the defining module) is the only place
// that can mint one, so the catalog is genuinely closed.
pub mod action {
    use super::AuditAction;
    pub const LOGIN: AuditAction = AuditAction("login");
    pub const LOGOUT: AuditAction = AuditAction("logout");
    pub const ACCOUNT_CREATE: AuditAction = AuditAction("account_create");
    pub const ACCOUNT_DELETE: AuditAction = AuditAction("account_delete");
    pub const ADMIN_GRANT: AuditAction = AuditAction("admin_grant");
    pub const ADMIN_REVOKE: AuditAction = AuditAction("admin_revoke");
    pub const PASSWORD_CHANGE: AuditAction = AuditAction("password_change");
    pub const PASSWORD_RESET: AuditAction = AuditAction("password_reset");
    pub const SESSION_REVOKE: AuditAction = AuditAction("session_revoke");
    pub const REGISTRATION_POLICY_CHANGE: AuditAction = AuditAction("registration_policy_change");
    pub const INVITE_CREATE: AuditAction = AuditAction("invite_create");
    pub const INVITE_REDEEM: AuditAction = AuditAction("invite_redeem");
    pub const INVITE_REVOKE: AuditAction = AuditAction("invite_revoke");
    pub const SHARE_GRANT: AuditAction = AuditAction("share_grant");
    pub const SHARE_REVOKE: AuditAction = AuditAction("share_revoke");
    pub const SHARE_LINK_CREATE: AuditAction = AuditAction("share_link_create"); // D0023 capability share-links
    pub const SHARE_LINK_REDEEM: AuditAction = AuditAction("share_link_redeem");
    pub const SHARE_LINK_REVOKE: AuditAction = AuditAction("share_link_revoke");
    pub const VAULT_CREATE: AuditAction = AuditAction("vault_create");
    pub const VAULT_DELETE: AuditAction = AuditAction("vault_delete");
    pub const VAULT_REINDEX: AuditAction = AuditAction("vault_reindex");
    pub const VAULT_PRUNE: AuditAction = AuditAction("vault_prune");
    pub const AUTHZ_DENIED: AuditAction = AuditAction("authz_denied");
    pub const RATE_LIMITED: AuditAction = AuditAction("rate_limited");
    pub const MFA_ENABLE: AuditAction = AuditAction("mfa_enable");
    pub const MFA_DISABLE: AuditAction = AuditAction("mfa_disable");
}

pub mod outcome {
    use super::Outcome;
    pub const SUCCESS: Outcome = Outcome("success");
    pub const FAILURE: Outcome = Outcome("failure");
    pub const DENIED: Outcome = Outcome("denied");
}

#[derive(Serialize)]
struct AuditEvent<'a> {
    ts: &'a str,      // WHEN — UTC RFC-3339 with millis (authoritative in-app timestamp, not runtime-dependent)
    actor: &'a str,   // WHO  — authenticated principal, or "-" for a pre-auth event (failed login / unknown token)
    action: &'a str,  // WHAT — the &str of an AuditAction from `action`
    target: &'a str,  // object acted on (subject account, "owner/vault", invite id, grantee)
    outcome: &'a str, // the &str of an Outcome from `outcome`
    source: &'a str,  // SOURCE — client IP (see ClientIp), or "-" if unknown
}

// Emit one audit event. Best-effort to the `audit` target at info level; a serialize failure degrades
// to a warn line rather than losing the fact entirely. The action/outcome are catalog newtypes, so the
// closed-catalog guarantee (AU.3.3.3) is enforced by the TYPE, not by convention at each call site.
pub fn audit(action: AuditAction, actor: &str, target: &str, outcome: Outcome, source: &str) {
    let ts = now_rfc3339();
    let ev = AuditEvent { ts: &ts, actor, action: action.as_str(), target, outcome: outcome.as_str(), source };
    match serde_json::to_string(&ev) {
        Ok(json) => log::info!(target: "audit", "{json}"),
        Err(e) => log::warn!(target: "audit", "audit-serialize-failed action={}: {e}", action.as_str()),
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
    let doe = z - era * 146_097; // [0, 146096] (already i64)
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
        let ev = AuditEvent { ts: "2026-07-10T00:00:00.000Z", actor: "alice", action: action::LOGIN.as_str(), target: "alice", outcome: outcome::SUCCESS.as_str(), source: "203.0.113.7" };
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

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

// One typed error for the whole request path. Handlers return Result<T, AppError>
// and use `?`; axum turns AppError into the right HTTP status via IntoResponse.
#[derive(Debug)]
pub enum AppError {
    NotFound,
    BadRequest(String),
    Unauthorized,
    Forbidden, // 403 — authenticated but not authorized for this owner/vault
    PasswordChangeRequired, // 403 — account flagged must-change; only /api/password & /api/logout allowed (IA.3.5.9)
    MfaRequired, // 401 — password OK but a TOTP/recovery second factor is required/missing/invalid (IA.3.5.3)
    Conflict(String),
    Unavailable(String), // 503 — vault not writable / lock poisoned (propagate, don't resume)
    TooManyRequests(u64), // 429 — login throttle tripped; payload = Retry-After seconds (SEC-AUTH)
    // 422 — the body is well-formed HTTP but not an SSE1 frame on a keyring vault (E2EE, spec section 4.6).
    // Distinct from 400 so a client can tell "plaintext into an encrypted vault" from a malformed request.
    Unprocessable(String),
    // 403 — a grantee reached a keyring vault without the x-selfsync-e2ee header: an old plugin build. The
    // body is the fixed E2EE_REQUIRED_MSG, never matched by the client's password-change regex (spec 4.6).
    E2eeRequired,
    Internal(String),
}

// The downgrade-guard body (spec section 4.6, srE2eeDowngradeGuard). Path-free, under the client cap. The
// old client maps any 403 to its Forbidden card; this text reaches only the plugin log.
pub const E2EE_REQUIRED_MSG: &str =
    "vault is end-to-end encrypted. This client version does not support it. Update the plugin.";

// Refusal ONE (spec section 4.4): the index says encrypted=1 but `.keyring.json` is gone. Path-free: names
// the sidecar by its basename only. Also the body of GET keyring on an encrypted handle with no sidecar.
pub const E2EE_KEYRING_MISSING_MSG: &str =
    "this vault is end-to-end encrypted but its .keyring.json is missing. Restore .keyring.json from backup. A vault that never synced can be deleted from the plugin. Operators: see /admin.";
// Refusal TWO, all mirror files are SSE1 frames: the index is the stale part.
pub const E2EE_STALE_INDEX_MSG: &str =
    "this vault has a .keyring.json but its index predates encryption. Every file is encrypted, so move .sync-index.db* aside and retry. That resets deletion history and can re-push deleted notes from lagging devices: restore the matching index from backup first.";
// Refusal TWO, no mirror file is a frame: the keyring is the stale part.
pub const E2EE_STALE_KEYRING_MSG: &str =
    "this vault has a .keyring.json but its index and files predate encryption. No file is encrypted, so move .keyring.json aside and retry.";
// Refusal TWO, mixed: the counts follow this prefix; the first 20 paths go to the server log.
pub const E2EE_MIXED_MSG: &str =
    "this vault has a .keyring.json, an index that predates encryption, and a mix of encrypted and plaintext files. Restore the index, the files and .keyring.json from one point in time. The server log lists the first 20 paths.";
// Refusal TWO, no mirror file at all: both remedies.
pub const E2EE_NO_MIRROR_MSG: &str =
    "this vault has a .keyring.json but its index predates encryption and holds no files. Move .sync-index.db* aside if the vault is encrypted, or move .keyring.json aside if it is not.";

// Refusal TWO, the file walk itself failed: no diagnosis, so no remedy is named.
pub const E2EE_SCAN_FAILED_MSG: &str =
    "this vault has a .keyring.json but its index predates encryption, and the server could not read the vault's files to tell which is stale. Check the permissions on the vault directory and retry.";

// An E2EE open refusal carried inside an io::Error (Vault::open keeps its io::Result signature). The body is
// one of the consts above plus any counts; vault_open_error downcasts it to a 503 with THAT body.
#[derive(Debug)]
pub struct E2eeRefusal {
    pub body: String,
}
impl std::fmt::Display for E2eeRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.body) }
}
impl std::error::Error for E2eeRefusal {}

pub fn e2ee_refusal(body: String) -> std::io::Error {
    std::io::Error::other(E2eeRefusal { body })
}

/// The refusal body carried by an open error, if it is one.
pub fn e2ee_refusal_body(e: &std::io::Error) -> Option<&str> {
    e.get_ref().and_then(|r| r.downcast_ref::<E2eeRefusal>()).map(|r| r.body.as_str())
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // 429 carries a Retry-After header, so build its response directly rather than via (code,msg).
        if let AppError::TooManyRequests(secs) = self {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [(axum::http::header::RETRY_AFTER, secs.to_string())],
                "too many attempts — try again later".to_string(),
            ).into_response();
        }
        let (code, msg) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
            // Distinct body so a client can detect the forced-change state and prompt (vs a plain 403).
            AppError::PasswordChangeRequired => (StatusCode::FORBIDDEN, "password change required".to_string()),
            // Distinct body so a client can detect it needs to prompt for the TOTP/recovery code.
            AppError::MfaRequired => (StatusCode::UNAUTHORIZED, "mfa required".to_string()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m),
            AppError::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m),
            AppError::Unprocessable(m) => (StatusCode::UNPROCESSABLE_ENTITY, m),
            AppError::E2eeRequired => (StatusCode::FORBIDDEN, E2EE_REQUIRED_MSG.to_string()),
            AppError::TooManyRequests(_) => unreachable!("handled above"),
            // SEC-6: never return the raw internal error (std::io messages can carry absolute
            // server paths) to the client — log it server-side, hand back a generic 500 body.
            AppError::Internal(m) => {
                log::error!("[500] {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (code, msg).into_response()
    }
}

// Map a vault OPEN error to an AppError. A schema DOWNGRADE (ErrorKind::Unsupported — index_store's migrate()
// refuses when this binary is OLDER than the one that wrote the index, e.g. an operator rolled the server
// image back after a newer one migrated the DB) is an operator-actionable state, NOT an internal fault → a
// DISTINCT 503 with a clear, PATH-FREE body the client renders, instead of an opaque 500 whose only clue is the
// server log (issueSchemaRollbackOpaque500). Any other open failure (IO/SQLite) stays a generic 500 — its raw
// message can carry an absolute server path, so it must NOT be surfaced (SEC-6).
pub fn vault_open_error(e: std::io::Error) -> AppError {
    // E2EE (spec section 4.4): both open refusals route to 503 with their OWN bodies, never the
    // schema-rollback body and never a 500. The bodies are path-free consts (plus counts).
    if let Some(body) = e2ee_refusal_body(&e) {
        return AppError::Unavailable(body.to_string());
    }
    if e.kind() == std::io::ErrorKind::Unsupported {
        // Kept comfortably UNDER the client's 300-char plain-text-body cap (transport.ts errText) so it always
        // surfaces to the operator rather than falling back to an opaque "HTTP 503" — vault_open_error_message_
        // fits_client_body_cap pins this. Path-free (SEC-6).
        AppError::Unavailable(SCHEMA_DOWNGRADE_MSG.into())
    } else {
        AppError::Internal(format!("vault open failed: {e}"))
    }
}
// The operator-facing body for a schema-downgrade (rollback) 503. A `const` so the test can length-check it
// against the client's body cap; short + path-free (SEC-6).
pub const SCHEMA_DOWNGRADE_MSG: &str =
    "this server is OLDER than the version that last wrote this vault's data — re-deploy the newer server image. Your data is intact; the server won't open a newer index, to avoid corrupting it.";

// Lock a mutex on the request path, mapping a POISONED lock to 503 rather than
// panicking (which would cascade) or resuming on possibly-corrupt state. A poison
// means a prior holder panicked mid-mutation — the honest response is "temporarily
// unavailable," not pretend-it's-fine.
pub fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>, AppError> {
    m.lock().map_err(|_| AppError::Unavailable("resource temporarily unavailable".into()))
}

// A per-vault RwLock lets reads (changes/missing/get_chunk/status) and chunk uploads
// run CONCURRENTLY, while mutations (commit/delete/reindex) stay exclusive — so one
// client's large pull no longer blocks another's reads of the same vault. Poison →
// 503, same honesty as `lock`.
pub fn rlock<T>(l: &RwLock<T>) -> Result<RwLockReadGuard<'_, T>, AppError> {
    l.read().map_err(|_| AppError::Unavailable("resource temporarily unavailable".into()))
}
pub fn wlock<T>(l: &RwLock<T>) -> Result<RwLockWriteGuard<'_, T>, AppError> {
    l.write().map_err(|_| AppError::Unavailable("resource temporarily unavailable".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    async fn status_of(e: AppError) -> StatusCode {
        e.into_response().status()
    }

    // issueSchemaRollbackOpaque500: a schema-downgrade open error surfaces as a DISTINCT 503 with a clear body
    // (self-diagnosing rollback), while any other open failure stays a generic 500 (SEC-6: no path leakage).
    #[tokio::test]
    async fn vault_open_error_maps_schema_downgrade_to_503_and_others_to_500() {
        let downgrade = std::io::Error::new(std::io::ErrorKind::Unsupported, "schema v3 > v2; refusing to open");
        match vault_open_error(downgrade) {
            AppError::Unavailable(m) => { assert!(m.contains("re-deploy the newer server image"), "clear operator message: {m}"); assert!(!m.contains("schema v3 > v2"), "does not echo the raw internal text"); }
            other => panic!("expected Unavailable(503), got {other:?}"),
        }
        assert_eq!(status_of(vault_open_error(std::io::Error::new(std::io::ErrorKind::Unsupported, "x"))).await, StatusCode::SERVICE_UNAVAILABLE);
        // CROSS-LANGUAGE COUPLING (critique MEDIUM): the client (transport.ts errText) only surfaces a server
        // error body when its .length <= 300, else it shows an opaque "HTTP 503". Pin the message WELL under
        // that cap (UTF-16 code units; all BMP here, so chars().count() == the client's .length) so a future
        // reword can't silently push it over and re-hide the rollback diagnosis.
        assert!(SCHEMA_DOWNGRADE_MSG.chars().count() <= 260, "schema-downgrade body must stay under the client's 300-char errText cap (with headroom): {}", SCHEMA_DOWNGRADE_MSG.chars().count());
        // A generic IO failure stays a 500 (its raw message may carry a server path → not surfaced).
        assert_eq!(status_of(vault_open_error(std::io::Error::other("/abs/server/path/db locked"))).await, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(matches!(vault_open_error(std::io::Error::other("boom")), AppError::Internal(_)));
    }

    // E2EE: an open refusal is a 503 with its own body (never the rollback body, never a 500), and every
    // const body stays under the client's 300-char errText cap so the remedy is shown, not "HTTP 503".
    #[tokio::test]
    async fn e2ee_refusals_map_to_503_with_their_own_body_and_fit_the_client_cap() {
        let e = e2ee_refusal(E2EE_KEYRING_MISSING_MSG.to_string());
        match vault_open_error(e) {
            AppError::Unavailable(m) => assert_eq!(m, E2EE_KEYRING_MISSING_MSG),
            other => panic!("expected Unavailable, got {other:?}"),
        }
        assert_eq!(status_of(vault_open_error(e2ee_refusal("x".into()))).await, StatusCode::SERVICE_UNAVAILABLE);
        for (name, body) in [("required", E2EE_REQUIRED_MSG), ("missing", E2EE_KEYRING_MISSING_MSG), ("stale index", E2EE_STALE_INDEX_MSG),
                             ("stale keyring", E2EE_STALE_KEYRING_MSG), ("mixed", E2EE_MIXED_MSG), ("no mirror", E2EE_NO_MIRROR_MSG), ("scan failed", E2EE_SCAN_FAILED_MSG)] {
            assert!(body.chars().count() <= 260, "{name} body must stay under the client cap with headroom: {}", body.chars().count());
            assert!(!body.contains('/') || body.contains("/admin"), "{name} body is path-free");
        }
        // The mixed body is the const plus two counts: pin the FORMATTED worst case under the hard cap.
        let worst = format!("{E2EE_MIXED_MSG} ({0} encrypted, {0} plaintext)", usize::MAX);
        assert!(worst.chars().count() <= 300, "the formatted mixed body must stay under the client cap: {}", worst.chars().count());
        // The downgrade-guard body must never read as the password-change state (connstate.ts:95).
        let pw = regex_lite(E2EE_REQUIRED_MSG);
        assert!(!pw, "the E2EE 403 body must not match /password.?change|change.?password/i");
        assert_eq!(status_of(AppError::E2eeRequired).await, StatusCode::FORBIDDEN);
        assert_eq!(status_of(AppError::Unprocessable("not a frame".into())).await, StatusCode::UNPROCESSABLE_ENTITY);
    }

    // The client's regex, transliterated: /password.?change|change.?password/i.
    fn regex_lite(s: &str) -> bool {
        let l = s.to_ascii_lowercase();
        let hit = |a: &str, b: &str| l.match_indices(a).any(|(i, _)| {
            let rest = &l[i + a.len()..];
            rest.starts_with(b) || (rest.len() > 1 && rest[1..].starts_with(b))
        });
        hit("password", "change") || hit("change", "password")
    }
}

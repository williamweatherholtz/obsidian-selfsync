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
    Internal(String),
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
    if e.kind() == std::io::ErrorKind::Unsupported {
        AppError::Unavailable("this server is OLDER than the version that last wrote this vault's data — its storage/protocol format is newer than this server understands. Update (re-deploy) the server to the newer image. Your data is intact; the server refuses to open a newer index to avoid corrupting it.".into())
    } else {
        AppError::Internal(format!("vault open failed: {e}"))
    }
}

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
            AppError::Unavailable(m) => { assert!(m.contains("Update (re-deploy) the server"), "clear operator message: {m}"); assert!(!m.contains("schema v3 > v2"), "does not echo the raw internal text"); }
            other => panic!("expected Unavailable(503), got {other:?}"),
        }
        assert_eq!(status_of(vault_open_error(std::io::Error::new(std::io::ErrorKind::Unsupported, "x"))).await, StatusCode::SERVICE_UNAVAILABLE);
        // A generic IO failure stays a 500 (its raw message may carry a server path → not surfaced).
        assert_eq!(status_of(vault_open_error(std::io::Error::other("/abs/server/path/db locked"))).await, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(matches!(vault_open_error(std::io::Error::other("boom")), AppError::Internal(_)));
    }
}

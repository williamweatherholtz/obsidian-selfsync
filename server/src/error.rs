use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use std::sync::{Mutex, MutexGuard};

// One typed error for the whole request path. Handlers return Result<T, AppError>
// and use `?`; axum turns AppError into the right HTTP status via IntoResponse.
#[derive(Debug)]
pub enum AppError {
    NotFound,
    BadRequest(String),
    Unauthorized,
    Conflict(String),
    Unavailable(String), // 503 — vault not writable / lock poisoned (propagate, don't resume)
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (code, msg) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m),
            AppError::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m),
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (code, msg).into_response()
    }
}

// Lock a mutex on the request path, mapping a POISONED lock to 503 rather than
// panicking (which would cascade) or resuming on possibly-corrupt state. A poison
// means a prior holder panicked mid-mutation — the honest response is "temporarily
// unavailable," not pretend-it's-fine.
pub fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>, AppError> {
    m.lock().map_err(|_| AppError::Unavailable("resource temporarily unavailable".into()))
}

use crate::error::{lock, AppError};
use crate::protocol::{LoginRequest, LoginResponse, RegisterRequest};
use crate::state::AppState;
use crate::users::safe_name;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::Json;

pub async fn login(
    State(st): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    let ok = lock(&st.users)?.verify(&req.username, &req.password);
    if ok {
        let token = lock(&st.tokens)?.issue(&req.username).map_err(|e| AppError::Internal(e.to_string()))?;
        eprintln!("[login] user='{}' -> OK", req.username);
        Ok(Json(LoginResponse { token }))
    } else {
        eprintln!("[login] user='{}' -> 401", req.username);
        Err(AppError::Unauthorized)
    }
}

pub async fn register(
    State(st): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<StatusCode, AppError> {
    if !safe_name(&req.username) {
        return Err(AppError::BadRequest("invalid username".into()));
    }
    // Avoid consuming an invite token on an obvious duplicate.
    if lock(&st.users)?.exists(&req.username) {
        return Err(AppError::Conflict("user exists".into()));
    }
    // Open: anyone may register. Closed: a valid single-use invite token is required
    // (carried in the `invite` field) and is consumed here.
    // `&&` short-circuits: redeem (which consumes the token) only runs in Closed mode.
    if lock(&st.registration)?.mode() == crate::registration::Mode::Closed
        && (req.invite.is_empty() || !lock(&st.registration)?.redeem(&req.invite))
    {
        eprintln!("[register] user='{}' -> 403 (registration closed; missing/invalid invite)", req.username);
        return Err(AppError::Forbidden);
    }
    match lock(&st.users)?.register(&req.username, &req.password) {
        Ok(()) => { eprintln!("[register] user='{}' -> OK", req.username); Ok(StatusCode::OK) }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(AppError::Conflict("user exists".into())),
        Err(_) => Err(AppError::BadRequest("could not register".into())),
    }
}

// Resolves a bearer token to the authenticated username.
pub struct AuthToken(pub String);

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthToken {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .map(|s| s.to_string())
            .ok_or(AppError::Unauthorized)?;
        let user = lock(&st.tokens)?.resolve(&token);
        user.map(AuthToken).ok_or(AppError::Unauthorized)
    }
}

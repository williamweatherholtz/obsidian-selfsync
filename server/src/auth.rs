use crate::protocol::{LoginRequest, LoginResponse};
use crate::state::AppState;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::Json;

pub async fn login(
    State(st): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    if req.username == st.cfg.user && req.password == st.cfg.password {
        let token = uuid::Uuid::new_v4().to_string();
        st.tokens.lock().unwrap().insert(token.clone());
        Ok(Json(LoginResponse { token }))
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

pub struct AuthToken(pub String);

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthToken {
    type Rejection = StatusCode;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .map(|s| s.to_string())
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if st.tokens.lock().unwrap().contains(&token) {
            Ok(AuthToken(token))
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

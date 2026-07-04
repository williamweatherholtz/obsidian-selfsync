use crate::auth::AuthToken;
use crate::error::AppError;
use crate::protocol::{CreateVaultRequest, VaultListResponse};
use crate::state::AppState;
use crate::users::safe_name;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;

pub async fn list_vaults(AuthToken(user): AuthToken, State(st): State<AppState>) -> Json<VaultListResponse> {
    Json(VaultListResponse { vaults: st.list_vaults(&user) })
}

pub async fn create_vault(
    AuthToken(user): AuthToken,
    State(st): State<AppState>,
    Json(req): Json<CreateVaultRequest>,
) -> Result<StatusCode, AppError> {
    if !safe_name(&req.name) {
        return Err(AppError::BadRequest("invalid vault name".into()));
    }
    if st.list_vaults(&user).contains(&req.name) {
        return Err(AppError::Conflict("vault exists".into()));
    }
    st.vault(&user, &req.name).map_err(|e| AppError::BadRequest(e.to_string()))?;
    eprintln!("[vault create] user='{}' vault='{}'", user, req.name);
    Ok(StatusCode::OK)
}

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
    // SEC-3: cap vaults per account. Each opened vault is a cached, never-evicted handle + a
    // directory tree; without a limit an authenticated user could loop create → unbounded RAM +
    // inode growth that degrades every tenant.
    const MAX_VAULTS_PER_USER: usize = 100;
    let existing = st.list_vaults(&user);
    if existing.len() >= MAX_VAULTS_PER_USER {
        return Err(AppError::BadRequest("vault limit reached for this account".into()));
    }
    if existing.contains(&req.name) {
        return Err(AppError::Conflict("vault exists".into()));
    }
    st.vault(&user, &req.name).map_err(|e| AppError::BadRequest(e.to_string()))?;
    log::info!("[vault create] user='{}' vault='{}'", user, req.name);
    Ok(StatusCode::OK)
}

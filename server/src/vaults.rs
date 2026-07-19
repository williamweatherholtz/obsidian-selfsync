use crate::audit::{action, audit, outcome, ClientIp};
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
    ClientIp(ip): ClientIp,
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
    // A deliberate (re)create clears any delete-tombstone for this key, so vault() will materialize it
    // (crit R+1, issueVaultDeleteOpenRace: the tombstone refuses only AUTO recreation via a raced open).
    st.allow_vault_recreate(&user, &req.name);
    st.vault(&user, &req.name).map_err(|e| AppError::BadRequest(e.to_string()))?;
    log::info!("[vault create] user='{}' vault='{}'", user, req.name);
    audit(action::VAULT_CREATE, &user, &format!("{user}/{}", req.name), outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

use crate::auth::AuthToken;
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
) -> Result<StatusCode, StatusCode> {
    if !safe_name(&req.name) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if st.list_vaults(&user).contains(&req.name) {
        return Err(StatusCode::CONFLICT);
    }
    // Opening the namespace materializes it on disk.
    st.vault(&user, &req.name).map_err(|_| StatusCode::BAD_REQUEST)?;
    eprintln!("[vault create] user='{}' vault='{}'", user, req.name);
    Ok(StatusCode::OK)
}

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
    // E2EE (D0102): the keyring is stored VERBATIM, so the only checks are a size cap and that it is one
    // JSON object. The server never parses the fields and cannot open it.
    const MAX_KEYRING_BYTES: usize = 8 * 1024;
    let keyring = match req.keyring.as_deref() {
        None => None,
        Some(k) if k.len() > MAX_KEYRING_BYTES => return Err(AppError::BadRequest("keyring exceeds 8 KiB".into())),
        Some(k) => match serde_json::from_str::<serde_json::Value>(k) {
            Ok(serde_json::Value::Object(_)) => Some(k.as_bytes().to_vec()),
            _ => return Err(AppError::BadRequest("keyring is not a JSON object".into())),
        },
    };
    let encrypted = keyring.is_some();
    // One atomic sequence under the per-key open lock: tombstone, directories (AlreadyExists is the 409),
    // sidecar with create_new and fsync, clear the tombstone, open, publish (state.rs create_vault).
    let (st2, user2, name2) = (st.clone(), user.clone(), req.name.clone());
    tokio::task::spawn_blocking(move || st2.create_vault(&user2, &name2, keyring.as_deref()))
        .await.map_err(|e| AppError::Internal(format!("vault create join failed: {e}")))?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => AppError::Conflict("vault exists".into()),
            std::io::ErrorKind::InvalidInput => AppError::BadRequest(e.to_string()),
            _ => AppError::Internal(format!("vault create failed: {e}")),
        })?;
    log::info!("[vault create] user='{}' vault='{}' encrypted={encrypted}", user, req.name);
    audit(action::VAULT_CREATE, &user, &format!("{user}/{} encrypted={encrypted}", req.name), outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

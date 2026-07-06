// The /api/admin/* JSON API — the AUTHORITY the web admin UI wraps (dual surface). Any
// owner manages their own vaults' shares; the server-admin (the bootstrap SYNC_USER
// account) manages accounts, the registration policy, and invite tokens. Password hashes
// and token plaintext are never returned.
use crate::auth::AuthToken;
use crate::error::{lock, AppError};
use crate::registration::{Mode, TokenInfo};
use crate::shares::Perm;
use crate::state::AppState;
use crate::users::safe_name;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

fn is_server_admin(st: &AppState, user: &str) -> bool {
    user == st.cfg.user
}
fn require_admin(st: &AppState, user: &str) -> Result<(), AppError> {
    if is_server_admin(st, user) { Ok(()) } else { Err(AppError::Forbidden) }
}

#[derive(Serialize)]
pub struct MeResp {
    username: String,
    is_server_admin: bool,
}
pub async fn me(AuthToken(user): AuthToken, State(st): State<AppState>) -> Json<MeResp> {
    let is_server_admin = is_server_admin(&st, &user);
    Json(MeResp { username: user, is_server_admin })
}

#[derive(Serialize)]
struct GrantView {
    grantee: String,
    perm: Perm,
}
#[derive(Serialize)]
pub struct VaultShares {
    vault: String,
    grants: Vec<GrantView>,
}
// The caller's OWN vaults + who each is shared with (owner-scoped share management).
pub async fn my_vaults(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<VaultShares>>, AppError> {
    let vaults = st.list_vaults(&user);
    let shares = lock(&st.shares)?;
    let out = vaults
        .into_iter()
        .map(|vault| {
            let grants = shares
                .grants_for(&user, &vault)
                .into_iter()
                .map(|g| GrantView { grantee: g.grantee, perm: g.perm })
                .collect();
            VaultShares { vault, grants }
        })
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct ShareReq {
    vault: String,
    grantee: String,
    perm: Perm,
}
// Grant a share on one of the caller's OWN vaults to an existing account.
pub async fn share_create(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<ShareReq>,
) -> Result<StatusCode, AppError> {
    if !safe_name(&req.vault) || !safe_name(&req.grantee) {
        return Err(AppError::BadRequest("invalid vault or grantee".into()));
    }
    // The caller can only share a vault they actually own.
    if !st.list_vaults(&user).iter().any(|v| v == &req.vault) {
        return Err(AppError::NotFound);
    }
    if req.grantee == user {
        return Err(AppError::BadRequest("cannot share a vault with its owner".into()));
    }
    if !lock(&st.users)?.exists(&req.grantee) {
        return Err(AppError::BadRequest("no such account".into()));
    }
    lock(&st.shares)?
        .grant(&user, &req.vault, &req.grantee, req.perm)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
pub struct ShareDelReq {
    vault: String,
    grantee: String,
}
pub async fn share_delete(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<ShareDelReq>,
) -> Result<StatusCode, AppError> {
    lock(&st.shares)?
        .revoke(&user, &req.vault, &req.grantee)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::OK)
}

// ---- server-admin only: accounts, registration policy, invite tokens ----

pub async fn users_list(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<String>>, AppError> {
    require_admin(&st, &user)?;
    Ok(Json(lock(&st.users)?.usernames()))
}

#[derive(Deserialize)]
pub struct NewUserReq {
    username: String,
    password: String,
}
pub async fn users_create(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<NewUserReq>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user)?;
    if !safe_name(&req.username) {
        return Err(AppError::BadRequest("invalid username".into()));
    }
    // SEC-R2#4: same argon2 DoS protection as the public register path — cap the password length
    // and run the memory-hard hash on a blocking thread bounded by the auth permit pool, instead
    // of hashing an uncapped password synchronously on an async worker.
    if req.password.len() > crate::auth::MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest("password too long".into()));
    }
    let permit = st.auth_slots.clone().acquire_owned().await.map_err(|_| AppError::Unavailable("auth busy".into()))?;
    let users = st.users.clone();
    let (u, p) = (req.username.clone(), req.password.clone());
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut g = users.lock().map_err(|_| std::io::Error::other("users lock poisoned"))?;
        g.register(&u, &p)
    }).await.map_err(|e| AppError::Internal(format!("auth join failed: {e}")))?;
    match result {
        Ok(()) => Ok(StatusCode::OK),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(AppError::Conflict("user exists".into())),
        Err(_) => Err(AppError::BadRequest("could not create user".into())),
    }
}

pub async fn users_delete(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(name): Path<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user)?;
    if name == st.cfg.user {
        return Err(AppError::BadRequest("cannot delete the server-admin account".into()));
    }
    if !lock(&st.users)?.exists(&name) {
        return Err(AppError::NotFound);
    }
    // SEC-R5#2: revoke the account's sessions FIRST, so no still-valid token of the deleted user
    // can race the purge (create_vault / an in-flight commit re-materializing DATA_ROOT/<name>/
    // after remove_dir_all). Only then purge data.
    lock(&st.tokens)?.revoke_user(&name).map_err(|e| AppError::Internal(e.to_string()))?;
    // SEC-R3#2 / SEC-MED-2: purge the vault data (drops cached handles + the dir) and treat failure
    // as a HARD error. If the account row were removed first and the purge then failed (e.g. a
    // Windows-locked chunk file), the account would be gone while DATA_ROOT/<name>/ remained — a
    // same-name recreation would inherit the prior owner's notes. Purging before removing the row
    // means a failure leaves the account intact + retryable, and the row is removed only once the
    // data is provably gone.
    st.purge_user_data(&name).map_err(|e| AppError::Internal(format!("could not purge vault data: {e}")))?;
    let removed = lock(&st.users)?.remove(&name).map_err(|e| AppError::Internal(e.to_string()))?;
    if !removed {
        return Err(AppError::NotFound);
    }
    // Drop the account's shares (as owner or grantee). Tokens were already revoked up front.
    lock(&st.shares)?.purge_user(&name).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::OK)
}

#[derive(Serialize)]
pub struct RegResp {
    mode: Mode,
}
pub async fn registration_get(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<RegResp>, AppError> {
    require_admin(&st, &user)?;
    Ok(Json(RegResp { mode: lock(&st.registration)?.mode() }))
}

#[derive(Deserialize)]
pub struct SetRegReq {
    mode: Mode,
}
pub async fn registration_set(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<SetRegReq>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user)?;
    lock(&st.registration)?.set_mode(req.mode).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
pub struct InviteReq {
    #[serde(default)]
    label: String,
    #[serde(default)]
    ttl_secs: Option<u64>,
}
#[derive(Serialize)]
pub struct InviteResp {
    // The plaintext token — shown ONCE here; only its hash is stored server-side.
    token: String,
}
pub async fn invite_create(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<InviteReq>,
) -> Result<Json<InviteResp>, AppError> {
    require_admin(&st, &user)?;
    let token = lock(&st.registration)?
        .issue(&req.label, req.ttl_secs)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(InviteResp { token }))
}

pub async fn invites_list(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<TokenInfo>>, AppError> {
    require_admin(&st, &user)?;
    Ok(Json(lock(&st.registration)?.list()))
}

pub async fn invite_delete(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user)?;
    let removed = lock(&st.registration)?.revoke(&id).map_err(|e| AppError::Internal(e.to_string()))?;
    if removed { Ok(StatusCode::OK) } else { Err(AppError::NotFound) }
}

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
    // The bootstrap SYNC_USER is always admin (implicit + undemotable); additionally-promoted
    // accounts live in the persisted admin set (D0021). A poisoned lock denies (fail-safe).
    user == st.cfg.user || lock(&st.admins).map(|a| a.contains(user)).unwrap_or(false)
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
// Grant a share on one of the caller's OWN vaults to another account.
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
    // R15 sec#2: DON'T reveal whether the grantee account exists. A per-name exists()→400 vs 200
    // difference is a username-enumeration oracle — and this endpoint now serves on the PUBLIC port
    // (owner self-service sharing), so any authenticated user could enumerate the whole user base one
    // guess at a time, defeating the deliberate de-oracling of login/register (SEC-MED-1). Record the
    // grant for any well-formed name; it's inert until an account with that name exists, then it
    // activates. (Owners can pre-share by name; a typo just creates a harmless dormant grant.)
    // R16 MEDIUM-1: but bound it — a per-owner grant CAP (checked atomically under the same lock as
    // the grant, so no TOCTOU) keeps a malicious user from inflating the globally-scanned .shares.json
    // now that any well-formed name is accepted. An upsert of an existing grantee is always allowed.
    let mut g = lock(&st.shares)?;
    let is_upsert = g.permission(&user, &req.vault, &req.grantee).is_some();
    if !is_upsert && g.owner_grant_count(&user) >= crate::shares::MAX_GRANTS_PER_OWNER {
        return Err(AppError::BadRequest("you've reached the maximum number of shares for this account".into()));
    }
    g.grant(&user, &req.vault, &req.grantee, req.perm).map_err(|e| AppError::Internal(e.to_string()))?;
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

#[derive(Deserialize)]
pub struct ReindexReq {
    owner: String,
    vault: String,
    // Round-7 RC-2: drop index entries for files that are missing from disk AND unrecoverable from
    // the chunk store (truly lost), so the rest of the vault can be repaired instead of the whole
    // reindex aborting. Off by default (the safe DI-4 behavior); an explicit operator choice.
    #[serde(default)]
    force: bool,
}
// Server-admin repair of ANY (owner, vault)'s index — the admin surface for a corrupt shared
// vault that today only its owner could fix via curl. Rebuilds the manifest from the materialized
// files (same operation as the owner's own /reindex), clears the ERROR state, and broadcasts the
// new version so connected clients re-sync. Admin-only; the owner path (api::reindex) is unchanged.
pub async fn reindex(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<ReindexReq>,
) -> Result<Json<crate::protocol::StatusResponse>, AppError> {
    require_admin(&st, &user)?;
    if !safe_name(&req.owner) || !safe_name(&req.vault) {
        return Err(AppError::BadRequest("invalid owner or vault".into()));
    }
    if !st.vault_exists(&req.owner, &req.vault) {
        return Err(AppError::NotFound);
    }
    // Open the handle INSIDE spawn_blocking (R19 LOW): a cold open runs verify_and_gc / auto-reindex
    // (a whole-dir walk + rehash), which must not run on the async worker shared with public sync.
    let st2 = st.clone();
    let (owner, vault, force) = (req.owner.clone(), req.vault.clone(), req.force);
    let version = tokio::task::spawn_blocking(move || -> Result<u64, AppError> {
        let h = st2.vault(&owner, &vault).map_err(|_| AppError::NotFound)?;
        let mut v = crate::error::wlock(&h.vault)?;
        // A forced reindex that still can't complete is a genuine BadRequest (unsafe/colliding
        // names on disk), not an internal error; surface the message so the operator can act.
        v.reindex(force).map_err(|e| if force { AppError::BadRequest(e.to_string()) } else { AppError::Internal(e.to_string()) })?;
        let version = v.version();
        drop(v);
        let _ = h.tx.send(version); // broadcast the rebuilt version so connected clients re-sync
        Ok(version)
    }).await.map_err(|e| AppError::Internal(format!("reindex join failed: {e}")))??;
    log::info!("[{}/{} reindex by admin {user}] rebuilt manifest -> v{version}", req.owner, req.vault);
    Ok(Json(crate::protocol::StatusResponse {
        status: "ready".to_string(), detail: String::new(), version,
        api_version: crate::protocol::API_VERSION,
    }))
}

#[derive(Deserialize)]
pub struct PruneHistoryReq {
    owner: String,
    vault: String,
    // The version below which to drop tombstones (also the new history_floor). Omitted ⇒ the current
    // version, i.e. prune ALL current tombstones. Clamped server-side to [current floor, version].
    #[serde(default)]
    floor: Option<u64>,
}
// Server-admin deliberate tombstone PRUNE (tombstonePrune / D0019): reclaim tombstone space by
// dropping deletions below a floor and raising the deletion-history floor to it. Safe because a
// client left below the raised floor reconciles conservatively (keep + push + a batched notice) per
// the horizon. Admin-only; broadcasts the (unchanged content) version so clients re-check.
pub async fn prune_history(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<PruneHistoryReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_admin(&st, &user)?;
    if !safe_name(&req.owner) || !safe_name(&req.vault) {
        return Err(AppError::BadRequest("invalid owner or vault".into()));
    }
    if !st.vault_exists(&req.owner, &req.vault) {
        return Err(AppError::NotFound);
    }
    let h = st.vault(&req.owner, &req.vault).map_err(|_| AppError::NotFound)?;
    let (owner, vault, floor) = (req.owner.clone(), req.vault.clone(), req.floor);
    let (pruned, version) = tokio::task::spawn_blocking(move || -> Result<(usize, u64), AppError> {
        let mut v = crate::error::wlock(&h.vault)?;
        let target = floor.unwrap_or_else(|| v.version()); // default: prune all current tombstones
        let n = v.prune_history(target).map_err(|e| AppError::Internal(e.to_string()))?;
        Ok((n, v.version()))
    }).await.map_err(|e| AppError::Internal(format!("prune join failed: {e}")))??;
    log::info!("[{owner}/{vault} prune-history by admin {user}] pruned {pruned} tombstone(s)");
    Ok(Json(serde_json::json!({ "pruned": pruned, "version": version })))
}

#[derive(Deserialize)]
pub struct VaultDelReq {
    owner: String,
    vault: String,
}
// Server-admin per-vault delete (Round-7 RC-4) — removes one vault's data (dir + cached handle),
// the finer-grained complement to whole-account users_delete. Admin-only; the vault must exist.
// (Any dangling share grants on it become inert — scoped() 404s a request to a non-existent vault.)
pub async fn vault_delete(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<VaultDelReq>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user)?;
    if !safe_name(&req.owner) || !safe_name(&req.vault) {
        return Err(AppError::BadRequest("invalid owner or vault".into()));
    }
    if !st.vault_exists(&req.owner, &req.vault) {
        return Err(AppError::NotFound);
    }
    st.purge_vault(&req.owner, &req.vault).map_err(|e| AppError::Internal(format!("could not delete vault: {e}")))?;
    log::info!("[admin {user}] deleted vault {}/{}", req.owner, req.vault);
    Ok(StatusCode::OK)
}

// ---- server-admin only: accounts, registration policy, invite tokens ----

#[derive(Serialize)]
pub struct UserView {
    username: String,
    is_admin: bool,
    is_bootstrap: bool, // the SYNC_USER account — always admin, can't be demoted or deleted
}
pub async fn users_list(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<UserView>>, AppError> {
    require_admin(&st, &user)?;
    let names = lock(&st.users)?.usernames();
    let admins = lock(&st.admins)?;
    let out = names.into_iter().map(|u| {
        let is_bootstrap = u == st.cfg.user;
        UserView { is_admin: is_bootstrap || admins.contains(&u), is_bootstrap, username: u }
    }).collect();
    Ok(Json(out))
}

// Grantee autocomplete (D0021): the username list for share typeahead + fuzzy match. SERVER-ADMIN
// only (critique R8 security): a full account-table dump must not be reachable by any authenticated
// user — in MERGE mode /api/admin/* rides the public port, so an ungated list would be an
// enumeration oracle worse than the per-name check the rest of the system de-oracles. The common
// operator IS the admin, so autocomplete still works for them; a non-admin owner falls back to
// typing the grantee (the server still verifies existence on share_create).
pub async fn usernames(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<String>>, AppError> {
    require_admin(&st, &user)?;
    Ok(Json(lock(&st.users)?.usernames()))
}

// Promote an account to server-admin (D0021) — server-admin only. The account must exist.
pub async fn admin_grant(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(name): Path<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user)?;
    if !safe_name(&name) {
        return Err(AppError::BadRequest("invalid username".into()));
    }
    if !lock(&st.users)?.exists(&name) {
        return Err(AppError::NotFound);
    }
    lock(&st.admins)?.grant(&name).map_err(|e| AppError::Internal(e.to_string()))?;
    log::info!("[admin {user}] granted server-admin to {name}");
    Ok(StatusCode::OK)
}

// Revoke server-admin from an account (D0021) — server-admin only. The BOOTSTRAP account is always
// admin and can never be demoted (else an operator could lock everyone out of administration).
pub async fn admin_revoke(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(name): Path<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user)?;
    if name == st.cfg.user {
        return Err(AppError::BadRequest("cannot demote the bootstrap admin account".into()));
    }
    lock(&st.admins)?.revoke(&name).map_err(|e| AppError::Internal(e.to_string()))?;
    log::info!("[admin {user}] revoked server-admin from {name}");
    Ok(StatusCode::OK)
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
    // Drop any server-admin membership so a re-created same-name account doesn't inherit admin (D0021).
    lock(&st.admins)?.revoke(&name).map_err(|e| AppError::Internal(e.to_string()))?;
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

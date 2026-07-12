// The /api/admin/* JSON API — the AUTHORITY the web admin UI wraps (dual surface). Any
// owner manages their own vaults' shares; the server-admin (the bootstrap SYNC_USER
// account) manages accounts, the registration policy, and invite tokens. Password hashes
// and token plaintext are never returned.
use crate::audit::{action, audit, outcome, ClientIp};
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
fn require_admin(st: &AppState, user: &str, ip: &str) -> Result<(), AppError> {
    if !is_server_admin(st, user) {
        // SEC-CMMC (AU.3.3.1/3.3.2): audit a denied privileged-function attempt at this single
        // choke-point so every /api/admin/* route is covered. The mutating handlers now thread their
        // ClientIp so the highest-value "who tried a privileged action, from where" events carry the
        // source; read-only handlers pass "-" (lower value, and the reverse proxy correlates by time).
        audit(action::AUTHZ_DENIED, user, "admin", outcome::DENIED, ip);
        return Err(AppError::Forbidden);
    }
    // IA.3.5.3 (crit-round): when the operator MANDATES admin MFA (REQUIRE_ADMIN_MFA=1), a privileged
    // account cannot act until it has enrolled TOTP — making MFA required for privileged accounts, not
    // merely available. Enrollment itself is on the (AuthToken-gated, non-admin) /api/mfa/* routes, so
    // a fresh admin can still enroll and is never locked out.
    if st.cfg.require_admin_mfa && !lock(&st.users)?.totp_enabled(user) {
        audit(action::AUTHZ_DENIED, user, "admin", outcome::DENIED, ip);
        return Err(AppError::Forbidden);
    }
    Ok(())
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

#[derive(Serialize, Clone)]
struct GrantView {
    grantee: String,
    perm: Perm,
}
#[derive(Serialize)]
pub struct VaultShares {
    vault: String,
    grants: Vec<GrantView>,
    // Admin-UX: per-vault health so the operator sees which vaults need repair, and Reindex becomes
    // status-driven instead of a guessed action. "ready" | "error" (corrupt index) | "missing".
    status: String,
}

// Open a vault (in a blocking context — a cold open runs verify_and_gc) and report its health. Never
// throws: a failed open / poisoned lock reports "error" so the operator is nudged to repair, not left
// blind. `st.vault` auto-heals a recoverable vault on open, so viewing health also opportunistically
// repairs — desirable for the "self-healing without babysitting" operator.
fn vault_health(st: &AppState, owner: &str, vault: &str) -> String {
    match st.vault(owner, vault) {
        Ok(h) => match crate::error::rlock(&h.vault) {
            Ok(v) => if v.is_corrupt() { "error".into() } else { "ready".into() },
            Err(_) => "error".into(),
        },
        Err(_) => "missing".into(),
    }
}

// The caller's OWN vaults + who each is shared with (owner-scoped share management) + health.
pub async fn my_vaults(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<VaultShares>>, AppError> {
    let vaults = st.list_vaults(&user);
    let grants_by_vault: std::collections::HashMap<String, Vec<GrantView>> = {
        let shares = lock(&st.shares)?;
        vaults.iter().map(|v| {
            let g = shares.grants_for(&user, v).into_iter().map(|g| GrantView { grantee: g.grantee, perm: g.perm }).collect();
            (v.clone(), g)
        }).collect()
    };
    // Probe each vault's health off the async worker (cold opens walk + rehash). Operators have few vaults.
    let (st2, owner, vlist) = (st.clone(), user.clone(), vaults.clone());
    let statuses = tokio::task::spawn_blocking(move || {
        vlist.into_iter().map(|v| { let s = vault_health(&st2, &owner, &v); (v, s) }).collect::<Vec<_>>()
    }).await.map_err(|e| AppError::Internal(format!("vault-status join failed: {e}")))?;
    let out = statuses.into_iter().map(|(vault, status)| {
        let grants = grants_by_vault.get(&vault).cloned().unwrap_or_default();
        VaultShares { vault, grants, status }
    }).collect();
    Ok(Json(out))
}

#[derive(Serialize)]
pub struct OwnerVault { vault: String, status: String }
// Server-admin: list ANY account's vaults + health, so vault repair/delete for another user can live
// under Accounts (folded from the old free-text repair panel — no typo-prone owner/vault entry). Admin-only.
pub async fn owner_vaults(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(name): Path<String>,
) -> Result<Json<Vec<OwnerVault>>, AppError> {
    require_admin(&st, &user, "-")?;
    if !safe_name(&name) { return Err(AppError::BadRequest("invalid username".into())); }
    let (st2, owner) = (st.clone(), name.clone());
    let vaults = st.list_vaults(&name);
    let out = tokio::task::spawn_blocking(move || {
        vaults.into_iter().map(|v| { let status = vault_health(&st2, &owner, &v); OwnerVault { vault: v, status } }).collect::<Vec<_>>()
    }).await.map_err(|e| AppError::Internal(format!("owner-vaults join failed: {e}")))?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct SetPwReq { password: String }
// Server-admin password RESET for another account (operator-for-others). Without this, a forgotten
// password forced a destructive delete+recreate (losing the account's vaults/shares). Sets the new
// password AND revokes the account's sessions (so the reset also signs the user out everywhere). The
// bootstrap admin is refused (its password is SYNC_PASSWORD, re-applied every boot). Admin-only.
pub async fn user_set_password(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Path(name): Path<String>, Json(req): Json<SetPwReq>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user, &ip)?;
    if !safe_name(&name) { return Err(AppError::BadRequest("invalid username".into())); }
    if name == st.cfg.user {
        return Err(AppError::BadRequest("the bootstrap admin's password is controlled by SYNC_PASSWORD — change it in the server environment and restart".into()));
    }
    crate::auth::validate_password_policy(&req.password)?; // IA.3.5.7
    if !lock(&st.users)?.exists(&name) { return Err(AppError::NotFound); }
    let permit = crate::auth::acquire_auth(&st).await?;
    let users = st.users.clone();
    let (u, p) = (name.clone(), req.password.clone());
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut g = users.lock().map_err(|_| std::io::Error::other("users lock poisoned"))?;
        g.rotate_password(&u, &p)?;         // records the old hash in history (IA.3.5.8)
        g.set_must_change(&u, true)          // IA.3.5.9: the reset password is TEMPORARY — force a change on next use
    }).await.map_err(|e| AppError::Internal(format!("auth join failed: {e}")))?
      .map_err(|e| AppError::Internal(e.to_string()))?;
    lock(&st.tokens)?.revoke_user(&name).map_err(|e| AppError::Internal(e.to_string()))?; // sign out everywhere
    log::info!("[admin {user}] reset password for '{name}' (temporary — must change; all sessions revoked)");
    audit(action::PASSWORD_RESET, &user, &name, outcome::SUCCESS, &ip);
    audit(action::SESSION_REVOKE, &user, &name, outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
pub struct ShareReq {
    vault: String,
    grantee: String,
    perm: Perm,
}
// Grant a share on one of the caller's OWN vaults to another account.
pub async fn share_create(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(mut req): Json<ShareReq>,
) -> Result<StatusCode, AppError> {
    req.grantee = req.grantee.trim().to_ascii_lowercase(); // usernames are case-insensitive
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
    drop(g);
    audit(action::SHARE_GRANT, &user, &format!("{}/{} -> {}", user, req.vault, req.grantee), outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
pub struct ShareDelReq {
    vault: String,
    grantee: String,
}
pub async fn share_delete(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<ShareDelReq>,
) -> Result<StatusCode, AppError> {
    lock(&st.shares)?
        .revoke(&user, &req.vault, &req.grantee)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    audit(action::SHARE_REVOKE, &user, &format!("{}/{} -> {}", user, req.vault, req.grantee), outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

// ---- D0023 capability share-links: share a vault by sending a single-use LINK. The link carries only
// an opaque token; redeeming (by a logged-in account) mints a normal grant bound to the redeemer. ----
#[derive(Deserialize)]
pub struct ShareLinkReq { vault: String, perm: Perm, #[serde(default)] label: String, #[serde(default)] ttl_secs: Option<u64> }
#[derive(Serialize)]
pub struct ShareLinkResp { token: String }

// Owner creates a link for one of THEIR OWN vaults. Returns the plaintext token once.
pub async fn share_link_create(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<ShareLinkReq>,
) -> Result<Json<ShareLinkResp>, AppError> {
    if !safe_name(&req.vault) { return Err(AppError::BadRequest("invalid vault".into())); }
    if !st.list_vaults(&user).iter().any(|v| v == &req.vault) { return Err(AppError::NotFound); } // must own it
    let token = lock(&st.share_links)?.create(&user, &req.vault, req.perm, &req.label, req.ttl_secs)
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    audit(action::SHARE_LINK_CREATE, &user, &format!("{}/{}", user, req.vault), outcome::SUCCESS, &ip);
    Ok(Json(ShareLinkResp { token }))
}

// The caller's own share-links (pending + redeemed); never the token/hash.
pub async fn share_link_list(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<crate::sharelinks::LinkInfo>>, AppError> {
    Ok(Json(lock(&st.share_links)?.list(&user)))
}

// Revoke a PENDING link the caller owns. An already-redeemed grant is revoked via /api/admin/shares.
pub async fn share_link_revoke(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    if !lock(&st.share_links)?.revoke(&user, &id).map_err(|e| AppError::Internal(e.to_string()))? {
        return Err(AppError::NotFound);
    }
    audit(action::SHARE_LINK_REVOKE, &user, &id, outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
pub struct RedeemLinkReq { token: String }
#[derive(Serialize)]
pub struct RedeemLinkResp { owner: String, vault: String, perm: Perm }

// Redeem a share-link (caller must be logged in). Binds a normal grant to the CALLER, consuming the
// link. Uniform error for unknown/expired/consumed (no oracle). Self-redeem is a no-op success.
pub async fn share_link_redeem(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<RedeemLinkReq>,
) -> Result<Json<RedeemLinkResp>, AppError> {
    let Some(r) = lock(&st.share_links)?.redeem(&req.token, &user) else {
        audit(action::SHARE_LINK_REDEEM, &user, "-", outcome::FAILURE, &ip);
        return Err(AppError::BadRequest("this share link is invalid, expired, or already used".into()));
    };
    if r.owner != user {
        // The link is now CLAIMED (redeem marked it consumed atomically — this preserves single-use
        // under concurrent redemption). Mint the D0008 grant bound to the redeemer; bound per-owner
        // (parity with share_create). If the grant fails for a RECOVERABLE reason (owner at cap, or a
        // grant I/O error), ROLL THE CLAIM BACK with unredeem() so the single-use invite isn't burned —
        // a missing grant fails closed, and the user/owner can retry rather than needing a fresh link.
        let mut g = lock(&st.shares)?;
        let is_upsert = g.permission(&r.owner, &r.vault, &user).is_some();
        if !is_upsert && g.owner_grant_count(&r.owner) >= crate::shares::MAX_GRANTS_PER_OWNER {
            drop(g);
            let _ = lock(&st.share_links)?.unredeem(&req.token);
            return Err(AppError::BadRequest("the vault owner has reached their maximum number of shares".into()));
        }
        if let Err(e) = g.grant(&r.owner, &r.vault, &user, r.perm) {
            drop(g);
            let _ = lock(&st.share_links)?.unredeem(&req.token);
            return Err(AppError::Internal(e.to_string()));
        }
    } else {
        // Self-redeem: the caller already owns the vault, so no grant is minted. Release the claim so
        // a no-op self-test doesn't BURN the single-use invite (the handler doc calls this a "no-op
        // success" — it must actually leave the link redeemable for the intended recipient) (critique F2b).
        let _ = lock(&st.share_links)?.unredeem(&req.token);
    }
    audit(action::SHARE_LINK_REDEEM, &user, &format!("{}/{} -> {}", r.owner, r.vault, user), outcome::SUCCESS, &ip);
    Ok(Json(RedeemLinkResp { owner: r.owner, vault: r.vault, perm: r.perm }))
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
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<ReindexReq>,
) -> Result<Json<crate::protocol::StatusResponse>, AppError> {
    require_admin(&st, &user, &ip)?;
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
    audit(action::VAULT_REINDEX, &user, &format!("{}/{}", req.owner, req.vault), outcome::SUCCESS, &ip);
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
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<PruneHistoryReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_admin(&st, &user, &ip)?;
    if !safe_name(&req.owner) || !safe_name(&req.vault) {
        return Err(AppError::BadRequest("invalid owner or vault".into()));
    }
    if !st.vault_exists(&req.owner, &req.vault) {
        return Err(AppError::NotFound);
    }
    // Open the handle INSIDE spawn_blocking (R20, parity with reindex) — a cold open auto-reindexes
    // (whole-dir walk), which must not run on the async worker shared with public sync.
    let st2 = st.clone();
    let (owner, vault, floor) = (req.owner.clone(), req.vault.clone(), req.floor);
    let (pruned, version) = tokio::task::spawn_blocking(move || -> Result<(usize, u64), AppError> {
        let h = st2.vault(&owner, &vault).map_err(|_| AppError::NotFound)?;
        let mut v = crate::error::wlock(&h.vault)?;
        let target = floor.unwrap_or_else(|| v.version()); // default: prune all current tombstones
        let n = v.prune_history(target).map_err(|e| AppError::Internal(e.to_string()))?;
        Ok((n, v.version()))
    }).await.map_err(|e| AppError::Internal(format!("prune join failed: {e}")))??;
    log::info!("[{}/{} prune-history by admin {user}] pruned {pruned} tombstone(s)", req.owner, req.vault);
    audit(action::VAULT_PRUNE, &user, &format!("{}/{}", req.owner, req.vault), outcome::SUCCESS, &ip);
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
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<VaultDelReq>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user, &ip)?;
    if !safe_name(&req.owner) || !safe_name(&req.vault) {
        return Err(AppError::BadRequest("invalid owner or vault".into()));
    }
    if !st.vault_exists(&req.owner, &req.vault) {
        return Err(AppError::NotFound);
    }
    st.purge_vault(&req.owner, &req.vault).map_err(|e| AppError::Internal(format!("could not delete vault: {e}")))?;
    log::info!("[admin {user}] deleted vault {}/{}", req.owner, req.vault);
    audit(action::VAULT_DELETE, &user, &format!("{}/{}", req.owner, req.vault), outcome::SUCCESS, &ip);
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
    require_admin(&st, &user, "-")?;
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
// typing the grantee (share_create deliberately does NOT verify existence — a dormant grant to a
// not-yet-registered name is allowed, precisely so it can't be used as an enumeration oracle).
pub async fn usernames(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<String>>, AppError> {
    require_admin(&st, &user, "-")?;
    Ok(Json(lock(&st.users)?.usernames()))
}

// Promote an account to server-admin (D0021) — server-admin only. The account must exist.
pub async fn admin_grant(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Path(name): Path<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user, &ip)?;
    if !safe_name(&name) {
        return Err(AppError::BadRequest("invalid username".into()));
    }
    if !lock(&st.users)?.exists(&name) {
        return Err(AppError::NotFound);
    }
    lock(&st.admins)?.grant(&name).map_err(|e| AppError::Internal(e.to_string()))?;
    log::info!("[admin {user}] granted server-admin to {name}");
    audit(action::ADMIN_GRANT, &user, &name, outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

// Revoke server-admin from an account (D0021) — server-admin only. The BOOTSTRAP account is always
// admin and can never be demoted (else an operator could lock everyone out of administration).
pub async fn admin_revoke(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Path(name): Path<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user, &ip)?;
    if !safe_name(&name) {
        return Err(AppError::BadRequest("invalid username".into())); // R22: parity with admin_grant — never log/act on a raw path segment
    }
    if name == st.cfg.user {
        return Err(AppError::BadRequest("cannot demote the bootstrap admin account".into()));
    }
    lock(&st.admins)?.revoke(&name).map_err(|e| AppError::Internal(e.to_string()))?;
    log::info!("[admin {user}] revoked server-admin from {name}");
    audit(action::ADMIN_REVOKE, &user, &name, outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
pub struct NewUserReq {
    username: String,
    password: String,
}
pub async fn users_create(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(mut req): Json<NewUserReq>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user, &ip)?;
    req.username = req.username.trim().to_ascii_lowercase(); // usernames are case-insensitive
    if !safe_name(&req.username) {
        return Err(AppError::BadRequest(format!("invalid username — {}", crate::users::NAME_RULE)));
    }
    // SEC-R2#4: same argon2 DoS protection as the public register path (offloaded, permit-bounded)
    // plus the shared password policy (IA.3.5.7).
    crate::auth::validate_password_policy(&req.password)?;
    let permit = crate::auth::acquire_auth(&st).await?;
    let users = st.users.clone();
    let (u, p) = (req.username.clone(), req.password.clone());
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut g = users.lock().map_err(|_| std::io::Error::other("users lock poisoned"))?;
        g.register(&u, &p)
    }).await.map_err(|e| AppError::Internal(format!("auth join failed: {e}")))?;
    match result {
        Ok(()) => {
            // IA.3.5.9: an admin-created account's initial password is TEMPORARY — force a change on
            // first use so the operator-chosen password isn't used indefinitely.
            let _ = lock(&st.users)?.set_must_change(&req.username, true);
            audit(action::ACCOUNT_CREATE, &user, &req.username, outcome::SUCCESS, &ip);
            Ok(StatusCode::OK)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(AppError::Conflict("user exists".into())),
        Err(_) => Err(AppError::BadRequest("could not create user".into())),
    }
}

pub async fn users_delete(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Path(name): Path<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user, &ip)?;
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
    audit(action::SESSION_REVOKE, &user, &name, outcome::SUCCESS, &ip);
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
    audit(action::ACCOUNT_DELETE, &user, &name, outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

#[derive(Serialize)]
pub struct RegResp {
    mode: Mode,
}
pub async fn registration_get(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<RegResp>, AppError> {
    require_admin(&st, &user, "-")?;
    Ok(Json(RegResp { mode: lock(&st.registration)?.mode() }))
}

#[derive(Deserialize)]
pub struct SetRegReq {
    mode: Mode,
}
pub async fn registration_set(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<SetRegReq>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user, &ip)?;
    lock(&st.registration)?.set_mode(req.mode).map_err(|e| AppError::Internal(e.to_string()))?;
    let mode_str = if req.mode == Mode::Open { "open" } else { "closed" };
    audit(action::REGISTRATION_POLICY_CHANGE, &user, mode_str, outcome::SUCCESS, &ip);
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
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<InviteReq>,
) -> Result<Json<InviteResp>, AppError> {
    require_admin(&st, &user, &ip)?;
    let token = lock(&st.registration)?
        .issue(&req.label, req.ttl_secs)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    // Audit the invite creation (never the token — it's a credential); label identifies it.
    audit(action::INVITE_CREATE, &user, &req.label, outcome::SUCCESS, &ip);
    Ok(Json(InviteResp { token }))
}

pub async fn invites_list(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<TokenInfo>>, AppError> {
    require_admin(&st, &user, "-")?;
    Ok(Json(lock(&st.registration)?.list()))
}

pub async fn invite_delete(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    require_admin(&st, &user, &ip)?;
    let removed = lock(&st.registration)?.revoke(&id).map_err(|e| AppError::Internal(e.to_string()))?;
    if removed { audit(action::INVITE_REVOKE, &user, &id, outcome::SUCCESS, &ip); Ok(StatusCode::OK) } else { Err(AppError::NotFound) }
}

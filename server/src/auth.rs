use crate::error::{lock, AppError};
use crate::protocol::{ChangePasswordRequest, LoginRequest, LoginResponse, RegisterRequest};
use crate::state::AppState;
use crate::users::safe_name;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::Json;

// Reject an absurdly long password BEFORE hashing it — argon2's cost scales with input, so an
// uncapped multi-MB password is a cheap CPU-amplification vector. 1 KiB is far above any real one. (SEC-2)
pub const MAX_PASSWORD_LEN: usize = 1024;
// SEC-AUTH (audit): a minimum length on ACCOUNT-CREATION paths. register previously accepted even an
// EMPTY password, which — with no rate limiting — made trivially-weak accounts a realistic foothold on
// an internet-facing box. Existing accounts are unaffected (this gates creation, not login). 8 is a
// modest floor; real strength is still the user's responsibility.
pub const MIN_PASSWORD_LEN: usize = 8;

// SEC-AUTH: acquire an argon2 permit with a bounded wait. The bare `acquire_owned().await` never times
// out (it only errors if the semaphore is closed), so an unauthenticated /api/login flood could pile up
// unbounded pending tasks behind the 8 permits and stall ALL logins indefinitely. Fast-fail with 503
// after a short wait so the queue depth is bounded and legitimate logins still get served. (M2)
pub async fn acquire_auth(st: &AppState) -> Result<tokio::sync::OwnedSemaphorePermit, AppError> {
    match tokio::time::timeout(std::time::Duration::from_secs(10), st.auth_slots.clone().acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        _ => Err(AppError::Unavailable("auth busy".into())),
    }
}

pub async fn login(
    State(st): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    if req.password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest("password too long".into()));
    }
    // S5 (R10): login doesn't require safe_name, so strip control chars + cap length before logging —
    // otherwise a username with embedded CR/LF could forge/split log lines (e.g. inject a fake "-> OK").
    let uname: String = req.username.chars().filter(|c| !c.is_control()).take(64).collect();
    // SEC-AUTH (FR9): per-account brute-force throttle. If this account has failed too many times in the
    // window, reject BEFORE doing the (expensive) argon2 verify — 429 + Retry-After, no oracle change
    // (a locked account and a wrong password are distinguishable only by the 429, which requires already
    // knowing the account has been hammered). Checked before verify so a locked account is cheap to reject.
    if let Err(retry) = lock(&st.login_throttle)?.check(&req.username) {
        log::warn!("[login] user='{uname}' -> 429 (rate-limited)");
        return Err(AppError::TooManyRequests(retry));
    }
    // Fetch the stored hash (or a dummy, constant-work) under a quick lock, then release it and
    // run the memory-hard argon2 verify on a BLOCKING thread, bounded by the auth permit pool —
    // so hashing never stalls an async worker and a login flood can't exhaust the runtime. (SEC-2)
    let (present, phc) = {
        let g = lock(&st.users)?;
        g.phc_for(&req.username)
    };
    let _permit = acquire_auth(&st).await?;
    let password = req.password.clone();
    let ok = tokio::task::spawn_blocking(move || crate::users::verify_password(&phc, &password))
        .await.map_err(|e| AppError::Internal(format!("auth join failed: {e}")))?;
    if present && ok {
        lock(&st.login_throttle)?.success(&req.username); // clear the failure counter on success
        let token = lock(&st.tokens)?.issue(&req.username).map_err(|e| AppError::Internal(e.to_string()))?;
        log::info!("[login] user='{uname}' -> OK");
        Ok(Json(LoginResponse { token }))
    } else {
        lock(&st.login_throttle)?.fail(&req.username); // count the failure toward the lockout threshold
        log::warn!("[login] user='{uname}' -> 401");
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
    if req.password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest("password too long".into()));
    }
    if req.password.len() < MIN_PASSWORD_LEN {
        return Err(AppError::BadRequest(format!("password too short (minimum {MIN_PASSWORD_LEN} characters)")));
    }
    // Registration/invite gate FIRST — before any existence check — so a closed server returns a
    // UNIFORM 403 whether or not the account exists. (Previously the exists() 409 fired before this
    // gate, giving an unauthenticated caller a 409-vs-403 username-enumeration oracle. SEC-MED-1.)
    // `&&` short-circuits: redeem (which consumes the token) only runs in Closed mode; on a rare
    // duplicate-with-valid-invite this consumes the invite, an acceptable cost for no oracle.
    if lock(&st.registration)?.mode() == crate::registration::Mode::Closed
        && (req.invite.is_empty() || !lock(&st.registration)?.redeem(&req.invite))
    {
        log::warn!("[register] user='{}' -> 403 (registration closed; missing/invalid invite)", req.username);
        return Err(AppError::Forbidden);
    }
    if lock(&st.users)?.exists(&req.username) {
        return Err(AppError::Conflict("user exists".into()));
    }
    // Offload the memory-hard argon2 hash to a blocking thread, bounded by the auth permit pool
    // (same DoS reasoning as login) — the users lock is taken INSIDE the blocking closure. (SEC-2)
    let permit = acquire_auth(&st).await?;
    let users = st.users.clone();
    let (u, p) = (req.username.clone(), req.password.clone());
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit; // held across the hash
        let mut g = users.lock().map_err(|_| std::io::Error::other("users lock poisoned"))?;
        g.register(&u, &p)
    }).await.map_err(|e| AppError::Internal(format!("auth join failed: {e}")))?;
    match result {
        Ok(()) => { log::info!("[register] user='{}' -> OK", req.username); Ok(StatusCode::OK) }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(AppError::Conflict("user exists".into())),
        Err(_) => Err(AppError::BadRequest("could not register".into())),
    }
}

// Authenticated self-service password change (R14 sec#2). Verify the CURRENT password, set the new
// one, then REVOKE every session for the user and issue ONE fresh token for this device — so a user
// whose token/password leaked can self-remediate (previously only an admin account-delete could).
pub async fn change_password(
    AuthToken(user): AuthToken,
    State(st): State<AppState>,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    if req.current.len() > MAX_PASSWORD_LEN || req.new_password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest("password too long".into()));
    }
    if req.new_password.is_empty() {
        return Err(AppError::BadRequest("new password must not be empty".into()));
    }
    // R15 sec#1: the bootstrap admin's password is re-asserted from SYNC_PASSWORD on EVERY boot
    // (state.rs — a deliberate env-rotation feature), so a self-service change here would be silently
    // reverted on the next restart — a FALSE remediation for the most-privileged account. Refuse it
    // and point the operator at the real lever: rotate SYNC_PASSWORD in the environment + restart.
    if user == st.cfg.user {
        return Err(AppError::BadRequest(
            "This is the bootstrap admin account — its password is controlled by SYNC_PASSWORD and \
             re-applied on every restart. To change it, update SYNC_PASSWORD in the server \
             environment and restart the server.".into()));
    }
    // Verify the CURRENT password — memory-hard argon2 offloaded to a blocking thread bounded by the
    // auth permit pool, same DoS reasoning as login. The account always exists (the token resolved).
    let (present, phc) = { lock(&st.users)?.phc_for(&user) };
    let permit = acquire_auth(&st).await?;
    let current = req.current.clone();
    let ok = tokio::task::spawn_blocking(move || { let _permit = permit; crate::users::verify_password(&phc, &current) })
        .await.map_err(|e| AppError::Internal(format!("auth join failed: {e}")))?;
    if !(present && ok) {
        log::warn!("[password] user='{user}' -> 401 (wrong current password)");
        return Err(AppError::Unauthorized);
    }
    // Hash + store the new password (offloaded, users lock taken inside the closure — like register).
    let permit = acquire_auth(&st).await?;
    let users = st.users.clone();
    let (u, np) = (user.clone(), req.new_password.clone());
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut g = users.lock().map_err(|_| std::io::Error::other("users lock poisoned"))?;
        g.set_password(&u, &np)
    }).await.map_err(|e| AppError::Internal(format!("auth join failed: {e}")))?
      .map_err(|e| AppError::Internal(e.to_string()))?;
    // Revoke ALL sessions (incl. the caller's current token + any leaked one elsewhere), then issue
    // one fresh token for THIS device so the caller stays logged in.
    lock(&st.tokens)?.revoke_user(&user).map_err(|e| AppError::Internal(e.to_string()))?;
    let token = lock(&st.tokens)?.issue(&user).map_err(|e| AppError::Internal(e.to_string()))?;
    log::info!("[password] user='{user}' changed password; all sessions revoked + one re-issued");
    Ok(Json(LoginResponse { token }))
}

// SEC-AUTH (audit): single-session logout — revoke the PRESENTED token server-side. Without this a
// "signed-out" (or leaked, or backed-up-in-data.json) token stayed valid until its 30-day TTL; only
// change_password (revokes all sessions) or an admin account-delete could kill it, so a user signing
// out on a shared/lost device had no way to actually end that session. Reads the raw bearer token
// directly (AuthToken discards it) and revokes just that one. Idempotent: an unknown token is a no-op OK.
pub async fn logout(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<StatusCode, AppError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    lock(&st.tokens)?.revoke(token).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StatusCode::OK)
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

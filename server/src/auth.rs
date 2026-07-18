// The AuthToken request-extractor impl intentionally sits at the file's end (after the test module);
// suppress clippy's items-after-test-module STYLE lint rather than reorder the file.
#![allow(clippy::items_after_test_module)]
use crate::audit::{action, audit, outcome, ClientIp};
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

// SEC-CMMC (IA.3.5.7 — minimum password complexity when new passwords are created). Applied on EVERY
// password-setting path (register / admin create / self change / admin reset), never on login (so it
// can't lock out an existing account). Modern, NIST-800-63B-aligned rule: enforce LENGTH, and accept
// either a passphrase (>= 15 chars, no composition rule — length is the strength) OR >= 2 distinct
// character classes for shorter passwords. Rejects the trivially-weak (single class, e.g. "password")
// without imposing the dated "1 upper + 1 digit + 1 symbol" burden. Returns a clear, actionable message.
pub fn validate_password_policy(pw: &str) -> Result<(), AppError> {
    if pw.len() > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest("password too long".into()));
    }
    if pw.len() < MIN_PASSWORD_LEN {
        return Err(AppError::BadRequest(format!("password too short (minimum {MIN_PASSWORD_LEN} characters)")));
    }
    if pw.chars().count() >= 15 {
        return Ok(()); // a long passphrase needs no composition rule (NIST 800-63B)
    }
    let mut classes = 0;
    if pw.chars().any(|c| c.is_ascii_lowercase()) { classes += 1; }
    if pw.chars().any(|c| c.is_ascii_uppercase()) { classes += 1; }
    if pw.chars().any(|c| c.is_ascii_digit()) { classes += 1; }
    if pw.chars().any(|c| !c.is_ascii_alphanumeric()) { classes += 1; }
    if classes < 2 {
        return Err(AppError::BadRequest(
            "password too simple — use at least two of: lowercase, uppercase, digits, symbols (or a passphrase of 15+ characters)".into()));
    }
    Ok(())
}

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
    ClientIp(ip): ClientIp,
    Json(mut req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    if req.password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest("password too long".into()));
    }
    // Usernames are case-insensitive: canonicalize to lowercase so "Will" logs into the same account
    // as "will". Non-breaking — stored keys have always been lowercase (safe_name enforced it), so this
    // only maps mixed-case INPUT onto the existing canonical key; the token binds to the canonical name.
    req.username = req.username.trim().to_ascii_lowercase();
    // S5 (R10): login doesn't require safe_name, so strip control chars + cap length before logging —
    // otherwise a username with embedded CR/LF could forge/split log lines (e.g. inject a fake "-> OK").
    let uname: String = req.username.chars().filter(|c| !c.is_control()).take(64).collect();
    // SEC-AUTH (FR9): per-account brute-force throttle. If this account has failed too many times in the
    // window, reject BEFORE doing the (expensive) argon2 verify — 429 + Retry-After, no oracle change
    // (a locked account and a wrong password are distinguishable only by the 429, which requires already
    // knowing the account has been hammered). Checked before verify so a locked account is cheap to reject.
    if let Err(retry) = lock(&st.login_throttle)?.check(&req.username) {
        log::warn!("[login] user='{uname}' -> 429 (rate-limited)");
        audit(action::RATE_LIMITED, &uname, &uname, outcome::DENIED, &ip);
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
        // IA.3.5.3: if the account has MFA enabled, the password alone is not enough — require a valid
        // TOTP (or single-use recovery) second factor. A missing/invalid factor is a distinct 401 "mfa
        // required" so the client prompts; the login-throttle failure is NOT cleared until BOTH factors
        // pass, so MFA-enabled accounts get the same brute-force protection on the second factor.
        if lock(&st.users)?.totp_enabled(&req.username) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let second_ok = match req.totp.as_deref() {
                Some(code) if !code.trim().is_empty() =>
                    lock(&st.users)?.totp_verify_second_factor(&req.username, code, now).map_err(|e| AppError::Internal(e.to_string()))?,
                _ => false,
            };
            if !second_ok {
                lock(&st.login_throttle)?.fail(&req.username);
                log::warn!("[login] user='{uname}' -> 401 (mfa required/invalid)");
                audit(action::LOGIN, &uname, &uname, outcome::FAILURE, &ip);
                return Err(AppError::MfaRequired);
            }
        }
        lock(&st.login_throttle)?.success(&req.username); // clear the failure counter on success
        let token = lock(&st.tokens)?.issue(&req.username).map_err(|e| AppError::Internal(e.to_string()))?;
        let must_change_password = lock(&st.users)?.must_change(&req.username); // IA.3.5.9 signal to the client
        log::info!("[login] user='{uname}' -> OK");
        audit(action::LOGIN, &uname, &uname, outcome::SUCCESS, &ip);
        Ok(Json(LoginResponse { token, must_change_password }))
    } else {
        lock(&st.login_throttle)?.fail(&req.username); // count the failure toward the lockout threshold
        log::warn!("[login] user='{uname}' -> 401");
        audit(action::LOGIN, &uname, &uname, outcome::FAILURE, &ip);
        Err(AppError::Unauthorized)
    }
}

pub async fn register(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(mut req): Json<RegisterRequest>,
) -> Result<StatusCode, AppError> {
    req.username = req.username.trim().to_ascii_lowercase(); // case-insensitive: canonicalize on create
    if !safe_name(&req.username) {
        return Err(AppError::BadRequest(format!("invalid username — {}", crate::users::NAME_RULE)));
    }
    validate_password_policy(&req.password)?; // IA.3.5.7 complexity/length
    // Registration/invite gate FIRST — before any existence check — so a closed server returns a
    // UNIFORM 403 whether or not the account exists. (Previously the exists() 409 fired before this
    // gate, giving an unauthenticated caller a 409-vs-403 username-enumeration oracle. SEC-MED-1.)
    // `&&` short-circuits: redeem (which consumes the token) only runs in Closed mode; on a rare
    // duplicate-with-valid-invite this consumes the invite, an acceptable cost for no oracle.
    if lock(&st.registration)?.mode() == crate::registration::Mode::Closed
        && (req.invite.is_empty() || !lock(&st.registration)?.redeem(&req.invite))
    {
        log::warn!("[register] user='{}' -> 403 (registration closed; missing/invalid invite)", req.username);
        let uname: String = req.username.chars().filter(|c| !c.is_control()).take(64).collect();
        audit(action::ACCOUNT_CREATE, "-", &uname, outcome::DENIED, &ip);
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
        Ok(()) => {
            log::info!("[register] user='{}' -> OK", req.username);
            audit(action::ACCOUNT_CREATE, &req.username, &req.username, outcome::SUCCESS, &ip);
            // A closed-mode registration that reached here consumed an invite; record the redemption.
            if !req.invite.is_empty() { audit(action::INVITE_REDEEM, &req.username, &req.username, outcome::SUCCESS, &ip); }
            Ok(StatusCode::OK)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(AppError::Conflict("user exists".into())),
        Err(_) => Err(AppError::BadRequest("could not register".into())),
    }
}

// Authenticated self-service password change (R14 sec#2). Verify the CURRENT password, set the new
// one, then REVOKE every session for the user and issue ONE fresh token for this device — so a user
// whose token/password leaked can self-remediate (previously only an admin account-delete could).
pub async fn change_password(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: axum::http::HeaderMap,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    // Resolve the token MANUALLY (not via the AuthToken extractor) so a must-change account — which
    // AuthToken rejects everywhere else (IA.3.5.9) — can still reach the one endpoint that clears the
    // flag. Security is unaffected: we verify the CURRENT password below regardless.
    let token = headers.get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok()).and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?.to_string();
    let user = lock(&st.tokens)?.resolve(&token).ok_or(AppError::Unauthorized)?;
    if req.current.len() > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest("password too long".into()));
    }
    validate_password_policy(&req.new_password)?; // IA.3.5.7 complexity/length on the NEW password
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
        audit(action::PASSWORD_CHANGE, &user, &user, outcome::FAILURE, &ip);
        return Err(AppError::Unauthorized);
    }
    // Reject reuse (IA.3.5.8), then rotate (records the old hash into history) — both under the users
    // lock on the blocking pool (argon2 verifies + hash). Returns false iff the new password matches the
    // current or a recent one.
    let permit = acquire_auth(&st).await?;
    let users = st.users.clone();
    let (u, np) = (user.clone(), req.new_password.clone());
    let accepted = tokio::task::spawn_blocking(move || -> std::io::Result<bool> {
        let _permit = permit;
        let mut g = users.lock().map_err(|_| std::io::Error::other("users lock poisoned"))?;
        if g.is_password_reused(&u, &np) { return Ok(false); }
        g.rotate_password(&u, &np)?;
        Ok(true)
    }).await.map_err(|e| AppError::Internal(format!("auth join failed: {e}")))?
      .map_err(|e| AppError::Internal(e.to_string()))?;
    if !accepted {
        audit(action::PASSWORD_CHANGE, &user, &user, outcome::FAILURE, &ip);
        return Err(AppError::BadRequest("that password matches a recent one — choose a password you haven't used lately".into()));
    }
    let _ = lock(&st.users)?.set_must_change(&user, false); // a successful self-change clears the forced-change flag (IA.3.5.9)
    // Revoke ALL sessions (incl. the caller's current token + any leaked one elsewhere), then issue
    // one fresh token for THIS device so the caller stays logged in.
    lock(&st.tokens)?.revoke_user(&user).map_err(|e| AppError::Internal(e.to_string()))?;
    let token = lock(&st.tokens)?.issue(&user).map_err(|e| AppError::Internal(e.to_string()))?;
    log::info!("[password] user='{user}' changed password; all sessions revoked + one re-issued");
    audit(action::PASSWORD_CHANGE, &user, &user, outcome::SUCCESS, &ip);
    audit(action::SESSION_REVOKE, &user, &user, outcome::SUCCESS, &ip);
    Ok(Json(LoginResponse { token, must_change_password: false }))
}

// SEC-AUTH (audit): single-session logout — revoke the PRESENTED token server-side. Without this a
// "signed-out" (or leaked, or backed-up-in-data.json) token stayed valid until its 30-day TTL; only
// change_password (revokes all sessions) or an admin account-delete could kill it, so a user signing
// out on a shared/lost device had no way to actually end that session. Reads the raw bearer token
// directly (AuthToken discards it) and revokes just that one. Idempotent: an unknown token is a no-op OK.
pub async fn logout(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: axum::http::HeaderMap,
) -> Result<StatusCode, AppError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    // Resolve the token to its user for audit attribution BEFORE revoking it (best-effort).
    let actor = lock(&st.tokens)?.resolve(token).unwrap_or_else(|| "-".to_string());
    lock(&st.tokens)?.revoke(token).map_err(|e| AppError::Internal(e.to_string()))?;
    audit(action::LOGOUT, &actor, &actor, outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod policy_tests {
    use super::validate_password_policy;
    #[test]
    fn enforces_length_and_complexity() {
        // too short
        assert!(validate_password_policy("Ab1").is_err());
        assert!(validate_password_policy("").is_err());
        // long enough but single character class -> rejected
        assert!(validate_password_policy("password").is_err());
        assert!(validate_password_policy("aaaaaaaa").is_err());
        // two classes at >= 8 -> ok
        assert!(validate_password_policy("vaultpw12").is_ok());   // lower+digit
        assert!(validate_password_policy("Charliepw1").is_ok());  // lower+upper+digit
        // long passphrase (>=15) needs no composition rule
        assert!(validate_password_policy("correcthorsebattery").is_ok());
        // absurdly long -> rejected
        assert!(validate_password_policy(&"a".repeat(2000)).is_err());
    }
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
        let user = lock(&st.tokens)?.resolve(&token).ok_or(AppError::Unauthorized)?;
        // IA.3.5.9: an account flagged must-change is blocked on EVERY AuthToken-gated route until it
        // sets a new password. /api/password and /api/logout resolve the token manually (not via this
        // extractor), so they remain reachable — the account can remediate but do nothing else.
        if lock(&st.users)?.must_change(&user) {
            return Err(AppError::PasswordChangeRequired);
        }
        Ok(AuthToken(user))
    }
}

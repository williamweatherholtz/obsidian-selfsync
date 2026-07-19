// SEC-CMMC (IA.3.5.3): self-service MFA (TOTP) management. A user enables/confirms/disables MFA on
// their OWN account (AuthToken-gated); the admin page surfaces this for privileged accounts. Enrollment
// is two-step (enroll -> confirm with a live code) so a half-finished setup never locks the account out,
// and disabling requires a current code so a stolen session token alone can't strip the second factor.
use crate::audit::{action, audit, outcome, ClientIp};
use crate::auth::AuthToken;
use crate::error::{lock, AppError};
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Serialize)]
pub struct MfaStatus { enabled: bool }
pub async fn status(AuthToken(user): AuthToken, State(st): State<AppState>) -> Result<Json<MfaStatus>, AppError> {
    Ok(Json(MfaStatus { enabled: lock(&st.users)?.totp_enabled(&user) }))
}

#[derive(Serialize)]
pub struct EnrollResp { secret: String, otpauth: String }
// Begin enrollment: return the secret + otpauth URI for the authenticator app. Not enforced until confirm.
pub async fn enroll(AuthToken(user): AuthToken, State(st): State<AppState>) -> Result<Json<EnrollResp>, AppError> {
    let secret = lock(&st.users)?.totp_begin_enroll(&user).map_err(|e| AppError::Internal(e.to_string()))?;
    let otpauth = crate::totp::otpauth_uri(&user, &secret);
    Ok(Json(EnrollResp { secret, otpauth }))
}

#[derive(Deserialize)]
pub struct CodeReq { code: String }
#[derive(Serialize)]
pub struct ConfirmResp { recovery_codes: Vec<String> }
// Confirm enrollment with a live code; enables MFA and returns the single-use recovery codes ONCE.
pub async fn confirm(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<CodeReq>,
) -> Result<Json<ConfirmResp>, AppError> {
    let codes = lock(&st.users)?.totp_confirm_enroll(&user, &req.code, now()).map_err(|e| AppError::Internal(e.to_string()))?;
    match codes {
        Some(recovery_codes) => {
            log::info!("[mfa] user='{user}' enabled TOTP");
            audit(action::MFA_ENABLE, &user, &user, outcome::SUCCESS, &ip);
            Ok(Json(ConfirmResp { recovery_codes }))
        }
        None => {
            // AU.3.3.1 (crit-round): a failed enrollment-confirm is a security-relevant event — record it.
            audit(action::MFA_ENABLE, &user, &user, outcome::FAILURE, &ip);
            Err(AppError::BadRequest("that code didn't match — check your authenticator's time sync and try again".into()))
        }
    }
}

// Disable MFA. Requires a valid current TOTP (or recovery) code so a stolen session token alone can't
// strip the factor. No-op OK if MFA is already off.
pub async fn disable(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<CodeReq>,
) -> Result<StatusCode, AppError> {
    if !lock(&st.users)?.totp_enabled(&user) { return Ok(StatusCode::OK); }
    // SEC (crit R+1, issueMfaDisableNoThrottle): the code check must be brute-force throttled, or a holder
    // of a stolen session token can hammer disable and strip MFA via the ±1-step TOTP window (~3/10^6 per
    // try) — defeating the "a stolen session token alone can't strip the factor" guarantee (doc above).
    // Same per-account counter as login's second-factor path (auth.rs), checked BEFORE the verify.
    if let Err(retry) = lock(&st.login_throttle)?.check(&user) {
        audit(action::RATE_LIMITED, &user, &user, outcome::DENIED, &ip);
        return Err(AppError::TooManyRequests(retry));
    }
    let ok = lock(&st.users)?.totp_verify_second_factor(&user, &req.code, now()).map_err(|e| AppError::Internal(e.to_string()))?;
    if !ok {
        lock(&st.login_throttle)?.fail(&user); // count toward the lockout, matching a failed login second factor
        // AU.3.3.1 (crit-round): a wrong-code MFA-disable attempt (a stolen-token probe to strip the
        // second factor) must leave an audit trail — the success path was audited but this wasn't.
        audit(action::MFA_DISABLE, &user, &user, outcome::FAILURE, &ip);
        return Err(AppError::Unauthorized);
    }
    lock(&st.login_throttle)?.success(&user); // a correct code clears the counter
    lock(&st.users)?.totp_disable(&user).map_err(|e| AppError::Internal(e.to_string()))?;
    log::info!("[mfa] user='{user}' disabled TOTP");
    audit(action::MFA_DISABLE, &user, &user, outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::throttle::DEFAULT_MAX_FAILS;
    use axum::extract::State;

    // CRITIQUE R+1 (issueMfaDisableNoThrottle): a stolen session token must not be able to brute-force
    // the TOTP window to strip MFA — the disable code check is per-account throttled like login.
    #[tokio::test]
    async fn disable_is_brute_force_throttled() {
        let dir = tempfile::tempdir().unwrap();
        let st = AppState::for_test(dir.path());
        {
            let mut u = st.users.lock().unwrap();
            u.register("u", "pw").unwrap();
            let secret = u.totp_begin_enroll("u").unwrap();
            let code = crate::totp::code_at(&secret, 1_000_000).unwrap(); // a valid enroll code
            u.totp_confirm_enroll("u", &code, 1_000_000).unwrap(); // MFA now enabled
        }
        let attempt = || disable(
            AuthToken("u".into()), State(st.clone()), ClientIp("t".into()),
            Json(CodeReq { code: "000000".into() }), // a wrong code
        );
        // Up to the lockout threshold, a wrong code is a plain 401 (and counts toward the lockout).
        for _ in 0..DEFAULT_MAX_FAILS {
            assert!(matches!(attempt().await, Err(AppError::Unauthorized)), "wrong code → 401");
        }
        // The next attempt is refused BEFORE the verify — the brute force is throttled.
        assert!(matches!(attempt().await, Err(AppError::TooManyRequests(_))), "brute force must be throttled (429)");
    }
}

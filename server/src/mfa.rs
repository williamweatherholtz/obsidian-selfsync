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
    let ok = lock(&st.users)?.totp_verify_second_factor(&user, &req.code, now()).map_err(|e| AppError::Internal(e.to_string()))?;
    if !ok {
        // AU.3.3.1 (crit-round): a wrong-code MFA-disable attempt (a stolen-token probe to strip the
        // second factor) must leave an audit trail — the success path was audited but this wasn't.
        audit(action::MFA_DISABLE, &user, &user, outcome::FAILURE, &ip);
        return Err(AppError::Unauthorized);
    }
    lock(&st.users)?.totp_disable(&user).map_err(|e| AppError::Internal(e.to_string()))?;
    log::info!("[mfa] user='{user}' disabled TOTP");
    audit(action::MFA_DISABLE, &user, &user, outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

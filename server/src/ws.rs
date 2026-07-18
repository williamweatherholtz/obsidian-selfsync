use crate::error::lock;
use crate::state::{AppState, MAX_WS_CONNECTIONS};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::broadcast::Receiver;

// Interval between server->client keepalive pings. A client that misses two consecutive pings
// (no Pong within ~2 intervals) is treated as dead and its socket is dropped, so a half-open
// TCP connection can't pin a task forever. (concurrency: WS idle timeout)
const WS_PING_INTERVAL: Duration = Duration::from_secs(30);

// Decrements the live-connection counters when a socket task ends (normal close, error, or idle
// timeout), so BOTH the global MAX_WS_CONNECTIONS budget and the per-user sub-cap are released on
// every exit path. (crit-round SC.3.13.1: the per-user count is released here too.)
struct ConnGuard {
    global: Arc<AtomicUsize>,
    per_user: Arc<std::sync::Mutex<HashMap<String, usize>>>,
    user: String,
}
impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.global.fetch_sub(1, Ordering::Relaxed);
        if let Ok(mut m) = self.per_user.lock() {
            if let Some(n) = m.get_mut(&self.user) {
                *n = n.saturating_sub(1);
                if *n == 0 { m.remove(&self.user); } // don't leak per-user entries
            }
        }
    }
}

// The subprotocol the server speaks; the client offers it alongside its `auth.<token>` entry
// and the server echoes THIS one back (never the secret) to complete the handshake.
const WS_SUBPROTOCOL: &str = "selfsync.v1";

// Pull the session token out of the Sec-WebSocket-Protocol header — the browser WebSocket API's
// only client-controlled header. The client offers ["selfsync.v1", "auth.<token>"]; we read the
// `auth.` entry. Keeping the token OFF the URL query keeps it out of access/proxy logs and
// browser history. (SEC-1)
fn token_from_protocols(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get("sec-websocket-protocol")?.to_str().ok()?;
    raw.split(',').map(str::trim).find_map(|p| p.strip_prefix("auth.").map(str::to_string))
}

pub async fn ws_handler(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Resolve token -> user, then subscribe to the requested vault's channel. A
    // poisoned token store returns 503 rather than panicking (matches error::lock).
    // SEC-CMMC (AU): client IP for the audit SOURCE — XFF/X-Real-IP (behind the reverse proxy).
    let src: String = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|s| s.split(',').next())
        .or_else(|| headers.get("x-real-ip").and_then(|v| v.to_str().ok()))
        .unwrap_or("-").trim().chars().filter(|c| !c.is_control()).take(64).collect();
    let src = if src.is_empty() { "-".to_string() } else { src };
    let token = token_from_protocols(&headers);
    let user = match lock(&st.tokens) {
        Ok(mut g) => token.as_deref().and_then(|t| g.resolve(t)),
        Err(_) => { log::warn!("[ws] connect REJECTED (token store unavailable)"); return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
    };
    let Some(user) = user else {
        log::warn!("[ws] connect REJECTED (missing/unknown token)");
        crate::audit::audit(crate::audit::action::AUTHZ_DENIED, "-", "ws", crate::audit::outcome::DENIED, &src);
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    };
    // IA.3.5.9 (crit-round): a must-change account can do NOTHING but set its own password. The HTTP
    // AuthToken extractor enforces this everywhere; the WS path resolves the token manually, so mirror
    // the gate here — otherwise a locked account could still open change-notification subscriptions.
    match lock(&st.users) {
        Ok(g) => if g.must_change(&user) {
            log::warn!("[ws] connect REJECTED (password change required)");
            return axum::http::StatusCode::FORBIDDEN.into_response();
        },
        Err(_) => return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
    let vault = q.get("vault").cloned().unwrap_or_default();
    // owner defaults to the caller (own vault); a shared vault names its owner. Subscribing
    // to change notifications is a read — gate it by the ACL, same as the read routes.
    let owner = q.get("owner").cloned().unwrap_or_else(|| user.clone());
    // Reject a malformed owner/vault BEFORE any log line interpolates them. A non-safe_name
    // value can never satisfy authorized()/vault_exists() anyway (store keys are safe_name),
    // so this only rejects requests that would 403/404 regardless — but it also closes the
    // log-injection surface the R20 safe_rel_path fix left open on this handler: the query
    // params are attacker-controlled and were logged raw on the reject paths below, so a
    // CR/LF/ANSI payload could forge operator-log lines. Fixed string, no interpolation.
    if !crate::users::safe_name(&owner) || !crate::users::safe_name(&vault) {
        log::warn!("[ws] connect REJECTED (malformed owner/vault)");
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let allowed = match lock(&st.shares) {
        Ok(g) => g.authorized(&owner, &vault, &user, crate::shares::Access::Read),
        Err(_) => { log::warn!("[ws] connect REJECTED (shares store unavailable)"); return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
    };
    if !allowed {
        log::warn!("[ws] connect REJECTED (forbidden {user} -> {owner}/{vault})");
        crate::audit::audit(crate::audit::action::AUTHZ_DENIED, &user, &format!("{owner}/{vault}"), crate::audit::outcome::DENIED, &src);
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    // Sync routes gate on vault existence (protocol-6); the WS is a read subscription, so it
    // opens the handle only if the vault already exists rather than lazily provisioning it.
    if !st.vault_exists(&owner, &vault) {
        log::warn!("[ws] connect REJECTED (no such vault '{owner}/{vault}')");
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let handle = match st.vault(&owner, &vault) {
        Ok(h) => h,
        Err(_) => { log::warn!("[ws] connect REJECTED (bad vault '{owner}/{vault}')"); return axum::http::StatusCode::NOT_FOUND.into_response(); }
    };
    // Enforce the global connection budget BEFORE upgrading. fetch_add + rollback keeps the
    // check-and-reserve atomic so concurrent connects can't overshoot the cap.
    let live = st.ws_conns.fetch_add(1, Ordering::Relaxed) + 1;
    if live > MAX_WS_CONNECTIONS {
        st.ws_conns.fetch_sub(1, Ordering::Relaxed);
        log::error!("[ws] connection refused — server is at capacity ({MAX_WS_CONNECTIONS} connections)");
        return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    // Per-user sub-cap (crit-round SC.3.13.1): reserve a slot for THIS account, releasing the global
    // reserve if the user is already at their cap — one principal can't monopolize the shared budget.
    {
        let mut m = match lock(&st.ws_conns_per_user) {
            Ok(m) => m,
            Err(_) => { st.ws_conns.fetch_sub(1, Ordering::Relaxed); return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
        };
        let n = m.entry(user.clone()).or_insert(0);
        if *n >= crate::state::MAX_WS_PER_USER {
            drop(m);
            st.ws_conns.fetch_sub(1, Ordering::Relaxed);
            log::warn!("[ws] connection refused — per-user cap reached");
            return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        *n += 1;
    }
    let guard = ConnGuard { global: st.ws_conns.clone(), per_user: st.ws_conns_per_user.clone(), user: user.clone() }; // releases both counters on task end
    // Routine connects are NOT logged. Emit capacity telemetry only: warn once we're at/over 80% of
    // the cap, and error at 100% (the next client will be refused).
    let pct = live * 100 / MAX_WS_CONNECTIONS;
    if live == MAX_WS_CONNECTIONS {
        log::error!("[ws] at capacity — {live}/{MAX_WS_CONNECTIONS} connections; further clients will be refused");
    } else if pct >= 80 {
        log::warn!("[ws] {live}/{MAX_WS_CONNECTIONS} connections ({pct}% of capacity)");
    }
    let rx = handle.tx.subscribe();
    // Echo back only the non-secret subprotocol so the handshake completes.
    let (st2, o2, v2, u2) = (st.clone(), owner.clone(), vault.clone(), user.clone());
    let tok = token.unwrap_or_default(); // resolved above; re-checked periodically to honor revocation
    ws.protocols([WS_SUBPROTOCOL])
        .on_upgrade(move |socket: WebSocket| async move { serve_socket(socket, rx, guard, st2, o2, v2, u2, tok).await })
}

// Is this live socket still allowed to receive change notifications? Two independent checks:
// the bearer token still resolves to this user (honors expiry + revoke_user from a password
// change / logout-all) AND the share ACL still authorizes a read (honors a revoked share). Either
// failing tears the socket down, so "revoke my sessions" and "unshare" both take effect promptly.
fn session_alive(st: &AppState, owner: &str, vault: &str, user: &str, token: &str) -> bool {
    let token_ok = match lock(&st.tokens) {
        Ok(mut g) => g.resolve(token).as_deref() == Some(user), // &mut: resolve prunes an expired token
        Err(_) => false,
    };
    if !token_ok { return false; }
    let acl_ok = match lock(&st.shares) {
        Ok(g) => g.authorized(owner, vault, user, crate::shares::Access::Read),
        Err(_) => false,
    };
    // Also re-assert the vault still EXISTS (R17 LOW): a socket subscribed to a since-deleted vault
    // should tear down promptly rather than ping forever against a dead subscription.
    acl_ok && st.vault_exists(owner, vault)
}

// The per-connection loop: fan out change notifications, keepalive-ping on an interval, and
// drop the socket if the peer misses two consecutive pings (dead/half-open connection).
// (8 args: the per-connection identity + guards; bundling into a struct buys nothing for a single
// internal call site, so allow the arg-count lint here.)
#[allow(clippy::too_many_arguments)]
async fn serve_socket(mut socket: WebSocket, mut rx: Receiver<u64>, _guard: ConnGuard, st: AppState, owner: String, vault: String, user: String, token: String) {
    let mut ping = tokio::time::interval(WS_PING_INTERVAL);
    // Delay (not the default Burst): if a busy change stream starves the ping branch for a full
    // interval, we DON'T fire two ticks back-to-back — which could see awaiting_pong still true
    // (the Pong unread in the buffer) and wrongly drop a healthy client. (CONC-4)
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // consume the immediate first tick
    let mut awaiting_pong = false;
    loop {
        tokio::select! {
            r = rx.recv() => match r {
                Ok(version) => {
                    // Re-check the SESSION before forwarding — token still valid (revocation, R16 LOW-1)
                    // AND the share ACL still authorizes (SEC-R2#3). A share revoked or a session killed
                    // (password change / logout-all) AFTER connect must stop this socket leaking
                    // change/version metadata (HTTP reads already re-authorize per request).
                    if !session_alive(&st, &owner, &vault, &user, &token) { break; }
                    let msg = format!("{{\"type\":\"changed\",\"version\":{version}}}");
                    if socket.send(Message::Text(msg)).await.is_err() { break; }
                }
                // Client fell behind the 256-deep channel: don't drop the socket — nudge
                // a full incremental catch-up (the client re-polls changes(since)). Re-check the
                // session here too (same as the Ok arm) so a revoked grantee / killed session stops
                // getting activity nudges instead of leaking until its next non-lagged recv.
                Err(RecvError::Lagged(_)) => {
                    if !session_alive(&st, &owner, &vault, &user, &token) { break; }
                    if socket.send(Message::Text("{\"type\":\"changed\"}".into())).await.is_err() { break; }
                }
                Err(RecvError::Closed) => break,
            },
            _ = ping.tick() => {
                if awaiting_pong { break; } // no Pong since the last ping -> peer is gone
                // R15 sec#3: also re-validate the session on each ping — catches a revocation during a
                // quiet period (no notifications flowing) so an idle revoked socket still tears down.
                if !session_alive(&st, &owner, &vault, &user, &token) { break; }
                if socket.send(Message::Ping(Vec::new())).await.is_err() { break; }
                // crit-round (residual: WS half-open liveness): also send an APPLICATION heartbeat the
                // client can see. Browsers auto-answer protocol Ping frames without surfacing them to
                // JS, so the client can't tell a half-open socket from a quiet one via our Pings. This
                // text frame reaches the client's onmessage on a healthy socket and is silently absent
                // on a dead one — letting the client time out and re-dial instead of showing green over
                // a dead channel. It carries no data; the client treats it as a liveness beat, not a poke.
                if socket.send(Message::Text("{\"type\":\"hb\"}".into())).await.is_err() { break; }
                awaiting_pong = true;
            }
            msg = socket.recv() => match msg {
                Some(Ok(Message::Pong(_))) => awaiting_pong = false,
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}       // ignore any other client frame
                Some(Err(_)) => break,  // transport error -> drop
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // SC.3.13.9 (terminate network connections) / SC.3.13.15 (session authenticity): a live WS socket
    // is torn down the moment its bearer token stops resolving. `session_alive` is the EXACT predicate
    // the socket loop re-checks on every ping and every change notification, so exercising it directly
    // is the real teardown behavior — a revoked session cannot keep leaking change/version metadata.
    #[test]
    fn ws_session_dies_when_the_token_is_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let st = AppState::for_test(dir.path());
        // The owner has full access to their own vault, so the ACL never blocks — this isolates the
        // TOKEN-revocation teardown path.
        // Single-token revoke (a logout).
        let t1 = lock(&st.tokens).unwrap().issue("admin").unwrap();
        assert!(session_alive(&st, "admin", "vault", "admin", &t1), "a fresh token keeps the socket alive");
        lock(&st.tokens).unwrap().revoke(&t1).unwrap();
        assert!(!session_alive(&st, "admin", "vault", "admin", &t1), "logout tears the socket down");
        // Revoke-all (a password change / logout-everywhere) must kill an unrelated live token too.
        let t2 = lock(&st.tokens).unwrap().issue("admin").unwrap();
        assert!(session_alive(&st, "admin", "vault", "admin", &t2));
        lock(&st.tokens).unwrap().revoke_user("admin").unwrap();
        assert!(!session_alive(&st, "admin", "vault", "admin", &t2), "logout-all / password change tears every socket down");
    }
}

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

// Decrements the live-connection counter when a socket task ends (normal close, error, or
// idle timeout), so the MAX_WS_CONNECTIONS budget is released on every exit path.
struct ConnGuard(Arc<AtomicUsize>);
impl Drop for ConnGuard {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::Relaxed); }
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
    let token = token_from_protocols(&headers);
    let user = match lock(&st.tokens) {
        Ok(mut g) => token.as_deref().and_then(|t| g.resolve(t)),
        Err(_) => { log::warn!("[ws] connect REJECTED (token store unavailable)"); return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
    };
    let Some(user) = user else {
        log::warn!("[ws] connect REJECTED (missing/unknown token)");
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    };
    let vault = q.get("vault").cloned().unwrap_or_default();
    // owner defaults to the caller (own vault); a shared vault names its owner. Subscribing
    // to change notifications is a read — gate it by the ACL, same as the read routes.
    let owner = q.get("owner").cloned().unwrap_or_else(|| user.clone());
    let allowed = match lock(&st.shares) {
        Ok(g) => g.authorized(&owner, &vault, &user, crate::shares::Access::Read),
        Err(_) => { log::warn!("[ws] connect REJECTED (shares store unavailable)"); return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
    };
    if !allowed {
        log::warn!("[ws] connect REJECTED (forbidden {user} -> {owner}/{vault})");
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
    let guard = ConnGuard(st.ws_conns.clone()); // released (decremented) when the socket task ends
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
    match lock(&st.shares) {
        Ok(g) => g.authorized(owner, vault, user, crate::shares::Access::Read),
        Err(_) => false,
    }
}

// The per-connection loop: fan out change notifications, keepalive-ping on an interval, and
// drop the socket if the peer misses two consecutive pings (dead/half-open connection).
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

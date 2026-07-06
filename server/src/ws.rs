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
        Err(_) => { eprintln!("[ws] connect REJECTED (token store unavailable)"); return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
    };
    let Some(user) = user else {
        eprintln!("[ws] connect REJECTED (missing/unknown token)");
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    };
    let vault = q.get("vault").cloned().unwrap_or_default();
    // owner defaults to the caller (own vault); a shared vault names its owner. Subscribing
    // to change notifications is a read — gate it by the ACL, same as the read routes.
    let owner = q.get("owner").cloned().unwrap_or_else(|| user.clone());
    let allowed = match lock(&st.shares) {
        Ok(g) => g.authorized(&owner, &vault, &user, crate::shares::Access::Read),
        Err(_) => { eprintln!("[ws] connect REJECTED (shares store unavailable)"); return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
    };
    if !allowed {
        eprintln!("[ws] connect REJECTED (forbidden {user} -> {owner}/{vault})");
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    // Sync routes gate on vault existence (protocol-6); the WS is a read subscription, so it
    // opens the handle only if the vault already exists rather than lazily provisioning it.
    if !st.vault_exists(&owner, &vault) {
        eprintln!("[ws] connect REJECTED (no such vault '{owner}/{vault}')");
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let handle = match st.vault(&owner, &vault) {
        Ok(h) => h,
        Err(_) => { eprintln!("[ws] connect REJECTED (bad vault '{owner}/{vault}')"); return axum::http::StatusCode::NOT_FOUND.into_response(); }
    };
    // Enforce the global connection budget BEFORE upgrading. fetch_add + rollback keeps the
    // check-and-reserve atomic so concurrent connects can't overshoot the cap.
    let live = st.ws_conns.fetch_add(1, Ordering::Relaxed) + 1;
    if live > MAX_WS_CONNECTIONS {
        st.ws_conns.fetch_sub(1, Ordering::Relaxed);
        eprintln!("[ws] connect REJECTED (at capacity: {MAX_WS_CONNECTIONS})");
        return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let guard = ConnGuard(st.ws_conns.clone()); // released (decremented) when the socket task ends
    eprintln!("[ws] {owner}/{vault} connected (by {user}) [{live}/{MAX_WS_CONNECTIONS}]");
    let rx = handle.tx.subscribe();
    // Echo back only the non-secret subprotocol so the handshake completes.
    ws.protocols([WS_SUBPROTOCOL])
        .on_upgrade(move |socket: WebSocket| async move { serve_socket(socket, rx, guard).await })
}

// The per-connection loop: fan out change notifications, keepalive-ping on an interval, and
// drop the socket if the peer misses two consecutive pings (dead/half-open connection).
async fn serve_socket(mut socket: WebSocket, mut rx: Receiver<u64>, _guard: ConnGuard) {
    let mut ping = tokio::time::interval(WS_PING_INTERVAL);
    ping.tick().await; // consume the immediate first tick
    let mut awaiting_pong = false;
    loop {
        tokio::select! {
            r = rx.recv() => match r {
                Ok(version) => {
                    let msg = format!("{{\"type\":\"changed\",\"version\":{version}}}");
                    if socket.send(Message::Text(msg)).await.is_err() { break; }
                }
                // Client fell behind the 256-deep channel: don't drop the socket — nudge
                // a full incremental catch-up (the client re-polls changes(since)).
                Err(RecvError::Lagged(_)) => {
                    if socket.send(Message::Text("{\"type\":\"changed\"}".into())).await.is_err() { break; }
                }
                Err(RecvError::Closed) => break,
            },
            _ = ping.tick() => {
                if awaiting_pong { break; } // no Pong since the last ping -> peer is gone
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

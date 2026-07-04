use crate::error::lock;
use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use std::collections::HashMap;
use tokio::sync::broadcast::error::RecvError;

pub async fn ws_handler(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Resolve token -> user, then subscribe to the requested vault's channel. A
    // poisoned token store returns 503 rather than panicking (matches error::lock).
    let user = match lock(&st.tokens) {
        Ok(g) => q.get("token").and_then(|t| g.get(t).cloned()),
        Err(_) => { eprintln!("[ws] connect REJECTED (token store unavailable)"); return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
    };
    let Some(user) = user else {
        eprintln!("[ws] connect REJECTED (missing/unknown token)");
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    };
    let vault = q.get("vault").cloned().unwrap_or_default();
    let handle = match st.vault(&user, &vault) {
        Ok(h) => h,
        Err(_) => { eprintln!("[ws] connect REJECTED (bad vault '{vault}')"); return axum::http::StatusCode::NOT_FOUND.into_response(); }
    };
    eprintln!("[ws] {user}/{vault} connected");
    let mut rx = handle.tx.subscribe();
    ws.on_upgrade(move |mut socket: WebSocket| async move {
        loop {
            match rx.recv().await {
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
            }
        }
    })
}

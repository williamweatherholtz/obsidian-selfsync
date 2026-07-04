use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use std::collections::HashMap;

pub async fn ws_handler(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Resolve token -> user, then subscribe to the requested vault's channel.
    let user = q.get("token").and_then(|t| st.tokens.lock().unwrap().get(t).cloned());
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
        while let Ok(version) = rx.recv().await {
            let msg = format!("{{\"type\":\"changed\",\"version\":{version}}}");
            if socket.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    })
}

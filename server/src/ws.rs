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
    let ok = q.get("token").map(|t| st.tokens.lock().unwrap().contains(t)).unwrap_or(false);
    if !ok { return axum::http::StatusCode::UNAUTHORIZED.into_response(); }
    let mut rx = st.tx.subscribe();
    ws.on_upgrade(move |mut socket: WebSocket| async move {
        while let Ok(version) = rx.recv().await {
            let msg = format!("{{\"type\":\"changed\",\"version\":{version}}}");
            if socket.send(Message::Text(msg)).await.is_err() { break; }
        }
    })
}

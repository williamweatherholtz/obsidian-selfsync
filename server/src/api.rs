use crate::auth::AuthToken;
use crate::protocol::{ChangesResponse, Deletion, FileMeta};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use std::collections::HashMap;

pub async fn changes(
    _auth: AuthToken,
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<ChangesResponse> {
    let since = q.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    Json(st.vault.lock().unwrap().changes(since))
}

pub async fn get_file(
    _auth: AuthToken,
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let path = q.get("path").cloned().unwrap_or_default();
    match st.vault.lock().unwrap().read(&path) {
        Ok(Some(bytes)) => (StatusCode::OK, bytes).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub async fn put_file(
    _auth: AuthToken,
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<FileMeta>, StatusCode> {
    let path = q.get("path").cloned().ok_or(StatusCode::BAD_REQUEST)?;
    let mtime = headers.get("X-Mtime").and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok()).unwrap_or(0);
    let meta = {
        let mut v = st.vault.lock().unwrap();
        v.put(&path, &body, mtime).map_err(|_| StatusCode::BAD_REQUEST)?
    };
    let _ = st.tx.send(meta.version);
    Ok(Json(meta))
}

pub async fn delete_file(
    _auth: AuthToken,
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Deletion>, StatusCode> {
    let path = q.get("path").cloned().ok_or(StatusCode::BAD_REQUEST)?;
    let d = {
        let mut v = st.vault.lock().unwrap();
        v.delete(&path).map_err(|_| StatusCode::BAD_REQUEST)?
    };
    match d {
        Some(d) => { let _ = st.tx.send(d.version); Ok(Json(d)) }
        None => Err(StatusCode::NOT_FOUND),
    }
}

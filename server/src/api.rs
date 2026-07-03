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
    let resp = st.vault.lock().unwrap().changes(since);
    eprintln!(
        "[changes] since={} -> v{} (+{} upserts, {} deletes)",
        since,
        resp.version,
        resp.upserts.len(),
        resp.deletes.len()
    );
    Json(resp)
}

pub async fn get_file(
    _auth: AuthToken,
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let path = q.get("path").cloned().unwrap_or_default();
    let result = st.vault.lock().unwrap().read(&path);
    match result {
        Ok(Some(bytes)) => {
            eprintln!("[get] {} -> 200 ({} bytes)", path, bytes.len());
            (StatusCode::OK, bytes).into_response()
        }
        Ok(None) => {
            eprintln!("[get] {} -> 404", path);
            StatusCode::NOT_FOUND.into_response()
        }
        Err(e) => {
            eprintln!("[get] {} -> 500 ({e})", path);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
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
    let mtime = headers
        .get("X-Mtime")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let meta = {
        let mut v = st.vault.lock().unwrap();
        v.put(&path, &body, mtime).map_err(|e| {
            eprintln!("[put] {} -> 400 ({e})", path);
            StatusCode::BAD_REQUEST
        })?
    };
    eprintln!("[put] {} ({} bytes) -> v{}", path, body.len(), meta.version);
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
        Some(d) => {
            eprintln!("[delete] {} -> v{}", path, d.version);
            let _ = st.tx.send(d.version);
            Ok(Json(d))
        }
        None => {
            eprintln!("[delete] {} -> 404 (not tracked)", path);
            Err(StatusCode::NOT_FOUND)
        }
    }
}

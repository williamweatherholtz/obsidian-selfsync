use crate::auth::AuthToken;
use crate::protocol::{ChangesResponse, CommitRequest, Deletion, FileMeta, MissingRequest, MissingResponse};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use std::collections::HashMap;

pub async fn changes(_a: AuthToken, State(st): State<AppState>, Query(q): Query<HashMap<String,String>>) -> Json<ChangesResponse> {
    let since = q.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    let resp = st.vault.lock().unwrap().changes(since);
    eprintln!("[changes] since={} -> v{} (+{} upserts, {} deletes)", since, resp.version, resp.upserts.len(), resp.deletes.len());
    Json(resp)
}

pub async fn chunks_missing(_a: AuthToken, State(st): State<AppState>, Json(req): Json<MissingRequest>) -> Json<MissingResponse> {
    let missing = st.vault.lock().unwrap().missing(&req.hashes);
    eprintln!("[missing] asked {} -> {} missing", req.hashes.len(), missing.len());
    Json(MissingResponse { missing })
}

pub async fn put_chunk(_a: AuthToken, State(st): State<AppState>, Path(hash): Path<String>, body: Bytes) -> Result<StatusCode, StatusCode> {
    st.vault.lock().unwrap().put_chunk(&hash, &body).map_err(|e| {
        eprintln!("[chunk put] {} -> 400 ({e})", hash); StatusCode::BAD_REQUEST
    })?;
    eprintln!("[chunk put] {} ({} bytes) -> 200", hash, body.len());
    Ok(StatusCode::OK)
}

pub async fn get_chunk(_a: AuthToken, State(st): State<AppState>, Path(hash): Path<String>) -> impl IntoResponse {
    match st.vault.lock().unwrap().get_chunk(&hash) {
        Ok(Some(b)) => (StatusCode::OK, b).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub async fn commit(_a: AuthToken, State(st): State<AppState>, Json(req): Json<CommitRequest>) -> Result<Json<FileMeta>, StatusCode> {
    let path = req.path.clone();
    let meta = {
        let mut v = st.vault.lock().unwrap();
        v.commit(req).map_err(|e| {
            eprintln!("[commit] {} -> error ({e})", path);
            if e.kind() == std::io::ErrorKind::NotFound { StatusCode::NOT_FOUND } else { StatusCode::BAD_REQUEST }
        })?
    };
    eprintln!("[commit] {} ({} chunks) -> v{}", meta.path, meta.chunks.len(), meta.version);
    let _ = st.tx.send(meta.version);
    Ok(Json(meta))
}

pub async fn delete_file(_a: AuthToken, State(st): State<AppState>, Query(q): Query<HashMap<String,String>>) -> Result<Json<Deletion>, StatusCode> {
    let path = q.get("path").cloned().ok_or(StatusCode::BAD_REQUEST)?;
    let d = { st.vault.lock().unwrap().delete(&path).map_err(|_| StatusCode::BAD_REQUEST)? };
    match d {
        Some(d) => { eprintln!("[delete] {} -> v{}", path, d.version); let _ = st.tx.send(d.version); Ok(Json(d)) }
        None => { eprintln!("[delete] {} -> 404", path); Err(StatusCode::NOT_FOUND) }
    }
}

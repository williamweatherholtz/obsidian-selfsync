use crate::auth::AuthToken;
use crate::protocol::{ChangesResponse, CommitRequest, Deletion, FileMeta, MissingRequest, MissingResponse};
use crate::state::{AppState, VaultHandle};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use std::collections::HashMap;

// Resolve the caller's (user, vault) namespace, or 404 if it can't be opened.
fn handle(st: &AppState, user: &str, vault: &str) -> Result<VaultHandle, StatusCode> {
    st.vault(user, vault).map_err(|_| StatusCode::NOT_FOUND)
}

pub async fn changes(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(vault): Path<String>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<ChangesResponse>, StatusCode> {
    let h = handle(&st, &user, &vault)?;
    let since = q.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    let resp = h.vault.lock().unwrap().changes(since);
    // Only log when there's actually something to report — routine idle polls (which
    // return nothing new for the client's version) stay silent.
    if !resp.upserts.is_empty() || !resp.deletes.is_empty() {
        eprintln!("[{user}/{vault} changes] since={} -> v{} (+{} upserts, {} deletes)",
            since, resp.version, resp.upserts.len(), resp.deletes.len());
    }
    Ok(Json(resp))
}

pub async fn chunks_missing(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(vault): Path<String>, Json(req): Json<MissingRequest>,
) -> Result<Json<MissingResponse>, StatusCode> {
    let h = handle(&st, &user, &vault)?;
    let missing = h.vault.lock().unwrap().missing(&req.hashes);
    Ok(Json(MissingResponse { missing }))
}

pub async fn put_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path((vault, hash)): Path<(String, String)>, body: Bytes,
) -> Result<StatusCode, StatusCode> {
    let h = handle(&st, &user, &vault)?;
    h.vault.lock().unwrap().put_chunk(&hash, &body).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(StatusCode::OK)
}

pub async fn get_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path((vault, hash)): Path<(String, String)>,
) -> impl IntoResponse {
    let h = match handle(&st, &user, &vault) { Ok(h) => h, Err(s) => return s.into_response() };
    let result = h.vault.lock().unwrap().get_chunk(&hash); // drop the guard before matching
    match result {
        Ok(Some(b)) => (StatusCode::OK, b).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub async fn commit(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(vault): Path<String>, Json(req): Json<CommitRequest>,
) -> Result<Json<FileMeta>, StatusCode> {
    let h = handle(&st, &user, &vault)?;
    let path = req.path.clone();
    let meta = {
        let mut v = h.vault.lock().unwrap();
        v.commit(req).map_err(|e| {
            eprintln!("[{user}/{vault} commit] {} -> error ({e})", path);
            if e.kind() == std::io::ErrorKind::NotFound { StatusCode::NOT_FOUND } else { StatusCode::BAD_REQUEST }
        })?
    };
    eprintln!("[{user}/{vault} commit] {} ({} chunks) -> v{}", meta.path, meta.chunks.len(), meta.version);
    let _ = h.tx.send(meta.version);
    Ok(Json(meta))
}

pub async fn delete_file(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(vault): Path<String>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Deletion>, StatusCode> {
    let h = handle(&st, &user, &vault)?;
    let path = q.get("path").cloned().ok_or(StatusCode::BAD_REQUEST)?;
    let d = { h.vault.lock().unwrap().delete(&path).map_err(|_| StatusCode::BAD_REQUEST)? };
    match d {
        Some(d) => { eprintln!("[{user}/{vault} delete] {} -> v{}", path, d.version); let _ = h.tx.send(d.version); Ok(Json(d)) }
        None => Err(StatusCode::NOT_FOUND),
    }
}

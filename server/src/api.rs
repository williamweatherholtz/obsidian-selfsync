use crate::auth::AuthToken;
use crate::error::{rlock, wlock, AppError};
use crate::protocol::{ChangesResponse, CommitRequest, Deletion, FileMeta, MissingRequest, MissingResponse, StatusResponse};
use crate::state::{AppState, VaultHandle};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::http::StatusCode;
use axum::Json;
use std::collections::HashMap;

// A content-defined chunk is ~64 KiB max; 1 MiB is a generous ceiling that still
// bounds a single upload well below the body limit.
const MAX_CHUNK_BYTES: usize = 1024 * 1024;

// Resolve the caller's (user, vault) namespace, or 404 if it can't be opened.
fn handle(st: &AppState, user: &str, vault: &str) -> Result<VaultHandle, AppError> {
    st.vault(user, vault).map_err(|_| AppError::NotFound)
}

// 503 if the vault's index is corrupt: sync ops must not read a degraded/empty
// manifest (our hash-based reconcile could interpret "no files" as deletions).
// Only /status and /reindex work on a corrupt vault. Caller holds the lock.
fn ensure_ready(v: &crate::vault::Vault) -> Result<(), AppError> {
    if v.is_corrupt() {
        return Err(AppError::Unavailable("vault index corrupt; operator must run reindex".into()));
    }
    Ok(())
}

pub async fn changes(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(vault): Path<String>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<ChangesResponse>, AppError> {
    let h = handle(&st, &user, &vault)?;
    let since = q.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    let v = rlock(&h.vault)?;
    ensure_ready(&v)?;
    let resp = v.changes(since);
    drop(v);
    if !resp.upserts.is_empty() || !resp.deletes.is_empty() {
        eprintln!("[{user}/{vault} changes] since={} -> v{} (+{} upserts, {} deletes)",
            since, resp.version, resp.upserts.len(), resp.deletes.len());
    }
    Ok(Json(resp))
}

pub async fn chunks_missing(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(vault): Path<String>, Json(req): Json<MissingRequest>,
) -> Result<Json<MissingResponse>, AppError> {
    let h = handle(&st, &user, &vault)?;
    let v = rlock(&h.vault)?;
    ensure_ready(&v)?;
    let missing = v.missing(&req.hashes);
    Ok(Json(MissingResponse { missing }))
}

pub async fn put_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path((vault, hash)): Path<(String, String)>, body: Bytes,
) -> Result<StatusCode, AppError> {
    let h = handle(&st, &user, &vault)?;
    // A CDC chunk is bounded (~64 KiB); reject anything wildly larger so a client
    // can't store giant blobs to defeat chunking / fill disk. (Server-internal
    // whole-file chunks from reindex bypass this — they don't come through the API.)
    if body.len() > MAX_CHUNK_BYTES {
        return Err(AppError::BadRequest("chunk exceeds size limit".into()));
    }
    // Shared read lock: chunk uploads run concurrently (content-addressed, unique
    // temp names) and don't block other reads. Commit takes the write lock later.
    rlock(&h.vault)?.put_chunk(&hash, &body).map_err(|e| AppError::BadRequest(e.to_string()))?;
    Ok(StatusCode::OK)
}

pub async fn get_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path((vault, hash)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let h = handle(&st, &user, &vault)?;
    let result = rlock(&h.vault)?.get_chunk(&hash).map_err(|e| AppError::Internal(e.to_string()))?;
    match result {
        Some(b) => Ok((StatusCode::OK, b).into_response()),
        None => Err(AppError::NotFound),
    }
}

pub async fn commit(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(vault): Path<String>, Json(req): Json<CommitRequest>,
) -> Result<Json<FileMeta>, AppError> {
    let h = handle(&st, &user, &vault)?;
    let path = req.path.clone();
    let meta = {
        let mut v = wlock(&h.vault)?;
        ensure_ready(&v)?;
        v.commit(req).map_err(|e| {
            eprintln!("[{user}/{vault} commit] {} -> error ({e})", path);
            if e.kind() == std::io::ErrorKind::NotFound { AppError::NotFound } else { AppError::BadRequest(e.to_string()) }
        })?
    };
    eprintln!("[{user}/{vault} commit] {} ({} chunks) -> v{}", meta.path, meta.chunks.len(), meta.version);
    let _ = h.tx.send(meta.version);
    Ok(Json(meta))
}

pub async fn delete_file(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(vault): Path<String>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Deletion>, AppError> {
    let h = handle(&st, &user, &vault)?;
    let path = q.get("path").cloned().ok_or_else(|| AppError::BadRequest("missing path".into()))?;
    let d = {
        let mut v = wlock(&h.vault)?;
        ensure_ready(&v)?;
        v.delete(&path).map_err(|e| AppError::BadRequest(e.to_string()))?
    };
    match d {
        Some(d) => { eprintln!("[{user}/{vault} delete] {} -> v{}", path, d.version); let _ = h.tx.send(d.version); Ok(Json(d)) }
        None => Err(AppError::NotFound),
    }
}

// GET /api/v/:vault/status — per-vault health (never gated; how a client learns a
// vault is in ERROR without tripping over a 503 on every sync op).
pub async fn status(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(vault): Path<String>,
) -> Result<Json<StatusResponse>, AppError> {
    let h = handle(&st, &user, &vault)?;
    let v = rlock(&h.vault)?;
    let (status, detail) = if v.is_corrupt() {
        ("error".to_string(), "index corrupt; run reindex".to_string())
    } else {
        ("ready".to_string(), String::new())
    };
    Ok(Json(StatusResponse { status, detail, version: v.version() }))
}

// POST /api/v/:vault/reindex — operator repair: rebuild the manifest from the
// materialized files (version-preserving), clearing the ERROR state. Scoped to the
// caller's own (user, vault) namespace.
pub async fn reindex(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(vault): Path<String>,
) -> Result<Json<StatusResponse>, AppError> {
    let h = handle(&st, &user, &vault)?;
    let version = {
        let mut v = wlock(&h.vault)?;
        v.reindex().map_err(|e| AppError::Internal(e.to_string()))?;
        v.version()
    };
    eprintln!("[{user}/{vault} reindex] rebuilt manifest from materialized files -> v{version}");
    let _ = h.tx.send(version);
    Ok(Json(StatusResponse { status: "ready".to_string(), detail: String::new(), version }))
}

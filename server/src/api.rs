use crate::auth::AuthToken;
use crate::error::{lock, rlock, wlock, AppError};
use crate::protocol::{ChangesResponse, CommitRequest, Deletion, FileMeta, MissingRequest, MissingResponse, StatusResponse};
use crate::shares::Access;
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

// Resolve the (owner, vault) a request targets and AUTHORIZE the caller for `access`.
// The owner comes from the path on owner-qualified routes (/api/u/:owner/:vault/…) or
// defaults to the caller on the legacy own-vault routes (/api/v/:vault/…). The isolation
// invariant is enforced here: no access without ownership or a matching grant (403);
// reads accept any grant, writes require read-write. 404 if the vault can't be opened.
fn scoped(
    st: &AppState, pp: &HashMap<String, String>, user: &str, access: Access,
) -> Result<(String, String, VaultHandle), AppError> {
    let vault = pp.get("vault").cloned().ok_or_else(|| AppError::BadRequest("missing vault".into()))?;
    let owner = pp.get("owner").cloned().unwrap_or_else(|| user.to_string());
    if !lock(&st.shares)?.authorized(&owner, &vault, user, access) {
        return Err(AppError::Forbidden);
    }
    let h = st.vault(&owner, &vault).map_err(|_| AppError::NotFound)?;
    Ok((owner, vault, h))
}

// Vaults shared WITH the caller (owned-by-others), so the client can offer them in its
// vault switcher. Own vaults come from /api/vaults; this is the complement.
#[derive(serde::Serialize)]
pub struct SharedVault {
    owner: String,
    vault: String,
    perm: crate::shares::Perm,
}
pub async fn shared_with_me(
    AuthToken(user): AuthToken, State(st): State<AppState>,
) -> Result<Json<Vec<SharedVault>>, AppError> {
    let grants = crate::error::lock(&st.shares)?.shared_with(&user);
    Ok(Json(grants.into_iter().map(|g| SharedVault { owner: g.owner, vault: g.vault, perm: g.perm }).collect()))
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
    Path(pp): Path<HashMap<String, String>>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<ChangesResponse>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Read)?;
    let since = q.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    let v = rlock(&h.vault)?;
    ensure_ready(&v)?;
    let resp = v.changes(since);
    drop(v);
    if !resp.upserts.is_empty() || !resp.deletes.is_empty() {
        eprintln!("[{owner}/{vault} changes by {user}] since={} -> v{} (+{} upserts, {} deletes)",
            since, resp.version, resp.upserts.len(), resp.deletes.len());
    }
    Ok(Json(resp))
}

// meta?path=… — metadata for one file (or 404), so a client can reconcile a single
// path without pulling the whole manifest.
pub async fn file_meta(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<FileMeta>, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read)?;
    let path = q.get("path").cloned().ok_or_else(|| AppError::BadRequest("missing path".into()))?;
    let v = rlock(&h.vault)?;
    ensure_ready(&v)?;
    v.file_meta(&path).map(Json).ok_or(AppError::NotFound)
}

pub async fn chunks_missing(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, Json(req): Json<MissingRequest>,
) -> Result<Json<MissingResponse>, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read)?;
    let v = rlock(&h.vault)?;
    ensure_ready(&v)?;
    let missing = v.missing(&req.hashes);
    Ok(Json(MissingResponse { missing }))
}

pub async fn put_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, body: Bytes,
) -> Result<StatusCode, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Write)?;
    let hash = pp.get("hash").cloned().ok_or_else(|| AppError::BadRequest("missing hash".into()))?;
    // A CDC chunk is bounded (~64 KiB); reject anything wildly larger so a client
    // can't store giant blobs to defeat chunking / fill disk.
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
    Path(pp): Path<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read)?;
    let hash = pp.get("hash").cloned().ok_or_else(|| AppError::BadRequest("missing hash".into()))?;
    let result = rlock(&h.vault)?.get_chunk(&hash).map_err(|e| AppError::Internal(e.to_string()))?;
    match result {
        Some(b) => Ok((StatusCode::OK, b).into_response()),
        None => Err(AppError::NotFound),
    }
}

pub async fn commit(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, Json(req): Json<CommitRequest>,
) -> Result<Json<FileMeta>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write)?;
    let path = req.path.clone();
    let meta = {
        let mut v = wlock(&h.vault)?;
        ensure_ready(&v)?;
        v.commit(req).map_err(|e| {
            eprintln!("[{owner}/{vault} commit by {user}] {} -> error ({e})", path);
            if e.kind() == std::io::ErrorKind::NotFound { AppError::NotFound } else { AppError::BadRequest(e.to_string()) }
        })?
    };
    eprintln!("[{owner}/{vault} commit by {user}] {} ({} chunks) -> v{}", meta.path, meta.chunks.len(), meta.version);
    let _ = h.tx.send(meta.version);
    Ok(Json(meta))
}

pub async fn delete_file(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Deletion>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write)?;
    let path = q.get("path").cloned().ok_or_else(|| AppError::BadRequest("missing path".into()))?;
    let d = {
        let mut v = wlock(&h.vault)?;
        ensure_ready(&v)?;
        v.delete(&path).map_err(|e| AppError::BadRequest(e.to_string()))?
    };
    match d {
        Some(d) => { eprintln!("[{owner}/{vault} delete by {user}] {} -> v{}", path, d.version); let _ = h.tx.send(d.version); Ok(Json(d)) }
        None => Err(AppError::NotFound),
    }
}

// status — per-vault health (skips the corrupt-index 503 so a client can LEARN a vault
// is in ERROR); still ACL-gated (read access), so it never leaks a vault to a non-grantee.
pub async fn status(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(pp): Path<HashMap<String, String>>,
) -> Result<Json<StatusResponse>, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read)?;
    let v = rlock(&h.vault)?;
    let (status, detail) = if v.is_corrupt() {
        ("error".to_string(), "index corrupt; run reindex".to_string())
    } else {
        ("ready".to_string(), String::new())
    };
    Ok(Json(StatusResponse { status, detail, version: v.version() }))
}

// reindex — operator repair (rebuild the manifest from materialized files). Registered
// only on the legacy own-vault route, so owner is always the caller (owner-scoped repair).
pub async fn reindex(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(pp): Path<HashMap<String, String>>,
) -> Result<Json<StatusResponse>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write)?;
    let version = {
        let mut v = wlock(&h.vault)?;
        v.reindex().map_err(|e| AppError::Internal(e.to_string()))?;
        v.version()
    };
    eprintln!("[{owner}/{vault} reindex by {user}] rebuilt manifest -> v{version}");
    let _ = h.tx.send(version);
    Ok(Json(StatusResponse { status: "ready".to_string(), detail: String::new(), version }))
}

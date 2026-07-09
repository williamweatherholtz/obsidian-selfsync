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
async fn scoped(
    st: &AppState, pp: &HashMap<String, String>, user: &str, access: Access,
) -> Result<(String, String, VaultHandle), AppError> {
    let vault = pp.get("vault").cloned().ok_or_else(|| AppError::BadRequest("missing vault".into()))?;
    let owner = pp.get("owner").cloned().unwrap_or_else(|| user.to_string());
    if !lock(&st.shares)?.authorized(&owner, &vault, user, access) {
        return Err(AppError::Forbidden);
    }
    // Sync routes act on an EXISTING vault only — never lazily provision one. Provisioning is
    // POST /api/vaults (create_vault); a sync request to an unknown vault is a 404, not a
    // silent create in the caller's namespace. (protocol-6)
    if !st.vault_exists(&owner, &vault) {
        return Err(AppError::NotFound);
    }
    // Open on the BLOCKING pool, never the async worker: a COLD open now auto-reindexes (D0022) —
    // a whole-vault directory walk + rehash — so doing it inline on a tokio worker would pin that
    // worker for the duration and, across several cold opens, stall the runtime (both ports).
    // A warm open is just a map lookup, so this is cheap in the common case. (critique-R8 concurrency H1.)
    let (st2, o2, v2) = (st.clone(), owner.clone(), vault.clone());
    let h = tokio::task::spawn_blocking(move || st2.vault(&o2, &v2))
        .await.map_err(|e| AppError::Internal(format!("vault open join failed: {e}")))?
        .map_err(|_| AppError::NotFound)?;
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
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Read).await?;
    let since = q.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    // R10-D3: offload the SQLite read to the blocking pool. A changes(0) full-manifest scan (issued
    // on every initial pull + periodic re-scan) must not run inline on an async worker — it holds the
    // per-vault mutex and stalls every other connection multiplexed on that worker.
    let resp = blocking(move || { let v = rlock(&h.vault)?; ensure_ready(&v)?; Ok(v.changes(since)) }).await?;
    // Log only a GENUINE forward delta (a client catching up from a known point). A `since=0` call
    // returns the whole manifest and is issued routinely (initial pull + the periodic config re-scan),
    // so it would spam identical lines even when nothing changed — every actual write is already in
    // the commit log, so a read doesn't need its own line.
    if since > 0 && (!resp.upserts.is_empty() || !resp.deletes.is_empty()) {
        log::info!("[{owner}/{vault} changes by {user}] since={} -> v{} (+{} upserts, {} deletes)",
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
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read).await?;
    let path = q.get("path").cloned().ok_or_else(|| AppError::BadRequest("missing path".into()))?;
    blocking(move || { let v = rlock(&h.vault)?; ensure_ready(&v)?; v.file_meta(&path).map(Json).ok_or(AppError::NotFound) }).await // R10-D3: off the async worker
}

// Run a blocking closure (filesystem IO / hashing) on the blocking thread pool so it never
// stalls an async runtime worker. The closure owns a cloned VaultHandle and takes the lock
// itself, so no std lock guard is ever held across an .await. (concurrency: offload blocking IO)
async fn blocking<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f).await.map_err(|e| AppError::Internal(format!("task join failed: {e}")))?
}

pub async fn chunks_missing(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, Json(req): Json<MissingRequest>,
) -> Result<Json<MissingResponse>, AppError> {
    // Cap the batch: an unbounded hash list drives one `exists()` stat syscall per hash under the
    // read lock — a 16 MiB body is ~230k stats, a cheap amplified DoS. A real file chunks into far
    // fewer than this. (concurrency-7)
    const MAX_MISSING_HASHES: usize = 10_000;
    if req.hashes.len() > MAX_MISSING_HASHES {
        return Err(AppError::BadRequest("too many hashes in one request".into()));
    }
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read).await?;
    let missing = blocking(move || {
        let v = rlock(&h.vault)?;
        ensure_ready(&v)?;
        Ok(v.missing(&req.hashes))
    }).await?;
    Ok(Json(MissingResponse { missing }))
}

pub async fn put_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, body: Bytes,
) -> Result<StatusCode, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Write).await?;
    let hash = pp.get("hash").cloned().ok_or_else(|| AppError::BadRequest("missing hash".into()))?;
    // A CDC chunk is bounded (~64 KiB); reject anything wildly larger so a client
    // can't store giant blobs to defeat chunking / fill disk.
    if body.len() > MAX_CHUNK_BYTES {
        return Err(AppError::BadRequest("chunk exceeds size limit".into()));
    }
    // Shared read lock: chunk uploads run concurrently (content-addressed, unique
    // temp names) and don't block other reads. Commit takes the write lock later.
    // The disk write runs on the blocking pool so it can't stall an async worker.
    blocking(move || {
        rlock(&h.vault)?.put_chunk(&hash, &body).map_err(|e| AppError::BadRequest(e.to_string()))
    }).await?;
    Ok(StatusCode::OK)
}

pub async fn get_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read).await?;
    let hash = pp.get("hash").cloned().ok_or_else(|| AppError::BadRequest("missing hash".into()))?;
    let result = blocking(move || {
        rlock(&h.vault)?.get_chunk(&hash).map_err(|e| AppError::Internal(e.to_string()))
    }).await?;
    match result {
        Some(b) => Ok((StatusCode::OK, b).into_response()),
        None => Err(AppError::NotFound),
    }
}

pub async fn commit(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, Json(req): Json<CommitRequest>,
) -> Result<Json<FileMeta>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write).await?;
    let tx = h.tx.clone();
    // `p` is for LOG lines only (the real path travels in `req`, moved into commit below). Strip
    // control chars here: on a bad-path rejection commit logs `p` verbatim, so an unsanitized raw
    // path would let a writer forge audit-log lines / smuggle ANSI escapes (R21 closed this on the
    // WS handler and the success path; R22 closes it on the commit REJECT path — the R20 tightening
    // relocated the injection here rather than eliminating it).
    let p: String = req.path.chars().filter(|c| !c.is_control()).take(256).collect();
    let (o, vlt, u) = (owner.clone(), vault.clone(), user.clone());
    // commit does journal + mirror IO under the write lock — run it on the blocking pool.
    let meta = blocking(move || {
        let mut v = wlock(&h.vault)?;
        ensure_ready(&v)?;
        v.commit(req).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound, // a 404 the client handles; not logged
            // CAS mismatch (optimistic concurrency): a NORMAL multi-device edit race — the client
            // based this write on a stale version, gets 409, and re-reconciles + merges. Log at debug
            // so routine concurrent edits don't flood the error stream (they aren't failures).
            std::io::ErrorKind::AlreadyExists => {
                log::debug!("[{o}/{vlt} commit by {u}] {p} -> 409 stale version (client re-reconciles)");
                AppError::Conflict(e.to_string())
            }
            // Client-actionable VALIDATION failures (bad chunk manifest: hash/size mismatch, oversize,
            // bad path) — safe + useful to return verbatim; they're content-level, never paths.
            std::io::ErrorKind::InvalidData | std::io::ErrorKind::InvalidInput => {
                log::warn!("[{o}/{vlt} commit by {u}] {p} -> rejected ({e})");
                AppError::BadRequest(e.to_string())
            }
            // Anything else is an UNEXPECTED internal/IO error — log it, return a generic 500 (R19
            // LOW: never surface the raw io/DB message to the client, per SEC-6).
            _ => {
                log::error!("[{o}/{vlt} commit by {u}] {p} -> internal error ({e})");
                AppError::Internal(e.to_string())
            }
        })
    }).await?;
    log::info!("[{owner}/{vault} commit by {user}] {} ({} chunks) -> v{}", meta.path, meta.chunks.len(), meta.version);
    let _ = tx.send(meta.version);
    Ok(Json(meta))
}

pub async fn delete_file(
    AuthToken(user): AuthToken, State(st): State<AppState>,
    Path(pp): Path<HashMap<String, String>>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Deletion>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write).await?;
    let path = q.get("path").cloned().ok_or_else(|| AppError::BadRequest("missing path".into()))?;
    let tx = h.tx.clone();
    let p = path.clone();
    let d = blocking(move || {
        let mut v = wlock(&h.vault)?;
        ensure_ready(&v)?;
        v.delete(&p).map_err(|e| AppError::Internal(e.to_string())) // a delete failure is internal (R19 LOW): log + generic 500, don't leak the raw io/DB message
    }).await?;
    match d {
        Some(d) => { log::info!("[{owner}/{vault} delete by {user}] {} -> v{}", path, d.version); let _ = tx.send(d.version); Ok(Json(d)) }
        None => Err(AppError::NotFound),
    }
}

// status — per-vault health (skips the corrupt-index 503 so a client can LEARN a vault
// is in ERROR); still ACL-gated (read access), so it never leaks a vault to a non-grantee.
pub async fn status(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(pp): Path<HashMap<String, String>>,
) -> Result<Json<StatusResponse>, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read).await?;
    blocking(move || { // R10-D3: SQLite read off the async worker
        let v = rlock(&h.vault)?;
        let (status, detail) = if v.is_corrupt() {
            ("error".to_string(), "index corrupt; run reindex".to_string())
        } else {
            ("ready".to_string(), String::new())
        };
        Ok(Json(StatusResponse { status, detail, version: v.version(), api_version: crate::protocol::API_VERSION }))
    }).await
}

// reindex — operator repair (rebuild the manifest from materialized files). Registered
// only on the legacy own-vault route, so owner is always the caller (owner-scoped repair).
pub async fn reindex(
    AuthToken(user): AuthToken, State(st): State<AppState>, Path(pp): Path<HashMap<String, String>>,
) -> Result<Json<StatusResponse>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write).await?;
    let tx = h.tx.clone();
    // reindex walks the whole vault dir + rehashes — always on the blocking pool.
    let version = blocking(move || {
        let mut v = wlock(&h.vault)?;
        v.reindex(false).map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(v.version())
    }).await?;
    log::info!("[{owner}/{vault} reindex by {user}] rebuilt manifest -> v{version}");
    let _ = tx.send(version);
    Ok(Json(StatusResponse { status: "ready".to_string(), detail: String::new(), version, api_version: crate::protocol::API_VERSION }))
}

#[derive(serde::Deserialize)]
pub struct OwnVaultDelReq {
    vault: String,
}
// Owner self-service vault delete (D0021): the caller deletes their OWN vault (owner == caller).
// Distinct from the server-admin any-vault delete (admin::vault_delete). Purges the vault dir +
// cached handle; a still-synced device then 404s (RC-3) and can deliberately re-create from its
// local copy (deletedVaultRecreatePrompt). DELETE /api/vault with a JSON body {vault}.
pub async fn delete_own_vault(
    AuthToken(user): AuthToken, State(st): State<AppState>, Json(req): Json<OwnVaultDelReq>,
) -> Result<StatusCode, AppError> {
    let vault = req.vault;
    if !crate::users::safe_name(&user) || !crate::users::safe_name(&vault) {
        return Err(AppError::BadRequest("invalid vault".into()));
    }
    // Owner-scoped: the vault lives under the caller's own namespace, so existence == ownership.
    if !st.vault_exists(&user, &vault) {
        return Err(AppError::NotFound);
    }
    st.purge_vault(&user, &vault).map_err(|e| AppError::Internal(format!("could not delete vault: {e}")))?;
    log::info!("[{user} delete-own-vault] {vault}");
    Ok(StatusCode::OK)
}

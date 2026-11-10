use crate::audit::{action, audit, outcome, ClientIp};
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
// reads accept any grant, writes require read-write. A non-existent vault is 404 (checked
// via vault_exists below); a genuine open failure AFTER that check is an unexpected server
// condition (IO / DB open error) → 500, not 404 (which would mislead the client into thinking
// the vault was deleted and hide the real fault).
// E2EE downgrade guard (D0103, spec section 4.6): a plugin that understands encrypted vaults sends
// `x-selfsync-e2ee: 1` on every vault-scoped request. Every sync handler threads this extractor into
// scoped(), which checks it AFTER authorization and existence against the handle's encrypted flag, so a
// non-grantee still gets the bare 403 and no caller learns whether a vault exists or is encrypted. The
// one exemption inside scoped() is GET keyring. Infallible: an absent header reads as false.
#[derive(Clone, Copy, Debug)]
pub struct E2eeHeader(pub bool);

#[axum::async_trait]
impl<S: Send + Sync> axum::extract::FromRequestParts<S> for E2eeHeader {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut axum::http::request::Parts, _st: &S) -> Result<Self, Self::Rejection> {
        let on = parts.headers.get("x-selfsync-e2ee").and_then(|v| v.to_str().ok()).map(|s| s.trim() == "1").unwrap_or(false);
        Ok(E2eeHeader(on))
    }
}

// Whether a request may reach a keyring vault without the header: only GET keyring.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Guard { Enforce, KeyringExempt }

async fn scoped(
    st: &AppState, pp: &HashMap<String, String>, user: &str, access: Access, e2ee: E2eeHeader,
) -> Result<(String, String, VaultHandle), AppError> {
    scoped_with(st, pp, user, access, e2ee, Guard::Enforce).await
}

async fn scoped_with(
    st: &AppState, pp: &HashMap<String, String>, user: &str, access: Access, e2ee: E2eeHeader, guard: Guard,
) -> Result<(String, String, VaultHandle), AppError> {
    let vault = pp.get("vault").cloned().ok_or_else(|| AppError::BadRequest("missing vault".into()))?;
    let owner = pp.get("owner").cloned().unwrap_or_else(|| user.to_string());
    if !lock(&st.shares)?.authorized(&owner, &vault, user, access) {
        // SEC-CMMC (AU.3.3.1/3.3.2): audit a cross-tenant access denial — the primary "probing another
        // user's vault" signal. Emitted at this single choke-point so every sync route is covered; the
        // authenticated principal (WHO) + target vault (WHAT) are known here (source IP is captured on
        // the mutating/auth events, not threaded through every hot read handler — see audit.rs).
        crate::audit::audit(crate::audit::action::AUTHZ_DENIED, user, &format!("{owner}/{vault}"), crate::audit::outcome::DENIED, "-");
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
        // vault_exists already confirmed the dir + safe names, so reaching here with an Err is an UNEXPECTED
        // open failure (IO / SQLite), not "not found". vault_open_error surfaces a schema DOWNGRADE (an older
        // binary opening a newer index after a rollback) DISTINCTLY as a 503 with a clear body, and anything
        // else as a generic 500 (issueSchemaRollbackOpaque500) — /status routes through here too, so a rolled-
        // back server self-diagnoses on the client instead of an opaque "internal error".
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound {
            // A request that passed vault_exists() and then met the delete tombstone under the open lock (a
            // purge whose best-effort directory removal is still pending, or a create that failed its
            // sidecar write): the vault is gone, so 404, never a 500 (spec section 4.4).
            AppError::NotFound
        } else { crate::error::vault_open_error(e) })?;
    // E2EE downgrade guard, after authorized() and vault_exists(): a grantee without the header on a
    // keyring vault gets 403 with the fixed body. Reads the in-memory flag only (a corrupt vault still answers).
    if guard == Guard::Enforce && !e2ee.0 && rlock(&h.vault)?.encrypted() {
        return Err(AppError::E2eeRequired);
    }
    Ok((owner, vault, h))
}

// GET keyring (D0102, spec section 4.4): the sidecar bytes, verbatim. 200 with the bytes; 404 when the
// vault is absent (from scoped) or the handle is plaintext with no sidecar; the refusal-one 503 when the
// handle is encrypted and the sidecar is gone, or its rebuild aborted for the no-sidecar reason, so a
// running server and a restarted one give one answer. Reads the sidecar and the in-memory flag only,
// never ensure_ready and never SQLite. A cold cache gets its handle through Vault::open first, whose own
// refusals map to the same 503 bodies. Exempt from the x-selfsync-e2ee guard: it is how a client learns.
pub async fn get_keyring(
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader, Path(pp): Path<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let (_owner, _vault, h) = scoped_with(&st, &pp, &user, Access::Read, e2ee, Guard::KeyringExempt).await?;
    let bytes = blocking(move || {
        let v = rlock(&h.vault)?;
        match v.keyring_bytes().map_err(|e| AppError::Internal(format!("keyring read failed: {e}")))? {
            Some(b) => Ok(Some(b)),
            None if v.encrypted() || v.aborted_for_no_sidecar() => Err(AppError::Unavailable(crate::error::E2EE_KEYRING_MISSING_MSG.into())),
            None => Ok(None),
        }
    }).await?;
    match bytes {
        Some(b) => Ok((StatusCode::OK, [(axum::http::header::CONTENT_TYPE, "application/json")], b).into_response()),
        None => Err(AppError::NotFound),
    }
}

// Vaults shared WITH the caller (owned-by-others), so the client can offer them in its
// vault switcher. Own vaults come from /api/vaults; this is the complement.
#[derive(serde::Serialize, schemars::JsonSchema)]
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

#[derive(serde::Deserialize)]
pub struct LeaveShareReq { owner: String, vault: String }
// Grantee-initiated "leave/decline a share": removes the CALLER's OWN grant on someone else's vault.
// The grantee is forced to the authed caller, so this can only drop your own access — never anyone
// else's (the owner's revoke stays separate). Idempotent: leaving a share you don't have is a no-op OK.
pub async fn leave_share(
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<LeaveShareReq>,
) -> Result<StatusCode, AppError> {
    crate::error::lock(&st.shares)?
        .revoke(&req.owner, &req.vault, &user) // grantee == caller — you can only remove your OWN access
        .map_err(|e| AppError::Internal(e.to_string()))?;
    audit(action::SHARE_REVOKE, &user, &format!("{}/{} -> {} (left)", req.owner, req.vault, user), outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
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
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader,
    Path(pp): Path<HashMap<String, String>>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<ChangesResponse>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Read, e2ee).await?;
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
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader,
    Path(pp): Path<HashMap<String, String>>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<FileMeta>, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read, e2ee).await?;
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
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader,
    Path(pp): Path<HashMap<String, String>>, Json(req): Json<MissingRequest>,
) -> Result<Json<MissingResponse>, AppError> {
    // Cap the batch: an unbounded hash list drives one `exists()` stat syscall per hash under the
    // read lock — a 16 MiB body is ~230k stats, a cheap amplified DoS. A real file chunks into far
    // fewer than this. (concurrency-7)
    const MAX_MISSING_HASHES: usize = 10_000;
    if req.hashes.len() > MAX_MISSING_HASHES {
        return Err(AppError::BadRequest("too many hashes in one request".into()));
    }
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read, e2ee).await?;
    let missing = blocking(move || {
        let v = rlock(&h.vault)?;
        ensure_ready(&v)?;
        Ok(v.missing(&req.hashes))
    }).await?;
    Ok(Json(MissingResponse { missing }))
}

pub async fn put_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader,
    Path(pp): Path<HashMap<String, String>>, body: Bytes,
) -> Result<StatusCode, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Write, e2ee).await?;
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
        rlock(&h.vault)?.put_chunk(&hash, &body).map_err(|e| match e.kind() {
            // E2EE (spec section 4.6): a non-frame on a keyring vault is 422 with a body naming the cause.
            std::io::ErrorKind::Unsupported => AppError::Unprocessable(e.to_string()),
            _ => AppError::BadRequest(e.to_string()),
        })
    }).await?;
    Ok(StatusCode::OK)
}

pub async fn get_chunk(
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader,
    Path(pp): Path<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read, e2ee).await?;
    let hash = pp.get("hash").cloned().ok_or_else(|| AppError::BadRequest("missing hash".into()))?;
    let result = blocking(move || {
        rlock(&h.vault)?.get_chunk(&hash).map_err(|e| AppError::Internal(e.to_string()))
    }).await?;
    match result {
        Some(b) => Ok((StatusCode::OK, b).into_response()),
        None => Err(AppError::NotFound),
    }
}

// @audit r2 2026-07-18 — FIXED (design): the SMALL-commit path now takes a permit too (a separate,
// generous small_commit_slots pool), so aggregate small-commit reassembly RAM is explicitly bounded
// (~512 MiB) instead of implicitly tied to the ~512-wide blocking pool (~8 GiB). Large commits keep
// their tight pool. (Sibling put_chunk's ≤16 MiB pre-check-buffer is a separate low item, still // @audit.)
// @audit-hash sha256:49bebda97232adf1
pub async fn commit(
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader,
    Path(pp): Path<HashMap<String, String>>, Json(req): Json<CommitRequest>,
) -> Result<Json<FileMeta>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write, e2ee).await?;
    // Configurable per-file ceiling (env MAX_FILE_MB, default 512). Reject an over-limit file early
    // with a clear message so the client can surface it, before taking a permit or touching the vault.
    if req.size > st.cfg.max_file_bytes {
        return Err(AppError::BadRequest(format!("file exceeds the server's size limit ({} MB)", st.cfg.max_file_bytes / (1024 * 1024))));
    }
    let tx = h.tx.clone();
    // `p` is for LOG lines only (the real path travels in `req`, moved into commit below). Strip
    // control chars here: on a bad-path rejection commit logs `p` verbatim, so an unsanitized raw
    // path would let a writer forge audit-log lines / smuggle ANSI escapes (R21 closed this on the
    // WS handler and the success path; R22 closes it on the commit REJECT path — the R20 tightening
    // relocated the injection here rather than eliminating it).
    let p: String = req.path.chars().filter(|c| !c.is_control()).take(256).collect();
    let (o, vlt, u) = (owner.clone(), vault.clone(), user.clone());
    // SEC (crit-round): bound AGGREGATE reassembly memory. A single commit is capped at
    // req.size ≤ MAX_FILE_BYTES, but a client owning many vaults could fire many large reassemblies
    // concurrently and exhaust RAM. Route only LARGE commits through a small permit pool (held across
    // the blocking reassembly); small note commits — the common case — take no permit. A bounded wait
    // sheds load as 503 rather than queueing unboundedly.
    let (pool, kind) = if req.size > crate::state::COMMIT_LARGE_BYTES {
        (&st.commit_slots, "large uploads")
    } else {
        (&st.small_commit_slots, "commits") // @audit r2: small commits are now bounded too (aggregate RAM)
    };
    let _commit_permit = match tokio::time::timeout(std::time::Duration::from_secs(30), pool.clone().acquire_owned()).await {
        Ok(Ok(permit)) => permit,
        _ => return Err(AppError::Unavailable(format!("server busy — too many {kind} in flight; retry shortly"))),
    };
    // commit does journal + mirror IO under the write lock — run it on the blocking pool.
    let meta = blocking(move || {
        let mut v = wlock(&h.vault)?;
        ensure_ready(&v)?;
        v.commit(req, &u).map_err(|e| match e.kind() {
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
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader,
    Path(pp): Path<HashMap<String, String>>, Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Deletion>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write, e2ee).await?;
    let path = q.get("path").cloned().ok_or_else(|| AppError::BadRequest("missing path".into()))?;
    // Optional optimistic-concurrency precondition (issueDeleteNoCasLostUpdate): the reconcile-driven
    // delete-remote sends the version it based the tombstone on; a deliberate/authoritative delete omits
    // it. Symmetric with commit's `expected_version`; an older client that never sends it keeps the
    // prior always-wins behavior.
    let expected_version = q.get("expected_version").and_then(|s| s.parse::<u64>().ok());
    // Deletion provenance (schema v3, issueDeletionProvenanceUnnotified): the client asserts its stable device
    // UUID + friendly label (same as commit's CommitRequest fields, here as query params since DELETE has no
    // body); the AUTHOR is the server-authenticated `user`, never a client field. An older client omits these →
    // recorded as '' (unknown) → the peer notifies conservatively.
    let device_id = q.get("device_id").cloned().unwrap_or_default();
    let device_name = q.get("device_name").cloned().unwrap_or_default();
    let tx = h.tx.clone();
    let (p, o, vlt, u, did, dname) = (path.clone(), owner.clone(), vault.clone(), user.clone(), device_id, device_name);
    let d = blocking(move || {
        let mut v = wlock(&h.vault)?;
        ensure_ready(&v)?;
        v.delete_checked(&p, expected_version, &u, &did, &dname).map_err(|e| match e.kind() {
            // CAS mismatch: a stale delete raced a newer commit — a NORMAL concurrent-edit outcome. 409
            // so the client re-reconciles (→ edit-wins-pull, resurrecting the edit). Debug-log, not error.
            std::io::ErrorKind::AlreadyExists => {
                log::debug!("[{o}/{vlt} delete by {u}] {p} -> 409 stale version (client re-reconciles)");
                AppError::Conflict(e.to_string())
            }
            // Any other delete failure is internal (R19 LOW): log + generic 500, don't leak the raw io/DB message.
            _ => AppError::Internal(e.to_string()),
        })
    }).await?;
    match d {
        Some(d) => { log::info!("[{owner}/{vault} delete by {user}] {} -> v{}", path, d.version); let _ = tx.send(d.version); Ok(Json(d)) }
        None => Err(AppError::NotFound),
    }
}

// status — per-vault health (skips the corrupt-index 503 so a client can LEARN a vault
// is in ERROR); still ACL-gated (read access), so it never leaks a vault to a non-grantee.
pub async fn status(
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader, Path(pp): Path<HashMap<String, String>>,
) -> Result<Json<StatusResponse>, AppError> {
    let (_owner, _vault, h) = scoped(&st, &pp, &user, Access::Read, e2ee).await?;
    blocking(move || { // R10-D3: SQLite read off the async worker
        let v = rlock(&h.vault)?;
        let (status, detail) = if v.is_corrupt() {
            // E2EE (spec section 4.5): a rebuild that aborted for a named reason reports that reason.
            ("error".to_string(), v.abort_reason().map(|r| r.to_string()).unwrap_or_else(|| "index corrupt; run reindex".to_string()))
        } else {
            ("ready".to_string(), String::new())
        };
        Ok(Json(StatusResponse { status, detail, version: v.version(), api_version: crate::protocol::API_VERSION, schema_hash: crate::wire_signature::signature_hash().to_string() }))
    }).await
}

// reindex — operator repair (rebuild the manifest from materialized files). Registered
// only on the legacy own-vault route, so owner is always the caller (owner-scoped repair).
pub async fn reindex(
    AuthToken(user): AuthToken, State(st): State<AppState>, e2ee: E2eeHeader, ClientIp(ip): ClientIp, Path(pp): Path<HashMap<String, String>>,
) -> Result<Json<StatusResponse>, AppError> {
    let (owner, vault, h) = scoped(&st, &pp, &user, Access::Write, e2ee).await?;
    let tx = h.tx.clone();
    // reindex walks the whole vault dir + rehashes — always on the blocking pool.
    let version = blocking(move || {
        let mut v = wlock(&h.vault)?;
        v.reindex(false).map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(v.version())
    }).await?;
    log::info!("[{owner}/{vault} reindex by {user}] rebuilt manifest -> v{version}");
    audit(action::VAULT_REINDEX, &user, &format!("{owner}/{vault}"), outcome::SUCCESS, &ip);
    let _ = tx.send(version);
    Ok(Json(StatusResponse { status: "ready".to_string(), detail: String::new(), version, api_version: crate::protocol::API_VERSION, schema_hash: crate::wire_signature::signature_hash().to_string() }))
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
    AuthToken(user): AuthToken, State(st): State<AppState>, ClientIp(ip): ClientIp, Json(req): Json<OwnVaultDelReq>,
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
    audit(action::VAULT_DELETE, &user, &format!("{user}/{vault}"), outcome::SUCCESS, &ip);
    Ok(StatusCode::OK)
}

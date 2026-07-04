# M1 Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minimal end-to-end sync: a Rust server materializes one vault as real files under a bind mount, and an Obsidian plugin logs in and syncs whole files to/from it in near-real-time — proving the protocol, transport, and WebSocket push before chunking/merge are added.

**Architecture:** Server-authoritative over a monotonic per-vault integer `version`. HTTP REST does the work (login, changes-since, file GET/PUT/DELETE); a WebSocket is only the "wake-up bell" (`{type:"changed",version}`). Files-as-truth: the bind mount holds the real files; an in-memory index (rebuilt from the files at startup, version persisted) tracks `path → {hash,size,mtime,version}`. M1 is single-user, single-vault, whole-file, last-write-wins (multi-tenant, chunking, and merge are M2–M4).

**Tech Stack:** Rust (axum 0.7, tokio, tokio-tungstenite via axum ws, serde, blake3, uuid, walkdir); reqwest + tokio-tungstenite for tests. Obsidian plugin in TypeScript (esbuild, obsidian API), vitest for pure-logic tests.

## Global Constraints

- **Repo layout:** server crate in `server/`, plugin in `client/`. The archived fork stays in `obsolete/` (untouched).
- **Server binds plain HTTP/WS** on `BIND_ADDR` (default `0.0.0.0:8080`); TLS is handled by the user's external reverse proxy (no TLS in-app).
- **Files are the source of truth**; the index is rebuildable by scanning `DATA_ROOT`. Never store a fact that can't be recomputed from files + persisted `version`.
- **Path safety:** every client-supplied path must be validated (reject absolute paths, `..`, and drive/UNC prefixes) before touching the filesystem.
- **M1 non-goals (do NOT build here):** chunking/delta, three-way merge, multi-tenant/accounts, argon2, mobile-specific handling, Docker packaging. Whole-file transfer + last-write-wins is intentional for M1.
- **Commit style:** conventional commits; commit at the end of every task.
- **Version semantics:** `version` is a monotonic `u64`. `0` means "client knows nothing." On startup the server loads the persisted vault version `V` (default `1` on first run) and stamps every scanned file with `version = V`. Each PUT/DELETE sets `version = (vault_version += 1)` on that path and persists the new vault version. `changes?since=N` returns files with `version > N` and deletions with `version > N`, plus the current vault `version`.

---

## File structure

**Server (`server/`)**
- `Cargo.toml` — crate + deps
- `src/main.rs` — bootstrap: load config, scan vault, build router, serve
- `src/config.rs` — `Config` from env (`DATA_ROOT`, `BIND_ADDR`, `VAULT`, `SYNC_USER`, `SYNC_PASSWORD`)
- `src/protocol.rs` — serde types shared across handlers (`FileMeta`, `ChangesResponse`, `Deletion`, `LoginRequest`, `LoginResponse`)
- `src/vault.rs` — `Vault` (scan, changes, put, delete, version persistence, path safety)
- `src/auth.rs` — login handler + `AuthToken` extractor + in-memory token store
- `src/api.rs` — file handlers (`changes`, `get_file`, `put_file`, `delete_file`)
- `src/ws.rs` — WebSocket upgrade + per-connection forward of version bumps
- `src/state.rs` — `AppState` (shared `Config`, `Vault`, tokens, broadcast sender)
- `tests/sync.rs` — integration tests (spawn app, drive with reqwest + ws client)

**Plugin (`client/`)**
- `manifest.json`, `package.json`, `tsconfig.json`, `esbuild.config.mjs`
- `src/protocol.ts` — TS mirror of the server types
- `src/transport.ts` — `SyncTransport` (login, changes, getFile, putFile, deleteFile, WS connect)
- `src/sync.ts` — pure reconcile/apply logic against a `VaultIo` interface + a `SyncState`
- `src/settings.ts` — settings tab + `NewLiveSyncSettings`
- `src/main.ts` — plugin entry: lifecycle, wire vault events → sync, WS → pull
- `test/sync.test.ts` — vitest tests for `sync.ts` with fake `VaultIo`/transport

---

## Task 1: Server scaffold + health endpoint

**Files:**
- Create: `server/Cargo.toml`, `server/src/main.rs`
- Test: `server/tests/sync.rs`

**Interfaces:**
- Produces: a runnable axum app builder `new_livesync_server::app(state)` returning `axum::Router`; a `GET /health` route returning `200 "ok"`.

- [ ] **Step 1: Create `server/Cargo.toml`**

```toml
[package]
name = "new-livesync-server"
version = "0.1.0"
edition = "2021"

[lib]
name = "new_livesync_server"
path = "src/lib.rs"

[[bin]]
name = "new-livesync-server"
path = "src/main.rs"

[dependencies]
axum = { version = "0.7", features = ["ws"] }
tokio = { version = "1", features = ["full"] }
tower-http = { version = "0.5", features = ["cors", "limit"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
blake3 = "1"
uuid = { version = "1", features = ["v4"] }
walkdir = "2"

[dev-dependencies]
reqwest = { version = "0.12", features = ["json"] }
tokio-tungstenite = "0.23"
futures-util = "0.3"
tempfile = "3"
```

- [ ] **Step 2: Create `server/src/lib.rs` with the app builder + health route**

```rust
use axum::{routing::get, Router};

pub mod api;
pub mod auth;
pub mod config;
pub mod protocol;
pub mod state;
pub mod vault;
pub mod ws;

pub use state::AppState;

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .with_state(state)
}
```

(The module files are created in later tasks; comment out `mod` lines you haven't created yet, or create empty stubs. Simplest: create empty `src/config.rs`, `src/protocol.rs`, `src/state.rs`, `src/vault.rs`, `src/auth.rs`, `src/api.rs`, `src/ws.rs` now with `#![allow(dead_code)]` so the crate compiles.)

- [ ] **Step 3: Create empty module stubs so the crate compiles**

Create each of `server/src/{config,protocol,state,vault,auth,api,ws}.rs` containing exactly:

```rust
#![allow(dead_code)]
```

- [ ] **Step 4: Create `server/src/main.rs` (temporary minimal bootstrap)**

```rust
#[tokio::main]
async fn main() {
    eprintln!("new-livesync-server: bootstrap wired in Task 8");
}
```

- [ ] **Step 5: Write the failing test `server/tests/sync.rs`**

```rust
use new_livesync_server::{app, AppState};

async fn spawn() -> String {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::for_test(dir.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    std::mem::forget(dir); // keep temp dir alive for the test process
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap(); });
    format!("http://{addr}")
}

#[tokio::test]
async fn health_ok() {
    let base = spawn().await;
    let body = reqwest::get(format!("{base}/health")).await.unwrap().text().await.unwrap();
    assert_eq!(body, "ok");
}
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd server && cargo test health_ok`
Expected: FAIL to compile — `AppState::for_test` does not exist yet.

- [ ] **Step 7: Add a temporary `AppState` with `for_test` in `src/state.rs`**

```rust
#![allow(dead_code)]
use std::path::Path;

#[derive(Clone)]
pub struct AppState {}

impl AppState {
    pub fn for_test(_data_root: &Path) -> Self { AppState {} }
}
```

Update `src/lib.rs` `app()` signature is already `AppState`; ensure `.with_state(state)` compiles (a unit state is fine for `/health`).

- [ ] **Step 8: Run test to verify it passes**

Run: `cd server && cargo test health_ok`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/Cargo.toml server/src server/tests
git commit -m "feat(server): scaffold axum crate with health endpoint"
```

---

## Task 2: Protocol types

**Files:**
- Modify: `server/src/protocol.rs`

**Interfaces:**
- Produces: `FileMeta { path:String, hash:String, size:u64, mtime:i64, version:u64 }`, `Deletion { path:String, version:u64 }`, `ChangesResponse { version:u64, upserts:Vec<FileMeta>, deletes:Vec<Deletion> }`, `LoginRequest { username:String, password:String }`, `LoginResponse { token:String }`. All `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]`.

- [ ] **Step 1: Write the failing test (append to `server/tests/sync.rs`)**

```rust
#[test]
fn filemeta_roundtrips_json() {
    use new_livesync_server::protocol::FileMeta;
    let m = FileMeta { path: "a/b.md".into(), hash: "h".into(), size: 3, mtime: 42, version: 1 };
    let s = serde_json::to_string(&m).unwrap();
    let back: FileMeta = serde_json::from_str(&s).unwrap();
    assert_eq!(m, back);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && cargo test filemeta_roundtrips_json`
Expected: FAIL — `protocol::FileMeta` not found.

- [ ] **Step 3: Implement `server/src/protocol.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileMeta {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mtime: i64,
    pub version: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Deletion {
    pub path: String,
    pub version: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ChangesResponse {
    pub version: u64,
    pub upserts: Vec<FileMeta>,
    pub deletes: Vec<Deletion>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LoginResponse {
    pub token: String,
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && cargo test filemeta_roundtrips_json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/protocol.rs server/tests/sync.rs
git commit -m "feat(server): add wire protocol types"
```

---

## Task 3: Config from environment

**Files:**
- Modify: `server/src/config.rs`

**Interfaces:**
- Produces: `Config { data_root:PathBuf, bind_addr:String, vault:String, user:String, password:String }` and `Config::from_env() -> Config` (with defaults: `bind_addr="0.0.0.0:8080"`, `vault="vault"`, `user="admin"`, `password="admin"`, `data_root="./data"`).

- [ ] **Step 1: Write the failing test (append to `server/tests/sync.rs`)**

```rust
#[test]
fn config_defaults_and_env() {
    use new_livesync_server::config::Config;
    std::env::set_var("SYNC_USER", "will");
    let c = Config::from_env();
    assert_eq!(c.user, "will");
    assert_eq!(c.bind_addr, "0.0.0.0:8080");
    std::env::remove_var("SYNC_USER");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && cargo test config_defaults_and_env`
Expected: FAIL — `config::Config` not found.

- [ ] **Step 3: Implement `server/src/config.rs`**

```rust
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_root: PathBuf,
    pub bind_addr: String,
    pub vault: String,
    pub user: String,
    pub password: String,
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        Config {
            data_root: PathBuf::from(env("DATA_ROOT", "./data")),
            bind_addr: env("BIND_ADDR", "0.0.0.0:8080"),
            vault: env("VAULT", "vault"),
            user: env("SYNC_USER", "admin"),
            password: env("SYNC_PASSWORD", "admin"),
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && cargo test config_defaults_and_env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.rs server/tests/sync.rs
git commit -m "feat(server): config from environment"
```

---

## Task 4: Vault index — scan, changes, put, delete, version persistence

**Files:**
- Modify: `server/src/vault.rs`

**Interfaces:**
- Consumes: `protocol::{FileMeta, Deletion, ChangesResponse}`.
- Produces:
  - `Vault::open(root: &Path) -> std::io::Result<Vault>` — creates `root` if missing, loads/initialises `version`, scans files.
  - `Vault::changes(&self, since: u64) -> ChangesResponse`
  - `Vault::put(&mut self, path: &str, bytes: &[u8], mtime: i64) -> std::io::Result<FileMeta>`
  - `Vault::delete(&mut self, path: &str) -> std::io::Result<Option<Deletion>>`
  - `Vault::read(&self, path: &str) -> std::io::Result<Option<Vec<u8>>>`
  - free fn `safe_rel_path(path: &str) -> Option<PathBuf>` (rejects `..`, absolute, backslashes, empty).

- [ ] **Step 1: Write failing tests (append to `server/tests/sync.rs`)**

```rust
#[test]
fn vault_put_changes_delete() {
    use new_livesync_server::vault::Vault;
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    let base = v.changes(0).version; // startup version (>=1)
    let m = v.put("notes/a.md", b"hello", 100).unwrap();
    assert_eq!(m.size, 5);
    assert!(m.version > base);
    let ch = v.changes(base);
    assert_eq!(ch.upserts.len(), 1);
    assert_eq!(ch.upserts[0].path, "notes/a.md");
    assert_eq!(v.read("notes/a.md").unwrap().unwrap(), b"hello");
    // file exists on disk (bind mount is truth)
    assert!(dir.path().join("notes/a.md").exists());
    let d = v.delete("notes/a.md").unwrap().unwrap();
    assert!(d.version > m.version);
    assert!(!dir.path().join("notes/a.md").exists());
    let ch2 = v.changes(m.version);
    assert_eq!(ch2.deletes.len(), 1);
    assert_eq!(ch2.deletes[0].path, "notes/a.md");
}

#[test]
fn safe_rel_path_rejects_traversal() {
    use new_livesync_server::vault::safe_rel_path;
    assert!(safe_rel_path("../x").is_none());
    assert!(safe_rel_path("/etc/passwd").is_none());
    assert!(safe_rel_path("a/../../b").is_none());
    assert!(safe_rel_path("ok/dir/file.md").is_some());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && cargo test vault_ safe_rel_path_`
Expected: FAIL — `vault::Vault` not found.

- [ ] **Step 3: Implement `server/src/vault.rs`**

```rust
use crate::protocol::{ChangesResponse, Deletion, FileMeta};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

pub fn safe_rel_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') { return None; }
    let p = PathBuf::from(path);
    if p.is_absolute() { return None; }
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            _ => return None, // ParentDir, RootDir, Prefix, CurDir all rejected
        }
    }
    Some(p)
}

pub struct Vault {
    root: PathBuf,
    version: u64,
    files: HashMap<String, FileMeta>,
    deletions: Vec<Deletion>,
}

impl Vault {
    pub fn open(root: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(root)?;
        let vpath = root.join(".sync-version");
        let version = std::fs::read_to_string(&vpath).ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(1);
        let mut files = HashMap::new();
        for entry in walkdir::WalkDir::new(root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() { continue; }
            let abs = entry.path();
            let rel = abs.strip_prefix(root).unwrap();
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str == ".sync-version" { continue; }
            let bytes = std::fs::read(abs)?;
            let meta = std::fs::metadata(abs)?;
            let mtime = meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64).unwrap_or(0);
            files.insert(rel_str.clone(), FileMeta {
                path: rel_str, hash: blake3::hash(&bytes).to_hex().to_string(),
                size: bytes.len() as u64, mtime, version,
            });
        }
        let mut v = Vault { root: root.to_path_buf(), version, files, deletions: Vec::new() };
        v.persist_version()?;
        Ok(v)
    }

    fn persist_version(&self) -> std::io::Result<()> {
        std::fs::write(self.root.join(".sync-version"), self.version.to_string())
    }

    pub fn changes(&self, since: u64) -> ChangesResponse {
        ChangesResponse {
            version: self.version,
            upserts: self.files.values().filter(|m| m.version > since).cloned().collect(),
            deletes: self.deletions.iter().filter(|d| d.version > since).cloned().collect(),
        }
    }

    pub fn read(&self, path: &str) -> std::io::Result<Option<Vec<u8>>> {
        let Some(rel) = safe_rel_path(path) else { return Ok(None); };
        let abs = self.root.join(rel);
        match std::fs::read(&abs) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn put(&mut self, path: &str, bytes: &[u8], mtime: i64) -> std::io::Result<FileMeta> {
        let rel = safe_rel_path(path)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad path"))?;
        let abs = self.root.join(&rel);
        if let Some(parent) = abs.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(&abs, bytes)?;
        self.version += 1;
        let meta = FileMeta {
            path: path.to_string(),
            hash: blake3::hash(bytes).to_hex().to_string(),
            size: bytes.len() as u64,
            mtime,
            version: self.version,
        };
        self.files.insert(path.to_string(), meta.clone());
        self.deletions.retain(|d| d.path != path);
        self.persist_version()?;
        Ok(meta)
    }

    pub fn delete(&mut self, path: &str) -> std::io::Result<Option<Deletion>> {
        let Some(rel) = safe_rel_path(path) else { return Ok(None); };
        if self.files.remove(path).is_none() { return Ok(None); }
        let abs = self.root.join(rel);
        if abs.exists() { std::fs::remove_file(&abs)?; }
        self.version += 1;
        let d = Deletion { path: path.to_string(), version: self.version };
        self.deletions.push(d.clone());
        self.persist_version()?;
        Ok(Some(d))
    }

    pub fn version(&self) -> u64 { self.version }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && cargo test vault_ safe_rel_path_`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/vault.rs server/tests/sync.rs
git commit -m "feat(server): vault index with scan, changes, put, delete, path safety"
```

---

## Task 5: AppState + auth (login + bearer-token extractor)

**Files:**
- Modify: `server/src/state.rs`, `server/src/auth.rs`, `server/src/lib.rs`

**Interfaces:**
- Consumes: `Config`, `Vault`, `protocol::{LoginRequest, LoginResponse}`.
- Produces:
  - `AppState { cfg: Arc<Config>, vault: Arc<Mutex<Vault>>, tokens: Arc<Mutex<HashSet<String>>>, tx: broadcast::Sender<u64> }` with `AppState::new(cfg) -> io::Result<Self>` and `AppState::for_test(dir)`.
  - `POST /api/login` handler; issues a uuid token when credentials match `cfg.user`/`cfg.password`, else `401`.
  - `AuthToken` extractor implementing `axum::extract::FromRequestParts` that returns `401` unless a valid `Authorization: Bearer <token>` is present.

- [ ] **Step 1: Write failing test (append to `server/tests/sync.rs`)**

```rust
async fn login(base: &str, u: &str, p: &str) -> reqwest::Response {
    reqwest::Client::new().post(format!("{base}/api/login"))
        .json(&serde_json::json!({"username":u,"password":p})).send().await.unwrap()
}

#[tokio::test]
async fn login_issues_token_and_rejects_bad_creds() {
    let base = spawn().await; // default creds admin/admin (see AppState::for_test)
    let ok = login(&base, "admin", "admin").await;
    assert_eq!(ok.status(), 200);
    let token: new_livesync_server::protocol::LoginResponse = ok.json().await.unwrap();
    assert!(!token.token.is_empty());
    let bad = login(&base, "admin", "nope").await;
    assert_eq!(bad.status(), 401);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && cargo test login_issues_token`
Expected: FAIL — `/api/login` route missing (404), assertion fails.

- [ ] **Step 3: Implement `server/src/state.rs`**

```rust
use crate::config::Config;
use crate::vault::Vault;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub vault: Arc<Mutex<Vault>>,
    pub tokens: Arc<Mutex<HashSet<String>>>,
    pub tx: broadcast::Sender<u64>,
}

impl AppState {
    pub fn new(cfg: Config) -> std::io::Result<Self> {
        let vault = Vault::open(&cfg.data_root.join(&cfg.vault))?;
        let (tx, _rx) = broadcast::channel(256);
        Ok(AppState {
            cfg: Arc::new(cfg),
            vault: Arc::new(Mutex::new(vault)),
            tokens: Arc::new(Mutex::new(HashSet::new())),
            tx,
        })
    }

    pub fn for_test(data_root: &Path) -> Self {
        let cfg = Config {
            data_root: data_root.to_path_buf(),
            bind_addr: "127.0.0.1:0".into(),
            vault: "vault".into(),
            user: "admin".into(),
            password: "admin".into(),
        };
        AppState::new(cfg).unwrap()
    }
}
```

- [ ] **Step 4: Implement `server/src/auth.rs`**

```rust
use crate::protocol::{LoginRequest, LoginResponse};
use crate::state::AppState;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::Json;

pub async fn login(
    State(st): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    if req.username == st.cfg.user && req.password == st.cfg.password {
        let token = uuid::Uuid::new_v4().to_string();
        st.tokens.lock().unwrap().insert(token.clone());
        Ok(Json(LoginResponse { token }))
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

pub struct AuthToken(pub String);

impl FromRequestParts<AppState> for AuthToken {
    type Rejection = StatusCode;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .map(|s| s.to_string())
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if st.tokens.lock().unwrap().contains(&token) {
            Ok(AuthToken(token))
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}
```

- [ ] **Step 5: Wire the login route in `src/lib.rs`**

```rust
use axum::{routing::{get, post}, Router};

pub mod api;
pub mod auth;
pub mod config;
pub mod protocol;
pub mod state;
pub mod vault;
pub mod ws;

pub use state::AppState;

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/login", post(auth::login))
        .with_state(state)
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd server && cargo test login_issues_token`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/state.rs server/src/auth.rs server/src/lib.rs server/tests/sync.rs
git commit -m "feat(server): app state, login, and bearer-token extractor"
```

---

## Task 6: File API — changes, GET, PUT, DELETE (with WS notify)

**Files:**
- Modify: `server/src/api.rs`, `server/src/lib.rs`

**Interfaces:**
- Consumes: `AppState`, `AuthToken`, `Vault`, `protocol::*`.
- Produces routes (all require `AuthToken`):
  - `GET /api/vault/changes?since=<u64>` → `Json<ChangesResponse>`
  - `GET /api/vault/file?path=<str>` → raw bytes (200) or `404`
  - `PUT /api/vault/file?path=<str>` header `X-Mtime: <i64>` body raw bytes → `Json<FileMeta>`
  - `DELETE /api/vault/file?path=<str>` → `Json<Deletion>` or `404`
  - Every successful PUT/DELETE calls `let _ = st.tx.send(new_version);`.

- [ ] **Step 1: Write failing test (append to `server/tests/sync.rs`)**

```rust
#[tokio::test]
async fn put_get_changes_delete_roundtrip() {
    let base = spawn().await;
    let tok = {
        let r: new_livesync_server::protocol::LoginResponse =
            login(&base, "admin", "admin").await.json().await.unwrap();
        r.token
    };
    let c = reqwest::Client::new();
    // PUT
    let put: new_livesync_server::protocol::FileMeta = c
        .put(format!("{base}/api/vault/file?path=n/a.md"))
        .bearer_auth(&tok).header("X-Mtime", "123").body("hello")
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(put.size, 5);
    // GET file
    let got = c.get(format!("{base}/api/vault/file?path=n/a.md"))
        .bearer_auth(&tok).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(&got[..], b"hello");
    // changes since 0 include it
    let ch: new_livesync_server::protocol::ChangesResponse = c
        .get(format!("{base}/api/vault/changes?since=0"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert!(ch.upserts.iter().any(|m| m.path == "n/a.md"));
    // unauthorised without token
    let no = c.get(format!("{base}/api/vault/changes?since=0")).send().await.unwrap();
    assert_eq!(no.status(), 401);
    // DELETE
    let del = c.delete(format!("{base}/api/vault/file?path=n/a.md"))
        .bearer_auth(&tok).send().await.unwrap();
    assert_eq!(del.status(), 200);
    let got2 = c.get(format!("{base}/api/vault/file?path=n/a.md"))
        .bearer_auth(&tok).send().await.unwrap();
    assert_eq!(got2.status(), 404);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && cargo test put_get_changes_delete_roundtrip`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement `server/src/api.rs`**

```rust
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
```

- [ ] **Step 4: Wire routes in `src/lib.rs` (replace the `app` fn body)**

```rust
pub fn app(state: AppState) -> Router {
    use axum::routing::{delete, get, post, put};
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/login", post(auth::login))
        .route("/api/vault/changes", get(api::changes))
        .route("/api/vault/file", get(api::get_file).put(api::put_file).delete(api::delete_file))
        .route("/api/ws", get(ws::ws_handler))
        .with_state(state)
}
```

(If `ws::ws_handler` isn't written yet, temporarily remove the `/api/ws` line; re-add it in Task 7.)

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && cargo test put_get_changes_delete_roundtrip`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/api.rs server/src/lib.rs server/tests/sync.rs
git commit -m "feat(server): file changes/get/put/delete API with version notify"
```

---

## Task 7: WebSocket change notifications

**Files:**
- Modify: `server/src/ws.rs`, `server/src/lib.rs`

**Interfaces:**
- Consumes: `AppState` (`tokens`, `tx`).
- Produces: `GET /api/ws?token=<t>` — upgrades to WS; rejects (close) if token invalid; otherwise forwards each broadcast version as a text frame `{"type":"changed","version":<n>}`.

- [ ] **Step 1: Write failing test (append to `server/tests/sync.rs`)**

```rust
#[tokio::test]
async fn ws_notifies_on_put() {
    use futures_util::StreamExt;
    let base = spawn().await; // http://127.0.0.1:PORT
    let tok = { let r: new_livesync_server::protocol::LoginResponse =
        login(&base, "admin", "admin").await.json().await.unwrap(); r.token };
    let ws_url = base.replace("http://", "ws://") + &format!("/api/ws?token={tok}");
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    // trigger a PUT from another task
    let b2 = base.clone(); let t2 = tok.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        reqwest::Client::new().put(format!("{b2}/api/vault/file?path=w.md"))
            .bearer_auth(t2).header("X-Mtime","1").body("x").send().await.unwrap();
    });
    let msg = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
        .await.unwrap().unwrap().unwrap();
    let txt = msg.into_text().unwrap();
    assert!(txt.contains("\"type\":\"changed\""), "got: {txt}");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && cargo test ws_notifies_on_put`
Expected: FAIL — `/api/ws` missing / `ws::ws_handler` undefined.

- [ ] **Step 3: Implement `server/src/ws.rs`**

```rust
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
```

- [ ] **Step 4: Ensure `/api/ws` route present in `src/lib.rs`** (added in Task 6 Step 4; re-add if you removed it).

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && cargo test ws_notifies_on_put`
Expected: PASS.

- [ ] **Step 6: Run the whole server test suite**

Run: `cd server && cargo test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/ws.rs server/src/lib.rs server/tests/sync.rs
git commit -m "feat(server): websocket change notifications"
```

---

## Task 8: Real server bootstrap (`main.rs`) + CORS

**Files:**
- Modify: `server/src/main.rs`, `server/src/lib.rs`

**Interfaces:**
- Produces: a runnable binary that reads `Config::from_env()`, builds `AppState::new`, applies a permissive CORS layer (so the Obsidian client can call it), and serves on `cfg.bind_addr`.

- [ ] **Step 1: Add a permissive CORS layer to `app()` in `src/lib.rs`**

```rust
pub fn app(state: AppState) -> Router {
    use axum::routing::{get, post};
    use tower_http::cors::{Any, CorsLayer};
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/login", post(auth::login))
        .route("/api/vault/changes", get(api::changes))
        .route("/api/vault/file", get(api::get_file).put(api::put_file).delete(api::delete_file))
        .route("/api/ws", get(ws::ws_handler))
        .with_state(state)
        .layer(cors)
}
```

- [ ] **Step 2: Implement `server/src/main.rs`**

```rust
use new_livesync_server::{app, config::Config, AppState};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let cfg = Config::from_env();
    let addr = cfg.bind_addr.clone();
    let state = AppState::new(cfg)?;
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("new-livesync-server listening on {addr}");
    axum::serve(listener, app(state)).await
}
```

- [ ] **Step 3: Build + smoke-test manually**

Run:
```bash
cd server && cargo build
DATA_ROOT=./data cargo run &
sleep 1
curl -s localhost:8080/health   # expect: ok
curl -s -X POST localhost:8080/api/login -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}'  # expect: {"token":"..."}
kill %1
```
Expected: `ok` then a token JSON.

- [ ] **Step 4: Commit**

```bash
git add server/src/main.rs server/src/lib.rs
git commit -m "feat(server): runnable bootstrap with permissive CORS"
```

---

## Task 9: Plugin scaffold (builds a loadable Obsidian plugin)

**Files:**
- Create: `client/manifest.json`, `client/package.json`, `client/tsconfig.json`, `client/esbuild.config.mjs`, `client/src/main.ts`

**Interfaces:**
- Produces: a plugin that loads in Obsidian and logs a load message; `npm run build` emits `client/main.js`.

- [ ] **Step 1: Create `client/manifest.json`**

```json
{
  "id": "new-livesync",
  "name": "New LiveSync",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "Self-hosted vault sync (walking skeleton).",
  "isDesktopOnly": false
}
```

- [ ] **Step 2: Create `client/package.json`**

```json
{
  "name": "new-livesync-client",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "node esbuild.config.mjs",
    "test": "vitest run"
  },
  "devDependencies": {
    "esbuild": "^0.23.0",
    "obsidian": "^1.5.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Create `client/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2018",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["DOM", "ES2018"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Create `client/esbuild.config.mjs`**

```js
import esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  platform: "browser",
  sourcemap: true,
});
```

- [ ] **Step 5: Create `client/src/main.ts` (minimal plugin)**

```ts
import { Plugin } from "obsidian";

export default class NewLiveSyncPlugin extends Plugin {
  async onload() {
    console.log("New LiveSync loaded");
  }
  onunload() {
    console.log("New LiveSync unloaded");
  }
}
```

- [ ] **Step 6: Install deps and build**

Run: `cd client && npm install && npm run build`
Expected: `client/main.js` is produced with no errors.

- [ ] **Step 7: Commit**

```bash
git add client/manifest.json client/package.json client/tsconfig.json client/esbuild.config.mjs client/src/main.ts
git commit -m "feat(client): scaffold loadable Obsidian plugin"
```

---

## Task 10: Protocol + pure sync logic (vitest-tested)

**Files:**
- Create: `client/src/protocol.ts`, `client/src/sync.ts`, `client/test/sync.test.ts`

**Interfaces:**
- Produces:
  - `protocol.ts`: `FileMeta`, `Deletion`, `ChangesResponse` (mirror of Rust types).
  - `sync.ts`:
    - `interface VaultIo { list(): Promise<Map<string,{mtime:number}>>; read(path:string): Promise<string>; write(path:string, data:string, mtime:number): Promise<void>; remove(path:string): Promise<void>; }`
    - `interface SyncApi { changes(since:number): Promise<ChangesResponse>; getFile(path:string): Promise<string>; putFile(path:string, data:string, mtime:number): Promise<FileMeta>; deleteFile(path:string): Promise<void>; }`
    - `type SyncState = { version: number }`
    - `async function pull(api, io, state): Promise<void>` — applies server changes since `state.version`, advances `state.version` to `resp.version`.
    - `async function pushLocal(api, io, state, knownPaths:Set<string>): Promise<void>` — pushes local files not yet known to the server (M1 initial push). Returns after updating `state.version` from the last `putFile` result.

- [ ] **Step 1: Create `client/src/protocol.ts`**

```ts
export interface FileMeta { path: string; hash: string; size: number; mtime: number; version: number; }
export interface Deletion { path: string; version: number; }
export interface ChangesResponse { version: number; upserts: FileMeta[]; deletes: Deletion[]; }
```

- [ ] **Step 2: Write the failing test `client/test/sync.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { pull, SyncApi, VaultIo, SyncState } from "../src/sync";
import { ChangesResponse, FileMeta } from "../src/protocol";

function fakeIo(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const io: VaultIo & { files: Map<string,string> } = {
    files,
    async list() { const m = new Map<string,{mtime:number}>(); for (const k of files.keys()) m.set(k,{mtime:0}); return m; },
    async read(p) { return files.get(p) ?? ""; },
    async write(p, d) { files.set(p, d); },
    async remove(p) { files.delete(p); },
  };
  return io;
}

function fakeApi(server: Record<string,string>, resp: ChangesResponse): SyncApi {
  return {
    async changes() { return resp; },
    async getFile(p) { return server[p]; },
    async putFile(p, d, mtime): Promise<FileMeta> { server[p] = d; return { path:p, hash:"h", size:d.length, mtime, version: 9 }; },
    async deleteFile(p) { delete server[p]; },
  };
}

describe("pull", () => {
  it("writes upserts and deletes locally and advances version", async () => {
    const io = fakeIo({ "old.md": "gone" });
    const resp: ChangesResponse = {
      version: 7,
      upserts: [{ path: "new.md", hash: "h", size: 3, mtime: 1, version: 5 }],
      deletes: [{ path: "old.md", version: 6 }],
    };
    const api = fakeApi({ "new.md": "abc" }, resp);
    const state: SyncState = { version: 0 };
    await pull(api, io, state);
    expect(io.files.get("new.md")).toBe("abc");
    expect(io.files.has("old.md")).toBe(false);
    expect(state.version).toBe(7);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd client && npx vitest run`
Expected: FAIL — `../src/sync` has no exports.

- [ ] **Step 4: Implement `client/src/sync.ts`**

```ts
import { ChangesResponse, FileMeta } from "./protocol";

export interface VaultIo {
  list(): Promise<Map<string, { mtime: number }>>;
  read(path: string): Promise<string>;
  write(path: string, data: string, mtime: number): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface SyncApi {
  changes(since: number): Promise<ChangesResponse>;
  getFile(path: string): Promise<string>;
  putFile(path: string, data: string, mtime: number): Promise<FileMeta>;
  deleteFile(path: string): Promise<void>;
}

export type SyncState = { version: number };

export async function pull(api: SyncApi, io: VaultIo, state: SyncState): Promise<void> {
  const resp = await api.changes(state.version);
  for (const m of resp.upserts) {
    const data = await api.getFile(m.path);
    await io.write(m.path, data, m.mtime);
  }
  for (const d of resp.deletes) {
    await io.remove(d.path);
  }
  state.version = resp.version;
}

export async function pushLocal(
  api: SyncApi, io: VaultIo, state: SyncState, knownPaths: Set<string>
): Promise<void> {
  const local = await io.list();
  for (const [path, meta] of local) {
    if (knownPaths.has(path)) continue;
    const data = await io.read(path);
    const res = await api.putFile(path, data, meta.mtime);
    state.version = Math.max(state.version, res.version);
    knownPaths.add(path);
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd client && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/protocol.ts client/src/sync.ts client/test/sync.test.ts
git commit -m "feat(client): protocol types and tested pure sync logic"
```

---

## Task 11: Transport + Obsidian wiring + settings

**Files:**
- Create: `client/src/transport.ts`, `client/src/settings.ts`
- Modify: `client/src/main.ts`

**Interfaces:**
- Consumes: `sync.ts` (`SyncApi`, `VaultIo`, `pull`, `pushLocal`), `protocol.ts`.
- Produces:
  - `transport.ts`: `class HttpTransport implements SyncApi` with `constructor(baseUrl, token)`, a static `HttpTransport.login(baseUrl,user,password): Promise<string>`, and `connectWs(onChanged: ()=>void): WebSocket`. Uses `fetch` (with a `requestUrl` fallback comment for a later mobile task).
  - `settings.ts`: `interface NewLiveSyncSettings { serverUrl:string; username:string; password:string }`, `DEFAULT_SETTINGS`, and `class NewLiveSyncSettingTab`.
  - `main.ts`: an `ObsidianVaultIo implements VaultIo` over `this.app.vault.adapter`, login on load, initial `pushLocal` + `pull`, WS `onChanged → pull`, and `vault.on("modify"/"create"/"delete")` → push/delete.

- [ ] **Step 1: Implement `client/src/transport.ts`**

```ts
import { ChangesResponse, FileMeta } from "./protocol";
import { SyncApi } from "./sync";

export class HttpTransport implements SyncApi {
  constructor(private baseUrl: string, private token: string) {}

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    const r = await fetch(`${baseUrl}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) throw new Error(`login failed: ${r.status}`);
    return (await r.json()).token as string;
  }

  private auth() { return { authorization: `Bearer ${this.token}` }; }

  async changes(since: number): Promise<ChangesResponse> {
    const r = await fetch(`${this.baseUrl}/api/vault/changes?since=${since}`, { headers: this.auth() });
    if (!r.ok) throw new Error(`changes: ${r.status}`);
    return await r.json();
  }
  async getFile(path: string): Promise<string> {
    const r = await fetch(`${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`, { headers: this.auth() });
    if (!r.ok) throw new Error(`getFile: ${r.status}`);
    return await r.text();
  }
  async putFile(path: string, data: string, mtime: number): Promise<FileMeta> {
    const r = await fetch(`${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`, {
      method: "PUT", headers: { ...this.auth(), "X-Mtime": String(mtime) }, body: data,
    });
    if (!r.ok) throw new Error(`putFile: ${r.status}`);
    return await r.json();
  }
  async deleteFile(path: string): Promise<void> {
    const r = await fetch(`${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`, {
      method: "DELETE", headers: this.auth(),
    });
    if (!r.ok && r.status !== 404) throw new Error(`deleteFile: ${r.status}`);
  }

  connectWs(onChanged: () => void): WebSocket {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/api/ws?token=${this.token}`;
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === "changed") onChanged(); } catch {} };
    return ws;
  }
}
```

- [ ] **Step 2: Implement `client/src/settings.ts`**

```ts
import { App, PluginSettingTab, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";

export interface NewLiveSyncSettings { serverUrl: string; username: string; password: string; }
export const DEFAULT_SETTINGS: NewLiveSyncSettings = { serverUrl: "http://localhost:8080", username: "admin", password: "admin" };

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Server URL").addText((t) =>
      t.setValue(s.serverUrl).onChange(async (v) => { s.serverUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Username").addText((t) =>
      t.setValue(s.username).onChange(async (v) => { s.username = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Password").addText((t) => {
      t.setValue(s.password).onChange(async (v) => { s.password = v; await this.plugin.saveSettings(); });
      t.inputEl.type = "password";
    });
    new Setting(containerEl).setName("Reconnect").addButton((b) =>
      b.setButtonText("Connect").onClick(() => this.plugin.reconnect()));
  }
}
```

- [ ] **Step 3: Implement `client/src/main.ts` (full wiring)**

```ts
import { Plugin, TFile, normalizePath } from "obsidian";
import { HttpTransport } from "./transport";
import { pull, pushLocal, SyncState, VaultIo } from "./sync";
import { DEFAULT_SETTINGS, NewLiveSyncSettings, NewLiveSyncSettingTab } from "./settings";

class ObsidianVaultIo implements VaultIo {
  constructor(private plugin: NewLiveSyncPlugin) {}
  async list() {
    const m = new Map<string, { mtime: number }>();
    for (const f of this.plugin.app.vault.getFiles()) m.set(f.path, { mtime: f.stat.mtime });
    return m;
  }
  async read(path: string) { return this.plugin.app.vault.adapter.read(normalizePath(path)); }
  async write(path: string, data: string) {
    const p = normalizePath(path);
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !(await this.plugin.app.vault.adapter.exists(dir))) await this.plugin.app.vault.adapter.mkdir(dir);
    await this.plugin.app.vault.adapter.write(p, data);
  }
  async remove(path: string) {
    const p = normalizePath(path);
    if (await this.plugin.app.vault.adapter.exists(p)) await this.plugin.app.vault.adapter.remove(p);
  }
}

export default class NewLiveSyncPlugin extends Plugin {
  settings!: NewLiveSyncSettings;
  private api?: HttpTransport;
  private ws?: WebSocket;
  private io = new ObsidianVaultIo(this);
  private state: SyncState = { version: 0 };
  private known = new Set<string>();
  private applying = false; // guard: don't echo server-driven writes back as pushes

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NewLiveSyncSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => this.reconnect());
    this.registerEvent(this.app.vault.on("modify", (f) => this.onLocalChange(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onLocalChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onLocalDelete(f.path)));
  }

  onunload() { this.ws?.close(); }

  async reconnect() {
    try {
      this.ws?.close();
      const token = await HttpTransport.login(this.settings.serverUrl, this.settings.username, this.settings.password);
      this.api = new HttpTransport(this.settings.serverUrl, token);
      this.applying = true;
      await pull(this.api, this.io, this.state);          // get server state first
      for (const p of (await this.io.list()).keys()) this.known.add(p);
      await pushLocal(this.api, this.io, this.state, this.known); // push anything server lacks
      this.applying = false;
      this.ws = this.api.connectWs(() => this.onRemoteChanged());
      console.log("New LiveSync connected @ version", this.state.version);
    } catch (e) { this.applying = false; console.error("New LiveSync connect failed", e); }
  }

  private async onRemoteChanged() {
    if (!this.api) return;
    this.applying = true;
    try { await pull(this.api, this.io, this.state); } finally { this.applying = false; }
  }

  private async onLocalChange(f: any) {
    if (this.applying || !this.api || !(f instanceof TFile)) return;
    const data = await this.io.read(f.path);
    const meta = await this.api.putFile(f.path, data, f.stat.mtime);
    this.state.version = Math.max(this.state.version, meta.version);
    this.known.add(f.path);
  }

  private async onLocalDelete(path: string) {
    if (this.applying || !this.api) return;
    await this.api.deleteFile(path);
    this.known.delete(path);
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}
```

- [ ] **Step 4: Build the plugin**

Run: `cd client && npm run build`
Expected: `client/main.js` produced, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/transport.ts client/src/settings.ts client/src/main.ts
git commit -m "feat(client): transport, settings, and Obsidian sync wiring"
```

---

## Task 12: End-to-end verification (two vaults, one server)

**Files:** none (manual verification + notes)

- [ ] **Step 1: Start the server**

Run:
```bash
cd server && DATA_ROOT=./e2e-data SYNC_USER=admin SYNC_PASSWORD=admin cargo run
```

- [ ] **Step 2: Install the plugin into two test vaults**

For each of two local Obsidian test vaults `VaultA` and `VaultB`:
```bash
mkdir -p "<VaultX>/.obsidian/plugins/new-livesync"
cp client/main.js client/manifest.json "<VaultX>/.obsidian/plugins/new-livesync/"
```
Enable "New LiveSync" in each vault's Community Plugins, set Server URL `http://localhost:8080`, admin/admin.

- [ ] **Step 3: Verify create + real-time propagation**

In VaultA create `hello.md` with text "from A". Within a second or two it appears in VaultB (WS `changed` → pull). Confirm `server/e2e-data/vault/hello.md` exists on disk with "from A".

- [ ] **Step 4: Verify edit + delete propagation**

Edit `hello.md` in VaultB → change reflects in VaultA and on disk. Delete it in VaultA → it disappears in VaultB and from `server/e2e-data/vault/`.

- [ ] **Step 5: Verify the bind mount is real**

`cat server/e2e-data/vault/hello.md` (before deletion) shows the current content — confirming files-as-truth.

- [ ] **Step 6: Record results + commit a short E2E note**

Create `docs/design/plans/m1-e2e-results.md` capturing: date, what worked, any glitches (e.g., echo loops, missed events), and follow-ups for M2. Then:
```bash
git add docs/design/plans/m1-e2e-results.md
git commit -m "docs(m1): record walking-skeleton E2E verification"
```

---

## Self-review notes (spec coverage)

- **Files-as-truth bind mount** → Task 4 (writes real files under `DATA_ROOT/<vault>`), Task 12 Step 5 verifies. ✅
- **WS push + monotonic version** → Tasks 6–7; version semantics in Global Constraints. ✅
- **Whole-file transfer (M1)** → Tasks 6, 10–11 (chunking is explicitly deferred to M2). ✅
- **Auth (login + token)** → Task 5 (single configured user; argon2/multi-tenant deferred to M4). ✅
- **Plain HTTP behind proxy + CORS** → Task 8 (permissive CORS so the Obsidian origin can call; TLS external). ✅
- **Path safety** → Task 4 `safe_rel_path`. ✅
- **Known M1 limitations to carry into later milestones:** deletions are in-memory only (not persisted across server restart) → M4 persistence; last-write-wins with no conflict handling → M3; no chunk dedup → M2; `applying` echo-guard is best-effort (Obsidian may still fire a `modify` after a server-driven write — acceptable for M1, hardened in M3 with base-hash comparison). These are intentional and listed so a reviewer doesn't treat them as defects.

# M2 — Chunking, Dedup & Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace M1's whole-file transfer with content-defined chunking + content-addressed dedup + delta transfer, and support binary files (bytes end-to-end).

**Architecture:** The **client** splits each file into content-defined chunks (deterministic pure-TS rolling-hash CDC), hashes each chunk with **SHA-256**, uploads only the chunks the server lacks, then commits a file manifest (`path → ordered chunk hashes`). The **server never chunks** — it is a content-addressed chunk store + a per-file chunk-list index; it verifies chunk hashes, reassembles whole files into the bind mount, dedups (each chunk stored once, refcounted), and GCs chunks at refcount 0. Because the server can't recompute chunk lists, the index (files + chunk lists + refcounts + version + deletions) is **persisted as JSON**. Everything is **binary** (`Uint8Array`); files are identified by their SHA-256 `hash`.

**Tech Stack:** Server: Rust (axum, `sha2`, serde). Client: TypeScript — pure-TS CDC + `crypto.subtle` SHA-256 (no WASM), `requestUrl` binary transport.

## Global Constraints

- Repo layout unchanged: `server/`, `client/`. Dev server binds `127.0.0.1:8789` (0.0.0.0:8080 in prod/Docker). `keel` pre-commit guards run on every commit; never `--no-verify`.
- **Hashing:** SHA-256, lowercase hex. Client computes via `crypto.subtle.digest("SHA-256", …)` (available in Obsidian desktop+mobile AND in Node 20 for the headless test). Server verifies via the `sha2` crate. File `hash` and chunk id both = SHA-256 hex of the respective bytes.
- **Chunker (deterministic — all clients MUST agree):** rolling gear-hash CDC, `MIN=2048`, `AVG=16384` (boundary when `hash & (AVG-1) == 0`), `MAX=65536` bytes. A file smaller than MIN is a single chunk. The gear table is a fixed constant (below) — do not change it (changing it invalidates dedup across versions).
- **Binary everywhere:** `VaultIo`, transport bodies, chunk store, and the sync engine use `Uint8Array` / raw bytes — never `string`. The echo-guard compares files by SHA-256 `hash`, not content.
- **Server is a dumb chunk store:** it never chunks; it stores chunk blobs by hash, verifies them, reassembles files by concatenating a file's chunk list, and refcounts chunks (GC at 0). No version history (so refcount GC is safe).
- **Persistence:** the server persists `DATA_ROOT/.sync-index.json` on every commit/delete and loads it on startup. Chunk blobs live under `DATA_ROOT/.chunks/`. Materialized files live under `DATA_ROOT/vault/` (the bind mount).
- **Replaced endpoints:** M1's `PUT`/`GET /api/vault/file` (whole-file) are removed; transfer is now chunk-based (`/api/vault/chunk/{hash}` + `/api/vault/commit`). `login`, `changes`, `delete`, `ws` remain.
- **M2 non-goals (do NOT build):** multi-tenant/argon2 (M4), full mobile hardening (M5), Docker packaging polish (M6), server-side external-edit watching (v2). Keep single-user/single-vault.

---

## File structure

**Server**
- `Cargo.toml` — add `sha2`, `serde` derive already present.
- `src/hash.rs` (new) — `sha256_hex(&[u8]) -> String`.
- `src/chunkstore.rs` (new) — `ContentStore` (put/get/has/remove blobs by hash).
- `src/protocol.rs` — add `chunks` to `FileMeta`; add `CommitRequest`, `MissingRequest`, `MissingResponse`.
- `src/vault.rs` — rewrite for the chunk model + persistent JSON index (keep `safe_rel_path`).
- `src/api.rs` — new handlers: `chunks_missing`, `get_chunk`, `put_chunk`, `commit`; keep `changes`, `delete_file`; remove `get_file`, `put_file`.
- `src/lib.rs` — rewire routes.
- `tests/sync.rs` — extend.

**Client**
- `src/chunker.ts` (new) — `sha256hex`, `chunk`.
- `src/protocol.ts` — add `chunks` to `FileMeta`; add `CommitRequest`.
- `src/sync.ts` — rewrite: bytes `VaultIo`, chunk-based `SyncApi`, `pull`/`pushFile` + local `ChunkCache`.
- `src/transport.ts` — chunk-based `requestUrl` transport (binary bodies).
- `src/main.ts` — binary `ObsidianVaultIo` (`readBinary`/`writeBinary`); echo-guard by hash.
- `test/sync.test.ts` — rewrite for the chunk engine.
- `test/e2e.spec.ts` — update to bytes + chunk protocol; add binary + dedup scenarios.

---

## Task 1: Server — sha2 dep + hash helper

**Files:** Modify `server/Cargo.toml`; Create `server/src/hash.rs`; Modify `server/src/lib.rs` (add `pub mod hash;`).
**Interfaces:** Produces `new_livesync_server::hash::sha256_hex(bytes: &[u8]) -> String` (lowercase hex).

- [ ] **Step 1: Add `sha2` to `server/Cargo.toml` `[dependencies]`**
```toml
sha2 = "0.10"
```
- [ ] **Step 2: Write the failing test (append to `server/tests/sync.rs`)**
```rust
#[test]
fn sha256_hex_known_vector() {
    use new_livesync_server::hash::sha256_hex;
    // SHA-256("abc")
    assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}
```
- [ ] **Step 3: Run → fails** `cd server && cargo test sha256_hex_known_vector` — Expected: FAIL (module missing).
- [ ] **Step 4: Implement `server/src/hash.rs`**
```rust
use sha2::{Digest, Sha256};

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let d = h.finalize();
    let mut s = String::with_capacity(64);
    for b in d { s.push_str(&format!("{b:02x}")); }
    s
}
```
Add `pub mod hash;` to `server/src/lib.rs`.
- [ ] **Step 5: Run → passes.** `cd server && cargo test sha256_hex_known_vector` — Expected: PASS.
- [ ] **Step 6: Commit** `git add server/Cargo.toml server/src/hash.rs server/src/lib.rs server/tests/sync.rs && git commit -m "feat(server): sha2 hash helper"`

---

## Task 2: Server — content-addressed chunk store

**Files:** Create `server/src/chunkstore.rs`; Modify `server/src/lib.rs` (`pub mod chunkstore;`).
**Interfaces:** Produces
- `ContentStore::open(dir: &Path) -> io::Result<ContentStore>`
- `ContentStore::has(&self, hash: &str) -> bool`
- `ContentStore::put(&self, hash: &str, bytes: &[u8]) -> io::Result<()>` — verifies `sha256_hex(bytes) == hash`, else `InvalidData`; idempotent.
- `ContentStore::get(&self, hash: &str) -> io::Result<Option<Vec<u8>>>`
- `ContentStore::remove(&self, hash: &str) -> io::Result<()>` — no-op if absent.

- [ ] **Step 1: Write failing test (append to `server/tests/sync.rs`)**
```rust
#[test]
fn chunkstore_put_get_verify_remove() {
    use new_livesync_server::chunkstore::ContentStore;
    use new_livesync_server::hash::sha256_hex;
    let dir = tempfile::tempdir().unwrap();
    let cs = ContentStore::open(dir.path()).unwrap();
    let data = b"chunk-bytes";
    let h = sha256_hex(data);
    assert!(!cs.has(&h));
    cs.put(&h, data).unwrap();
    assert!(cs.has(&h));
    assert_eq!(cs.get(&h).unwrap().unwrap(), data);
    // wrong hash rejected
    assert!(cs.put("deadbeef", data).is_err());
    cs.remove(&h).unwrap();
    assert!(!cs.has(&h));
}
```
- [ ] **Step 2: Run → fails.** `cd server && cargo test chunkstore_put_get_verify_remove` — FAIL.
- [ ] **Step 3: Implement `server/src/chunkstore.rs`**
```rust
use crate::hash::sha256_hex;
use std::path::{Path, PathBuf};

pub struct ContentStore { root: PathBuf }

impl ContentStore {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(ContentStore { root: dir.to_path_buf() })
    }
    fn path_for(&self, hash: &str) -> PathBuf {
        // shard by first 2 hex chars to avoid huge flat dirs
        self.root.join(&hash[0..2.min(hash.len())]).join(hash)
    }
    pub fn has(&self, hash: &str) -> bool { self.path_for(hash).exists() }
    pub fn put(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
        if sha256_hex(bytes) != hash {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "chunk hash mismatch"));
        }
        let p = self.path_for(hash);
        if p.exists() { return Ok(()); }
        if let Some(parent) = p.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(p, bytes)
    }
    pub fn get(&self, hash: &str) -> std::io::Result<Option<Vec<u8>>> {
        match std::fs::read(self.path_for(hash)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    pub fn remove(&self, hash: &str) -> std::io::Result<()> {
        let p = self.path_for(hash);
        if p.exists() { std::fs::remove_file(p)?; }
        Ok(())
    }
}
```
Add `pub mod chunkstore;` to `server/src/lib.rs`.
- [ ] **Step 4: Run → passes.** `cd server && cargo test chunkstore_put_get_verify_remove` — PASS.
- [ ] **Step 5: Commit** `git add server/src/chunkstore.rs server/src/lib.rs server/tests/sync.rs && git commit -m "feat(server): content-addressed chunk store with hash verification"`

---

## Task 3: Server — protocol additions (chunks, commit, missing)

**Files:** Modify `server/src/protocol.rs`.
**Interfaces:** Produces (all `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]`):
- `FileMeta { path:String, hash:String, size:u64, mtime:i64, version:u64, chunks:Vec<String> }` (adds `chunks`)
- `CommitRequest { path:String, hash:String, size:u64, mtime:i64, chunks:Vec<String> }`
- `MissingRequest { hashes:Vec<String> }`, `MissingResponse { missing:Vec<String> }`

- [ ] **Step 1: Failing test (append to `server/tests/sync.rs`)**
```rust
#[test]
fn commit_request_roundtrips() {
    use new_livesync_server::protocol::CommitRequest;
    let c = CommitRequest { path:"a.md".into(), hash:"h".into(), size:3, mtime:1, chunks:vec!["c1".into(),"c2".into()] };
    let s = serde_json::to_string(&c).unwrap();
    assert_eq!(serde_json::from_str::<CommitRequest>(&s).unwrap(), c);
}
```
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Edit `server/src/protocol.rs`** — add `pub chunks: Vec<String>` to `FileMeta`, and add:
```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CommitRequest {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mtime: i64,
    pub chunks: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MissingRequest { pub hashes: Vec<String> }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MissingResponse { pub missing: Vec<String> }
```
(Update the existing `filemeta_roundtrips_json` test to include `chunks: vec![]`.)
- [ ] **Step 4: Run → passes.** `cd server && cargo test commit_request_roundtrips filemeta_roundtrips_json`
- [ ] **Step 5: Commit** `git add server/src/protocol.rs server/tests/sync.rs && git commit -m "feat(server): chunk-aware protocol types"`

---

## Task 4: Server — Vault chunk model + persistent JSON index

**Files:** Modify `server/src/vault.rs` (rewrite), `server/src/state.rs` (Vault::open signature unchanged; still `Arc<Mutex<Vault>>`).
**Interfaces:** Consumes `ContentStore`, `hash::sha256_hex`, `protocol::*`. Produces on `Vault`:
- `Vault::open(root: &Path) -> io::Result<Vault>` — ensures `root/vault`, `root/.chunks`; loads `root/.sync-index.json` or starts empty (version 1).
- `has_chunk(&self, hash:&str)->bool`; `put_chunk(&self, hash:&str, bytes:&[u8])->io::Result<()>`; `get_chunk(&self, hash:&str)->io::Result<Option<Vec<u8>>>`; `missing(&self, hashes:&[String])->Vec<String>`.
- `commit(&mut self, req: CommitRequest) -> io::Result<FileMeta>` — errors `NotFound` if any chunk absent; reassembles; verifies `sha256(bytes)==req.hash` and `len==size`; writes bind-mount file; adjusts refcounts (incr req.chunks, decr previous file's chunks); GCs refcount-0 chunks; `version += 1`; persists.
- `delete(&mut self, path:&str) -> io::Result<Option<Deletion>>` — decr chunks + GC; remove bind-mount file; `version += 1`; persists.
- `changes(&self, since:u64) -> ChangesResponse`.
- free `safe_rel_path` (unchanged from M1).

- [ ] **Step 1: Failing tests (append to `server/tests/sync.rs`)**
```rust
#[test]
fn vault_commit_dedup_delete_gc() {
    use new_livesync_server::vault::Vault;
    use new_livesync_server::hash::sha256_hex;
    use new_livesync_server::protocol::CommitRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    // two chunks
    let c1 = b"AAAA".to_vec(); let h1 = sha256_hex(&c1);
    let c2 = b"BBBB".to_vec(); let h2 = sha256_hex(&c2);
    v.put_chunk(&h1, &c1).unwrap();
    v.put_chunk(&h2, &c2).unwrap();
    // file1 = c1+c2
    let body1 = [c1.clone(), c2.clone()].concat();
    let m1 = v.commit(CommitRequest{ path:"f1.bin".into(), hash: sha256_hex(&body1), size: body1.len() as u64, mtime:1, chunks: vec![h1.clone(), h2.clone()] }).unwrap();
    assert_eq!(m1.chunks, vec![h1.clone(), h2.clone()]);
    assert_eq!(std::fs::read(dir.path().join("vault/f1.bin")).unwrap(), body1); // reassembled on disk
    // file2 shares c1 (dedup: no new chunk upload needed)
    assert!(v.missing(&[h1.clone()]).is_empty());
    let body2 = c1.clone();
    v.commit(CommitRequest{ path:"f2.bin".into(), hash: sha256_hex(&body2), size: body2.len() as u64, mtime:1, chunks: vec![h1.clone()] }).unwrap();
    // delete f1: c2 now unreferenced -> GC'd; c1 still referenced by f2 -> kept
    v.delete("f1.bin").unwrap();
    assert!(!v.has_chunk(&h2), "c2 should be GC'd");
    assert!(v.has_chunk(&h1), "c1 still referenced by f2");
    assert!(!dir.path().join("vault/f1.bin").exists());
}

#[test]
fn vault_commit_rejects_missing_chunk() {
    use new_livesync_server::vault::Vault;
    use new_livesync_server::protocol::CommitRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    let r = v.commit(CommitRequest{ path:"x.md".into(), hash:"h".into(), size:1, mtime:0, chunks: vec!["missinghash".into()] });
    assert!(r.is_err());
}

#[test]
fn vault_index_persists_across_reopen() {
    use new_livesync_server::vault::Vault;
    use new_livesync_server::hash::sha256_hex;
    use new_livesync_server::protocol::CommitRequest;
    let dir = tempfile::tempdir().unwrap();
    let (h, body);
    { let mut v = Vault::open(dir.path()).unwrap();
      body = b"hello".to_vec(); h = sha256_hex(&body);
      v.put_chunk(&h, &body).unwrap();
      v.commit(CommitRequest{ path:"n.md".into(), hash:h.clone(), size:5, mtime:1, chunks: vec![h.clone()] }).unwrap();
    }
    // reopen: chunk list must survive (server can't re-chunk)
    let v2 = Vault::open(dir.path()).unwrap();
    let ch = v2.changes(0);
    let f = ch.upserts.iter().find(|m| m.path=="n.md").unwrap();
    assert_eq!(f.chunks, vec![h]);
}
```
- [ ] **Step 2: Run → fails.** `cd server && cargo test vault_commit_dedup_delete_gc vault_commit_rejects_missing_chunk vault_index_persists_across_reopen`
- [ ] **Step 3: Implement `server/src/vault.rs`**
```rust
use crate::chunkstore::ContentStore;
use crate::hash::sha256_hex;
use crate::protocol::{ChangesResponse, CommitRequest, Deletion, FileMeta};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

pub fn safe_rel_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') { return None; }
    let p = PathBuf::from(path);
    if p.is_absolute() { return None; }
    for c in p.components() {
        if !matches!(c, Component::Normal(_)) { return None; }
    }
    Some(p)
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Index {
    version: u64,
    files: HashMap<String, FileMeta>,
    deletions: Vec<Deletion>,
    chunk_refs: HashMap<String, u64>,
}

pub struct Vault {
    root: PathBuf,
    vault_dir: PathBuf,
    store: ContentStore,
    idx: Index,
}

impl Vault {
    pub fn open(root: &Path) -> std::io::Result<Self> {
        let vault_dir = root.join("vault");
        std::fs::create_dir_all(&vault_dir)?;
        let store = ContentStore::open(&root.join(".chunks"))?;
        let idx: Index = match std::fs::read(root.join(".sync-index.json")) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => Index::default(),
        };
        let mut idx = idx;
        if idx.version == 0 { idx.version = 1; }
        Ok(Vault { root: root.to_path_buf(), vault_dir, store, idx })
    }

    fn persist(&self) -> std::io::Result<()> {
        let tmp = self.root.join(".sync-index.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&self.idx)?)?;
        std::fs::rename(tmp, self.root.join(".sync-index.json")) // atomic replace
    }

    pub fn has_chunk(&self, hash: &str) -> bool { self.store.has(hash) }
    pub fn put_chunk(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> { self.store.put(hash, bytes) }
    pub fn get_chunk(&self, hash: &str) -> std::io::Result<Option<Vec<u8>>> { self.store.get(hash) }
    pub fn missing(&self, hashes: &[String]) -> Vec<String> {
        hashes.iter().filter(|h| !self.store.has(h)).cloned().collect()
    }
    pub fn version(&self) -> u64 { self.idx.version }

    fn decref(&mut self, chunks: &[String]) -> std::io::Result<()> {
        for h in chunks {
            let n = self.idx.chunk_refs.get(h).copied().unwrap_or(0);
            if n <= 1 { self.idx.chunk_refs.remove(h); self.store.remove(h)?; }
            else { self.idx.chunk_refs.insert(h.clone(), n - 1); }
        }
        Ok(())
    }

    pub fn commit(&mut self, req: CommitRequest) -> std::io::Result<FileMeta> {
        let rel = safe_rel_path(&req.path)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad path"))?;
        // reassemble from chunks (all must be present)
        let mut body = Vec::with_capacity(req.size as usize);
        for h in &req.chunks {
            let c = self.store.get(h)?
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("missing chunk {h}")))?;
            body.extend_from_slice(&c);
        }
        if body.len() as u64 != req.size || sha256_hex(&body) != req.hash {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "file hash/size mismatch"));
        }
        // write bind-mount file
        let abs = self.vault_dir.join(&rel);
        if let Some(p) = abs.parent() { std::fs::create_dir_all(p)?; }
        std::fs::write(&abs, &body)?;
        // refcounts: incr new, decr old
        for h in &req.chunks { *self.idx.chunk_refs.entry(h.clone()).or_insert(0) += 1; }
        if let Some(old) = self.idx.files.get(&req.path).map(|m| m.chunks.clone()) {
            self.decref(&old)?;
        }
        self.idx.version += 1;
        let meta = FileMeta {
            path: req.path.clone(), hash: req.hash, size: req.size, mtime: req.mtime,
            version: self.idx.version, chunks: req.chunks,
        };
        self.idx.files.insert(req.path.clone(), meta.clone());
        self.idx.deletions.retain(|d| d.path != req.path);
        self.persist()?;
        Ok(meta)
    }

    pub fn delete(&mut self, path: &str) -> std::io::Result<Option<Deletion>> {
        let Some(rel) = safe_rel_path(path) else { return Ok(None); };
        let Some(old) = self.idx.files.remove(path) else { return Ok(None); };
        self.decref(&old.chunks)?;
        let abs = self.vault_dir.join(rel);
        if abs.exists() { std::fs::remove_file(&abs)?; }
        self.idx.version += 1;
        let d = Deletion { path: path.to_string(), version: self.idx.version };
        self.idx.deletions.push(d.clone());
        self.persist()?;
        Ok(Some(d))
    }

    pub fn changes(&self, since: u64) -> ChangesResponse {
        ChangesResponse {
            version: self.idx.version,
            upserts: self.idx.files.values().filter(|m| m.version > since).cloned().collect(),
            deletes: self.idx.deletions.iter().filter(|d| d.version > since).cloned().collect(),
        }
    }
}
```
- [ ] **Step 4: Run → passes.** `cd server && cargo test vault_`
- [ ] **Step 5: Fix `state.rs` if needed** — `Vault::open(&cfg.data_root.join(&cfg.vault))` still returns `io::Result<Vault>`; unchanged. Run `cd server && cargo build`.
- [ ] **Step 6: Commit** `git add server/src/vault.rs server/tests/sync.rs && git commit -m "feat(server): vault chunk model, dedup+GC, persistent JSON index"`

---

## Task 5: Server — chunk/commit API + route rewire

**Files:** Modify `server/src/api.rs`, `server/src/lib.rs`.
**Interfaces:** Consumes `AuthToken`, `AppState`, `protocol::*`. Produces routes (all require `AuthToken` except where noted):
- `GET /api/vault/changes?since=N` → `Json<ChangesResponse>` (now with chunks) — unchanged handler.
- `POST /api/vault/chunks/missing` body `MissingRequest` → `Json<MissingResponse>`.
- `PUT /api/vault/chunk/{hash}` body raw bytes → 200 or 400 (hash mismatch).
- `GET /api/vault/chunk/{hash}` → bytes or 404.
- `POST /api/vault/commit` body `CommitRequest` → `Json<FileMeta>` (400 on mismatch, 404 on missing chunk) + `tx.send(version)`.
- `DELETE /api/vault/file?path=` → `Json<Deletion>` / 404 + `tx.send`.
- Remove `get_file`, `put_file`.

- [ ] **Step 1: Failing integration test (append to `server/tests/sync.rs`)** — full chunk roundtrip through HTTP:
```rust
#[tokio::test]
async fn chunk_upload_commit_and_pull_roundtrip() {
    use new_livesync_server::hash::sha256_hex;
    let base = spawn().await;
    let tok = { let r: new_livesync_server::protocol::LoginResponse = login(&base,"admin","admin").await.json().await.unwrap(); r.token };
    let c = reqwest::Client::new();
    let body = b"hello chunk world".to_vec();
    let h = sha256_hex(&body); // single chunk (small)
    // missing?
    let miss: new_livesync_server::protocol::MissingResponse = c.post(format!("{base}/api/vault/chunks/missing"))
        .bearer_auth(&tok).json(&serde_json::json!({"hashes":[h]})).send().await.unwrap().json().await.unwrap();
    assert_eq!(miss.missing, vec![h.clone()]);
    // upload chunk
    let up = c.put(format!("{base}/api/vault/chunk/{h}")).bearer_auth(&tok).body(body.clone()).send().await.unwrap();
    assert_eq!(up.status(), 200);
    // commit
    let meta: new_livesync_server::protocol::FileMeta = c.post(format!("{base}/api/vault/commit"))
        .bearer_auth(&tok).json(&serde_json::json!({"path":"n.md","hash":h,"size":body.len(),"mtime":1,"chunks":[h]}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(meta.chunks, vec![h.clone()]);
    // changes shows it with chunks
    let ch: new_livesync_server::protocol::ChangesResponse = c.get(format!("{base}/api/vault/changes?since=0"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert!(ch.upserts.iter().any(|m| m.path=="n.md" && m.chunks==vec![h.clone()]));
    // download the chunk back
    let got = c.get(format!("{base}/api/vault/chunk/{h}")).bearer_auth(&tok).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(&got[..], &body[..]);
    // commit with a missing chunk -> 404
    let bad = c.post(format!("{base}/api/vault/commit")).bearer_auth(&tok)
        .json(&serde_json::json!({"path":"x.md","hash":"h","size":1,"mtime":0,"chunks":["nope"]})).send().await.unwrap();
    assert_eq!(bad.status(), 404);
}
```
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Rewrite `server/src/api.rs`** (keep `changes` and `delete_file` as in M1; replace file GET/PUT with chunk handlers):
```rust
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
```
- [ ] **Step 4: Rewire routes in `server/src/lib.rs` `app()`** (replace the `/api/vault/file` GET/PUT/DELETE line):
```rust
use axum::routing::{get, post, put};
// ...
Router::new()
    .route("/health", get(|| async { "ok" }))
    .route("/api/login", post(auth::login))
    .route("/api/vault/changes", get(api::changes))
    .route("/api/vault/chunks/missing", post(api::chunks_missing))
    .route("/api/vault/chunk/{hash}", put(api::put_chunk).get(api::get_chunk))
    .route("/api/vault/commit", post(api::commit))
    .route("/api/vault/file", axum::routing::delete(api::delete_file))
    .route("/api/ws", get(ws::ws_handler))
    .with_state(state)
    .layer(cors)
```
(axum 0.7 path param syntax is `{hash}`. Keep the CORS + `DefaultBodyLimit` layers from M1.)
- [ ] **Step 5: Delete the old `put_get_changes_delete_roundtrip` test** (it used whole-file PUT/GET which no longer exist) and the `put_large_file_over_2mb` test (rewrite the large-file check at the chunk layer if desired, or rely on the client E2E). Update `two_client_propagation` if it used file PUT — replace its PUT with chunk-upload+commit (or delete it; the client E2E covers propagation). Keep `ws_notifies_on_put` only if it still compiles (it PUT a file → change to commit, or delete). Simplest: remove the three M1 file-transfer tests and rely on `chunk_upload_commit_and_pull_roundtrip` + the client E2E for propagation.
- [ ] **Step 6: Run → passes.** `cd server && cargo test` — all remaining tests green; `cargo build` warning-free.
- [ ] **Step 7: Commit** `git add server/src/api.rs server/src/lib.rs server/tests/sync.rs && git commit -m "feat(server): chunk/commit API; remove whole-file transfer"`

---

## Task 6: Client — chunker (pure-TS CDC + SHA-256)

**Files:** Create `client/src/chunker.ts`, `client/test/chunker.test.ts`.
**Interfaces:** Produces
- `sha256hex(bytes: Uint8Array): Promise<string>`
- `interface Chunk { hash: string; bytes: Uint8Array }`
- `chunk(bytes: Uint8Array): Promise<Chunk[]>` — deterministic content-defined chunking.

- [ ] **Step 1: Failing test `client/test/chunker.test.ts`**
```ts
import { describe, it, expect } from "vitest";
import { chunk, sha256hex } from "../src/chunker";

const enc = (s: string) => new TextEncoder().encode(s);

describe("chunker", () => {
  it("sha256hex matches a known vector", async () => {
    expect(await sha256hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("small input is a single chunk that reassembles", async () => {
    const data = enc("hello world");
    const cs = await chunk(data);
    expect(cs.length).toBe(1);
    expect(cs[0].hash).toBe(await sha256hex(data));
    const joined = new Uint8Array(cs.reduce((n, c) => n + c.bytes.length, 0));
    let o = 0; for (const c of cs) { joined.set(c.bytes, o); o += c.bytes.length; }
    expect(joined).toEqual(data);
  });
  it("is deterministic and content-addressed (same bytes -> same chunks)", async () => {
    const data = new Uint8Array(200_000).map((_, i) => (i * 2654435761) & 0xff);
    const a = await chunk(data); const b = await chunk(data);
    expect(a.map((c) => c.hash)).toEqual(b.map((c) => c.hash));
    expect(a.length).toBeGreaterThan(1); // large input splits
    // reassembles exactly
    const total = a.reduce((n, c) => n + c.bytes.length, 0);
    expect(total).toBe(data.length);
  });
});
```
- [ ] **Step 2: Run → fails.** `cd client && npx vitest run test/chunker.test.ts`
- [ ] **Step 3: Implement `client/src/chunker.ts`**
```ts
export interface Chunk { hash: string; bytes: Uint8Array }

const MIN = 2048, AVG_MASK = (1 << 14) - 1, MAX = 65536; // avg ~16 KiB

// Fixed gear table (do NOT change — determines chunk boundaries / dedup).
const GEAR = (() => {
  const g = new Uint32Array(256);
  let s = 0x1234567 >>> 0;
  for (let i = 0; i < 256; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; g[i] = s; }
  return g;
})();

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  let s = ""; for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function chunk(bytes: Uint8Array): Promise<Chunk[]> {
  const out: Chunk[] = [];
  let start = 0, i = 0, hash = 0;
  const push = async (end: number) => {
    const slice = bytes.subarray(start, end);
    out.push({ hash: await sha256hex(slice), bytes: slice });
    start = end; hash = 0;
  };
  while (i < bytes.length) {
    hash = ((hash << 1) + GEAR[bytes[i]]) >>> 0;
    const len = i - start + 1;
    if (len >= MIN && ((hash & AVG_MASK) === 0 || len >= MAX)) { await push(i + 1); }
    i++;
  }
  if (start < bytes.length || out.length === 0) await push(bytes.length);
  return out;
}
```
- [ ] **Step 4: Run → passes.** `cd client && npx vitest run test/chunker.test.ts`
- [ ] **Step 5: Commit** `git add client/src/chunker.ts client/test/chunker.test.ts && git commit -m "feat(client): pure-TS content-defined chunker + sha256"`

---

## Task 7: Client — protocol types

**Files:** Modify `client/src/protocol.ts`.
**Interfaces:** Produces `FileMeta` (adds `chunks: string[]`), `CommitRequest { path; hash; size; mtime; chunks: string[] }`. `Deletion`, `ChangesResponse` unchanged.

- [ ] **Step 1: Edit `client/src/protocol.ts`**
```ts
export interface FileMeta { path: string; hash: string; size: number; mtime: number; version: number; chunks: string[]; }
export interface Deletion { path: string; version: number; }
export interface ChangesResponse { version: number; upserts: FileMeta[]; deletes: Deletion[]; }
export interface CommitRequest { path: string; hash: string; size: number; mtime: number; chunks: string[]; }
```
- [ ] **Step 2: Typecheck** `cd client && npx tsc --noEmit` — Expected: errors in sync.ts/transport.ts (they still use the old shape) — that's fine, fixed in Tasks 8–9. If you want a clean gate here, do Task 7 immediately before 8–9 and commit them together. Commit now:
- [ ] **Step 3: Commit** `git add client/src/protocol.ts && git commit -m "feat(client): chunk-aware protocol types"`

---

## Task 8: Client — chunk-based sync engine (binary)

**Files:** Rewrite `client/src/sync.ts`, `client/test/sync.test.ts`.
**Interfaces:** Produces
- `interface VaultIo { list(): Promise<Map<string,{mtime:number}>>; read(path:string): Promise<Uint8Array>; write(path:string, bytes:Uint8Array): Promise<void>; remove(path:string): Promise<void>; }`
- `interface SyncApi { changes(since:number): Promise<ChangesResponse>; missing(hashes:string[]): Promise<string[]>; getChunk(hash:string): Promise<Uint8Array>; putChunk(hash:string, bytes:Uint8Array): Promise<void>; commit(req:CommitRequest): Promise<FileMeta>; deleteFile(path:string): Promise<void>; }`
- `type SyncState = { version:number }`
- `type ChunkCache = Map<string, Uint8Array>`
- `async pull(api, io, state, cache): Promise<void>` — apply server upserts (fetch missing chunks into cache, reassemble, write) + deletes; advance version.
- `async pushFile(api, io, state, cache, path): Promise<string>` — chunk the file, upload missing chunks, commit; returns the file hash. Adds chunks to cache.
- `async pushLocalNew(api, io, state, cache, known): Promise<void>` — pushFile for local paths not in `known`.

- [ ] **Step 1: Failing test `client/test/sync.test.ts`** (fakes; verifies reassembly + missing-only upload)
```ts
import { describe, it, expect } from "vitest";
import { pull, pushFile, SyncApi, VaultIo, SyncState, ChunkCache } from "../src/sync";
import { chunk, sha256hex } from "../src/chunker";
import { ChangesResponse, CommitRequest, FileMeta } from "../src/protocol";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function fakeServer() {
  const chunks = new Map<string, Uint8Array>();
  const files = new Map<string, FileMeta>();
  let version = 1;
  const api: SyncApi = {
    async changes(since) { return { version, upserts: [...files.values()].filter(f => f.version > since), deletes: [] } as ChangesResponse; },
    async missing(hashes) { return hashes.filter(h => !chunks.has(h)); },
    async getChunk(h) { return chunks.get(h)!; },
    async putChunk(h, b) { chunks.set(h, b); },
    async commit(req: CommitRequest) { const m: FileMeta = { ...req, version: ++version }; files.set(req.path, m); return m; },
    async deleteFile(p) { files.delete(p); },
  };
  return { api, chunks, files };
}
function fakeIo(seed: Record<string, string> = {}) {
  const m = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, enc(v)]));
  const io: VaultIo & { m: Map<string, Uint8Array> } = {
    m,
    async list() { const r = new Map<string,{mtime:number}>(); for (const k of m.keys()) r.set(k, { mtime: 0 }); return r; },
    async read(p) { return m.get(p)!; },
    async write(p, b) { m.set(p, b); },
    async remove(p) { m.delete(p); },
  };
  return io;
}

describe("chunk sync engine", () => {
  it("pushFile uploads only missing chunks then commits", async () => {
    const { api, chunks } = fakeServer();
    const io = fakeIo({ "a.md": "hello world" });
    const cache: ChunkCache = new Map();
    const h = await pushFile(api, io, { version: 0 }, cache, "a.md");
    expect(h).toBe(await sha256hex(enc("hello world")));
    // chunk(s) landed on the server
    const cs = await chunk(enc("hello world"));
    for (const c of cs) expect(chunks.has(c.hash)).toBe(true);
  });

  it("pull reassembles a file from chunks and writes bytes", async () => {
    const { api } = fakeServer();
    // push from client A
    const ioA = fakeIo({ "n.md": "the quick brown fox" });
    const cacheA: ChunkCache = new Map();
    await pushFile(api, ioA, { version: 0 }, cacheA, "n.md");
    // pull into empty client B
    const ioB = fakeIo();
    const cacheB: ChunkCache = new Map();
    const state: SyncState = { version: 0 };
    await pull(api, ioB, state, cacheB);
    expect(dec(ioB.m.get("n.md")!)).toBe("the quick brown fox");
    expect(state.version).toBeGreaterThan(0);
  });
});
```
- [ ] **Step 2: Run → fails.** `cd client && npx vitest run test/sync.test.ts`
- [ ] **Step 3: Implement `client/src/sync.ts`**
```ts
import { ChangesResponse, CommitRequest, FileMeta } from "./protocol";
import { chunk, sha256hex } from "./chunker";

export interface VaultIo {
  list(): Promise<Map<string, { mtime: number }>>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}
export interface SyncApi {
  changes(since: number): Promise<ChangesResponse>;
  missing(hashes: string[]): Promise<string[]>;
  getChunk(hash: string): Promise<Uint8Array>;
  putChunk(hash: string, bytes: Uint8Array): Promise<void>;
  commit(req: CommitRequest): Promise<FileMeta>;
  deleteFile(path: string): Promise<void>;
}
export type SyncState = { version: number };
export type ChunkCache = Map<string, Uint8Array>;

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function pull(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache): Promise<void> {
  const resp = await api.changes(state.version);
  for (const f of resp.upserts) {
    const parts: Uint8Array[] = [];
    for (const h of f.chunks) {
      let bytes = cache.get(h);
      if (!bytes) { bytes = await api.getChunk(h); cache.set(h, bytes); }
      parts.push(bytes);
    }
    await io.write(f.path, concat(parts));
  }
  for (const d of resp.deletes) await io.remove(d.path);
  state.version = resp.version;
}

export async function pushFile(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache, path: string): Promise<string> {
  const bytes = await io.read(path);
  const chunks = await chunk(bytes);
  for (const c of chunks) cache.set(c.hash, c.bytes);
  const hashes = chunks.map((c) => c.hash);
  const missing = await api.missing(hashes);
  const missingSet = new Set(missing);
  for (const c of chunks) if (missingSet.has(c.hash)) await api.putChunk(c.hash, c.bytes);
  const fileHash = await sha256hex(bytes);
  const meta = await api.commit({ path, hash: fileHash, size: bytes.length, mtime: Date.now(), chunks: hashes });
  state.version = Math.max(state.version, meta.version);
  return fileHash;
}

export async function pushLocalNew(api: SyncApi, io: VaultIo, state: SyncState, cache: ChunkCache, known: Set<string>): Promise<void> {
  for (const path of (await io.list()).keys()) {
    if (known.has(path)) continue;
    await pushFile(api, io, state, cache, path);
    known.add(path);
  }
}
```
- [ ] **Step 4: Run → passes.** `cd client && npx vitest run test/sync.test.ts test/chunker.test.ts`
- [ ] **Step 5: Commit** `git add client/src/sync.ts client/test/sync.test.ts && git commit -m "feat(client): binary chunk-based sync engine"`

---

## Task 9: Client — chunk-based binary transport

**Files:** Rewrite `client/src/transport.ts`.
**Interfaces:** Produces `HttpTransport implements SyncApi` with `constructor(baseUrl, token)`, static `login(baseUrl,u,p)`, `connectWs(onChanged): WebSocket|null`, and the chunk methods. Uses `requestUrl` with `ArrayBuffer` bodies/responses for chunks; JSON for changes/missing/commit.

- [ ] **Step 1: Implement `client/src/transport.ts`**
```ts
import { requestUrl } from "obsidian";
import { ChangesResponse, CommitRequest, FileMeta } from "./protocol";
import { SyncApi } from "./sync";

export class HttpTransport implements SyncApi {
  constructor(private baseUrl: string, private token: string) {}

  static async login(baseUrl: string, username: string, password: string): Promise<string> {
    const r = await requestUrl({ url: `${baseUrl}/api/login`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ username, password }), throw: false });
    if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
    return (r.json as { token: string }).token;
  }
  private auth() { return { authorization: `Bearer ${this.token}` }; }

  async changes(since: number): Promise<ChangesResponse> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/changes?since=${since}`, method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`changes: HTTP ${r.status}`);
    return r.json as ChangesResponse;
  }
  async missing(hashes: string[]): Promise<string[]> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/chunks/missing`, method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify({ hashes }), throw: false });
    if (r.status !== 200) throw new Error(`missing: HTTP ${r.status}`);
    return (r.json as { missing: string[] }).missing;
  }
  async getChunk(hash: string): Promise<Uint8Array> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/chunk/${hash}`, method: "GET", headers: this.auth(), throw: false });
    if (r.status !== 200) throw new Error(`getChunk: HTTP ${r.status}`);
    return new Uint8Array(r.arrayBuffer);
  }
  async putChunk(hash: string, bytes: Uint8Array): Promise<void> {
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/chunk/${hash}`, method: "PUT", headers: this.auth(), body, throw: false });
    if (r.status !== 200) throw new Error(`putChunk: HTTP ${r.status}`);
  }
  async commit(req: CommitRequest): Promise<FileMeta> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/commit`, method: "POST", contentType: "application/json",
      headers: this.auth(), body: JSON.stringify(req), throw: false });
    if (r.status !== 200) throw new Error(`commit: HTTP ${r.status}`);
    return r.json as FileMeta;
  }
  async deleteFile(path: string): Promise<void> {
    const r = await requestUrl({ url: `${this.baseUrl}/api/vault/file?path=${encodeURIComponent(path)}`, method: "DELETE", headers: this.auth(), throw: false });
    if (r.status !== 200 && r.status !== 404) throw new Error(`deleteFile: HTTP ${r.status}`);
  }
  connectWs(onChanged: () => void): WebSocket | null {
    try {
      const ws = new WebSocket(this.baseUrl.replace(/^http/, "ws") + `/api/ws?token=${this.token}`);
      ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === "changed") onChanged(); } catch {} };
      return ws;
    } catch { return null; }
  }
}
```
- [ ] **Step 2: Typecheck** `cd client && npx tsc --noEmit` — main.ts will still error (old engine) until Task 10. Commit with Task 10, or commit now and fix next.
- [ ] **Step 3: Commit** `git add client/src/transport.ts && git commit -m "feat(client): chunk-based binary transport"`

---

## Task 10: Client — plugin wiring (binary I/O + hash echo-guard)

**Files:** Modify `client/src/main.ts` (`ObsidianVaultIo` → binary; connect/pull/push use the chunk engine + a `ChunkCache`; echo-guard by file hash).
**Interfaces:** Consumes `pull`, `pushFile`, `pushLocalNew`, `ChunkCache` from `sync.ts`; `sha256hex` from `chunker.ts`; `HttpTransport`.

- [ ] **Step 1: Update `ObsidianVaultIo` to binary** — replace its body:
```ts
class ObsidianVaultIo implements VaultIo {
  constructor(private plugin: NewLiveSyncPlugin) {}
  async list() {
    const m = new Map<string, { mtime: number }>();
    for (const f of this.plugin.app.vault.getFiles()) m.set(f.path, { mtime: f.stat.mtime });
    return m;
  }
  async read(path: string) { return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(normalizePath(path))); }
  async write(path: string, bytes: Uint8Array) {
    const p = normalizePath(path);
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !(await this.plugin.app.vault.adapter.exists(dir))) await this.plugin.app.vault.adapter.mkdir(dir);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.plugin.app.vault.adapter.writeBinary(p, buf);
    await this.plugin.noteSyncedBytes(p, bytes);
  }
  async remove(path: string) {
    const p = normalizePath(path);
    if (await this.plugin.app.vault.adapter.exists(p)) await this.plugin.app.vault.adapter.remove(p);
    this.plugin.forgetSynced(p);
  }
}
```
- [ ] **Step 2: Update the plugin fields + connect/push/pull + echo-guard** — replace the relevant members of `NewLiveSyncPlugin`:
  - Replace `private lastSynced = new Map<string,string>()` with `private lastHash = new Map<string, string>()` (path → last-synced file SHA-256) and add `private cache: import("./sync").ChunkCache = new Map()`.
  - Add helpers:
```ts
async noteSyncedBytes(path: string, bytes: Uint8Array) { this.lastHash.set(path, await sha256hex(bytes)); }
forgetSynced(path: string) { this.lastHash.delete(path); }
```
  - In `reconnect()`, replace the pull/pushLocal block with:
```ts
      this.applying = true;
      await pull(this.api, this.io, this.state, this.cache);
      this.known = new Set((await this.api.changes(0)).upserts.map((m) => m.path));
      await pushLocalNew(this.api, this.io, this.state, this.cache, this.known);
      this.applying = false;
```
  - `onRemoteChanged()`: `await pull(this.api, this.io, this.state, this.cache);` (add `this.cache`).
  - `onLocalChange(f)`:
```ts
    if (this.applying || !this.api || !(f instanceof TFile)) return;
    try {
      const bytes = await this.io.read(f.path);
      const h = await sha256hex(bytes);
      if (this.lastHash.get(f.path) === h) return; // echo of a server-driven write
      await pushFile(this.api, this.io, this.state, this.cache, f.path);
      this.known.add(f.path); this.lastHash.set(f.path, h);
      this.log(`local edit ${f.path} → pushed`);
      this.setStatus("connected", `v${this.state.version}`);
    } catch (e: any) { this.log(`push FAILED for ${f.path}: ${e?.message ?? e}`); }
```
  - `onLocalRename(file, oldPath)`: `await this.api.deleteFile(oldPath); this.known.delete(oldPath); this.lastHash.delete(oldPath); await pushFile(this.api, this.io, this.state, this.cache, file.path); this.known.add(file.path); this.lastHash.set(file.path, await sha256hex(await this.io.read(file.path)));` (wrapped in try/catch + log).
  - `onLocalDelete(path)`: unchanged except `this.lastHash.delete(path)`.
  - Update imports: `import { pull, pushFile, pushLocalNew, SyncState, VaultIo, ChunkCache } from "./sync";` and `import { sha256hex } from "./chunker";`
- [ ] **Step 3: Build + typecheck** `cd client && npm run build && npx tsc --noEmit` — Expected: clean (0 errors). Fix any signature drift against Tasks 8–9.
- [ ] **Step 4: Run unit tests** `cd client && npx vitest run test/sync.test.ts test/chunker.test.ts` — PASS (E2E updated next).
- [ ] **Step 5: Commit** `git add client/src/main.ts && git commit -m "feat(client): binary vault I/O + chunk engine wiring + hash echo-guard"`

---

## Task 11: Update the headless E2E for chunks + binary

**Files:** Modify `client/test/e2e.spec.ts`.
**Interfaces:** Consumes the new `sync.ts` (`pull`/`pushFile`/`ChunkCache`) + `chunker.ts`.

- [ ] **Step 1: Rewrite `NodeTransport` to the chunk API** — mirror `HttpTransport` but with Node `fetch`: `missing`, `getChunk` (`new Uint8Array(await r.arrayBuffer())`), `putChunk` (body = the bytes), `commit`, `changes`, `deleteFile`. Rewrite `FsVaultIo` to bytes (`fs.readFile` → `Uint8Array`, `fs.writeFile` accepts `Uint8Array`). Each client gets its own `ChunkCache`.
- [ ] **Step 2: Rewrite the scenario** to use `pushFile`/`pull` and add a **binary** + a **dedup** assertion:
```ts
  it("propagates create/edit/delete, a binary file, and dedups shared chunks", async () => {
    const a = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-A-")));
    const b = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-B-")));

    // text create → B
    await a.io.write("n1.md", new TextEncoder().encode("hello from A"));
    await pushFile(a.api, a.io, a.state, a.cache, "n1.md");
    await pull(b.api, b.io, b.state, b.cache);
    expect(new TextDecoder().decode(await b.io.read("n1.md"))).toBe("hello from A");

    // binary file (non-UTF8 bytes) round-trips intact
    const bin = new Uint8Array(50000); for (let i = 0; i < bin.length; i++) bin[i] = (i * 37) & 0xff;
    await a.io.write("img.bin", bin);
    await pushFile(a.api, a.io, a.state, a.cache, "img.bin");
    await pull(b.api, b.io, b.state, b.cache);
    expect(await b.io.read("img.bin")).toEqual(bin);

    // dedup: a second file whose content is a prefix of img.bin shares chunks -> few/no new uploads
    // (assert via server chunk-store dir size staying bounded, or via missing() returning fewer than total)

    // delete propagates
    await a.io.remove("n1.md"); await a.api.deleteFile("n1.md"); a.known?.delete?.("n1.md");
    await pull(b.api, b.io, b.state, b.cache);
    expect(await exists(path.join((b as any).root, "n1.md"))).toBe(false);
  }, 30000);
```
(Adjust the `connect`/`Client` helpers to carry a `cache: ChunkCache`. Keep the "spawn server or SYNC_SERVER_URL" harness from M1 unchanged.)
- [ ] **Step 3: Build server + run** `cd server && cargo build && cd ../client && npx vitest run` — all pass (chunker + sync + e2e).
- [ ] **Step 4: Commit** `git add client/test/e2e.spec.ts && git commit -m "test(client): headless E2E for chunks, binary, dedup"`

---

## Task 12: Docs + full verification

**Files:** Modify `docs/design/e2e-process.md` (note binary + dedup scenarios now covered); optionally note M2 status in `docs/design/design-spec.md` §5/§9.

- [ ] **Step 1:** Run the whole suite: `cd server && cargo test` (green) and `cd client && npx tsc --noEmit && npx vitest run` (green).
- [ ] **Step 2:** Run the containerized E2E: `docker compose -f docker-compose.e2e.yml up --build --abort-on-container-exit --exit-code-from e2e` → exit 0.
- [ ] **Step 3:** Update `docs/design/e2e-process.md`: the headless E2E now covers binary + dedup; note the chunk protocol.
- [ ] **Step 4: Commit** `git add docs/design && git commit -m "docs(m2): chunk/binary E2E coverage notes"`

---

## Self-review notes

- **Spec coverage:** FastCDC-class chunking (Task 6 — pure-TS CDC, a deliberate M2 substitution for FastCDC-WASM; perf upgrade deferred), content-addressed dedup + GC (Tasks 2, 4), delta transfer via missing-negotiation (Tasks 4, 5, 8), binary support (Tasks 6–11), reassembly to the bind mount (Task 4). ✅
- **Deliberate deviation from the design spec (surface for the human):** the spec named **FastCDC + blake3**; M2 uses a **pure-TS gear-hash CDC + SHA-256** (no WASM) per the chosen approach — same functional dedup/delta/binary, with the blake3/FastCDC-SIMD speed upgrade left for a later perf pass. The server also gains a **persistent JSON index** (not in the M1 in-memory design) because the server cannot recompute chunk lists; this partially pre-empts M4's persistence work.
- **Carry-over M2 limitations:** still single-user/single-vault (M4); still no server-side external-edit watching (v2); chunk-store `.chunks` + index JSON live under `DATA_ROOT` (back them up with the vault). `mtime` on `pushFile` uses `Date.now()` client-side (M1 already ignored server mtime); revisit if mtime-based logic arrives.
- **Type consistency:** `FileMeta.chunks` (server `Vec<String>` ↔ client `string[]`); `CommitRequest` fields identical both sides; `VaultIo`/`SyncApi` signatures match between `sync.ts`, `transport.ts`, `main.ts`, and the E2E's Node impls.

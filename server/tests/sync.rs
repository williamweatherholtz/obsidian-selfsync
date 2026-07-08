use new_livesync_server::{admin_app, app, public_app, AppState};

async fn serve(router: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
    format!("http://{addr}")
}

async fn spawn() -> String {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::for_test(dir.path());
    std::mem::forget(dir); // keep temp dir alive for the test process
    serve(app(state)).await
}

// D0021: the public router must NOT carry the admin surface, and the admin router must NOT carry the
// sync surface. A route present on one but absent on the other returns 404 (unrouted) vs 401 (routed,
// needs auth) — that 404-vs-401 split is the proof, and needs no token.
#[tokio::test]
async fn admin_split_isolates_surfaces() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::for_test(dir.path());
    std::mem::forget(dir);
    let public = serve(public_app(state.clone())).await;
    let admin = serve(admin_app(state)).await;
    let c = reqwest::Client::new();
    let status = |base: String, path: &'static str| {
        let c = c.clone();
        async move { c.get(format!("{base}{path}")).send().await.unwrap().status().as_u16() }
    };
    // /health on both surfaces.
    assert_eq!(status(public.clone(), "/health").await, 200);
    assert_eq!(status(admin.clone(), "/health").await, 200);
    // Admin API: UNROUTED on public (404) vs routed-but-unauthed on admin (401).
    assert_eq!(status(public.clone(), "/api/admin/me").await, 404, "admin API must not exist on the public port");
    assert_eq!(status(admin.clone(), "/api/admin/me").await, 401, "admin API exists on the admin port (needs auth)");
    // Sync API: routed-but-unauthed on public (401) vs UNROUTED on admin (404).
    assert_eq!(status(public.clone(), "/api/vaults").await, 401, "sync API exists on the public port (needs auth)");
    assert_eq!(status(admin.clone(), "/api/vaults").await, 404, "sync API must not exist on the admin port");
}

#[tokio::test]
async fn health_ok() {
    let base = spawn().await;
    let resp = reqwest::get(format!("{base}/health")).await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    // The version handshake: /health advertises the protocol version the client checks on connect.
    assert_eq!(body["apiVersion"], new_livesync_server::protocol::API_VERSION);
}

#[test]
fn filemeta_roundtrips_json() {
    use new_livesync_server::protocol::FileMeta;
    let m = FileMeta { path: "a/b.md".into(), hash: "h".into(), size: 3, mtime: 42, version: 1, chunks: vec![] };
    let s = serde_json::to_string(&m).unwrap();
    let back: FileMeta = serde_json::from_str(&s).unwrap();
    assert_eq!(m, back);
}

#[test]
fn config_defaults_and_env() {
    use new_livesync_server::config::Config;
    // Control the environment: clear any ambient value (e.g. BIND_ADDR leaked into
    // the shell by the e2e harness) so the default assertion is deterministic.
    std::env::remove_var("BIND_ADDR");
    std::env::set_var("SYNC_USER", "will");
    let c = Config::from_env();
    std::env::remove_var("SYNC_USER");
    assert_eq!(c.user, "will");
    assert_eq!(c.bind_addr, "0.0.0.0:8080");
}

#[test]
fn safe_rel_path_rejects_traversal() {
    use new_livesync_server::vault::safe_rel_path;
    assert!(safe_rel_path("../x").is_none());
    assert!(safe_rel_path("/etc/passwd").is_none());
    assert!(safe_rel_path("a/../../b").is_none());
    assert!(safe_rel_path("ok/dir/file.md").is_some());
}

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

#[test]
fn sha256_hex_known_vector() {
    use new_livesync_server::hash::sha256_hex;
    // SHA-256("abc")
    assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

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

#[test]
fn chunkstore_rejects_malicious_hash() {
    use new_livesync_server::chunkstore::ContentStore;
    let dir = tempfile::tempdir().unwrap();
    let cs = ContentStore::open(dir.path()).unwrap();
    // path-traversal attempt and a non-hex/short hash must be safely rejected, no panic, no escape
    assert!(!cs.has("../../../../etc/passwd"));
    assert!(cs.get("../../../../etc/passwd").unwrap().is_none());
    assert!(cs.remove("../../../../etc/passwd").is_ok());
    assert!(cs.put("../../etc/passwd", b"x").is_err());
    assert!(!cs.has("€€€")); // multi-byte: must not panic
    assert!(!cs.has("abc")); // too short
}

#[test]
fn commit_request_roundtrips() {
    use new_livesync_server::protocol::CommitRequest;
    let c = CommitRequest { path:"a.md".into(), hash:"h".into(), size:3, mtime:1, chunks:vec!["c1".into(),"c2".into()], expected_version: None };
    let s = serde_json::to_string(&c).unwrap();
    assert_eq!(serde_json::from_str::<CommitRequest>(&s).unwrap(), c);
}

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
    let m1 = v.commit(CommitRequest{ path:"f1.bin".into(), hash: sha256_hex(&body1), size: body1.len() as u64, mtime:1, chunks: vec![h1.clone(), h2.clone()], expected_version: None }).unwrap();
    assert_eq!(m1.chunks, vec![h1.clone(), h2.clone()]);
    assert_eq!(std::fs::read(dir.path().join("vault/f1.bin")).unwrap(), body1); // reassembled on disk
    // file2 shares c1 (dedup: no new chunk upload needed)
    assert!(v.missing(std::slice::from_ref(&h1)).is_empty());
    let body2 = c1.clone();
    v.commit(CommitRequest{ path:"f2.bin".into(), hash: sha256_hex(&body2), size: body2.len() as u64, mtime:1, chunks: vec![h1.clone()], expected_version: None }).unwrap();
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
    let r = v.commit(CommitRequest{ path:"x.md".into(), hash:"h".into(), size:1, mtime:0, chunks: vec!["missinghash".into()], expected_version: None });
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
      v.commit(CommitRequest{ path:"n.md".into(), hash:h.clone(), size:5, mtime:1, chunks: vec![h.clone()], expected_version: None }).unwrap();
    }
    // reopen: chunk list must survive (server can't re-chunk)
    let v2 = Vault::open(dir.path()).unwrap();
    let ch = v2.changes(0);
    let f = ch.upserts.iter().find(|m| m.path=="n.md").unwrap();
    assert_eq!(f.chunks, vec![h]);
}

#[test]
fn vault_recommit_same_path_keeps_shared_chunks() {
    use new_livesync_server::vault::Vault;
    use new_livesync_server::hash::sha256_hex;
    use new_livesync_server::protocol::CommitRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    let c1 = b"AAAA".to_vec(); let h1 = sha256_hex(&c1);
    let c2 = b"BBBB".to_vec(); let h2 = sha256_hex(&c2);
    v.put_chunk(&h1, &c1).unwrap();
    v.put_chunk(&h2, &c2).unwrap();
    // v1 of p.md = [h1, h2]
    let body1 = [c1.clone(), c2.clone()].concat();
    v.commit(CommitRequest{ path:"p.md".into(), hash: sha256_hex(&body1), size: body1.len() as u64, mtime:1, chunks: vec![h1.clone(), h2.clone()], expected_version: None }).unwrap();
    // re-commit SAME path with a list that still uses h1 but drops h2: [h1]
    let body2 = c1.clone();
    v.commit(CommitRequest{ path:"p.md".into(), hash: sha256_hex(&body2), size: body2.len() as u64, mtime:2, chunks: vec![h1.clone()], expected_version: None }).unwrap();
    // h1 is still referenced by the new version -> MUST survive; h2 no longer referenced -> GC'd
    assert!(v.has_chunk(&h1), "shared chunk h1 must survive the re-commit");
    assert!(!v.has_chunk(&h2), "dropped chunk h2 should be GC'd");
    // and re-committing the identical content again keeps h1 alive (incr-before-decr on full overlap)
    v.commit(CommitRequest{ path:"p.md".into(), hash: sha256_hex(&body2), size: body2.len() as u64, mtime:3, chunks: vec![h1.clone()], expected_version: None }).unwrap();
    assert!(v.has_chunk(&h1), "h1 must survive an identical-content re-commit (incr-before-decr)");
}

#[tokio::test]
async fn chunk_upload_commit_and_pull_roundtrip() {
    use new_livesync_server::hash::sha256_hex;
    let base = spawn().await;
    let tok = { let r: new_livesync_server::protocol::LoginResponse = login(&base,"admin","admin").await.json().await.unwrap(); r.token };
    let c = reqwest::Client::new();
    let body = b"hello chunk world".to_vec();
    let h = sha256_hex(&body); // single chunk (small)
    // missing?
    let miss: new_livesync_server::protocol::MissingResponse = c.post(format!("{base}/api/v/default/chunks/missing"))
        .bearer_auth(&tok).json(&serde_json::json!({"hashes":[h]})).send().await.unwrap().json().await.unwrap();
    assert_eq!(miss.missing, vec![h.clone()]);
    // upload chunk
    let up = c.put(format!("{base}/api/v/default/chunk/{h}")).bearer_auth(&tok).body(body.clone()).send().await.unwrap();
    assert_eq!(up.status(), 200);
    // commit
    let meta: new_livesync_server::protocol::FileMeta = c.post(format!("{base}/api/v/default/commit"))
        .bearer_auth(&tok).json(&serde_json::json!({"path":"n.md","hash":h,"size":body.len(),"mtime":1,"chunks":[h]}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(meta.chunks, vec![h.clone()]);
    // changes shows it with chunks
    let ch: new_livesync_server::protocol::ChangesResponse = c.get(format!("{base}/api/v/default/changes?since=0"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert!(ch.upserts.iter().any(|m| m.path=="n.md" && m.chunks==vec![h.clone()]));
    // download the chunk back
    let got = c.get(format!("{base}/api/v/default/chunk/{h}")).bearer_auth(&tok).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(&got[..], &body[..]);
    // single-path metadata endpoint: present file -> its FileMeta; absent -> 404
    let one: new_livesync_server::protocol::FileMeta = c.get(format!("{base}/api/v/default/meta?path=n.md"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert_eq!(one.path, "n.md");
    assert_eq!(one.chunks, vec![h.clone()]);
    let miss_meta = c.get(format!("{base}/api/v/default/meta?path=absent.md")).bearer_auth(&tok).send().await.unwrap();
    assert_eq!(miss_meta.status(), 404);

    // commit with a missing chunk -> 404
    let bad = c.post(format!("{base}/api/v/default/commit")).bearer_auth(&tok)
        .json(&serde_json::json!({"path":"x.md","hash":"h","size":1,"mtime":0,"chunks":["nope"]})).send().await.unwrap();
    assert_eq!(bad.status(), 404);

    // Concurrent reads of the same vault (B4b: per-vault RwLock) must all succeed and
    // return the same data — a regression guard against deadlock/poison under the new
    // shared-read path.
    let mut reads = vec![];
    for _ in 0..12 {
        let (c, base, tok, h) = (c.clone(), base.clone(), tok.clone(), h.clone());
        reads.push(tokio::spawn(async move {
            let chg: new_livesync_server::protocol::ChangesResponse = c.get(format!("{base}/api/v/default/changes?since=0"))
                .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
            let blob = c.get(format!("{base}/api/v/default/chunk/{h}")).bearer_auth(&tok).send().await.unwrap();
            (chg.upserts.len(), blob.status().as_u16())
        }));
    }
    for r in reads {
        let (upserts, blob_status) = r.await.unwrap();
        assert!(upserts >= 1);
        assert_eq!(blob_status, 200);
    }
}

#[test]
fn vault_open_locks_on_corrupt_index_not_blank_reset() {
    use new_livesync_server::vault::Vault;
    let dir = tempfile::tempdir().unwrap();
    // a genuinely-absent index starts fresh (first run), not corrupt
    {
        let fresh = Vault::open(dir.path()).unwrap();
        assert!(!fresh.is_corrupt());
    } // drop the handle (closes the SQLite DB) before corrupting the file on disk
    // D0022: a present-but-corrupt index DB is never silently blanked (WAL sidecars dropped, main DB
    // clobbered), and with NO recoverable data it AUTO-REPAIRS to a clean (empty) index on open —
    // it does not crash the open, and it does not leave stale bytes. (A corrupt DB WITH files on disk
    // auto-repairs by rebuilding from them; a file lost from both disk and store stays ERROR — both
    // covered by the vault unit tests.)
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.path().join(format!(".sync-index.db{suffix}")));
    }
    std::fs::write(dir.path().join(".sync-index.db"), b"{ this is not a sqlite database").unwrap();
    let v = Vault::open(dir.path()).unwrap();
    assert!(!v.is_corrupt(), "corrupt DB with no recoverable data auto-repairs to a clean empty index");
    assert!(std::path::Path::new(&dir.path().join(".sync-index.db.corrupt")).exists(), "the bad DB was quarantined");
}

#[test]
fn userstore_register_verify_persist() {
    use new_livesync_server::users::{UserStore, safe_name};
    assert!(safe_name("will"));
    assert!(!safe_name("../etc"));
    assert!(!safe_name("bad name"));
    assert!(!safe_name(""));
    assert!(!safe_name(".."));
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join(".users.json");
    {
        let mut us = UserStore::open(&p).unwrap();
        assert!(us.is_empty());
        us.register("will", "s3cret").unwrap();
        assert!(us.verify("will", "s3cret"));
        assert!(!us.verify("will", "wrong"));
        assert!(us.register("will", "again").is_err()); // duplicate
        assert!(us.register("../x", "p").is_err());      // unsafe name
    }
    // persisted across reopen
    let us2 = UserStore::open(&p).unwrap();
    assert!(us2.verify("will", "s3cret"));
    assert!(!us2.is_empty());
}

#[tokio::test]
async fn vaults_are_isolated_and_listable() {
    use new_livesync_server::hash::sha256_hex;
    let base = spawn().await; // admin/admin seeded, with a `default` vault
    let tok = { let r: new_livesync_server::protocol::LoginResponse =
        login(&base, "admin", "admin").await.json().await.unwrap(); r.token };
    let c = reqwest::Client::new();
    // create a second vault
    let mk = c.post(format!("{base}/api/vaults")).bearer_auth(&tok)
        .json(&serde_json::json!({"name":"work"})).send().await.unwrap();
    assert_eq!(mk.status(), 200);
    // list shows both
    let list: new_livesync_server::protocol::VaultListResponse = c.get(format!("{base}/api/vaults"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert!(list.vaults.contains(&"default".to_string()));
    assert!(list.vaults.contains(&"work".to_string()));
    // put a file in `work`
    let body = b"work-only".to_vec(); let h = sha256_hex(&body);
    c.put(format!("{base}/api/v/work/chunk/{h}")).bearer_auth(&tok).body(body.clone()).send().await.unwrap();
    c.post(format!("{base}/api/v/work/commit")).bearer_auth(&tok)
        .json(&serde_json::json!({"path":"w.md","hash":h,"size":body.len(),"mtime":1,"chunks":[h]})).send().await.unwrap();
    // it appears in `work` but NOT in `default` (isolation)
    let inwork: new_livesync_server::protocol::ChangesResponse = c.get(format!("{base}/api/v/work/changes?since=0"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert!(inwork.upserts.iter().any(|m| m.path=="w.md"));
    let indefault: new_livesync_server::protocol::ChangesResponse = c.get(format!("{base}/api/v/default/changes?since=0"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert!(!indefault.upserts.iter().any(|m| m.path=="w.md"));
}

#[tokio::test]
async fn vault_with_orphaned_files_auto_reindexes_on_first_access() {
    use new_livesync_server::protocol::{StatusResponse, ChangesResponse};
    // D0022: a vault "broken" (NOT the bootstrap "default", so it isn't opened until first request)
    // with a materialized file but NO index (a restore, or the SQLite format change) AUTO-REPAIRS on
    // first access — status is ready and changes advertises the file, with no manual reindex.
    let dir = tempfile::tempdir().unwrap();
    let vroot = dir.path().join("admin").join("broken");
    std::fs::create_dir_all(vroot.join("vault")).unwrap();
    std::fs::write(vroot.join("vault").join("seed.md"), b"survivor").unwrap();

    let state = AppState::for_test(dir.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    std::mem::forget(dir);
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap(); });
    let base = format!("http://{addr}");

    let tok = { let r: new_livesync_server::protocol::LoginResponse =
        login(&base, "admin", "admin").await.json().await.unwrap(); r.token };
    let c = reqwest::Client::new();

    // First access auto-repairs → status is READY (not error), no manual reindex needed.
    let st: StatusResponse = c.get(format!("{base}/api/v/broken/status"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert_eq!(st.status, "ready", "orphaned-files vault auto-reindexes on open");

    // changes serves normally and advertises the materialized file.
    let ch: ChangesResponse = c.get(format!("{base}/api/v/broken/changes?since=0"))
        .bearer_auth(&tok).send().await.unwrap().json().await.unwrap();
    assert!(ch.upserts.iter().any(|m| m.path == "seed.md"));
}

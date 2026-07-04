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
    let resp = reqwest::get(format!("{base}/health")).await.unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert_eq!(body, "ok");
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
    let c = CommitRequest { path:"a.md".into(), hash:"h".into(), size:3, mtime:1, chunks:vec!["c1".into(),"c2".into()] };
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
    v.commit(CommitRequest{ path:"p.md".into(), hash: sha256_hex(&body1), size: body1.len() as u64, mtime:1, chunks: vec![h1.clone(), h2.clone()] }).unwrap();
    // re-commit SAME path with a list that still uses h1 but drops h2: [h1]
    let body2 = c1.clone();
    v.commit(CommitRequest{ path:"p.md".into(), hash: sha256_hex(&body2), size: body2.len() as u64, mtime:2, chunks: vec![h1.clone()] }).unwrap();
    // h1 is still referenced by the new version -> MUST survive; h2 no longer referenced -> GC'd
    assert!(v.has_chunk(&h1), "shared chunk h1 must survive the re-commit");
    assert!(!v.has_chunk(&h2), "dropped chunk h2 should be GC'd");
    // and re-committing the identical content again keeps h1 alive (incr-before-decr on full overlap)
    v.commit(CommitRequest{ path:"p.md".into(), hash: sha256_hex(&body2), size: body2.len() as u64, mtime:3, chunks: vec![h1.clone()] }).unwrap();
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

#[test]
fn vault_open_fails_loud_on_corrupt_index() {
    use new_livesync_server::vault::Vault;
    let dir = tempfile::tempdir().unwrap();
    // a genuinely-absent index starts fresh (first run)
    assert!(Vault::open(dir.path()).is_ok());
    // a present-but-corrupt index must NOT silently reset (would hide all files)
    std::fs::write(dir.path().join(".sync-index.json"), b"{ this is not json").unwrap();
    match Vault::open(dir.path()) {
        Err(e) => assert_eq!(e.kind(), std::io::ErrorKind::InvalidData),
        Ok(_) => panic!("expected corrupt index to fail loud, got Ok"),
    }
}

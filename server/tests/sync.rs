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
    let m = FileMeta { path: "a/b.md".into(), hash: "h".into(), size: 3, mtime: 42, version: 1 };
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

#[tokio::test]
async fn put_large_file_over_2mb() {
    let base = spawn().await;
    let tok = {
        let r: new_livesync_server::protocol::LoginResponse =
            login(&base, "admin", "admin").await.json().await.unwrap();
        r.token
    };
    let c = reqwest::Client::new();
    let size = 3 * 1024 * 1024;
    let body = vec![b'x'; size];
    let put: new_livesync_server::protocol::FileMeta = c
        .put(format!("{base}/api/vault/file?path=big.bin"))
        .bearer_auth(&tok).header("X-Mtime", "123").body(body.clone())
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(put.size, size as u64);
    let got = c.get(format!("{base}/api/vault/file?path=big.bin"))
        .bearer_auth(&tok).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(got.len(), size);
}

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

#[tokio::test]
async fn two_client_propagation() {
    use futures_util::StreamExt;
    let base = spawn().await;
    // Two logins with the same creds represent two devices/clients, A and B.
    let tok_a = { let r: new_livesync_server::protocol::LoginResponse =
        login(&base, "admin", "admin").await.json().await.unwrap(); r.token };
    let tok_b = { let r: new_livesync_server::protocol::LoginResponse =
        login(&base, "admin", "admin").await.json().await.unwrap(); r.token };

    // Client A opens a WebSocket to observe server-pushed changes.
    let ws_url = base.replace("http://", "ws://") + &format!("/api/ws?token={tok_a}");
    let (mut ws_a, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();

    let c = reqwest::Client::new();

    // Client B PUTs a new file.
    let put_resp = c.put(format!("{base}/api/vault/file?path=shared/note.md"))
        .bearer_auth(&tok_b).header("X-Mtime", "1000").body("from B")
        .send().await.unwrap();
    assert_eq!(put_resp.status(), 200);
    let put_meta: new_livesync_server::protocol::FileMeta = put_resp.json().await.unwrap();

    // Client A's WS must receive a "changed" notification within 2s.
    let msg = tokio::time::timeout(std::time::Duration::from_secs(2), ws_a.next())
        .await.expect("timed out waiting for WS notification after B's PUT")
        .unwrap().unwrap();
    let txt = msg.into_text().unwrap();
    assert!(txt.contains("\"type\":\"changed\""), "got: {txt}");

    // Client A pulls changes and reads the file B wrote — proving real propagation
    // through the server, not just a notification.
    let ch: new_livesync_server::protocol::ChangesResponse = c
        .get(format!("{base}/api/vault/changes?since=0"))
        .bearer_auth(&tok_a).send().await.unwrap().json().await.unwrap();
    assert!(ch.upserts.iter().any(|m| m.path == "shared/note.md"),
        "A's changes should list B's new file: {ch:?}");

    let got = c.get(format!("{base}/api/vault/file?path=shared/note.md"))
        .bearer_auth(&tok_a).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(&got[..], b"from B");

    // Client B deletes the file.
    let del_resp = c.delete(format!("{base}/api/vault/file?path=shared/note.md"))
        .bearer_auth(&tok_b).send().await.unwrap();
    assert_eq!(del_resp.status(), 200);

    // Client A's WS must also observe the delete notification.
    let msg2 = tokio::time::timeout(std::time::Duration::from_secs(2), ws_a.next())
        .await.expect("timed out waiting for WS notification after B's DELETE")
        .unwrap().unwrap();
    let txt2 = msg2.into_text().unwrap();
    assert!(txt2.contains("\"type\":\"changed\""), "got: {txt2}");

    // Client A pulls changes since the file's put version and sees the delete.
    let ch2: new_livesync_server::protocol::ChangesResponse = c
        .get(format!("{base}/api/vault/changes?since={}", put_meta.version))
        .bearer_auth(&tok_a).send().await.unwrap().json().await.unwrap();
    assert!(ch2.deletes.iter().any(|d| d.path == "shared/note.md"),
        "A's changes should list B's delete: {ch2:?}");
    assert!(!ch2.upserts.iter().any(|m| m.path == "shared/note.md"));

    // And a direct GET now 404s for client A.
    let got2 = c.get(format!("{base}/api/vault/file?path=shared/note.md"))
        .bearer_auth(&tok_a).send().await.unwrap();
    assert_eq!(got2.status(), 404);
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

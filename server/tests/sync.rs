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

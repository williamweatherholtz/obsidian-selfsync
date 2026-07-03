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
    assert_eq!(c.user, "will");
    assert_eq!(c.bind_addr, "0.0.0.0:8080");
    std::env::remove_var("SYNC_USER");
}

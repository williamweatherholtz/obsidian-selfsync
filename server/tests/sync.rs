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

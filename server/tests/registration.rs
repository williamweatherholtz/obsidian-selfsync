// HTTP tests for the registration policy + single-use invite tokens (Phase 1, slice 3).
use new_livesync_server::{app, registration::Mode, AppState};
use tempfile::tempdir;

async fn spawn() -> (String, AppState) {
    let dir = tempdir().unwrap();
    let root = Box::leak(Box::new(dir)).path().to_path_buf();
    let state = AppState::for_test(&root); // for_test seeds registration = Open
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app_state = state.clone();
    tokio::spawn(async move { axum::serve(listener, app(app_state)).await.unwrap(); });
    (format!("http://{addr}"), state)
}

async fn register(base: &str, user: &str, invite: &str) -> u16 {
    reqwest::Client::new()
        .post(format!("{base}/api/register"))
        .json(&serde_json::json!({ "username": user, "password": "regpw1234", "invite": invite }))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn open_mode_allows_tokenless_registration() {
    let (base, _st) = spawn().await; // Open by default
    assert_eq!(register(&base, "newbie", "").await, 200);
}

#[tokio::test]
async fn closed_mode_requires_a_valid_single_use_token() {
    let (base, st) = spawn().await;
    st.registration.lock().unwrap().set_mode(Mode::Closed).unwrap();

    // no token -> forbidden
    assert_eq!(register(&base, "alice", "").await, 403);

    // issue a token, register with it -> ok
    let token = st.registration.lock().unwrap().issue("for alice", None).unwrap();
    assert_eq!(register(&base, "alice", &token).await, 200);

    // the token is single-use: a second registration with it is rejected
    assert_eq!(register(&base, "bob", &token).await, 403);
}

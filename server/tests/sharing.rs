// HTTP-level authorization tests for vault sharing (Phase 1, slice 2). Spawns the real
// app and drives it with reqwest: a grantee can reach a shared vault via the owner-
// qualified routes per their permission; a non-grantee cannot; the owner always can.
use new_livesync_server::{app, shares::Perm, AppState};
use tempfile::tempdir;

async fn spawn() -> (String, AppState) {
    let dir = tempdir().unwrap();
    // leak the tempdir so the data root outlives the test server
    let root = Box::leak(Box::new(dir)).path().to_path_buf();
    let state = AppState::for_test(&root);
    {
        let mut u = state.users.lock().unwrap();
        u.register("alice", "pw").unwrap();
        u.register("bob", "pw").unwrap();
        u.register("carol", "pw").unwrap();
    }
    state.vault("alice", "notes").unwrap(); // owner creates the vault namespace
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app_state = state.clone();
    tokio::spawn(async move { axum::serve(listener, app(app_state)).await.unwrap(); });
    (format!("http://{addr}"), state)
}

async fn login(base: &str, user: &str) -> String {
    let c = reqwest::Client::new();
    let r = c
        .post(format!("{base}/api/login"))
        .json(&serde_json::json!({ "username": user, "password": "pw" }))
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success(), "login {user} failed: {}", r.status());
    r.json::<serde_json::Value>().await.unwrap()["token"].as_str().unwrap().to_string()
}

async fn get_status(base: &str, path: &str, token: &str) -> u16 {
    reqwest::Client::new()
        .get(format!("{base}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

async fn put_chunk_status(base: &str, path: &str, token: &str) -> u16 {
    reqwest::Client::new()
        .put(format!("{base}{path}"))
        .bearer_auth(token)
        .body(vec![1u8, 2, 3])
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn owner_reaches_own_vault_via_legacy_route() {
    let (base, _st) = spawn().await;
    let tok = login(&base, "alice").await;
    assert_eq!(get_status(&base, "/api/v/notes/changes?since=0", &tok).await, 200);
}

#[tokio::test]
async fn non_grantee_is_forbidden_on_shared_route() {
    let (base, _st) = spawn().await;
    let tok = login(&base, "carol").await;
    // carol has no grant on alice/notes
    assert_eq!(get_status(&base, "/api/u/alice/notes/changes?since=0", &tok).await, 403);
}

#[tokio::test]
async fn read_grant_allows_read_but_not_write() {
    let (base, st) = spawn().await;
    st.shares.lock().unwrap().grant("alice", "notes", "bob", Perm::Read).unwrap();
    let tok = login(&base, "bob").await;
    // read: allowed
    assert_eq!(get_status(&base, "/api/u/alice/notes/changes?since=0", &tok).await, 200);
    // write: forbidden (read-only) — 403 regardless of chunk validity (authz runs first)
    assert_eq!(put_chunk_status(&base, "/api/u/alice/notes/chunk/deadbeef", &tok).await, 403);
}

#[tokio::test]
async fn readwrite_grant_allows_write_and_revoke_denies() {
    let (base, st) = spawn().await;
    st.shares.lock().unwrap().grant("alice", "notes", "bob", Perm::ReadWrite).unwrap();
    let tok = login(&base, "bob").await;
    // write authorized: NOT 403 (may be 200/400 depending on chunk validity — the point is
    // the authorization layer let it through)
    assert_ne!(put_chunk_status(&base, "/api/u/alice/notes/chunk/deadbeef", &tok).await, 403);
    // revoke takes effect immediately
    st.shares.lock().unwrap().revoke("alice", "notes", "bob").unwrap();
    assert_eq!(get_status(&base, "/api/u/alice/notes/changes?since=0", &tok).await, 403);
}

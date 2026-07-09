// HTTP tests for the /api/admin/* management API (Phase 1, slice 4).
use new_livesync_server::{app, public_app, AppState};
use serde_json::{json, Value};
use tempfile::tempdir;

async fn spawn() -> String {
    let dir = tempdir().unwrap();
    let root = Box::leak(Box::new(dir)).path().to_path_buf();
    let state = AppState::for_test(&root); // bootstrap admin = "admin"; has a "default" vault
    state.users.lock().unwrap().register("bob", "pw").unwrap(); // a non-admin account
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap(); });
    format!("http://{addr}")
}

// Same fixture, but bound to the PUBLIC-only router (the default-split public port).
async fn spawn_public() -> String {
    let dir = tempdir().unwrap();
    let root = Box::leak(Box::new(dir)).path().to_path_buf();
    let state = AppState::for_test(&root);
    state.users.lock().unwrap().register("bob", "pw").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, public_app(state)).await.unwrap(); });
    format!("http://{addr}")
}

async fn login(base: &str, user: &str) -> String {
    // the bootstrap admin account (SYNC_USER) has password "admin"; test accounts use "pw"
    let password = if user == "admin" { "admin" } else { "pw" };
    let r = reqwest::Client::new()
        .post(format!("{base}/api/login"))
        .json(&json!({ "username": user, "password": password }))
        .send().await.unwrap();
    r.json::<Value>().await.unwrap()["token"].as_str().unwrap().to_string()
}
async fn get(base: &str, path: &str, token: &str) -> (u16, Value) {
    let r = reqwest::Client::new().get(format!("{base}{path}")).bearer_auth(token).send().await.unwrap();
    let s = r.status().as_u16();
    let v = r.json::<Value>().await.unwrap_or(Value::Null);
    (s, v)
}
async fn send(base: &str, method: &str, path: &str, token: &str, body: Value) -> u16 {
    let c = reqwest::Client::new();
    let rb = match method {
        "POST" => c.post(format!("{base}{path}")),
        "PUT" => c.put(format!("{base}{path}")),
        "DELETE" => c.delete(format!("{base}{path}")),
        _ => unreachable!(),
    };
    let rb = if body.is_null() { rb } else { rb.json(&body) };
    rb.bearer_auth(token).send().await.unwrap().status().as_u16()
}

#[tokio::test]
async fn admin_ui_page_is_served() {
    let base = spawn().await;
    let r = reqwest::Client::new().get(format!("{base}/admin")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let body = r.text().await.unwrap();
    assert!(body.contains("SelfSync") && body.contains("/api/admin/"), "admin page shell missing");
}

#[tokio::test]
async fn me_reports_server_admin() {
    let base = spawn().await;
    let (_s, admin) = get(&base, "/api/admin/me", &login(&base, "admin").await).await;
    assert_eq!(admin["is_server_admin"], json!(true));
    let (_s, bob) = get(&base, "/api/admin/me", &login(&base, "bob").await).await;
    assert_eq!(bob["is_server_admin"], json!(false));
}

#[tokio::test]
async fn non_admin_cannot_manage_server() {
    let base = spawn().await;
    let bob = login(&base, "bob").await;
    assert_eq!(get(&base, "/api/admin/users", &bob).await.0, 403);
    assert_eq!(send(&base, "PUT", "/api/admin/registration", &bob, json!({"mode":"open"})).await, 403);
}

#[tokio::test]
async fn admin_creates_and_lists_users() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    assert_eq!(send(&base, "POST", "/api/admin/users", &admin, json!({"username":"charlie","password":"pw"})).await, 200);
    let (_s, users) = get(&base, "/api/admin/users", &admin).await;
    // users_list now returns objects {username, is_admin, is_bootstrap} (D0021).
    let charlie = users.as_array().unwrap().iter().find(|u| u["username"] == "charlie").unwrap();
    assert_eq!(charlie["is_admin"], serde_json::json!(false)); // a freshly-created account is not admin
    let admin_row = users.as_array().unwrap().iter().find(|u| u["username"] == "admin").unwrap();
    assert_eq!(admin_row["is_admin"], serde_json::json!(true)); // the bootstrap account is admin
    assert_eq!(admin_row["is_bootstrap"], serde_json::json!(true));
}

#[tokio::test]
async fn owner_grants_and_revokes_a_share() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    // grant admin's "default" vault to bob (read)
    assert_eq!(send(&base, "POST", "/api/admin/shares", &admin, json!({"vault":"default","grantee":"bob","perm":"read"})).await, 200);
    let (_s, vaults) = get(&base, "/api/admin/vaults", &admin).await;
    let def = vaults.as_array().unwrap().iter().find(|v| v["vault"] == "default").unwrap();
    assert_eq!(def["grants"][0]["grantee"], json!("bob"));
    assert_eq!(def["grants"][0]["perm"], json!("read"));
    // revoke
    assert_eq!(send(&base, "DELETE", "/api/admin/shares", &admin, json!({"vault":"default","grantee":"bob"})).await, 200);
    let (_s, vaults) = get(&base, "/api/admin/vaults", &admin).await;
    let def = vaults.as_array().unwrap().iter().find(|v| v["vault"] == "default").unwrap();
    assert_eq!(def["grants"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn admin_sets_registration_and_issues_working_invite() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    assert_eq!(send(&base, "PUT", "/api/admin/registration", &admin, json!({"mode":"closed"})).await, 200);
    assert_eq!(get(&base, "/api/admin/registration", &admin).await.1["mode"], json!("closed"));
    // issue an invite and use it to register (closed mode)
    let (_s, inv) = {
        let r = reqwest::Client::new().post(format!("{base}/api/admin/invites")).bearer_auth(&admin).json(&json!({"label":"for dave"})).send().await.unwrap();
        (r.status().as_u16(), r.json::<Value>().await.unwrap())
    };
    let token = inv["token"].as_str().unwrap();
    let reg = reqwest::Client::new().post(format!("{base}/api/register")).json(&json!({"username":"dave","password":"pw","invite":token})).send().await.unwrap();
    assert_eq!(reg.status().as_u16(), 200);
}

#[tokio::test]
async fn password_change_revokes_all_other_sessions_and_reissues(/* R14 sec#2 */) {
    let base = spawn().await;
    let t1 = login(&base, "bob").await; // session 1 (the one we'll change from)
    let t2 = login(&base, "bob").await; // session 2 (a "leaked"/other device)
    // Both tokens work against an authed owner-scoped endpoint.
    assert_eq!(get(&base, "/api/admin/me", &t1).await.0, 200);
    assert_eq!(get(&base, "/api/admin/me", &t2).await.0, 200);
    // Wrong current password is rejected.
    assert_eq!(send(&base, "POST", "/api/password", &t1, json!({"current":"wrong","new_password":"pw2"})).await, 401);
    // Correct change returns a fresh token and revokes ALL prior sessions.
    let r = reqwest::Client::new().post(format!("{base}/api/password")).bearer_auth(&t1)
        .json(&json!({"current":"pw","new_password":"pw2"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let t3 = r.json::<Value>().await.unwrap()["token"].as_str().unwrap().to_string();
    assert_eq!(get(&base, "/api/admin/me", &t1).await.0, 401, "old session 1 revoked");
    assert_eq!(get(&base, "/api/admin/me", &t2).await.0, 401, "old session 2 revoked");
    assert_eq!(get(&base, "/api/admin/me", &t3).await.0, 200, "the re-issued token works");
    // The new password logs in; the old one no longer does.
    assert_eq!(reqwest::Client::new().post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw2"})).send().await.unwrap().status().as_u16(), 200);
    assert_eq!(reqwest::Client::new().post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw"})).send().await.unwrap().status().as_u16(), 401);
}

#[tokio::test]
async fn bootstrap_admin_password_change_is_refused(/* R15 sec#1 */) {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    // The bootstrap SYNC_USER's password is re-applied from SYNC_PASSWORD on every boot, so a
    // self-service change would silently revert on restart — a false remediation. It's refused.
    assert_eq!(send(&base, "POST", "/api/password", &admin, json!({"current":"admin","new_password":"newpw"})).await, 400);
    // …and the original password still works (nothing was changed).
    assert_eq!(reqwest::Client::new().post(format!("{base}/api/login")).json(&json!({"username":"admin","password":"admin"})).send().await.unwrap().status().as_u16(), 200);
}

#[tokio::test]
async fn share_create_does_not_reveal_grantee_existence(/* R15 sec#2 */) {
    let base = spawn().await;
    let admin = login(&base, "admin").await; // owns "default"; "bob" exists, "ghost-user" does not
    // Sharing to a NON-EXISTENT account returns the SAME 200 as sharing to a real one — no
    // username-enumeration oracle on the public surface; the grant is dormant until the name registers.
    assert_eq!(send(&base, "POST", "/api/admin/shares", &admin, json!({"vault":"default","grantee":"ghost-user","perm":"read"})).await, 200);
    assert_eq!(send(&base, "POST", "/api/admin/shares", &admin, json!({"vault":"default","grantee":"bob","perm":"read"})).await, 200);
}

#[tokio::test]
async fn owner_share_endpoints_reachable_on_public_surface_but_not_account_admin(/* R14 sec#4 */) {
    let base = spawn_public().await;
    let bob = login(&base, "bob").await;
    // Owner-scoped share management IS reachable on the public port (was admin-router-only → 404).
    assert_eq!(get(&base, "/api/admin/vaults", &bob).await.0, 200);
    assert_eq!(get(&base, "/api/admin/me", &bob).await.0, 200);
    // Account-admin endpoints stay OFF the public surface (404, not exposed).
    assert_eq!(get(&base, "/api/admin/users", &bob).await.0, 404);
    assert_eq!(get(&base, "/api/admin/usernames", &bob).await.0, 404);
}

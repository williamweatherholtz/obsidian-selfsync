// HTTP tests for the /api/admin/* management API (Phase 1, slice 4).
use new_livesync_server::{app, AppState};
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

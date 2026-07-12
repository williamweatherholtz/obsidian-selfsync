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
    assert_eq!(send(&base, "POST", "/api/admin/users", &admin, json!({"username":"charlie","password":"Charliepw1"})).await, 200);
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
    let reg = reqwest::Client::new().post(format!("{base}/api/register")).json(&json!({"username":"dave","password":"davepw123","invite":token})).send().await.unwrap();
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
    assert_eq!(send(&base, "POST", "/api/password", &t1, json!({"current":"wrong","new_password":"NewPass12"})).await, 401);
    // Correct change returns a fresh token and revokes ALL prior sessions.
    let r = reqwest::Client::new().post(format!("{base}/api/password")).bearer_auth(&t1)
        .json(&json!({"current":"pw","new_password":"NewPass12"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let t3 = r.json::<Value>().await.unwrap()["token"].as_str().unwrap().to_string();
    assert_eq!(get(&base, "/api/admin/me", &t1).await.0, 401, "old session 1 revoked");
    assert_eq!(get(&base, "/api/admin/me", &t2).await.0, 401, "old session 2 revoked");
    assert_eq!(get(&base, "/api/admin/me", &t3).await.0, 200, "the re-issued token works");
    // The new password logs in; the old one no longer does.
    assert_eq!(reqwest::Client::new().post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"NewPass12"})).send().await.unwrap().status().as_u16(), 200);
    assert_eq!(reqwest::Client::new().post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw"})).send().await.unwrap().status().as_u16(), 401);
}

#[tokio::test]
async fn bootstrap_admin_password_change_is_refused(/* R15 sec#1 */) {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    // The bootstrap SYNC_USER's password is re-applied from SYNC_PASSWORD on every boot, so a
    // self-service change would silently revert on restart — a false remediation. It's refused.
    assert_eq!(send(&base, "POST", "/api/password", &admin, json!({"current":"admin","new_password":"NewPass12"})).await, 400);
    // …and the original password still works (nothing was changed).
    assert_eq!(reqwest::Client::new().post(format!("{base}/api/login")).json(&json!({"username":"admin","password":"admin"})).send().await.unwrap().status().as_u16(), 200);
}

#[tokio::test]
async fn deleting_a_vault_purges_its_share_grants(/* R17: no stale-grant reactivation */) {
    let base = spawn().await;
    let admin = login(&base, "admin").await; // owns the bootstrap "default" vault
    assert_eq!(send(&base, "POST", "/api/admin/shares", &admin, json!({"vault":"default","grantee":"bob","perm":"read"})).await, 200);
    let bob = login(&base, "bob").await;
    assert!(!get(&base, "/api/shared", &bob).await.1.as_array().unwrap().is_empty(), "bob sees the shared vault");
    // Deleting the vault must also drop its grant, so recreating a vault of the same name later
    // doesn't silently re-grant bob.
    assert_eq!(send(&base, "DELETE", "/api/admin/vault", &admin, json!({"owner":"admin","vault":"default"})).await, 200);
    assert!(get(&base, "/api/shared", &bob).await.1.as_array().unwrap().is_empty(), "grant purged with the vault");
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

#[tokio::test]
async fn login_is_rate_limited_after_repeated_failures(/* SEC-AUTH FR9 */) {
    let base = spawn().await;
    let c = reqwest::Client::new();
    // DEFAULT_MAX_FAILS (10) wrong-password attempts against one account are each a plain 401…
    for _ in 0..10 {
        let s = c.post(format!("{base}/api/login")).json(&json!({"username":"admin","password":"wrong"}))
            .send().await.unwrap().status().as_u16();
        assert_eq!(s, 401);
    }
    // …then the account is locked out: the NEXT attempt is 429 with Retry-After — EVEN with the
    // correct password (lockout is by account, so a brute-forcer can't just keep guessing).
    let r = c.post(format!("{base}/api/login")).json(&json!({"username":"admin","password":"admin"}))
        .send().await.unwrap();
    assert_eq!(r.status().as_u16(), 429);
    assert!(r.headers().contains_key("retry-after"), "429 carries a Retry-After header");
    // A DIFFERENT account is unaffected by admin's lockout.
    assert_eq!(c.post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw"}))
        .send().await.unwrap().status().as_u16(), 200);
}

#[tokio::test]
async fn logout_revokes_the_presented_token(/* SEC-AUTH */) {
    let base = spawn().await;
    let t = login(&base, "bob").await;
    assert_eq!(get(&base, "/api/admin/me", &t).await.0, 200);        // token works
    assert_eq!(send(&base, "POST", "/api/logout", &t, json!({})).await, 200);
    assert_eq!(get(&base, "/api/admin/me", &t).await.0, 401);        // …and is dead after logout
}

#[tokio::test]
async fn operator_can_reset_a_user_password_and_revoke_sessions(/* admin UX */) {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    // bob (registered directly with "pw") has a live session; a reset changes the password AND kills it.
    let bob = login(&base, "bob").await;
    assert_eq!(get(&base, "/api/admin/me", &bob).await.0, 200);
    assert_eq!(send(&base, "POST", "/api/admin/users/bob/password", &admin, json!({"password":"resetpw12"})).await, 200);
    assert_eq!(get(&base, "/api/admin/me", &bob).await.0, 401, "old session revoked by the reset");
    // bob logs in with the NEW password; the old one is dead.
    assert_eq!(reqwest::Client::new().post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"resetpw12"})).send().await.unwrap().status().as_u16(), 200);
    assert_eq!(reqwest::Client::new().post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw"})).send().await.unwrap().status().as_u16(), 401);
    // A short reset password is refused; the bootstrap admin cannot be reset this way.
    assert_eq!(send(&base, "POST", "/api/admin/users/bob/password", &admin, json!({"password":"short"})).await, 400);
    assert_eq!(send(&base, "POST", "/api/admin/users/admin/password", &admin, json!({"password":"whatever8"})).await, 400);
}

#[tokio::test]
async fn admin_lists_any_account_vaults_with_health(/* admin UX: folded repair */) {
    let base = spawn().await;
    let admin = login(&base, "admin").await; // owns the bootstrap "default" vault
    let (s, vaults) = get(&base, "/api/admin/users/admin/vaults", &admin).await;
    assert_eq!(s, 200);
    let arr = vaults.as_array().unwrap();
    let def = arr.iter().find(|v| v["vault"] == "default").expect("admin has a default vault");
    assert_eq!(def["status"], serde_json::json!("ready"), "a healthy vault reports ready");
    // A non-admin cannot enumerate another account's vaults (require_admin → 403 on the merged app).
    let bob = login(&base, "bob").await;
    assert_eq!(get(&base, "/api/admin/users/admin/vaults", &bob).await.0, 403);
}

#[tokio::test]
async fn my_vaults_reports_per_vault_health(/* admin UX */) {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    let (s, vaults) = get(&base, "/api/admin/vaults", &admin).await;
    assert_eq!(s, 200);
    let def = vaults.as_array().unwrap().iter().find(|v| v["vault"] == "default").expect("default vault present");
    assert_eq!(def["status"], serde_json::json!("ready"));
}

#[tokio::test]
async fn admin_created_account_is_forced_to_change_password_before_use(/* IA.3.5.9 */) {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    let c = reqwest::Client::new();
    assert_eq!(send(&base, "POST", "/api/admin/users", &admin, json!({"username":"dana","password":"Temp-Pass-1"})).await, 200);
    // dana logs in — login succeeds and the response flags must_change.
    let r = c.post(format!("{base}/api/login")).json(&json!({"username":"dana","password":"Temp-Pass-1"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let body = r.json::<Value>().await.unwrap();
    assert_eq!(body["must_change_password"], json!(true), "login flags the forced change");
    let tok = body["token"].as_str().unwrap().to_string();
    // Any normal authed route is BLOCKED with 403 until the password is changed.
    assert_eq!(get(&base, "/api/admin/me", &tok).await.0, 403, "must-change account is blocked on authed routes");
    // change-password is reachable (manual token), clears the flag, and returns a fresh usable token.
    let cr = c.post(format!("{base}/api/password")).bearer_auth(&tok)
        .json(&json!({"current":"Temp-Pass-1","new_password":"Perm-Pass-9"})).send().await.unwrap();
    assert_eq!(cr.status().as_u16(), 200);
    let tok2 = cr.json::<Value>().await.unwrap()["token"].as_str().unwrap().to_string();
    assert_eq!(get(&base, "/api/admin/me", &tok2).await.0, 200, "after the change the account works normally");
}

#[tokio::test]
async fn password_change_rejects_reuse_of_a_recent_password(/* IA.3.5.8 */) {
    let base = spawn().await;
    let t1 = login(&base, "bob").await; // bob's password is "pw"
    let c = reqwest::Client::new();
    // Change bob "pw" -> "First-Pass-1".
    let r1 = c.post(format!("{base}/api/password")).bearer_auth(&t1).json(&json!({"current":"pw","new_password":"First-Pass-1"})).send().await.unwrap();
    assert_eq!(r1.status().as_u16(), 200);
    let t2 = r1.json::<Value>().await.unwrap()["token"].as_str().unwrap().to_string();
    // Try to change back to the ORIGINAL "pw" (now in history) -> 400 reuse.
    assert_eq!(send(&base, "POST", "/api/password", &t2, json!({"current":"First-Pass-1","new_password":"pw"})).await, 400, "reusing a recent password is rejected");
    // Change to the SAME current password -> also reuse -> 400.
    assert_eq!(send(&base, "POST", "/api/password", &t2, json!({"current":"First-Pass-1","new_password":"First-Pass-1"})).await, 400);
    // A genuinely new one succeeds.
    assert_eq!(send(&base, "POST", "/api/password", &t2, json!({"current":"First-Pass-1","new_password":"Second-Pass-2"})).await, 200);
}

#[tokio::test]
async fn mfa_totp_full_lifecycle(/* IA.3.5.3 */) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = || SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let base = spawn().await;
    let c = reqwest::Client::new();
    let t = login(&base, "bob").await; // bob's password is "pw"
    // Enroll -> secret; confirm with a live code -> recovery codes; MFA now enabled.
    let er = c.post(format!("{base}/api/mfa/enroll")).bearer_auth(&t).send().await.unwrap();
    assert_eq!(er.status().as_u16(), 200);
    let secret = er.json::<Value>().await.unwrap()["secret"].as_str().unwrap().to_string();
    let confirm_code = new_livesync_server::totp::code_at(&secret, now()).unwrap();
    let cr = c.post(format!("{base}/api/mfa/confirm")).bearer_auth(&t).json(&json!({"code": confirm_code})).send().await.unwrap();
    assert_eq!(cr.status().as_u16(), 200);
    let recovery = cr.json::<Value>().await.unwrap()["recovery_codes"][0].as_str().unwrap().to_string();
    // Password alone no longer logs in — 401 "mfa required".
    assert_eq!(c.post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw"}))
        .send().await.unwrap().status().as_u16(), 401);
    // Password + a valid TOTP code -> 200.
    let login_code = new_livesync_server::totp::code_at(&secret, now()).unwrap();
    let ok = c.post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw","totp": login_code})).send().await.unwrap();
    assert_eq!(ok.status().as_u16(), 200);
    let tok = ok.json::<Value>().await.unwrap()["token"].as_str().unwrap().to_string();
    // A single-use recovery code logs in; reusing it fails.
    assert_eq!(c.post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw","totp": recovery}))
        .send().await.unwrap().status().as_u16(), 200);
    assert_eq!(c.post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw","totp": recovery}))
        .send().await.unwrap().status().as_u16(), 401, "a consumed recovery code can't be reused");
    // Disable requires a current code; after disabling, password alone logs in again. Use a NEXT-window
    // code (now+30) — the login above consumed this window's step, and the replay guard rejects a reused
    // step; a fresh-step code is still within the +1 skew window the server accepts.
    let disable_code = new_livesync_server::totp::code_at(&secret, now() + 30).unwrap();
    assert_eq!(send(&base, "POST", "/api/mfa/disable", &tok, json!({"code": disable_code})).await, 200);
    assert_eq!(c.post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw"}))
        .send().await.unwrap().status().as_u16(), 200, "MFA disabled -> password alone works");
}

// IA.3.5.3 (crit-round): a TOTP code can't be REPLAYED within its validity window — once a step is
// consumed, the same code is rejected (RFC 6238 §5.2), so a captured code isn't reusable seconds later.
#[tokio::test]
async fn totp_code_cannot_be_replayed_within_its_window() {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = || SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let base = spawn().await;
    let c = reqwest::Client::new();
    let t = login(&base, "bob").await;
    let secret = c.post(format!("{base}/api/mfa/enroll")).bearer_auth(&t).send().await.unwrap()
        .json::<Value>().await.unwrap()["secret"].as_str().unwrap().to_string();
    let confirm = new_livesync_server::totp::code_at(&secret, now()).unwrap();
    assert_eq!(c.post(format!("{base}/api/mfa/confirm")).bearer_auth(&t).json(&json!({"code": confirm})).send().await.unwrap().status().as_u16(), 200);
    let code = new_livesync_server::totp::code_at(&secret, now()).unwrap();
    // First use of a fresh code → 200.
    assert_eq!(c.post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw","totp": code.clone()}))
        .send().await.unwrap().status().as_u16(), 200);
    // The SAME code (same 30s step) → 401: the consumed step is rejected as a replay.
    assert_eq!(c.post(format!("{base}/api/login")).json(&json!({"username":"bob","password":"pw","totp": code}))
        .send().await.unwrap().status().as_u16(), 401, "a consumed TOTP code can't be replayed");
}

#[tokio::test]
async fn register_rejects_a_too_short_password(/* SEC-AUTH min-length */) {
    let base = spawn().await; // Open registration is off by default here, but the length check runs first.
    let c = reqwest::Client::new();
    let s = c.post(format!("{base}/api/register")).json(&json!({"username":"shorty","password":"1234567"}))
        .send().await.unwrap().status().as_u16();
    assert_eq!(s, 400, "a <8-char password is rejected before the registration gate");
}

// ---- UI functional-guard tests (2026-07 admin-UI e2e audit). Each guards the SERVER behavior a fixed
// admin-page control depends on, so a regression in a control's *effect* fails here. ----

// POST returning (status, body) — send() drops the body, and these assert on it. No auth header when
// the token is empty (e.g. /api/login), so it isn't sent a malformed "Bearer ".
async fn post_json(base: &str, path: &str, token: &str, body: Value) -> (u16, Value) {
    let mut rb = reqwest::Client::new().post(format!("{base}{path}")).json(&body);
    if !token.is_empty() { rb = rb.bearer_auth(token); }
    let r = rb.send().await.unwrap();
    let s = r.status().as_u16();
    (s, r.json::<Value>().await.unwrap_or(Value::Null))
}

// A3 (admin login must handle must_change): an admin-created account is flagged must-change; its token
// is rejected on every route but change-password until it sets a new password — then it's fully usable.
// This is the exact contract the admin page's forced-change screen relies on.
#[tokio::test]
async fn must_change_account_is_blocked_until_password_set_then_works() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    assert_eq!(send(&base, "POST", "/api/admin/users", &admin, json!({"username":"dana","password":"Temp1234"})).await, 200);
    // login SUCCEEDS and signals must_change_password …
    let (ls, lv) = post_json(&base, "/api/login", "", json!({"username":"dana","password":"Temp1234"})).await;
    assert_eq!(ls, 200);
    assert_eq!(lv["must_change_password"], json!(true), "an admin-created account is flagged must-change");
    let dtok = lv["token"].as_str().unwrap().to_string();
    // … but that token is rejected on a normal route (403 password-change-required) …
    assert_eq!(get(&base, "/api/admin/me", &dtok).await.0, 403, "a must-change token is blocked until the password is set");
    // … the forced change clears the flag and returns a fresh token …
    let (cs, cv) = post_json(&base, "/api/password", &dtok, json!({"current":"Temp1234","new_password":"Newpass12"})).await;
    assert_eq!(cs, 200);
    let ntok = cv["token"].as_str().unwrap().to_string();
    assert_eq!(get(&base, "/api/admin/me", &ntok).await.0, 200, "after the change the account is fully usable");
    // … and the temp password no longer logs in (it was replaced).
    assert_eq!(post_json(&base, "/api/login", "", json!({"username":"dana","password":"Temp1234"})).await.0, 401);
}

// admin grant/revoke (was UNCOVERED): promoting an account opens admin routes; revoking closes them.
#[tokio::test]
async fn admin_grant_and_revoke_toggles_admin_access() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    let bob = login(&base, "bob").await;
    assert_eq!(get(&base, "/api/admin/users", &bob).await.0, 403, "a non-admin can't reach admin routes");
    assert_eq!(send(&base, "POST", "/api/admin/users/bob/admin", &admin, Value::Null).await, 200);
    assert_eq!(get(&base, "/api/admin/users", &bob).await.0, 200, "a promoted account reaches admin routes");
    assert_eq!(send(&base, "DELETE", "/api/admin/users/bob/admin", &admin, Value::Null).await, 200);
    assert_eq!(get(&base, "/api/admin/users", &bob).await.0, 403, "a revoked account is blocked again");
}

// user delete (was UNCOVERED): a deleted account can no longer authenticate.
#[tokio::test]
async fn admin_deletes_an_account() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    assert_eq!(send(&base, "POST", "/api/admin/users", &admin, json!({"username":"eve","password":"Temp1234"})).await, 200);
    assert_eq!(post_json(&base, "/api/login", "", json!({"username":"eve","password":"Temp1234"})).await.0, 200);
    assert_eq!(send(&base, "DELETE", "/api/admin/users/eve", &admin, Value::Null).await, 200);
    assert_eq!(post_json(&base, "/api/login", "", json!({"username":"eve","password":"Temp1234"})).await.0, 401, "a deleted account cannot log in");
}

// admin Repair + Prune-history HTTP endpoints (were UNCOVERED at the HTTP layer) — the admin repair
// control and the tombstone-prune control. A healthy reindex is a valid no-op that reports the version.
#[tokio::test]
async fn admin_reindex_and_prune_history_http_ok() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    let (rs, rv) = post_json(&base, "/api/admin/reindex", &admin, json!({"owner":"admin","vault":"default","force":false})).await;
    assert_eq!(rs, 200, "repairing a healthy vault is a valid no-op");
    assert!(rv["version"].is_number(), "reindex reports the vault version");
    assert_eq!(post_json(&base, "/api/admin/prune-history", &admin, json!({"owner":"admin","vault":"default"})).await.0, 200);
    let bob = login(&base, "bob").await;
    assert_eq!(post_json(&base, "/api/admin/reindex", &bob, json!({"owner":"admin","vault":"default"})).await.0, 403, "a non-admin can't repair");
}

// Invite list + delete (were UNCOVERED): a created invite is listed, then gone after delete.
#[tokio::test]
async fn admin_invite_list_and_delete() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    assert_eq!(send(&base, "PUT", "/api/admin/registration", &admin, json!({"mode":"closed"})).await, 200);
    assert_eq!(post_json(&base, "/api/admin/invites", &admin, json!({"label":"for dana"})).await.0, 200);
    let (ls, lv) = get(&base, "/api/admin/invites", &admin).await;
    assert_eq!(ls, 200);
    let arr = lv.as_array().unwrap();
    assert_eq!(arr.len(), 1, "the created invite is listed");
    let id = arr[0]["id"].as_str().unwrap().to_string();
    assert_eq!(send(&base, "DELETE", &format!("/api/admin/invites/{id}"), &admin, Value::Null).await, 200);
    let (_s, lv2) = get(&base, "/api/admin/invites", &admin).await;
    assert_eq!(lv2.as_array().unwrap().len(), 0, "the deleted invite is gone");
}

// A server with REQUIRE_ADMIN_MFA=1 enforced.
async fn spawn_admin_mfa() -> String {
    let dir = tempdir().unwrap();
    let root = Box::leak(Box::new(dir)).path().to_path_buf();
    let state = AppState::for_test_admin_mfa(&root);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap(); });
    format!("http://{addr}")
}

// IA.3.5.3 (crit-round): with REQUIRE_ADMIN_MFA=1, a server-admin cannot use any /api/admin/* route
// until they enroll TOTP — MFA is MANDATORY for privileged accounts, not merely available. Enrollment
// is reachable while blocked (the /api/mfa/* routes are AuthToken-gated, not admin-gated), so no lockout.
#[tokio::test]
async fn require_admin_mfa_blocks_admin_until_totp_enrolled() {
    let base = spawn_admin_mfa().await;
    let admin = login(&base, "admin").await;
    assert_eq!(get(&base, "/api/admin/users", &admin).await.0, 403, "admin without MFA is denied when REQUIRE_ADMIN_MFA=1");
    // Enroll + confirm TOTP (not admin-gated → reachable while the admin routes are blocked).
    let (es, ev) = post_json(&base, "/api/mfa/enroll", &admin, Value::Null).await;
    assert_eq!(es, 200);
    let secret = ev["secret"].as_str().unwrap().to_string();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let code = new_livesync_server::totp::code_at(&secret, now).unwrap();
    assert_eq!(post_json(&base, "/api/mfa/confirm", &admin, serde_json::json!({ "code": code })).await.0, 200);
    assert_eq!(get(&base, "/api/admin/users", &admin).await.0, 200, "after enrolling MFA the admin can act");
}

// D0023 (capability share-links): an owner creates a single-use link; a logged-in account redeems it,
// gaining a normal grant bound to itself (reaches the owner-qualified route); the link is single-use.
#[tokio::test]
async fn share_link_create_redeem_binds_a_grant_and_is_single_use() {
    let base = spawn().await;
    let admin = login(&base, "admin").await; // owns "vault"
    let (cs, cv) = post_json(&base, "/api/share-links", &admin, json!({"vault":"vault","perm":"readWrite","label":"for bob"})).await;
    assert_eq!(cs, 200);
    let token = cv["token"].as_str().unwrap().to_string();
    // bob can't reach admin's vault yet.
    let bob = login(&base, "bob").await;
    assert_eq!(get(&base, "/api/u/admin/vault/status", &bob).await.0, 403, "no access before redeem");
    // bob redeems → gets a grant bound to bob.
    let (rs, rv) = post_json(&base, "/api/share-redeem", &bob, json!({"token": token})).await;
    assert_eq!(rs, 200);
    assert_eq!((rv["owner"].as_str(), rv["vault"].as_str(), rv["perm"].as_str()), (Some("admin"), Some("vault"), Some("readWrite")));
    assert_eq!(get(&base, "/api/u/admin/vault/status", &bob).await.0, 200, "grantee reaches the shared vault after redeem");
    // single-use.
    assert_eq!(post_json(&base, "/api/share-redeem", &bob, json!({"token": token})).await.0, 400, "a consumed link can't be redeemed again");
}

// Self-redeem (the owner redeems their OWN link, e.g. to test it) is a no-op success that must NOT
// burn the single-use invite — the intended recipient can still redeem it afterwards (critique F2b).
#[tokio::test]
async fn self_redeem_does_not_burn_the_link() {
    let base = spawn().await;
    let admin = login(&base, "admin").await; // owns "vault"
    let token = post_json(&base, "/api/share-links", &admin, json!({"vault":"vault","perm":"read","label":"for bob"})).await.1["token"].as_str().unwrap().to_string();
    // admin redeems their own link → success, but the link must remain available.
    assert_eq!(post_json(&base, "/api/share-redeem", &admin, json!({"token": token})).await.0, 200, "self-redeem is a no-op success");
    // bob (the intended recipient) can STILL redeem it and gain access — it wasn't consumed.
    let bob = login(&base, "bob").await;
    let (rs, rv) = post_json(&base, "/api/share-redeem", &bob, json!({"token": token})).await;
    assert_eq!(rs, 200, "the invite survived the owner's self-redeem");
    assert_eq!((rv["owner"].as_str(), rv["vault"].as_str()), (Some("admin"), Some("vault")));
    assert_eq!(get(&base, "/api/u/admin/vault/status", &bob).await.0, 200, "recipient reaches the vault");
}

// A share-link is owner-scoped (can't create for a vault you don't own) and revoking a pending link
// prevents redemption.
#[tokio::test]
async fn share_link_owner_scoped_and_revoke_blocks_redeem() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    let bob = login(&base, "bob").await;
    // bob doesn't own "vault".
    assert_eq!(post_json(&base, "/api/share-links", &bob, json!({"vault":"vault","perm":"read"})).await.0, 404);
    // admin creates a link, lists it, revokes it → redeem fails.
    let token = post_json(&base, "/api/share-links", &admin, json!({"vault":"vault","perm":"read"})).await.1["token"].as_str().unwrap().to_string();
    let (_ls, lv) = get(&base, "/api/share-links", &admin).await;
    let id = lv.as_array().unwrap()[0]["id"].as_str().unwrap().to_string();
    assert_eq!(send(&base, "DELETE", &format!("/api/share-links/{id}"), &admin, Value::Null).await, 200);
    assert_eq!(post_json(&base, "/api/share-redeem", &bob, json!({"token": token})).await.0, 400, "a revoked link can't be redeemed");
}

// Configurable per-file ceiling (env MAX_FILE_MB, default 512): a commit DECLARING a size over the
// limit is rejected 400 at the api layer — before any reassembly — with a clear "size limit" message.
// (The check is on req.size, so no real large body is needed to exercise it.)
#[tokio::test]
async fn commit_over_size_limit_is_rejected() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    let over = 513u64 * 1024 * 1024; // just over the 512 MiB test default
    let (s, _v) = post_json(&base, "/api/v/default/commit", &admin,
        json!({"path":"big.bin","hash":"h","size":over,"mtime":1,"chunks":["c1"]})).await;
    // 400 = rejected at the api-layer size check (before reassembly). The error body is plain text,
    // not JSON, so we assert on the status rather than the message.
    assert_eq!(s, 400, "a file over the server ceiling is rejected before reassembly");
}

// Usernames are case-insensitive (canonicalized to lowercase). An admin creates "Dana"; it's stored
// as "dana", logs in as "DANA", and is grantable as "Dana" — all map to the one canonical account.
#[tokio::test]
async fn usernames_are_case_insensitive() {
    let base = spawn().await;
    let admin = login(&base, "admin").await;
    assert_eq!(send(&base, "POST", "/api/admin/users", &admin, json!({"username":"Dana","password":"Temp1234"})).await, 200);
    // login with a different case succeeds against the same account …
    let (ls, lv) = post_json(&base, "/api/login", "", json!({"username":"DANA","password":"Temp1234"})).await;
    assert_eq!(ls, 200, "mixed-case login maps to the canonical account");
    let dtok = lv["token"].as_str().unwrap().to_string();
    let (cs, _cv) = post_json(&base, "/api/password", &dtok, json!({"current":"Temp1234","new_password":"Newpass12"})).await;
    assert_eq!(cs, 200);
    // … and it appears exactly once, lowercased, in the account list.
    let (_s, users) = get(&base, "/api/admin/users", &admin).await;
    let danas = users.as_array().unwrap().iter().filter(|u| u["username"] == json!("dana")).count();
    assert_eq!(danas, 1, "stored once, canonical lowercase");
    assert!(!users.as_array().unwrap().iter().any(|u| u["username"] == json!("Dana")), "never stored mixed-case");
}

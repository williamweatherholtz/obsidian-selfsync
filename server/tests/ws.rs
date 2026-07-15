// Integration tests for the `/api/ws` change-notification WebSocket (src/ws.rs) — the biggest
// server test gap: 259 LOC of the trickiest concurrency in the codebase (subprotocol-token auth,
// the global MAX_WS_CONNECTIONS budget + per-user MAX_WS_PER_USER sub-cap with reservation/rollback,
// the ConnGuard that releases both counters on every exit path, and session re-auth / must_change).
//
// These drive the REAL axum app over a real TCP socket with tokio-tungstenite as the WS client — no
// mocking. Where a scenario is impractical to reproduce end-to-end (the 512-socket global cap), the
// SAME reservation/rollback arithmetic is asserted directly via the observable `ws_conns` counter
// (spawn() hands the test a clone of AppState, whose `ws_conns` AtomicUsize and `ws_conns_per_user`
// map are public), which is both cheaper and a stronger assertion than opening 512 sockets.

use futures_util::StreamExt;
use new_livesync_server::state::MAX_WS_PER_USER;
use new_livesync_server::{app, AppState};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn serve(router: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
    format!("http://{addr}")
}

// Spawn the merged app on a fresh temp dir and ALSO return a clone of the shared AppState so a test
// can observe the live WS counters (ws_conns / ws_conns_per_user) — the same state the router uses.
// `AppState::for_test` seeds bootstrap admin (admin/admin) and provisions the "default" + "vault"
// namespaces admin owns.
async fn spawn() -> (String, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::for_test(dir.path());
    std::mem::forget(dir); // keep the temp dir alive for the test process
    let base = serve(app(state.clone())).await;
    (base, state)
}

async fn login(base: &str, user: &str, pw: &str) -> String {
    let r = reqwest::Client::new()
        .post(format!("{base}/api/login"))
        .json(&serde_json::json!({ "username": user, "password": pw }))
        .send()
        .await
        .unwrap();
    r.json::<serde_json::Value>().await.unwrap()["token"].as_str().unwrap().to_string()
}

// Open a WS to /api/ws{query}. `proto` is the full Sec-WebSocket-Protocol header value the client
// offers (None = omit the header entirely). On a successful 101 upgrade returns the negotiated
// stream + handshake response; on a non-101 the server rejects BEFORE upgrading, which tungstenite
// surfaces as Error::Http — we return that HTTP status so tests can assert the exact rejection code.
async fn ws_connect(
    base: &str,
    query: &str,
    proto: Option<&str>,
) -> Result<(Ws, tokio_tungstenite::tungstenite::handshake::client::Response), u16> {
    let url = format!("{}/api/ws{}", base.replace("http://", "ws://"), query);
    let mut req = url.into_client_request().unwrap();
    if let Some(p) = proto {
        req.headers_mut()
            .insert("sec-websocket-protocol", HeaderValue::from_str(p).unwrap());
    }
    match connect_async(req).await {
        Ok(pair) => Ok(pair),
        Err(WsError::Http(resp)) => Err(resp.status().as_u16()),
        Err(e) => panic!("expected either a 101 upgrade or an HTTP rejection, got: {e:?}"),
    }
}

// Convenience: the full subprotocol header a healthy client sends — the spoken protocol plus the
// `auth.<token>` entry the server parses the bearer token out of.
fn auth_proto(token: &str) -> String {
    format!("selfsync.v1, auth.{token}")
}

// Poll the live global WS counter until it hits `want` (decrements happen asynchronously when the
// server task ends and drops its ConnGuard). Panics with the stuck value on timeout.
async fn wait_ws_conns(state: &AppState, want: usize) {
    for _ in 0..200 {
        if state.ws_conns.load(Ordering::Relaxed) == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!(
        "ws_conns never reached {want}; stuck at {}",
        state.ws_conns.load(Ordering::Relaxed)
    );
}

// ---- 1. Handshake auth (subprotocol token) --------------------------------------------------

// A valid token in the `auth.<token>` subprotocol upgrades the connection (101) and the server
// echoes back ONLY the non-secret spoken subprotocol `selfsync.v1` (never the token).
#[tokio::test]
async fn valid_token_in_subprotocol_upgrades_and_echoes_only_the_public_subprotocol() {
    let (base, _st) = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    let (mut sock, resp) = ws_connect(&base, "?vault=vault", Some(&auth_proto(&tok)))
        .await
        .expect("a valid token must upgrade the WS");
    assert_eq!(resp.status().as_u16(), 101, "a valid handshake completes with 101 Switching Protocols");
    // The server echoes the SPOKEN subprotocol, and never leaks the secret `auth.<token>` entry back.
    let echoed = resp
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert_eq!(echoed, "selfsync.v1", "server echoes only the public subprotocol");
    let _ = sock.close(None).await;
}

// A MISSING token (client offers only the spoken subprotocol, no `auth.` entry) is rejected 401 with
// no upgrade.
#[tokio::test]
async fn missing_token_is_rejected_401() {
    let (base, _st) = spawn().await;
    let err = ws_connect(&base, "?vault=vault", Some("selfsync.v1")).await.unwrap_err();
    assert_eq!(err, 401, "a handshake with no auth.<token> entry is unauthorized");
}

// An INVALID/garbage token that resolves to no user is rejected 401.
#[tokio::test]
async fn garbage_token_is_rejected_401() {
    let (base, _st) = spawn().await;
    let err = ws_connect(&base, "?vault=vault", Some(&auth_proto("deadbeefdeadbeefdeadbeef")))
        .await
        .unwrap_err();
    assert_eq!(err, 401, "a token that resolves to no user is unauthorized");
}

// A malformed EMPTY `auth.` entry (prefix present, token empty) resolves to no user -> 401.
#[tokio::test]
async fn empty_auth_token_is_rejected_401() {
    let (base, _st) = spawn().await;
    let err = ws_connect(&base, "?vault=vault", Some("selfsync.v1, auth.")).await.unwrap_err();
    assert_eq!(err, 401, "an empty auth. token resolves to no user and is unauthorized");
}

// A valid token but a non-existent vault is rejected 404 (the WS is a read subscription and only
// opens against an EXISTING vault — it never lazily provisions one). Guards the auth-passes-but-
// resource-missing branch distinct from the auth failures above.
#[tokio::test]
async fn valid_token_unknown_vault_is_rejected_404() {
    let (base, _st) = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    let err = ws_connect(&base, "?vault=nope-not-a-vault", Some(&auth_proto(&tok)))
        .await
        .unwrap_err();
    assert_eq!(err, 404, "subscribing to a non-existent vault is not found");
}

// ---- 2. Per-user cap (MAX_WS_PER_USER) ------------------------------------------------------

// One account may hold at most MAX_WS_PER_USER live sockets; the NEXT one is refused 503 while the
// earlier sockets stay open. Also asserts the per-user counter reflects exactly the cap.
#[tokio::test]
async fn per_user_cap_blocks_the_seventeenth_socket() {
    let (base, st) = spawn().await;
    let tok = login(&base, "admin", "admin").await;

    // Fill the per-user cap; every one of these must upgrade.
    let mut socks: Vec<Ws> = Vec::new();
    for i in 0..MAX_WS_PER_USER {
        let (s, _r) = ws_connect(&base, "?vault=vault", Some(&auth_proto(&tok)))
            .await
            .unwrap_or_else(|code| panic!("socket #{i} (under the cap) should upgrade, got HTTP {code}"));
        socks.push(s);
    }
    wait_ws_conns(&st, MAX_WS_PER_USER).await;
    assert_eq!(
        *st.ws_conns_per_user.lock().unwrap().get("admin").unwrap(),
        MAX_WS_PER_USER,
        "the per-user counter equals the cap once it's full"
    );

    // The one-over-cap connection is refused with 503 (Service Unavailable) — and the earlier
    // sockets are still open (still in `socks`, holding their server tasks alive).
    let err = ws_connect(&base, "?vault=vault", Some(&auth_proto(&tok)))
        .await
        .expect_err("the socket over the per-user cap must be refused");
    assert_eq!(err, 503, "one over the per-user cap is refused 503");

    for mut s in socks {
        let _ = s.close(None).await;
    }
}

// ---- 3. Global cap reservation / rollback ---------------------------------------------------

// Opening 512 real sockets to trip the GLOBAL MAX_WS_CONNECTIONS cap is impractical in a unit test
// (slow, fd-heavy, flaky). Instead we assert the reservation/rollback ARITHMETIC directly: the
// global reserve is a fetch_add done BEFORE the per-user check, and a per-user rejection must roll it
// back with a fetch_sub (ws.rs lines 119-140). So after the cap-plus-one rejection, the observable
// global counter must sit at exactly MAX_WS_PER_USER — proving the reserve was rolled back, not
// leaked. A leak here (counter left inflated) is exactly the capacity-erosion bug the cap exists to
// prevent, and this asserts it can't happen on the rejection path.
#[tokio::test]
async fn global_reserve_is_rolled_back_when_the_per_user_cap_rejects() {
    let (base, st) = spawn().await;
    let tok = login(&base, "admin", "admin").await;

    let mut socks: Vec<Ws> = Vec::new();
    for _ in 0..MAX_WS_PER_USER {
        socks.push(ws_connect(&base, "?vault=vault", Some(&auth_proto(&tok))).await.unwrap().0);
    }
    wait_ws_conns(&st, MAX_WS_PER_USER).await;

    // This connect reserves a global slot, then the per-user check rejects it and MUST release that
    // reserve. If rollback were missing, ws_conns would climb to MAX_WS_PER_USER + 1 and stay there.
    let err = ws_connect(&base, "?vault=vault", Some(&auth_proto(&tok))).await.unwrap_err();
    assert_eq!(err, 503);
    assert_eq!(
        st.ws_conns.load(Ordering::Relaxed),
        MAX_WS_PER_USER,
        "the global reserve is rolled back on a per-user rejection (no capacity leak)"
    );

    for mut s in socks {
        let _ = s.close(None).await;
    }
}

// ---- 4. Teardown / counter integrity (ConnGuard releases both counters on drop) -------------

// The ConnGuard decrements BOTH the global and per-user counters on every socket exit path (its
// Drop). Open a batch, confirm the counters rose, close them, and confirm both return to baseline
// (global 0, and the per-user entry is REMOVED, not left at 0) — then a fresh connection succeeds,
// i.e. capacity was actually reclaimed rather than leaked.
#[tokio::test]
async fn closing_sockets_releases_the_slots_and_counter_returns_to_zero() {
    let (base, st) = spawn().await;
    let tok = login(&base, "admin", "admin").await;

    let n = 8usize;
    let mut socks: Vec<Ws> = Vec::new();
    for _ in 0..n {
        socks.push(ws_connect(&base, "?vault=vault", Some(&auth_proto(&tok))).await.unwrap().0);
    }
    wait_ws_conns(&st, n).await;
    assert_eq!(*st.ws_conns_per_user.lock().unwrap().get("admin").unwrap(), n);

    // Close every socket; the server tasks end and drop their guards.
    for mut s in socks {
        let _ = s.close(None).await;
    }
    wait_ws_conns(&st, 0).await;
    assert!(
        st.ws_conns_per_user.lock().unwrap().get("admin").is_none(),
        "the per-user entry is removed at zero, not leaked as a stale 0"
    );

    // Capacity was reclaimed: a fresh connection upgrades again.
    let (mut fresh, resp) = ws_connect(&base, "?vault=vault", Some(&auth_proto(&tok)))
        .await
        .expect("capacity reclaimed after teardown -> a new socket upgrades");
    assert_eq!(resp.status().as_u16(), 101);
    let _ = fresh.close(None).await;
}

// ---- 5. Revoke mid-session --------------------------------------------------------------------

// A live socket is torn down the moment its bearer token stops resolving. The socket re-checks the
// session on every change notification, so: connect with token A, revoke token A (logout), then push
// a change on the subscribed vault (committed via an independent token B). The socket must be closed
// on the re-check rather than deliver the change — a revoked session cannot keep leaking change
// metadata.
#[tokio::test]
async fn revoking_the_session_tears_down_the_live_socket() {
    let (base, _st) = spawn().await;
    let t_ws = login(&base, "admin", "admin").await; // the socket's token
    let t_commit = login(&base, "admin", "admin").await; // an independent session used to poke a change

    let (mut sock, _r) = ws_connect(&base, "?vault=vault", Some(&auth_proto(&t_ws))).await.unwrap();

    // Revoke ONLY the socket's token (a single-session logout); t_commit stays valid.
    let logout = reqwest::Client::new()
        .post(format!("{base}/api/logout"))
        .bearer_auth(&t_ws)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status().as_u16(), 200);

    // Push a change on admin/vault (the channel the socket is subscribed to) using the still-valid
    // token. This wakes the socket's recv, which re-checks the (now-revoked) session and tears down.
    commit_a_change(&base, &t_commit).await;

    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match sock.next().await {
                None => return "closed",
                Some(Ok(Message::Close(_))) => return "closed",
                Some(Ok(Message::Text(t))) if t.contains("\"changed\"") => return "leaked-change",
                Some(Ok(_)) => continue, // ping / pong / heartbeat / other frame -> keep waiting
                Some(Err(_)) => return "closed", // transport error during teardown counts as closed
            }
        }
    })
    .await
    .expect("the revoked socket must close promptly, not hang");
    assert_eq!(
        outcome, "closed",
        "a revoked session's socket is torn down on the next re-check, never delivered the change"
    );
}

// Upload a chunk + commit a file to admin/vault so a change is broadcast on that vault's channel
// (the same VaultHandle.tx the WS subscribed to), waking any subscribed socket's recv loop.
async fn commit_a_change(base: &str, token: &str) {
    use new_livesync_server::hash::sha256_hex;
    let c = reqwest::Client::new();
    let body = b"ws-revoke-poke".to_vec();
    let h = sha256_hex(&body);
    let up = c
        .put(format!("{base}/api/v/vault/chunk/{h}"))
        .bearer_auth(token)
        .body(body.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(up.status().as_u16(), 200, "chunk upload should succeed");
    let commit = c
        .post(format!("{base}/api/v/vault/commit"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "path": "poke.md", "hash": h, "size": body.len(), "mtime": 1, "chunks": [h] }))
        .send()
        .await
        .unwrap();
    assert_eq!(commit.status().as_u16(), 200, "commit should succeed and broadcast a change");
}

// ---- 6. must_change gate on the WS path ------------------------------------------------------

// A forced-change account can do NOTHING but set its own password — the HTTP AuthToken extractor
// enforces this on every route, and the WS handler (which resolves the token manually) mirrors the
// gate. An admin-created account is flagged must_change; its otherwise-valid token must be refused
// 403 on the WS path, before any subscription opens.
#[tokio::test]
async fn must_change_account_cannot_open_a_ws_session() {
    let (base, _st) = spawn().await;
    let admin = login(&base, "admin", "admin").await;
    // Admin-created accounts are flagged must-change until they set their own password.
    let created = reqwest::Client::new()
        .post(format!("{base}/api/admin/users"))
        .bearer_auth(&admin)
        .json(&serde_json::json!({ "username": "dana", "password": "Temp-Pass-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status().as_u16(), 200);

    // dana logs in (login succeeds and flags must_change) and gets a real token …
    let lv = reqwest::Client::new()
        .post(format!("{base}/api/login"))
        .json(&serde_json::json!({ "username": "dana", "password": "Temp-Pass-1" }))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(lv["must_change_password"], serde_json::json!(true), "dana is flagged must-change");
    let dana = lv["token"].as_str().unwrap().to_string();

    // … but that token is refused 403 on the WS path (the must_change gate fires before subscription).
    let err = ws_connect(&base, "?owner=admin&vault=vault", Some(&auth_proto(&dana)))
        .await
        .expect_err("a must-change account cannot open a WS session");
    assert_eq!(err, 403, "the WS handler mirrors the must-change gate with 403");
}

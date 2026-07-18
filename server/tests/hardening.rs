// Server hardening / concurrency integration tests for the SelfSync sync server.
//
// The correctness primitives (vault CAS, chunk store, token store) are well unit-tested; THIS suite
// exercises the concurrent + resource-bound + error-mapping layer in src/api.rs (which had 0 tests)
// against the REAL app over HTTP: the CAS commit race, the DoS bounds (chunk / body / hash-batch
// caps), the degraded-storage 503 contract, the per-account vault cap, corrupt-store fail-loud on
// boot, and the AppError->HTTP status mapping. Every active test asserts a SPECIFIC status/body
// outcome (never a `!= 403` tautology). Harness copied from tests/admin.rs + tests/sync.rs.

use new_livesync_server::hash::sha256_hex;
use new_livesync_server::{app, AppState};
use serde_json::{json, Value};
use tempfile::tempdir;

// Spawn the merged app on an ephemeral port; return its base URL. admin/admin is seeded with a
// `default` + a `vault` namespace (AppState::for_test).
async fn spawn() -> String {
    let dir = tempdir().unwrap();
    let root = Box::leak(Box::new(dir)).path().to_path_buf();
    let state = AppState::for_test(&root);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    format!("http://{addr}")
}

// Same, but also registers a non-admin account `bob`/`pw` (for the authz/error-mapping tests).
async fn spawn_with_bob() -> String {
    let dir = tempdir().unwrap();
    let root = Box::leak(Box::new(dir)).path().to_path_buf();
    let state = AppState::for_test(&root);
    state.users.lock().unwrap().register("bob", "pw").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    format!("http://{addr}")
}

async fn login(base: &str, user: &str, pw: &str) -> String {
    reqwest::Client::new()
        .post(format!("{base}/api/login"))
        .json(&json!({ "username": user, "password": pw }))
        .send().await.unwrap()
        .json::<Value>().await.unwrap()["token"].as_str().unwrap().to_string()
}

// ---------------------------------------------------------------------------------------------
// 1. Concurrent-commit CAS race: two parallel commits for the SAME new path with the SAME
//    expected_version must resolve to EXACTLY ONE 200 and ONE 409 — the write lock serializes
//    them and the CAS check on the second sees the advanced version. Both-200 would be the
//    lost-update the CAS exists to prevent.
// ---------------------------------------------------------------------------------------------
#[tokio::test]
async fn concurrent_commit_cas_race_exactly_one_wins() {
    let base = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    let c = reqwest::Client::new();

    // Two DISTINCT contents (distinct hashes, so neither hits the idempotent-recommit short-circuit).
    let a = b"content-A".to_vec();
    let ha = sha256_hex(&a);
    let b = b"content-B".to_vec();
    let hb = sha256_hex(&b);
    // Upload both chunks up front so the commits only race on the CAS, not on chunk availability.
    c.put(format!("{base}/api/v/vault/chunk/{ha}")).bearer_auth(&tok).body(a.clone()).send().await.unwrap();
    c.put(format!("{base}/api/v/vault/chunk/{hb}")).bearer_auth(&tok).body(b.clone()).send().await.unwrap();

    // Both commit path "race.md" based on expected_version = 0 (absent) with different content.
    let fire = |h: String, size: usize| {
        let (c, base, tok) = (c.clone(), base.clone(), tok.clone());
        tokio::spawn(async move {
            c.post(format!("{base}/api/v/vault/commit"))
                .bearer_auth(&tok)
                .json(&json!({ "path": "race.md", "hash": h, "size": size, "mtime": 1, "chunks": [h], "expected_version": 0 }))
                .send().await.unwrap().status().as_u16()
        })
    };
    let (r1, r2) = tokio::join!(fire(ha, a.len()), fire(hb, b.len()));
    let mut got = [r1.unwrap(), r2.unwrap()];
    got.sort_unstable();
    assert_eq!(got, [200, 409], "exactly one concurrent commit wins (200); the other loses the CAS race (409) — never both 200");
}

// ---------------------------------------------------------------------------------------------
// 2. Oversized chunk: a PUT larger than MAX_CHUNK_BYTES (1 MiB) but under the 16 MiB body limit is
//    rejected at the api-layer size check → 400 (not 200, not 500).
// ---------------------------------------------------------------------------------------------
#[tokio::test]
async fn oversized_chunk_is_rejected_400() {
    let base = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    let big = vec![0u8; 1024 * 1024 + 1]; // 1 MiB + 1 byte — over MAX_CHUNK_BYTES, under the body limit
    let h = "0".repeat(64);
    let r = reqwest::Client::new()
        .put(format!("{base}/api/v/vault/chunk/{h}"))
        .bearer_auth(&tok).body(big).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 400, "a chunk over MAX_CHUNK_BYTES (1 MiB) is rejected 400");
}

// ---------------------------------------------------------------------------------------------
// 3. Body limit: a request body larger than the 16 MiB DefaultBodyLimit is rejected by the layer
//    → 413 Payload Too Large (before the handler ever runs).
// ---------------------------------------------------------------------------------------------
#[tokio::test]
async fn body_over_16mib_is_rejected_413() {
    let base = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    let huge = vec![0u8; 16 * 1024 * 1024 + 1]; // just over the 16 MiB buffered-body ceiling
    let h = "0".repeat(64);
    let r = reqwest::Client::new()
        .put(format!("{base}/api/v/vault/chunk/{h}"))
        .bearer_auth(&tok).body(huge).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 413, "a body over the 16 MiB DefaultBodyLimit is rejected 413");
}

// ---------------------------------------------------------------------------------------------
// 4. chunks_missing cap: a missing-chunks query with more than MAX_MISSING_HASHES (10,000) hashes
//    is rejected → 400 (the amplified-stat DoS bound).
// ---------------------------------------------------------------------------------------------
#[tokio::test]
async fn chunks_missing_over_cap_is_rejected_400() {
    let base = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    let hashes: Vec<String> = vec!["0".repeat(64); 10_001];
    let r = reqwest::Client::new()
        .post(format!("{base}/api/v/vault/chunks/missing"))
        .bearer_auth(&tok)
        .json(&json!({ "hashes": hashes }))
        .send().await.unwrap();
    assert_eq!(r.status().as_u16(), 400, "more than 10,000 hashes in one missing-chunks query is rejected 400");
}

// ---------------------------------------------------------------------------------------------
// 5. Degraded-storage 503 contract: a vault whose indexed file is lost from BOTH the mirror AND the
//    chunk store opens UNRECOVERABLY corrupt (auto-repair can't rebuild it). Sync ops (changes /
//    meta / commit) must 503 — NEVER serve a silent empty manifest (which the client would read as a
//    mass-deletion) — while /status stays 200 and REPORTS the error state so the client can learn it.
// ---------------------------------------------------------------------------------------------
#[tokio::test]
async fn corrupt_vault_503_on_sync_but_status_reports_error() {
    use new_livesync_server::protocol::CommitRequest;
    use new_livesync_server::vault::Vault;

    let dir = tempdir().unwrap();
    let root = dir.path().to_path_buf();
    // Build an unrecoverably-corrupt vault directly. `broken` is NOT the bootstrap default, so the
    // server won't open it until the first request hits it.
    let vroot = root.join("admin").join("broken");
    {
        let mut v = Vault::open(&vroot).unwrap();
        let body = b"payload";
        let h = sha256_hex(body);
        v.put_chunk(&h, body).unwrap();
        v.commit(CommitRequest { path: "lost.md".into(), hash: h.clone(), size: body.len() as u64, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        // Lose the only file from BOTH sides so no rebuild source remains → reindex aborts → ERROR.
        std::fs::remove_file(vroot.join("vault").join("lost.md")).unwrap();
        std::fs::remove_file(vroot.join(".chunks").join(&h[0..2]).join(&h)).unwrap();
    }
    assert!(Vault::open(&vroot).unwrap().is_corrupt(), "setup precondition: the vault must be unrecoverably corrupt");

    let state = AppState::for_test(&root);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    std::mem::forget(dir);
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let base = format!("http://{addr}");
    let tok = login(&base, "admin", "admin").await;
    let c = reqwest::Client::new();

    // /status → 200, reporting the degraded ERROR state (the client must be able to LEARN it).
    let st = c.get(format!("{base}/api/v/broken/status")).bearer_auth(&tok).send().await.unwrap();
    assert_eq!(st.status().as_u16(), 200, "status is reachable on a corrupt vault");
    let sv: Value = st.json().await.unwrap();
    assert_eq!(sv["status"], "error", "status must report the degraded state, not `ready`");

    // changes → 503, NEVER an empty 200 manifest (that would read as a mass-deletion).
    let ch = c.get(format!("{base}/api/v/broken/changes?since=0")).bearer_auth(&tok).send().await.unwrap();
    assert_eq!(ch.status().as_u16(), 503, "changes on a corrupt vault is 503 — never a silent empty manifest");

    // meta → 503.
    let mt = c.get(format!("{base}/api/v/broken/meta?path=whatever.md")).bearer_auth(&tok).send().await.unwrap();
    assert_eq!(mt.status().as_u16(), 503, "meta on a corrupt vault is 503");

    // commit → 503 (ensure_ready trips before any write).
    let cm = c.post(format!("{base}/api/v/broken/commit")).bearer_auth(&tok)
        .json(&json!({ "path": "x.md", "hash": "h", "size": 1, "mtime": 1, "chunks": ["c"] }))
        .send().await.unwrap();
    assert_eq!(cm.status().as_u16(), 503, "commit on a corrupt vault is 503");
}

// ---------------------------------------------------------------------------------------------
// 6. Resource cap: an account may hold at most MAX_VAULTS_PER_USER (100) vaults. admin starts with
//    2 (`default` + `vault`); creating up to 100 succeeds and the 101st is rejected → 400.
//    (The cap is a private const with no test override, so this drives the real 100.)
// ---------------------------------------------------------------------------------------------
#[tokio::test]
async fn vault_cap_rejects_the_hundred_and_first_400() {
    let base = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    let c = reqwest::Client::new();
    // admin already owns `default` + `vault`.
    let mut count = 2usize;
    let mut i = 0usize;
    while count < 100 {
        let name = format!("box{i}");
        i += 1;
        let s = c.post(format!("{base}/api/vaults")).bearer_auth(&tok)
            .json(&json!({ "name": name })).send().await.unwrap().status().as_u16();
        assert_eq!(s, 200, "creating vault #{count} must succeed under the cap");
        count += 1;
    }
    // Now at exactly 100 → the next create is over the cap.
    let over = c.post(format!("{base}/api/vaults")).bearer_auth(&tok)
        .json(&json!({ "name": "one-too-many" })).send().await.unwrap().status().as_u16();
    assert_eq!(over, 400, "the 101st vault is rejected 400 (MAX_VAULTS_PER_USER = 100)");
}

// ---------------------------------------------------------------------------------------------
// 7. Corrupt JSON store fails loud: a garbage .users.json / .admins.json / .shares.json must make
//    the store's open() (and AppState::new) return an error — the server must NOT silently start
//    with wiped accounts/admins/grants (the silent-reset bug admins.rs documents).
// ---------------------------------------------------------------------------------------------
#[test]
fn corrupt_json_stores_fail_loud_not_silent_reset() {
    use new_livesync_server::admins::AdminStore;
    use new_livesync_server::config::Config;
    use new_livesync_server::shares::ShareStore;
    use new_livesync_server::users::UserStore;

    // Store-level: each corrupt file is a loud Err, never an empty-default open.
    let d = tempdir().unwrap();
    let up = d.path().join(".users.json");
    std::fs::write(&up, b"{ not valid json").unwrap();
    assert!(UserStore::open(&up).is_err(), "a corrupt .users.json must fail loud, not open empty");
    let ap = d.path().join(".admins.json");
    std::fs::write(&ap, b"{ not valid json").unwrap();
    assert!(AdminStore::open(&ap).is_err(), "a corrupt .admins.json must fail loud (no silent privilege wipe)");
    let sp = d.path().join(".shares.json");
    std::fs::write(&sp, b"{ not valid json").unwrap();
    assert!(ShareStore::open(&sp).is_err(), "a corrupt .shares.json must fail loud");

    // Integration: AppState::new refuses to boot on any corrupt store (each in its own fresh root).
    let cfg = |root: &std::path::Path| Config {
        data_root: root.to_path_buf(),
        bind_addr: "127.0.0.1:0".into(),
        admin_bind: None,
        vault: "vault".into(),
        user: "admin".into(),
        password: "admin".into(),
        registration: "open".into(),
        invite_code: String::new(),
        login_banner: String::new(),
        require_admin_mfa: false,
        max_file_bytes: 512 * 1024 * 1024,
    };
    for store in [".users.json", ".admins.json", ".shares.json"] {
        let dd = tempdir().unwrap();
        std::fs::write(dd.path().join(store), b"{ garbage not json").unwrap();
        assert!(AppState::new(cfg(dd.path())).is_err(), "AppState must not start on a corrupt {store}");
    }
}

// ---------------------------------------------------------------------------------------------
// 8. api.rs error mapping at the HTTP layer: 403 (non-grantee on an owner-qualified route), 404
//    (missing vault / missing meta), 409 (CAS conflict), and the idempotent-op behavior of
//    leave_share (repeatable 200) and delete_own_vault (200 then 404 once gone).
// ---------------------------------------------------------------------------------------------
#[tokio::test]
async fn api_error_mapping_403_404_409_and_idempotent_ops() {
    let base = spawn_with_bob().await;
    let admin = login(&base, "admin", "admin").await;
    let bob = login(&base, "bob", "pw").await;
    let c = reqwest::Client::new();

    // 403: bob is neither owner nor grantee of admin's `vault` on an owner-qualified route.
    let r403 = c.get(format!("{base}/api/u/admin/vault/status")).bearer_auth(&bob).send().await.unwrap();
    assert_eq!(r403.status().as_u16(), 403, "a non-grantee on an owner-qualified route is 403");

    // 404: admin's own-vault route to a vault that doesn't exist (authorized as owner, but no dir).
    let r404 = c.get(format!("{base}/api/v/does-not-exist/status")).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(r404.status().as_u16(), 404, "a missing vault is 404");
    // 404: meta for an absent path in an existing vault.
    let r404b = c.get(format!("{base}/api/v/vault/meta?path=absent.md")).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(r404b.status().as_u16(), 404, "meta for an absent file is 404");

    // 409: a CAS conflict. Create the file (expected_version 0 → v1), then a second write still based
    // on v0 with different content conflicts.
    let a = b"v-one".to_vec();
    let ha = sha256_hex(&a);
    let b2 = b"v-two".to_vec();
    let hb = sha256_hex(&b2);
    c.put(format!("{base}/api/v/vault/chunk/{ha}")).bearer_auth(&admin).body(a.clone()).send().await.unwrap();
    c.put(format!("{base}/api/v/vault/chunk/{hb}")).bearer_auth(&admin).body(b2.clone()).send().await.unwrap();
    let first = c.post(format!("{base}/api/v/vault/commit")).bearer_auth(&admin)
        .json(&json!({ "path": "cas.md", "hash": ha, "size": a.len(), "mtime": 1, "chunks": [ha], "expected_version": 0 }))
        .send().await.unwrap();
    assert_eq!(first.status().as_u16(), 200, "the first CAS commit creates the file");
    let conflict = c.post(format!("{base}/api/v/vault/commit")).bearer_auth(&admin)
        .json(&json!({ "path": "cas.md", "hash": hb, "size": b2.len(), "mtime": 2, "chunks": [hb], "expected_version": 0 }))
        .send().await.unwrap();
    assert_eq!(conflict.status().as_u16(), 409, "a stale expected_version is a 409 conflict");

    // Idempotent leave_share: bob leaving a share he never had is a repeatable no-op 200.
    let leave = || {
        let (c, base, bob) = (c.clone(), base.clone(), bob.clone());
        async move {
            c.delete(format!("{base}/api/shared")).bearer_auth(&bob)
                .json(&json!({ "owner": "admin", "vault": "vault" })).send().await.unwrap().status().as_u16()
        }
    };
    assert_eq!(leave().await, 200, "leaving a share you don't hold is an idempotent no-op 200");
    assert_eq!(leave().await, 200, "…and repeating it is still 200");

    // delete_own_vault: admin deletes a throwaway vault (200); deleting it again is 404 (already gone).
    assert_eq!(
        c.post(format!("{base}/api/vaults")).bearer_auth(&admin).json(&json!({ "name": "scratch" }))
            .send().await.unwrap().status().as_u16(),
        200, "create the throwaway vault"
    );
    let del = || {
        let (c, base, admin) = (c.clone(), base.clone(), admin.clone());
        async move {
            c.delete(format!("{base}/api/vault")).bearer_auth(&admin)
                .json(&json!({ "vault": "scratch" })).send().await.unwrap().status().as_u16()
        }
    };
    assert_eq!(del().await, 200, "deleting an owned vault succeeds");
    assert_eq!(del().await, 404, "deleting an already-removed vault is 404");
}

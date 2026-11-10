// E2EE at the HTTP surface (E2, D0102/D0103, spec sections 4.4 and 4.6): atomic create with a keyring,
// GET keyring on both route families with its three answers, the x-selfsync-e2ee downgrade guard inside
// scoped() over the WHOLE signed route list, PUT chunk 422 on a non-frame, commit with cid, the refusal-one
// 503 on a warm handle and across a restart, and DELETE /api/vault removing the keyring with the vault.
use selfsync_server::error::{E2EE_KEYRING_MISSING_MSG, E2EE_REQUIRED_MSG};
use selfsync_server::hash::sha256_hex;
use selfsync_server::{app, shares::Perm, wire_signature, AppState};
use tempfile::tempdir;

const KEYRING: &str = r#"{"version":1,"vault_id":"EBESExQVFhcYGRobHB0eHw==","kdf":{"alg":"argon2id","m_kib":64,"t":1,"p":1,"salt":"oKGio6SlpqeoqaqrrK2urw=="},"check":"00","wrap":{"alg":"A256GCM","nonce":"0NHS09TV1tfY2drb","ct":"AA=="}}"#;

async fn serve(state: AppState) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap(); });
    format!("http://{addr}")
}

async fn spawn() -> (String, AppState, std::path::PathBuf) {
    let dir = tempdir().unwrap();
    let root = Box::leak(Box::new(dir)).path().to_path_buf();
    let state = AppState::for_test(&root);
    {
        let mut u = state.users.lock().unwrap();
        u.register("bob", "pw").unwrap();
        u.register("carol", "pw").unwrap();
    }
    let base = serve(state.clone()).await;
    (base, state, root)
}

async fn login(base: &str, user: &str, pw: &str) -> String {
    let r = reqwest::Client::new().post(format!("{base}/api/login"))
        .json(&serde_json::json!({ "username": user, "password": pw })).send().await.unwrap();
    assert!(r.status().is_success(), "login {user}");
    r.json::<serde_json::Value>().await.unwrap()["token"].as_str().unwrap().to_string()
}

async fn create(base: &str, tok: &str, name: &str, keyring: Option<&str>) -> u16 {
    let mut body = serde_json::json!({ "name": name });
    if let Some(k) = keyring { body["keyring"] = serde_json::Value::String(k.to_string()); }
    reqwest::Client::new().post(format!("{base}/api/vaults")).bearer_auth(tok).json(&body).send().await.unwrap().status().as_u16()
}

fn frame(pt_len: usize, seed: u8) -> Vec<u8> {
    let mut f = vec![0u8; 68 + pt_len];
    f[..4].copy_from_slice(b"SSE1");
    f[16..20].copy_from_slice(&((pt_len + 48) as u32).to_le_bytes());
    for (i, b) in f[20..].iter_mut().enumerate() { *b = seed ^ (i as u8); }
    f
}

#[tokio::test]
async fn create_with_keyring_stores_it_verbatim_and_get_keyring_answers_on_both_families() {
    let (base, st, _root) = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    let c = reqwest::Client::new();
    assert_eq!(create(&base, &tok, "enc", Some(KEYRING)).await, 200);
    assert_eq!(create(&base, &tok, "enc", Some(KEYRING)).await, 409, "the name exists");
    assert_eq!(create(&base, &tok, "plain", None).await, 200);
    assert_eq!(create(&base, &tok, "bad1", Some("not json")).await, 400);
    assert_eq!(create(&base, &tok, "bad2", Some("[1,2]")).await, 400);
    assert_eq!(create(&base, &tok, "bad3", Some(&"x".repeat(9000))).await, 400);
    // 200: the bytes exactly as sent, content-type json, on the own-vault route.
    let r = c.get(format!("{base}/api/v/enc/keyring")).bearer_auth(&tok).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers().get("content-type").unwrap().to_str().unwrap().starts_with("application/json"));
    assert_eq!(r.text().await.unwrap(), KEYRING);
    // 404: a plaintext vault, and an absent vault.
    assert_eq!(c.get(format!("{base}/api/v/plain/keyring")).bearer_auth(&tok).send().await.unwrap().status(), 404);
    assert_eq!(c.get(format!("{base}/api/v/nope/keyring")).bearer_auth(&tok).send().await.unwrap().status(), 404);
    // The owner-qualified family answers a grantee with any grant, and refuses a non-grantee with the bare 403.
    st.shares.lock().unwrap().grant("admin", "enc", "bob", Perm::Read).unwrap();
    let bob = login(&base, "bob", "pw").await;
    let r = c.get(format!("{base}/api/u/admin/enc/keyring")).bearer_auth(&bob).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.text().await.unwrap(), KEYRING);
    let carol = login(&base, "carol", "pw").await;
    let r = c.get(format!("{base}/api/u/admin/enc/keyring")).bearer_auth(&carol).send().await.unwrap();
    assert_eq!(r.status(), 403);
    assert_eq!(r.text().await.unwrap(), "forbidden");
    // The handle is flagged in memory (a cached handle for a keyring-created vault reads encrypted=true).
    let h = st.vault("admin", "enc").unwrap();
    assert!(h.vault.read().unwrap().encrypted());
    assert!(!st.vault("admin", "plain").unwrap().vault.read().unwrap().encrypted());
    // A sidecar dropped beside the PLAINTEXT warm handle: the server's encrypted test is the flag, so GET
    // keyring answers 404, never 200 (a joiner must not push frames into a plaintext handle).
    std::fs::write(_root.join("admin").join("plain").join(".keyring.json"), KEYRING).unwrap();
    assert_eq!(c.get(format!("{base}/api/v/plain/keyring")).bearer_auth(&tok).send().await.unwrap().status(), 404);
}

// (6) The downgrade guard over the WHOLE signed route list: every vault-scoped route answers a grantee
// without the header with 403 and the fixed body, except GET keyring. With the header, none does. A
// non-grantee gets the bare 403 either way. The body never matches the client's password-change regex.
#[tokio::test]
async fn every_vault_scoped_route_enforces_the_header_except_keyring() {
    let (base, st, _root) = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    assert_eq!(create(&base, &tok, "enc", Some(KEYRING)).await, 200);
    st.shares.lock().unwrap().grant("admin", "enc", "bob", Perm::ReadWrite).unwrap();
    let bob = login(&base, "bob", "pw").await;
    let carol = login(&base, "carol", "pw").await;
    let c = reqwest::Client::new();
    let mut checked = 0;
    for entry in wire_signature::declared_endpoints() {
        let (method, path) = entry.split_once(' ').unwrap();
        if !(path.contains("/api/v/:vault/") || path.contains("/api/u/:owner/:vault/")) { continue; }
        let concrete = path.replace(":owner", "admin").replace(":vault", "enc").replace(":hash", &"ab".repeat(32));
        // A body the Json extractor accepts, so the request reaches scoped() instead of a 422 at extraction.
        let body = if path.ends_with("/chunks/missing") { r#"{"hashes":[]}"# }
            else if path.ends_with("/commit") { r#"{"path":"x.md","hash":"h","size":0,"mtime":0,"chunks":[]}"# }
            else { "{}" };
        let send = |who: &str, header: bool| {
            let url = format!("{base}{concrete}");
            let mut r = match method { "GET" => c.get(&url), "POST" => c.post(&url), "PUT" => c.put(&url), "DELETE" => c.delete(&url), m => panic!("{m}") };
            r = r.bearer_auth(who).header("content-type", "application/json").body(body);
            if header { r = r.header("x-selfsync-e2ee", "1"); }
            r.send()
        };
        let who = if path.contains("/api/u/") { &bob } else { &tok };
        let r = send(who, false).await.unwrap();
        let (status, body) = (r.status().as_u16(), r.text().await.unwrap());
        if path.ends_with("/keyring") {
            assert_eq!(status, 200, "{entry}: GET keyring is exempt");
        } else {
            assert_eq!((status, body.as_str()), (403, E2EE_REQUIRED_MSG), "{entry}: no header on a keyring vault");
        }
        let r = send(who, true).await.unwrap();
        let (status, body) = (r.status().as_u16(), r.text().await.unwrap());
        assert!(!(status == 403 && body == E2EE_REQUIRED_MSG), "{entry}: with the header the guard is silent");
        if path.contains("/api/u/") {
            let r = send(&carol, false).await.unwrap();
            assert_eq!((r.status().as_u16(), r.text().await.unwrap().as_str()), (403, "forbidden"), "{entry}: a non-grantee gets the bare 403");
        }
        checked += 1;
    }
    assert!(checked >= 17, "the signed route list carries the vault-scoped routes, checked {checked}");
    let re = regex_lite(E2EE_REQUIRED_MSG);
    assert!(!re, "the body must not read as the password-change state");
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() { copy_dir(&src, &dst); } else { std::fs::copy(&src, &dst).unwrap(); }
    }
}

fn regex_lite(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    let hit = |a: &str, b: &str| l.match_indices(a).any(|(i, _)| { let rest = &l[i + a.len()..]; rest.starts_with(b) || (rest.len() > 1 && rest[1..].starts_with(b)) });
    hit("password", "change") || hit("change", "password")
}

// (3) PUT chunk refuses a non-frame with 422 and a body naming the cause; a frame is 200. Commit without cid is
// 400, with cid 200, and changes and meta return cid. A plaintext vault is unchanged by every rule.
#[tokio::test]
async fn put_chunk_and_commit_rules_on_a_keyring_vault() {
    let (base, _st, _root) = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    assert_eq!(create(&base, &tok, "enc", Some(KEYRING)).await, 200);
    let c = reqwest::Client::new();
    let plain = b"plain bytes".to_vec(); let hp = sha256_hex(&plain);
    let r = c.put(format!("{base}/api/v/enc/chunk/{hp}")).bearer_auth(&tok).header("x-selfsync-e2ee", "1").body(plain.clone()).send().await.unwrap();
    assert_eq!(r.status(), 422);
    assert!(r.text().await.unwrap().contains("SSE1"));
    let f = frame(30, 1); let hf = sha256_hex(&f);
    let r = c.put(format!("{base}/api/v/enc/chunk/{hf}")).bearer_auth(&tok).header("x-selfsync-e2ee", "1").body(f.clone()).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let no_cid = serde_json::json!({"path":"n.md","hash":hf,"size":30,"mtime":1,"chunks":[hf]});
    let r = c.post(format!("{base}/api/v/enc/commit")).bearer_auth(&tok).header("x-selfsync-e2ee", "1").json(&no_cid).send().await.unwrap();
    assert_eq!(r.status(), 400);
    let cid = "cd".repeat(32);
    let ok = serde_json::json!({"path":"n.md","hash":hf,"size":30,"mtime":1,"chunks":[hf],"cid":cid});
    let r = c.post(format!("{base}/api/v/enc/commit")).bearer_auth(&tok).header("x-selfsync-e2ee", "1").json(&ok).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let m: selfsync_server::protocol::FileMeta = r.json().await.unwrap();
    assert_eq!(m.cid.as_deref(), Some(cid.as_str()));
    let ch: selfsync_server::protocol::ChangesResponse = c.get(format!("{base}/api/v/enc/changes?since=0")).bearer_auth(&tok).header("x-selfsync-e2ee", "1").send().await.unwrap().json().await.unwrap();
    assert_eq!(ch.upserts[0].cid.as_deref(), Some(cid.as_str()));
    let one: selfsync_server::protocol::FileMeta = c.get(format!("{base}/api/v/enc/meta?path=n.md")).bearer_auth(&tok).header("x-selfsync-e2ee", "1").send().await.unwrap().json().await.unwrap();
    assert_eq!(one.cid.as_deref(), Some(cid.as_str()));
    // missing on the stored frame hash reports present
    let miss: selfsync_server::protocol::MissingResponse = c.post(format!("{base}/api/v/enc/chunks/missing")).bearer_auth(&tok).header("x-selfsync-e2ee", "1").json(&serde_json::json!({"hashes":[hf]})).send().await.unwrap().json().await.unwrap();
    assert!(miss.missing.is_empty());
    // plaintext vault: a non-frame chunk and a cid-less commit are fine, with or without the header
    assert_eq!(create(&base, &tok, "plain", None).await, 200);
    let r = c.put(format!("{base}/api/v/plain/chunk/{hp}")).bearer_auth(&tok).body(plain.clone()).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let r = c.post(format!("{base}/api/v/plain/commit")).bearer_auth(&tok).json(&serde_json::json!({"path":"p.md","hash":hp,"size":plain.len(),"mtime":1,"chunks":[hp]})).send().await.unwrap();
    assert_eq!(r.status(), 200);
}

// (1) Refusal one at the API: a warm handle whose sidecar vanished answers GET keyring 503 with the body;
// after a restart the cold open refuses with the same body on every vault-scoped route and on GET keyring.
// Restoring the sidecar heals it. DELETE /api/vault removes the keyring with the vault.
#[tokio::test]
async fn missing_sidecar_answers_the_same_503_warm_and_cold_and_delete_removes_the_keyring() {
    let (base, _st, root) = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    assert_eq!(create(&base, &tok, "enc", Some(KEYRING)).await, 200);
    let c = reqwest::Client::new();
    let sidecar = root.join("admin").join("enc").join(".keyring.json");
    assert!(sidecar.is_file());
    std::fs::remove_file(&sidecar).unwrap();
    let r = c.get(format!("{base}/api/v/enc/keyring")).bearer_auth(&tok).send().await.unwrap();
    assert_eq!((r.status().as_u16(), r.text().await.unwrap().as_str()), (503, E2EE_KEYRING_MISSING_MSG), "warm handle");
    // restart: a fresh AppState over a COPY of the data root (the first server keeps its SQLite handle open,
    // and Windows would refuse the later directory removal while it lives)
    let root2 = tempdir().unwrap();
    let root2 = Box::leak(Box::new(root2)).path().to_path_buf();
    copy_dir(&root, &root2);
    let sidecar = root2.join("admin").join("enc").join(".keyring.json");
    let state2 = AppState::for_test(&root2);
    let base2 = serve(state2).await;
    let tok2 = login(&base2, "admin", "admin").await;
    let r = c.get(format!("{base2}/api/v/enc/keyring")).bearer_auth(&tok2).send().await.unwrap();
    assert_eq!((r.status().as_u16(), r.text().await.unwrap().as_str()), (503, E2EE_KEYRING_MISSING_MSG), "cold open");
    let r = c.get(format!("{base2}/api/v/enc/status")).bearer_auth(&tok2).header("x-selfsync-e2ee", "1").send().await.unwrap();
    assert_eq!((r.status().as_u16(), r.text().await.unwrap().as_str()), (503, E2EE_KEYRING_MISSING_MSG), "every vault-scoped route");
    std::fs::write(&sidecar, KEYRING).unwrap();
    let r = c.get(format!("{base2}/api/v/enc/keyring")).bearer_auth(&tok2).send().await.unwrap();
    assert_eq!(r.status(), 200);
    // delete removes the directory, the sidecar with it
    let r = c.delete(format!("{base2}/api/vault")).bearer_auth(&tok2).json(&serde_json::json!({"vault":"enc"})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(!sidecar.exists());
    assert_eq!(c.get(format!("{base2}/api/v/enc/keyring")).bearer_auth(&tok2).send().await.unwrap().status(), 404);
    // and a same-name recreate as PLAINTEXT is a plaintext vault (404 on keyring), the pin on the client catches it
    assert_eq!(create(&base2, &tok2, "enc", None).await, 200);
    assert_eq!(c.get(format!("{base2}/api/v/enc/keyring")).bearer_auth(&tok2).send().await.unwrap().status(), 404);
}

// The create sequence (spec section 4.4): a retried create on a live name is 409 and the live vault keeps
// working (the tombstone it found is restored); a purge then a create of the same name succeeds; the created
// vault's handle is published only after the sidecar exists (the handle reads it on the first request).
#[test]
fn create_vault_409_restores_the_tombstone_state_and_purge_then_create_works() {
    let dir = tempdir().unwrap();
    let st = AppState::for_test(dir.path());
    let kind = |r: std::io::Result<selfsync_server::state::VaultHandle>| match r { Ok(_) => None, Err(e) => Some(e.kind()) };
    assert!(st.create_vault("admin", "enc", Some(KEYRING.as_bytes())).is_ok());
    assert!(st.vault("admin", "enc").unwrap().vault.read().unwrap().encrypted());
    assert_eq!(kind(st.create_vault("admin", "enc", Some(KEYRING.as_bytes()))), Some(std::io::ErrorKind::AlreadyExists));
    // A COLD open sees the tombstone, a warm one does not: a second AppState over the same root is cold.
    let cold = AppState::for_test(dir.path());
    assert!(cold.vault("admin", "enc").is_ok(), "the live vault is not tombstoned by a 409 (cold open)");
    assert!(st.vault("admin", "enc").is_ok());
    drop(cold); // release its SQLite handle, or Windows refuses the purge's directory removal
    st.purge_vault("admin", "enc").unwrap();
    assert_eq!(kind(st.vault("admin", "enc")), Some(std::io::ErrorKind::NotFound), "purged: tombstoned, a raced open gets NotFound");
    // a deliberate same-name create after a purge succeeds and clears the tombstone, as plaintext here
    let h = st.create_vault("admin", "enc", None).unwrap();
    assert!(!h.vault.read().unwrap().encrypted());
    assert!(st.vault("admin", "enc").is_ok());
    // a half-purged name (directory left behind, tombstone set) keeps its purge tombstone on a 409
    st.purge_vault("admin", "enc").unwrap();
    std::fs::create_dir_all(dir.path().join("admin").join("enc")).unwrap();
    assert_eq!(kind(st.create_vault("admin", "enc", None)), Some(std::io::ErrorKind::AlreadyExists));
    assert_eq!(kind(st.vault("admin", "enc")), Some(std::io::ErrorKind::NotFound), "the purge tombstone survived the 409");
}

// (4) The status detail carries the named abort reason of a rebuild that aborted on the no-sidecar pre-pass,
// and GET keyring on that handle answers the refusal-one 503 (the handle holds the no-sidecar abort reason).
#[tokio::test]
async fn status_detail_carries_the_abort_reason_and_keyring_answers_503_on_that_handle() {
    let (base, _st, root) = spawn().await;
    let tok = login(&base, "admin", "admin").await;
    assert_eq!(create(&base, &tok, "plain", None).await, 200);
    let c = reqwest::Client::new();
    // a frame stream with a trailer dropped into vault/ of a plaintext vault, and the index lost
    let mut dropped = frame(300, 2);
    dropped.extend_from_slice(b"SSEM");
    dropped.extend_from_slice(&[0xabu8; 32]);
    let vdir = root.join("admin").join("plain");
    std::fs::write(vdir.join("vault").join("dropped.md"), &dropped).unwrap();
    // evict the warm handle by purging the cache: a fresh AppState over a copy sees a cold open
    let root2 = tempdir().unwrap();
    let root2 = Box::leak(Box::new(root2)).path().to_path_buf();
    copy_dir(&root, &root2);
    for s in ["", "-wal", "-shm"] { let _ = std::fs::remove_file(root2.join("admin").join("plain").join(format!(".sync-index.db{s}"))); }
    let base2 = serve(AppState::for_test(&root2)).await;
    let tok2 = login(&base2, "admin", "admin").await;
    let r = c.get(format!("{base2}/api/v/plain/status")).bearer_auth(&tok2).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let s: selfsync_server::protocol::StatusResponse = r.json().await.unwrap();
    assert_eq!(s.status, "error");
    assert!(s.detail.starts_with("rebuild aborted: no .keyring.json"), "{}", s.detail);
    assert!(s.detail.contains("dropped.md"));
    let r = c.get(format!("{base2}/api/v/plain/keyring")).bearer_auth(&tok2).send().await.unwrap();
    assert_eq!((r.status().as_u16(), r.text().await.unwrap().as_str()), (503, E2EE_KEYRING_MISSING_MSG));
    // the exit: restore a sidecar and reindex, the vault is encrypted and ready, the reason is cleared
    std::fs::write(root2.join("admin").join("plain").join(".keyring.json"), KEYRING).unwrap();
    let r = c.post(format!("{base2}/api/v/plain/reindex")).bearer_auth(&tok2).header("x-selfsync-e2ee", "1").send().await.unwrap();
    assert_eq!(r.status(), 200);
    let s: selfsync_server::protocol::StatusResponse = c.get(format!("{base2}/api/v/plain/status")).bearer_auth(&tok2).header("x-selfsync-e2ee", "1").send().await.unwrap().json().await.unwrap();
    assert_eq!((s.status.as_str(), s.detail.as_str()), ("ready", ""));
    let r = c.get(format!("{base2}/api/v/plain/keyring")).bearer_auth(&tok2).send().await.unwrap();
    assert_eq!(r.status(), 200);
}

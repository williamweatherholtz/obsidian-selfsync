// F4 (issueEndpointsRouterDrift): every route the wire-contract signature DECLARES (wire_signature::ENDPOINTS)
// must actually exist in the router — otherwise the client trusts a route the server no longer serves and hits
// an undiagnosable runtime 404 (the exact failure the compat feature exists to prevent). The signature's own
// drift-gate is generated FROM the ENDPOINTS const, so it can't catch the const diverging from the real axum
// routes; this test cross-checks it. A missing route returns 404 (unrouted); a present one returns anything
// else (401/400/405/426/200/…), so `status != 404` proves existence without needing auth or a valid body.
use new_livesync_server::{app, wire_signature, AppState};

async fn serve(router: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
    format!("http://{addr}")
}

#[tokio::test]
async fn every_declared_endpoint_exists_in_the_router() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::for_test(dir.path());
    std::mem::forget(dir); // keep the temp dir alive for the test process
    let base = serve(app(state)).await; // the MERGED router (public sync + admin) carries every client-facing route
    let client = reqwest::Client::new();

    // GUARD the guard (5-pass review): the "not-404 ⇒ route exists" premise holds ONLY while the router has no
    // catch-all fallback. If someone later adds a `.fallback()` (e.g. an SPA), EVERY probe would return non-404
    // and this drift test would silently become a no-op — a false pass exactly when drift is most likely. Assert
    // a definitely-unrouted path genuinely 404s first, so that regression fails HERE, loudly.
    let control = client.get(format!("{base}/definitely/not/a/real/route/xyzzy")).send().await.unwrap().status().as_u16();
    assert_eq!(control, 404, "an unrouted path must 404 — a router fallback would turn the endpoint-existence probe below into a no-op");

    for entry in wire_signature::declared_endpoints() {
        let (method, path) = entry.split_once(' ').unwrap_or_else(|| panic!("malformed ENDPOINTS entry: {entry}"));
        // Concretize path params (:vault, :owner, :hash, :id) with a placeholder so the route matches.
        let concrete: String = path
            .split('/')
            .map(|seg| if seg.starts_with(':') { "x" } else { seg })
            .collect::<Vec<_>>()
            .join("/");
        let url = format!("{base}{concrete}");
        let req = match method {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            "DELETE" => client.delete(&url),
            other => panic!("unknown method '{other}' in ENDPOINTS entry: {entry}"),
        };
        let status = req.send().await.unwrap().status().as_u16();
        assert_ne!(
            status, 404,
            "declared endpoint '{entry}' is NOT in the router (drift) — {method} {concrete} returned 404. \
             Update wire_signature.rs ENDPOINTS to match lib.rs build()'s routes."
        );
    }
}

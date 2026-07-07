use axum::Router;

pub mod admin;
pub mod admin_ui;
pub mod api;
pub mod auth;
pub mod chunkstore;
pub mod config;
pub mod hash;
pub mod error;
pub mod protocol;
pub mod registration;
pub mod shares;
pub mod state;
pub mod tokens;
pub mod users;
pub mod vault;
pub mod vaults;
pub mod ws;

pub use state::AppState;

pub fn app(state: AppState) -> Router {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post, put};
    // No CORS layer: the plugin talks to the server over a NATIVE HTTP client
    // (Obsidian requestUrl / mobile), which is not subject to the browser
    // same-origin policy, and the only browser consumer is the same-origin
    // /admin page. Emitting `Access-Control-Allow-Origin: *` would needlessly
    // let any web page script the API on a logged-in user's behalf. (SEC-LOW-2)
    Router::new()
        // Unauthenticated liveness + version handshake. Returns the protocol/index-schema version
        // (API_VERSION) so the client can detect an incompatible server before syncing and say
        // "upgrade one of them" instead of looping on a malformed response. `apiVersion` is
        // camelCase for the JS client; the field is stable wire contract.
        .route("/health", get(|| async {
            axum::Json(serde_json::json!({ "status": "ok", "apiVersion": crate::protocol::API_VERSION }))
        }))
        .route("/admin", get(admin_ui::page)) // web management UI (wraps /api/admin/*)
        .route("/api/login", post(auth::login))
        .route("/api/register", post(auth::register))
        .route("/api/vaults", get(vaults::list_vaults).post(vaults::create_vault))
        .route("/api/shared", get(api::shared_with_me)) // vaults shared WITH the caller
        // Own-vault sync routes: /api/v/{vault}/... (owner defaults to the caller).
        .route("/api/v/:vault/changes", get(api::changes))
        .route("/api/v/:vault/meta", get(api::file_meta))
        .route("/api/v/:vault/chunks/missing", post(api::chunks_missing))
        .route("/api/v/:vault/chunk/:hash", put(api::put_chunk).get(api::get_chunk))
        .route("/api/v/:vault/commit", post(api::commit))
        .route("/api/v/:vault/status", get(api::status))
        .route("/api/v/:vault/reindex", post(api::reindex))
        .route("/api/v/:vault/file", axum::routing::delete(api::delete_file))
        // Owner-qualified sync routes: /api/u/{owner}/{vault}/... — reach a vault owned by
        // someone else, gated by the share ACL (reindex stays own-vault only). A distinct
        // `/api/u/` prefix (not `/api/v/{owner}/...`) avoids a matchit param-name conflict.
        .route("/api/u/:owner/:vault/changes", get(api::changes))
        .route("/api/u/:owner/:vault/meta", get(api::file_meta))
        .route("/api/u/:owner/:vault/chunks/missing", post(api::chunks_missing))
        .route("/api/u/:owner/:vault/chunk/:hash", put(api::put_chunk).get(api::get_chunk))
        .route("/api/u/:owner/:vault/commit", post(api::commit))
        .route("/api/u/:owner/:vault/status", get(api::status))
        .route("/api/u/:owner/:vault/file", axum::routing::delete(api::delete_file))
        .route("/api/ws", get(ws::ws_handler))
        // Management API (authority behind the web admin UI). Owner-scoped share management
        // for any account; account/registration/invite management for the server-admin.
        .route("/api/admin/me", get(admin::me))
        .route("/api/admin/vaults", get(admin::my_vaults))
        .route("/api/admin/shares", post(admin::share_create).delete(admin::share_delete))
        // Operator repair of ANY vault's corrupt index (owner-scoped reindex is own-vault only;
        // this lets the server-admin fix a shared/non-owned vault without shelling in via curl).
        .route("/api/admin/reindex", post(admin::reindex))
        .route("/api/admin/vault", axum::routing::delete(admin::vault_delete)) // per-vault delete (RC-4)
        .route("/api/admin/users", get(admin::users_list).post(admin::users_create))
        .route("/api/admin/users/:name", axum::routing::delete(admin::users_delete))
        .route("/api/admin/registration", get(admin::registration_get).put(admin::registration_set))
        .route("/api/admin/invites", get(admin::invites_list).post(admin::invite_create))
        .route("/api/admin/invites/:id", axum::routing::delete(admin::invite_delete))
        .with_state(state)
        // Requests are small: one CDC chunk (~64 KiB) or a JSON metadata body. Cap the
        // buffered body at 16 MiB so a client can't force the server to buffer a huge
        // body in RAM (was 1 GiB — far larger than any legitimate request).
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}

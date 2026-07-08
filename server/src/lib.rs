use axum::Router;

pub mod admin;
pub mod admin_ui;
pub mod admins;
pub mod atomicfile;
pub mod api;
pub mod auth;
pub mod chunkstore;
pub mod config;
pub mod hash;
pub mod index_store;
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

// The merged router (public sync/login + admin) on one port — used in MERGE mode (D0021 opt-out).
pub fn app(state: AppState) -> Router { build(state, true, true) }

// PUBLIC-only router (D0021): sync + login + register + health. NO /admin, NO /api/admin/*, so an
// /api/admin/* request here 404s. This is what binds to the public port in the default split.
pub fn public_app(state: AppState) -> Router { build(state, true, false) }

// ADMIN-only router (D0021): /admin + /api/admin/* (+ /api/login so the admin page can authenticate,
// + /health for its own liveness). Binds to the private admin address in the default split.
pub fn admin_app(state: AppState) -> Router { build(state, false, true) }

// Shared route groups, composed per surface. No CORS layer: the plugin talks over a NATIVE HTTP
// client (Obsidian requestUrl / mobile), not subject to the browser same-origin policy, and the only
// browser consumer is the same-origin /admin page. `Access-Control-Allow-Origin: *` would needlessly
// let any web page script the API on a logged-in user's behalf. (SEC-LOW-2)
fn build(state: AppState, include_public: bool, include_admin: bool) -> Router {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post, put};
    // Shared on every surface: unauthenticated liveness + version handshake (apiVersion is stable
    // camelCase wire contract) and /api/login (the admin page authenticates here too).
    let mut r = Router::new()
        .route("/health", get(|| async {
            axum::Json(serde_json::json!({ "status": "ok", "apiVersion": crate::protocol::API_VERSION }))
        }))
        .route("/api/login", post(auth::login))
        // Owner self-service vault delete is SHARED on both surfaces: its only UI trigger is the admin
        // page (which serves on the PRIVATE admin port in the default split), but it's owner-scoped +
        // authenticated so it's safe on the public surface too. (Was public-only → 404'd from the
        // admin page in split mode — critique R8 correctness.)
        .route("/api/vault", axum::routing::delete(api::delete_own_vault));
    if include_public {
        r = r
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
            // someone else, gated by the share ACL. A distinct `/api/u/` prefix (not
            // `/api/v/{owner}/...`) avoids a matchit param-name conflict.
            .route("/api/u/:owner/:vault/changes", get(api::changes))
            .route("/api/u/:owner/:vault/meta", get(api::file_meta))
            .route("/api/u/:owner/:vault/chunks/missing", post(api::chunks_missing))
            .route("/api/u/:owner/:vault/chunk/:hash", put(api::put_chunk).get(api::get_chunk))
            .route("/api/u/:owner/:vault/commit", post(api::commit))
            .route("/api/u/:owner/:vault/status", get(api::status))
            .route("/api/u/:owner/:vault/file", axum::routing::delete(api::delete_file))
            .route("/api/ws", get(ws::ws_handler));
    }
    if include_admin {
        r = r
            .route("/admin", get(admin_ui::page)) // web management UI (wraps /api/admin/*)
            // Management API (authority behind the web admin UI). Owner-scoped share management
            // for any account; account/registration/invite management for the server-admin.
            .route("/api/admin/me", get(admin::me))
            .route("/api/admin/vaults", get(admin::my_vaults))
            .route("/api/admin/usernames", get(admin::usernames)) // grantee autocomplete (private surface)
            .route("/api/admin/shares", post(admin::share_create).delete(admin::share_delete))
            .route("/api/admin/reindex", post(admin::reindex))
            .route("/api/admin/vault", axum::routing::delete(admin::vault_delete)) // per-vault delete (RC-4)
            .route("/api/admin/prune-history", post(admin::prune_history)) // deliberate tombstone prune (tombstonePrune/D0019)
            .route("/api/admin/users", get(admin::users_list).post(admin::users_create))
            .route("/api/admin/users/:name", axum::routing::delete(admin::users_delete))
            .route("/api/admin/users/:name/admin", post(admin::admin_grant).delete(admin::admin_revoke)) // promote/demote (D0021)
            .route("/api/admin/registration", get(admin::registration_get).put(admin::registration_set))
            .route("/api/admin/invites", get(admin::invites_list).post(admin::invite_create))
            .route("/api/admin/invites/:id", axum::routing::delete(admin::invite_delete));
    }
    // Requests are small: one CDC chunk (~64 KiB) or a JSON metadata body. Cap the buffered body at
    // 16 MiB so a client can't force the server to buffer a huge body in RAM.
    r.with_state(state).layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}

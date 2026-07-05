use axum::Router;

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
pub mod users;
pub mod vault;
pub mod vaults;
pub mod ws;

pub use state::AppState;

pub fn app(state: AppState) -> Router {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post, put};
    use tower_http::cors::{Any, CorsLayer};
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/login", post(auth::login))
        .route("/api/register", post(auth::register))
        .route("/api/vaults", get(vaults::list_vaults).post(vaults::create_vault))
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
        .with_state(state)
        .layer(cors)
        // Requests are small: one CDC chunk (~64 KiB) or a JSON metadata body. Cap the
        // buffered body at 16 MiB so a client can't force the server to buffer a huge
        // body in RAM (was 1 GiB — far larger than any legitimate request).
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}

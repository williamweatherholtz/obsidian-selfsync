use axum::Router;

pub mod api;
pub mod auth;
pub mod chunkstore;
pub mod config;
pub mod hash;
pub mod error;
pub mod protocol;
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
        // vault-scoped sync routes: /api/v/{vault}/...
        .route("/api/v/:vault/changes", get(api::changes))
        .route("/api/v/:vault/chunks/missing", post(api::chunks_missing))
        .route("/api/v/:vault/chunk/:hash", put(api::put_chunk).get(api::get_chunk))
        .route("/api/v/:vault/commit", post(api::commit))
        .route("/api/v/:vault/status", get(api::status))
        .route("/api/v/:vault/reindex", post(api::reindex))
        .route("/api/v/:vault/file", axum::routing::delete(api::delete_file))
        .route("/api/ws", get(ws::ws_handler))
        .with_state(state)
        .layer(cors)
        .layer(DefaultBodyLimit::max(1024 * 1024 * 1024))
}

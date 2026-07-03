use axum::Router;

pub mod api;
pub mod auth;
pub mod chunkstore;
pub mod config;
pub mod hash;
pub mod protocol;
pub mod state;
pub mod vault;
pub mod ws;

pub use state::AppState;

pub fn app(state: AppState) -> Router {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post};
    use tower_http::cors::{Any, CorsLayer};
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/login", post(auth::login))
        .route("/api/vault/changes", get(api::changes))
        .route("/api/vault/file", get(api::get_file).put(api::put_file).delete(api::delete_file))
        .route("/api/ws", get(ws::ws_handler))
        .with_state(state)
        .layer(cors)
        .layer(DefaultBodyLimit::max(1024 * 1024 * 1024))
}

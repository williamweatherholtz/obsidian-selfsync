use axum::{routing::get, Router};

pub mod api;
pub mod auth;
pub mod config;
pub mod protocol;
pub mod state;
pub mod vault;
pub mod ws;

pub use state::AppState;

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .with_state(state)
}

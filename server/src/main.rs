use new_livesync_server::{app, config::Config, AppState};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let cfg = Config::from_env();
    let addr = cfg.bind_addr.clone();
    let state = AppState::new(cfg)?;
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("new-livesync-server listening on {addr}");
    axum::serve(listener, app(state)).await
}

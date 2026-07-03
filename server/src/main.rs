use new_livesync_server::{app, config::Config, AppState};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let cfg = Config::from_env();
    let addr = cfg.bind_addr.clone();
    let state = AppState::new(cfg)?;
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("new-livesync-server: FAILED to bind {addr}: {e}");
            eprintln!("  (is the port already in use? Docker Desktop commonly holds 8080)");
            return Err(e);
        }
    };
    // Print the ACTUAL bound address (so `:0` ephemeral ports are discoverable).
    let local = listener.local_addr()?;
    eprintln!("new-livesync-server listening on {local}");
    axum::serve(listener, app(state)).await
}

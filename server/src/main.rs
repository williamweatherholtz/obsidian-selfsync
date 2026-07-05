use new_livesync_server::{app, config::Config, AppState};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let cfg = Config::from_env();
    // SEC: refuse to boot with the default/unset admin password (SYNC_PASSWORD == "admin"), which
    // would ship a publicly-known admin login on any exposed server. A trusted LAN/dev box can
    // opt in explicitly with ALLOW_WEAK_ADMIN=1.
    if cfg.password == "admin" && std::env::var("ALLOW_WEAK_ADMIN").ok().as_deref() != Some("1") {
        eprintln!("new-livesync-server: REFUSING to start — SYNC_PASSWORD is unset or 'admin' (default admin credentials).");
        eprintln!("  Set a strong SYNC_PASSWORD. For a trusted LAN/dev instance only, set ALLOW_WEAK_ADMIN=1 to override.");
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "default admin password refused"));
    }
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

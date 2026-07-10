use new_livesync_server::{admin_app, app, config::Config, public_app, AppState};
use log::{error, info, warn};
use std::future::IntoFuture;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Leveled logging, report level from the LOG_LEVEL env var (default "info"); e.g. LOG_LEVEL=warn
    // in the compose stack shows only warnings + errors. No timestamp — the container runtime adds one.
    env_logger::Builder::from_env(env_logger::Env::default().filter_or("LOG_LEVEL", "info"))
        .format_timestamp(None)
        .init();
    let cfg = Config::from_env();
    // SEC: refuse to boot with the default/unset admin password (SYNC_PASSWORD == "admin"), which
    // would ship a publicly-known admin login on any exposed server. A trusted LAN/dev box can
    // opt in explicitly with ALLOW_WEAK_ADMIN=1.
    let allow_weak = std::env::var("ALLOW_WEAK_ADMIN").ok().as_deref() == Some("1");
    if new_livesync_server::config::weak_admin_refused(&cfg.password, allow_weak) {
        error!("REFUSING to start — SYNC_PASSWORD is unset or 'admin' (default admin credentials). Set a strong SYNC_PASSWORD. For a trusted LAN/dev instance only, set ALLOW_WEAK_ADMIN=1 to override.");
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "default admin password refused"));
    }
    let public_addr = cfg.bind_addr.clone();
    let admin_bind = cfg.admin_bind.clone();
    let state = AppState::new(cfg)?;

    // Bind a listener + report the ACTUAL bound address (so `:0` ephemeral ports are discoverable).
    async fn bind(addr: &str, label: &str) -> std::io::Result<tokio::net::TcpListener> {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => {
                let local = l.local_addr()?;
                info!("{label} listening on {local}");
                Ok(l)
            }
            Err(e) => {
                error!("FAILED to bind {label} at {addr}: {e} (is the port already in use? Docker Desktop commonly holds 8080)");
                Err(e)
            }
        }
    }

    match admin_bind {
        // MERGE (opt-out): the admin surface shares the public port — one server, today's behavior.
        None => {
            warn!("admin surface MERGED onto the public port (ADMIN_BIND_ADDR=merge) — the /admin page is reachable on the public port.");
            let listener = bind(&public_addr, "public+admin").await?;
            axum::serve(listener, app(state)).await
        }
        // SPLIT (safe default): public sync/login on the public port, /admin + /api/admin/* on a
        // separate private (localhost-only by default) port. Expose ONLY the public port via a
        // reverse proxy; reach admin over localhost / an SSH or VPN tunnel.
        Some(admin_addr) => {
            info!("admin surface SPLIT to a separate private port (safe default). Reverse-proxy ONLY the public port; the admin port is not exposed. Set ADMIN_BIND_ADDR=merge for a single-port setup.");
            let public_listener = bind(&public_addr, "public (sync/login)").await?;
            let admin_listener = bind(&admin_addr, "admin (PRIVATE)").await?;
            let public = axum::serve(public_listener, public_app(state.clone())).into_future();
            let admin = axum::serve(admin_listener, admin_app(state)).into_future();
            // Run both until one exits/errors (each serves forever in normal operation).
            tokio::try_join!(public, admin)?;
            Ok(())
        }
    }
}

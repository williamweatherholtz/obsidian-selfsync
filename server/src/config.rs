use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_root: PathBuf,
    pub bind_addr: String,
    // Where the ADMIN surface (/admin + /api/admin/*) binds (D0021). None ⇒ MERGE onto bind_addr
    // (admin shares the public port). Some(addr) ⇒ SPLIT: admin serves only there. SAFE BY DEFAULT:
    // when ADMIN_BIND_ADDR is unset this defaults to a private localhost-only address (127.0.0.1 on
    // the public port + 1), so a naive deploy never exposes account management on the public port;
    // ADMIN_BIND_ADDR=merge is the explicit opt-out for a trusted/all-in-one single-port setup.
    pub admin_bind: Option<String>,
    pub vault: String,
    pub user: String,
    pub password: String,
    pub registration: String, // "open" | "invite" | "closed"
    pub invite_code: String,  // shared secret required when registration == "invite"
    // SEC-CMMC (AC.3.1.9 — system-use notification / consent banner). Shown to a user BEFORE they
    // authenticate. Empty ⇒ no banner. Set SYNC_LOGIN_BANNER to the operator's authorized-use notice
    // (e.g. a DoD standard consent banner for a CUI system). Surfaced by /health and rendered pre-auth.
    pub login_banner: String,
}

// The port from a "host:port" (or "[ipv6]:port") bind string.
fn port_of(addr: &str) -> Option<u16> {
    addr.rsplit(':').next().and_then(|p| p.parse::<u16>().ok())
}

// Derive the safe default admin address from the public bind: localhost on the public port + 1.
// Returns None (=> MERGE) when the public port is EPHEMERAL (0) or unparseable — a split can't derive
// a stable admin port there (e.g. a test/dynamic :0 bind would otherwise try to bind port 1 and fail).
// Localhost-only so it's reachable only from the host / an explicit tunnel, never off-box by default.
fn default_admin_bind(bind_addr: &str) -> Option<String> {
    match port_of(bind_addr) {
        Some(0) => None, // ephemeral public port → merge (no stable admin port to derive)
        Some(p) if p < u16::MAX => Some(format!("127.0.0.1:{}", p + 1)),
        _ => Some("127.0.0.1:8081".to_string()),
    }
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let bind_addr = env("BIND_ADDR", "0.0.0.0:8080");
        // ADMIN_BIND_ADDR: unset ⇒ safe default split (localhost:port+1); "merge" (or == bind_addr) ⇒
        // opt-out to one port; any other value ⇒ split at that explicit address.
        let admin_bind = match std::env::var("ADMIN_BIND_ADDR").ok().as_deref() {
            None | Some("") => default_admin_bind(&bind_addr),
            Some("merge") => None,
            // Same PORT as the public bind ⇒ MERGE — two listeners on one port can't coexist even on
            // different interface strings (0.0.0.0:8080 vs 127.0.0.1:8080), so this would otherwise
            // fail the second bind and refuse to start. Compare ports, not full strings. (An exotic
            // genuinely-distinct-NIC same-port split is not supported; use different ports.)
            Some(a) if port_of(a).is_some() && port_of(a) == port_of(&bind_addr) => None,
            Some(a) => Some(a.to_string()),
        };
        Config {
            data_root: PathBuf::from(env("DATA_ROOT", "./data")),
            bind_addr,
            admin_bind,
            vault: env("VAULT", "vault"),
            user: env("SYNC_USER", "admin"),
            password: env("SYNC_PASSWORD", "admin"),
            registration: env("REGISTRATION", "closed"),
            invite_code: env("INVITE_CODE", ""),
            login_banner: env("SYNC_LOGIN_BANNER", ""),
        }
    }
}

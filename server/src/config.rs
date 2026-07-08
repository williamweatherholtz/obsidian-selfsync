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
}

// Derive the safe default admin address from the public bind: localhost on the public port + 1.
// Falls back to 127.0.0.1:8081 if the public port can't be parsed. Localhost-only so it's reachable
// only from the host (or an explicit SSH/VPN tunnel), never off-box by default.
fn default_admin_addr(bind_addr: &str) -> String {
    let port = bind_addr.rsplit(':').next().and_then(|p| p.parse::<u16>().ok());
    match port {
        Some(p) if p < u16::MAX => format!("127.0.0.1:{}", p + 1),
        _ => "127.0.0.1:8081".to_string(),
    }
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let bind_addr = env("BIND_ADDR", "0.0.0.0:8080");
        // ADMIN_BIND_ADDR: unset ⇒ safe default split (localhost:port+1); "merge" (or == bind_addr) ⇒
        // opt-out to one port; any other value ⇒ split at that explicit address.
        let admin_bind = match std::env::var("ADMIN_BIND_ADDR").ok().as_deref() {
            None | Some("") => Some(default_admin_addr(&bind_addr)),
            Some("merge") => None,
            Some(a) if a == bind_addr => None, // same address as public ⇒ merge (can't bind twice)
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
        }
    }
}

use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_root: PathBuf,
    pub bind_addr: String,
    pub vault: String,
    pub user: String,
    pub password: String,
    pub registration: String, // "open" | "invite" | "closed"
    pub invite_code: String,  // shared secret required when registration == "invite"
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        Config {
            data_root: PathBuf::from(env("DATA_ROOT", "./data")),
            bind_addr: env("BIND_ADDR", "0.0.0.0:8080"),
            vault: env("VAULT", "vault"),
            user: env("SYNC_USER", "admin"),
            password: env("SYNC_PASSWORD", "admin"),
            registration: env("REGISTRATION", "closed"),
            invite_code: env("INVITE_CODE", ""),
        }
    }
}

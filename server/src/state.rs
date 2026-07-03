use crate::config::Config;
use crate::vault::Vault;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub vault: Arc<Mutex<Vault>>,
    pub tokens: Arc<Mutex<HashSet<String>>>,
    pub tx: broadcast::Sender<u64>,
}

impl AppState {
    pub fn new(cfg: Config) -> std::io::Result<Self> {
        let vault = Vault::open(&cfg.data_root.join(&cfg.vault))?;
        let (tx, _rx) = broadcast::channel(256);
        Ok(AppState {
            cfg: Arc::new(cfg),
            vault: Arc::new(Mutex::new(vault)),
            tokens: Arc::new(Mutex::new(HashSet::new())),
            tx,
        })
    }

    pub fn for_test(data_root: &Path) -> Self {
        let cfg = Config {
            data_root: data_root.to_path_buf(),
            bind_addr: "127.0.0.1:0".into(),
            vault: "vault".into(),
            user: "admin".into(),
            password: "admin".into(),
        };
        AppState::new(cfg).unwrap()
    }
}

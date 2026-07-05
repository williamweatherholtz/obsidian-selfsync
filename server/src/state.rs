use crate::config::Config;
use crate::registration::{Mode, RegistrationStore};
use crate::shares::ShareStore;
use crate::users::{safe_name, UserStore};
use crate::vault::Vault;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::broadcast;

// A lazily-opened per-(user,vault) namespace: the Vault plus its own change
// broadcast channel (so a client only wakes for its own vault). The Vault is behind
// an RwLock so reads/uploads run concurrently and only mutations are exclusive.
#[derive(Clone)]
pub struct VaultHandle {
    pub vault: Arc<RwLock<Vault>>,
    pub tx: broadcast::Sender<u64>,
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub users: Arc<Mutex<UserStore>>,
    pub shares: Arc<Mutex<ShareStore>>, // vault access-control list (.shares.json)
    pub registration: Arc<Mutex<RegistrationStore>>, // policy + invite tokens (.registration.json)
    pub tokens: Arc<Mutex<HashMap<String, String>>>, // token -> username
    ns: Arc<Mutex<HashMap<(String, String), VaultHandle>>>, // (user,vault) -> handle
}

impl AppState {
    pub fn new(cfg: Config) -> std::io::Result<Self> {
        std::fs::create_dir_all(&cfg.data_root)?;
        let mut users = UserStore::open(&cfg.data_root.join(".users.json"))?;
        // Back-compat bootstrap: seed the configured account + its default vault
        // on a fresh store so existing single-user setups keep working.
        if users.is_empty() && !cfg.user.is_empty() && safe_name(&cfg.user) {
            users.register(&cfg.user, &cfg.password)?;
        }
        let shares = ShareStore::open(&cfg.data_root.join(".shares.json"))?;
        // Seed the registration policy from the env config on FIRST run only; after that
        // it's runtime-managed via the admin API (persisted in .registration.json).
        let reg_path = cfg.data_root.join(".registration.json");
        let fresh_reg = !reg_path.exists();
        let mut registration = RegistrationStore::open(&reg_path)?;
        if fresh_reg {
            let mode = if cfg.registration == "open" { Mode::Open } else { Mode::Closed };
            registration.set_mode(mode)?;
        }
        let state = AppState {
            cfg: Arc::new(cfg),
            users: Arc::new(Mutex::new(users)),
            shares: Arc::new(Mutex::new(shares)),
            registration: Arc::new(Mutex::new(registration)),
            tokens: Arc::new(Mutex::new(HashMap::new())),
            ns: Arc::new(Mutex::new(HashMap::new())),
        };
        // Ensure the bootstrap account has a `default` vault to land in.
        if safe_name(&state.cfg.user) {
            let _ = state.vault(&state.cfg.user, "default");
        }
        Ok(state)
    }

    fn ns_dir(&self, user: &str, vault: &str) -> std::path::PathBuf {
        self.cfg.data_root.join(user).join(vault)
    }

    // Open (and cache) the namespace for (user, vault). Names must be safe.
    pub fn vault(&self, user: &str, vault: &str) -> std::io::Result<VaultHandle> {
        if !safe_name(user) || !safe_name(vault) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid user/vault name"));
        }
        let key = (user.to_string(), vault.to_string());
        {
            let map = self.ns.lock().map_err(|_| std::io::Error::other("namespace lock poisoned"))?;
            if let Some(h) = map.get(&key) { return Ok(h.clone()); }
        }
        let v = Vault::open(&self.ns_dir(user, vault))?;
        let (tx, _rx) = broadcast::channel(256);
        let handle = VaultHandle { vault: Arc::new(RwLock::new(v)), tx };
        let mut map = self.ns.lock().map_err(|_| std::io::Error::other("namespace lock poisoned"))?;
        // Another thread may have opened it meanwhile — keep the first.
        Ok(map.entry(key).or_insert(handle).clone())
    }

    // Vaults that exist on disk for a user (directories under DATA_ROOT/<user>).
    pub fn list_vaults(&self, user: &str) -> Vec<String> {
        if !safe_name(user) { return vec![]; }
        let mut out = vec![];
        if let Ok(rd) = std::fs::read_dir(self.cfg.data_root.join(user)) {
            for e in rd.flatten() {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if let Some(n) = e.file_name().to_str() { out.push(n.to_string()); }
                }
            }
        }
        out.sort();
        out
    }

    pub fn for_test(data_root: &Path) -> Self {
        let cfg = Config {
            data_root: data_root.to_path_buf(),
            bind_addr: "127.0.0.1:0".into(),
            vault: "vault".into(),
            user: "admin".into(),
            password: "admin".into(),
            registration: "open".into(),
            invite_code: String::new(),
        };
        AppState::new(cfg).unwrap()
    }
}

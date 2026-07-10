use crate::config::Config;
use crate::registration::{Mode, RegistrationStore};
use crate::shares::ShareStore;
use crate::tokens::TokenStore;
use crate::users::{safe_name, UserStore};
use crate::vault::Vault;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

// Hard ceiling on concurrently-open change-notification WebSockets across all vaults, so a
// client (or a runaway reconnect loop) can't pin unbounded tasks/sockets. Generous for a
// self-hosted deployment's device count. (concurrency: WS connection cap)
pub const MAX_WS_CONNECTIONS: usize = 512;

// RS-1 (Round-7 scale): bound resident vault handles. The ns map was insert-only (removed only on
// account/vault delete), so every vault ever opened stayed fully in RAM (its whole Index) for the
// process's life. When the map reaches this soft cap, opening a new vault first evicts IDLE ones
// (not accessed in IDLE_EVICT) that have NO live WS subscribers — safe (an active/subscribed vault
// is never evicted; a re-open re-reads from disk) and non-thrashing (the idle window >> the 4s poll).
pub const MAX_CACHED_VAULTS: usize = 256;
const IDLE_EVICT: Duration = Duration::from_secs(600); // 10 min

// A lazily-opened per-(user,vault) namespace: the Vault plus its own change
// broadcast channel (so a client only wakes for its own vault). The Vault is behind
// an RwLock so reads/uploads run concurrently and only mutations are exclusive.
// `last_access` drives idle eviction (RS-1).
#[derive(Clone)]
pub struct VaultHandle {
    pub vault: Arc<RwLock<Vault>>,
    pub tx: broadcast::Sender<u64>,
    pub last_access: Arc<Mutex<Instant>>,
}

// RS-1 eviction predicate: a handle is "in use" (never evict) if it has a live WS subscriber OR was
// accessed within IDLE_EVICT. Keeps active/subscribed vaults; a poisoned lock keeps it (fail-safe).
fn handle_in_use(h: &VaultHandle, now: Instant) -> bool {
    h.tx.receiver_count() > 0
        || h.last_access.lock().map(|la| now.duration_since(*la) < IDLE_EVICT).unwrap_or(true)
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub users: Arc<Mutex<UserStore>>,
    pub shares: Arc<Mutex<ShareStore>>, // vault access-control list (.shares.json)
    pub registration: Arc<Mutex<RegistrationStore>>, // policy + invite tokens (.registration.json)
    pub admins: Arc<Mutex<crate::admins::AdminStore>>, // promoted server-admins beyond the bootstrap (.admins.json, D0021)
    pub tokens: Arc<Mutex<TokenStore>>, // durable, expiring, revocable session tokens (.tokens.json)
    ns: Arc<Mutex<HashMap<(String, String), VaultHandle>>>, // (user,vault) -> handle
    pub ws_conns: Arc<AtomicUsize>, // live WebSocket count (bounded by MAX_WS_CONNECTIONS)
    // Bounds concurrent argon2 password hashing (login/register): argon2 is deliberately
    // memory-hard (~19 MiB each), so an unauthenticated flood could otherwise exhaust CPU+RAM.
    // A small permit pool caps in-flight hashes; excess auth requests queue briefly. (SEC-2)
    pub auth_slots: Arc<tokio::sync::Semaphore>,
    // SEC-AUTH (FR9): per-account login throttle / lockout — brute-force protection for the
    // internet-facing front door (the design docs promised rate-limiting; it was never built).
    pub login_throttle: Arc<Mutex<crate::throttle::LoginThrottle>>,
}

// Max concurrent password-hash operations across all login/register requests. (SEC-2)
pub const MAX_CONCURRENT_AUTH_HASHES: usize = 8;

impl AppState {
    pub fn new(cfg: Config) -> std::io::Result<Self> {
        std::fs::create_dir_all(&cfg.data_root)?;
        let mut users = UserStore::open(&cfg.data_root.join(".users.json"))?;
        // Back-compat bootstrap: seed the configured account + its default vault
        // on a fresh store so existing single-user setups keep working.
        if !cfg.user.is_empty() && safe_name(&cfg.user) {
            if users.is_empty() {
                users.register(&cfg.user, &cfg.password)?;
            } else {
                // S1 (R10): keep SYNC_PASSWORD authoritative for the bootstrap admin on EVERY boot so
                // the admin password can actually be ROTATED (change the env + restart). Previously it
                // seeded only a fresh store, so a rotation silently no-op'd and a compromised password
                // stayed valid. No-op if the account was deleted (never resurrected).
                users.set_password(&cfg.user, &cfg.password)?;
            }
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
        let tokens = TokenStore::open(&cfg.data_root.join(".tokens.json"))?;
        let admins = crate::admins::AdminStore::open(&cfg.data_root.join(".admins.json"))?;
        let state = AppState {
            cfg: Arc::new(cfg),
            users: Arc::new(Mutex::new(users)),
            shares: Arc::new(Mutex::new(shares)),
            registration: Arc::new(Mutex::new(registration)),
            admins: Arc::new(Mutex::new(admins)),
            tokens: Arc::new(Mutex::new(tokens)),
            ns: Arc::new(Mutex::new(HashMap::new())),
            ws_conns: Arc::new(AtomicUsize::new(0)),
            auth_slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_AUTH_HASHES)),
            login_throttle: Arc::new(Mutex::new(crate::throttle::LoginThrottle::new())),
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
            if let Some(h) = map.get(&key) {
                if let Ok(mut la) = h.last_access.lock() { *la = Instant::now(); } // touch for idle eviction
                return Ok(h.clone());
            }
        }
        let v = Vault::open(&self.ns_dir(user, vault))?;
        let (tx, _rx) = broadcast::channel(256);
        let handle = VaultHandle { vault: Arc::new(RwLock::new(v)), tx, last_access: Arc::new(Mutex::new(Instant::now())) };
        let mut map = self.ns.lock().map_err(|_| std::io::Error::other("namespace lock poisoned"))?;
        // RS-1: bound resident handles — before inserting a new one, evict IDLE vaults with no live
        // WS subscribers. Keeps active/subscribed vaults (an evicted one just re-opens from disk on
        // next access); an in-flight op holds its own Arc, so removal never breaks it.
        if map.len() >= MAX_CACHED_VAULTS {
            let now = Instant::now();
            map.retain(|_, h| handle_in_use(h, now));
        }
        // Another thread may have opened it meanwhile — keep the first.
        Ok(map.entry(key).or_insert(handle).clone())
    }

    // Does this (user, vault) already exist on disk? Sync routes require an EXISTING vault —
    // provisioning goes through POST /api/vaults (create_vault). Without this, any GET to a
    // sync route would lazily create+persist an arbitrary vault dir in the caller's namespace
    // (a self-namespaced junk-dir amplification). (protocol-6 auto-provision)
    pub fn vault_exists(&self, user: &str, vault: &str) -> bool {
        safe_name(user) && safe_name(vault) && self.ns_dir(user, vault).is_dir()
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

    // Remove ALL of a user's vault data on account delete — the cached in-RAM handles AND the
    // on-disk directory — so a recreated username can never inherit the prior owner's notes/chunks
    // (SEC-MED-2 data remanence). Best-effort on the dir (a locked file shouldn't wedge the delete).
    pub fn purge_user_data(&self, user: &str) -> std::io::Result<()> {
        if !safe_name(user) { return Ok(()); } // the admin route already validated; defensive
        if let Ok(mut map) = self.ns.lock() {
            map.retain(|(u, _), _| u != user); // drop cached handles so a reopen can't serve a stale index
        }
        let dir = self.cfg.data_root.join(user);
        if dir.exists() { std::fs::remove_dir_all(&dir)?; }
        Ok(())
    }

    // Remove ONE vault's data (cached handle + on-disk dir) — the operator's per-vault delete
    // (Round-7 RC-4), the finer-grained complement to purge_user_data. Best-effort on the dir.
    pub fn purge_vault(&self, owner: &str, vault: &str) -> std::io::Result<()> {
        if !safe_name(owner) || !safe_name(vault) { return Ok(()); }
        // Drop this vault's share grants FIRST (R17). Otherwise a grant lingers invisibly (my_vaults
        // only lists existing vaults) and silently REACTIVATES if the owner later recreates a vault of
        // the same name — re-exposing new content to a prior grantee. Account-delete already purges
        // grants (purge_user); vault-delete must too. FAIL LOUD on a poisoned lock (R18): skipping the
        // purge but still removing the dir + returning Ok would silently reopen the reactivation
        // window — so propagate the error and DON'T remove the dir (no half-state), matching every
        // other shares access.
        self.shares.lock().map_err(|_| std::io::Error::other("shares lock poisoned"))?.purge_vault(owner, vault)?;
        if let Ok(mut map) = self.ns.lock() { map.remove(&(owner.to_string(), vault.to_string())); }
        let dir = self.ns_dir(owner, vault);
        if dir.exists() { std::fs::remove_dir_all(&dir)?; }
        Ok(())
    }

    pub fn for_test(data_root: &Path) -> Self {
        let cfg = Config {
            data_root: data_root.to_path_buf(),
            bind_addr: "127.0.0.1:0".into(),
            admin_bind: None, // tests use the merged in-process app; no separate admin bind
            vault: "vault".into(),
            user: "admin".into(),
            password: "admin".into(),
            registration: "open".into(),
            invite_code: String::new(),
            login_banner: String::new(),
        };
        let st = AppState::new(cfg).unwrap();
        // Tests exercise the sync routes against a `vault` namespace; provision it here (the
        // bootstrap only makes `default`) so vault_exists() gating in scoped() lets them through.
        let _ = st.vault("admin", "vault");
        st
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // RS-1: the eviction predicate keeps a subscribed or recently-accessed handle and drops an
    // idle, unsubscribed one — so a busy/connected vault is never evicted while idle ones bound RAM.
    #[test]
    fn idle_handle_evictable_unless_subscribed_or_recent() {
        let dir = tempfile::tempdir().unwrap();
        let st = AppState::for_test(dir.path());
        let h = st.vault("admin", "vault").unwrap();
        // Backdate last access beyond the idle window; no WS subscriber -> evictable.
        *h.last_access.lock().unwrap() = Instant::now() - IDLE_EVICT - Duration::from_secs(1);
        assert!(!handle_in_use(&h, Instant::now()), "idle + no subscriber -> evictable");
        // A live WS subscriber pins it even when idle.
        let rx = h.tx.subscribe();
        assert!(handle_in_use(&h, Instant::now()), "idle but subscribed -> kept");
        drop(rx);
        // Recently accessed -> kept regardless of subscribers.
        *h.last_access.lock().unwrap() = Instant::now();
        assert!(handle_in_use(&h, Instant::now()), "recently accessed -> kept");
    }
}

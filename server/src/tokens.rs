use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// Bearer session tokens, persisted to DATA_ROOT/.tokens.json (atomic JSON, no DB, D0005),
// so a login survives a server restart instead of being lost (previously in-memory only).
// Tokens are stored HASHED (sha256) — the plaintext lives only on the client; a leaked
// .tokens.json grants nothing. Tokens EXPIRE (30 days) and are REVOCABLE (per user), which
// matters now that vaults can be shared across accounts.
const TOKEN_TTL_SECS: u64 = 30 * 24 * 3600;

#[derive(Serialize, Deserialize, Clone)]
struct TokenRec {
    user: String,
    expires_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct TokensFile {
    tokens: HashMap<String, TokenRec>, // key = sha256(token)
}

pub struct TokenStore {
    path: PathBuf,
    file: TokensFile,
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl TokenStore {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let mut file: TokensFile = match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!(".tokens.json is corrupt ({e})"))
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => TokensFile::default(),
            Err(e) => return Err(e),
        };
        // R22 LOW: sweep expired tokens on load. Without this the store grows monotonically —
        // an expired token hash is only ever pruned when THAT exact token is presented again
        // (resolve), which never happens after a client re-logs-in, so it lingers in RAM and in
        // .tokens.json across restarts forever. Bounded, honest (never resurrects a live token).
        let mut store = TokenStore { path: path.to_path_buf(), file: TokensFile::default() };
        let before = file.tokens.len();
        file.tokens.retain(|_, r| r.expires_at > now());
        store.file = file;
        if store.file.tokens.len() != before { let _ = store.save(); }
        Ok(store)
    }

    fn save(&self) -> std::io::Result<()> {
        crate::atomicfile::atomic_write(&self.path, &serde_json::to_vec(&self.file)?) // fsync-durable (R12-CC2)
    }

    pub fn issue(&mut self, user: &str) -> std::io::Result<String> {
        self.issue_ttl(user, TOKEN_TTL_SECS)
    }

    // Issue a bearer token for `user`; returns the plaintext ONCE (only its hash is stored).
    pub fn issue_ttl(&mut self, user: &str, ttl_secs: u64) -> std::io::Result<String> {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.file.tokens.insert(sha256_hex(&token), TokenRec { user: user.to_string(), expires_at: now() + ttl_secs });
        self.save()?;
        Ok(token)
    }

    // Resolve a token to its user iff present and unexpired; prunes an expired token.
    pub fn resolve(&mut self, token: &str) -> Option<String> {
        let h = sha256_hex(token);
        match self.file.tokens.get(&h) {
            Some(rec) if rec.expires_at > now() => Some(rec.user.clone()),
            Some(_) => { self.file.tokens.remove(&h); let _ = self.save(); None } // expired
            None => None,
        }
    }

    // Revoke a SINGLE session by its plaintext token (server-side logout, SEC-AUTH). Idempotent:
    // an unknown/already-expired token is a no-op success — the caller only cares that it's gone.
    pub fn revoke(&mut self, token: &str) -> std::io::Result<()> {
        if self.file.tokens.remove(&sha256_hex(token)).is_some() { self.save() } else { Ok(()) }
    }

    // Revoke every session for a user (e.g. when the account is deleted). Takes effect at once.
    pub fn revoke_user(&mut self, user: &str) -> std::io::Result<()> {
        let before = self.file.tokens.len();
        self.file.tokens.retain(|_, r| r.user != user);
        if self.file.tokens.len() != before { self.save() } else { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, TokenStore) {
        let dir = tempdir().unwrap();
        let s = TokenStore::open(&dir.path().join(".tokens.json")).unwrap();
        (dir, s)
    }

    #[test]
    fn issue_then_resolve_returns_user() {
        let (_d, mut s) = store();
        let t = s.issue("alice").unwrap();
        assert_eq!(s.resolve(&t).as_deref(), Some("alice"));
        assert_eq!(s.resolve("bogus"), None);
    }

    #[test]
    fn expired_token_does_not_resolve() {
        let (_d, mut s) = store();
        let t = s.issue_ttl("alice", 0).unwrap(); // already expired (expires_at = now)
        assert_eq!(s.resolve(&t), None);
    }

    #[test]
    fn revoke_user_kills_all_their_sessions() {
        let (_d, mut s) = store();
        let a1 = s.issue("alice").unwrap();
        let a2 = s.issue("alice").unwrap();
        let b = s.issue("bob").unwrap();
        s.revoke_user("alice").unwrap();
        assert_eq!(s.resolve(&a1), None);
        assert_eq!(s.resolve(&a2), None);
        assert_eq!(s.resolve(&b).as_deref(), Some("bob")); // bob unaffected
    }

    #[test]
    fn open_sweeps_expired_tokens_but_keeps_live_ones() { // R22 LOW: unbounded leak guard
        let dir = tempdir().unwrap();
        let p = dir.path().join(".tokens.json");
        let live = {
            let mut s = TokenStore::open(&p).unwrap();
            s.issue_ttl("alice", 0).unwrap();      // expired the instant it's written
            s.issue("bob").unwrap()                // live (30-day TTL)
        };
        // Reopen: the expired token must be pruned from the file, the live one preserved.
        let mut s = TokenStore::open(&p).unwrap();
        assert_eq!(s.resolve(&live).as_deref(), Some("bob"), "live token survives the sweep");
        // Only ONE record remains on disk (the live one) — the expired hash was swept, not left to leak.
        let reopened = TokenStore::open(&p).unwrap();
        assert_eq!(reopened.file.tokens.len(), 1, "expired token swept on load, not accumulated");
    }

    #[test]
    fn survives_reopen_and_stores_only_hashes() {
        let dir = tempdir().unwrap();
        let p = dir.path().join(".tokens.json");
        let t = {
            let mut s = TokenStore::open(&p).unwrap();
            s.issue("alice").unwrap()
        };
        // reopened store still resolves the token (durable across restart)
        assert_eq!(TokenStore::open(&p).unwrap().resolve(&t).as_deref(), Some("alice"));
        // plaintext token never persisted
        assert!(!std::fs::read_to_string(&p).unwrap().contains(&t));
    }
}

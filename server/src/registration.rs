use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// Account registration policy + single-use invite tokens, persisted to
// DATA_ROOT/.registration.json (filesystem JSON, atomic write — no DB, D0005).
// Closed by default: registration needs a valid single-use token unless the admin
// opens it. Tokens are stored HASHED (sha256 of a high-entropy random secret) — the
// plaintext is shown once at issue and never persisted.

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Closed,
    Open,
}

#[derive(Serialize, Deserialize, Clone)]
struct TokenRec {
    id: String,               // stable id for admin listing/revocation (not a secret)
    hash: String,             // sha256 hex of the token secret
    label: String,            // free note (e.g. who it's for)
    expires_at: Option<u64>,  // epoch secs; None = no expiry
}

// Public metadata for the admin view — never the hash or plaintext.
#[derive(Serialize, Clone)]
pub struct TokenInfo {
    pub id: String,
    pub label: String,
    pub expires_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct RegFile {
    mode: Mode,
    tokens: Vec<TokenRec>,
}

pub struct RegistrationStore {
    path: PathBuf,
    file: RegFile,
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl RegistrationStore {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let file: RegFile = match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!(".registration.json is corrupt ({e})"))
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => RegFile::default(),
            Err(e) => return Err(e),
        };
        Ok(RegistrationStore { path: path.to_path_buf(), file })
    }

    fn save(&self) -> std::io::Result<()> {
        crate::atomicfile::atomic_write(&self.path, &serde_json::to_vec(&self.file)?) // fsync-durable (R12-CC2)
    }

    pub fn mode(&self) -> Mode {
        self.file.mode
    }

    pub fn set_mode(&mut self, mode: Mode) -> std::io::Result<()> {
        self.file.mode = mode;
        self.save()
    }

    // Issue a new single-use token; returns the plaintext secret ONCE (only its hash is
    // stored). ttl_secs = optional expiry from now.
    pub fn issue(&mut self, label: &str, ttl_secs: Option<u64>) -> std::io::Result<String> {
        let secret = uuid::Uuid::new_v4().simple().to_string();
        let rec = TokenRec {
            id: uuid::Uuid::new_v4().to_string(),
            hash: sha256_hex(&secret),
            label: label.to_string(),
            expires_at: ttl_secs.map(|t| now_secs() + t),
        };
        self.file.tokens.push(rec);
        self.save()?;
        Ok(secret)
    }

    // Redeem a token: valid iff it matches an unexpired stored token. Single-use — a
    // successful redeem consumes it. Expired tokens are also pruned as a side effect.
    pub fn redeem(&mut self, secret: &str) -> bool {
        let now = now_secs();
        let hash = sha256_hex(secret);
        let before = self.file.tokens.len();
        self.file.tokens.retain(|t| t.expires_at.map(|e| e > now).unwrap_or(true)); // drop expired
        let pos = self.file.tokens.iter().position(|t| t.hash == hash);
        let ok = if let Some(i) = pos {
            self.file.tokens.remove(i); // single-use
            true
        } else {
            false
        };
        if ok || self.file.tokens.len() != before {
            let _ = self.save();
        }
        ok
    }

    pub fn list(&self) -> Vec<TokenInfo> {
        self.file
            .tokens
            .iter()
            .map(|t| TokenInfo { id: t.id.clone(), label: t.label.clone(), expires_at: t.expires_at })
            .collect()
    }

    pub fn revoke(&mut self, id: &str) -> std::io::Result<bool> {
        let before = self.file.tokens.len();
        self.file.tokens.retain(|t| t.id != id);
        let removed = self.file.tokens.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, RegistrationStore) {
        let dir = tempdir().unwrap();
        let s = RegistrationStore::open(&dir.path().join(".registration.json")).unwrap();
        (dir, s)
    }

    #[test]
    fn default_mode_is_closed() {
        let (_d, s) = store();
        assert_eq!(s.mode(), Mode::Closed);
    }

    #[test]
    fn set_mode_persists() {
        let dir = tempdir().unwrap();
        let p = dir.path().join(".registration.json");
        {
            let mut s = RegistrationStore::open(&p).unwrap();
            s.set_mode(Mode::Open).unwrap();
        }
        assert_eq!(RegistrationStore::open(&p).unwrap().mode(), Mode::Open);
    }

    #[test]
    fn token_is_single_use() {
        let (_d, mut s) = store();
        let tok = s.issue("for bob", None).unwrap();
        assert!(s.redeem(&tok)); // first use ok
        assert!(!s.redeem(&tok)); // second use rejected
    }

    #[test]
    fn unknown_token_rejected() {
        let (_d, mut s) = store();
        assert!(!s.redeem("not-a-real-token"));
    }

    #[test]
    fn expired_token_not_redeemable() {
        let (_d, mut s) = store();
        // issue with a 0-second TTL: expires_at = now, redeem requires e > now -> pruned
        let tok = s.issue("expired", Some(0)).unwrap();
        assert!(!s.redeem(&tok));
    }

    #[test]
    fn list_hides_secret_and_revoke_removes() {
        let (_d, mut s) = store();
        let _ = s.issue("a", None).unwrap();
        let id = s.list()[0].id.clone();
        assert_eq!(s.list().len(), 1);
        assert!(s.revoke(&id).unwrap());
        assert_eq!(s.list().len(), 0);
        assert!(!s.revoke(&id).unwrap()); // idempotent
    }

    #[test]
    fn plaintext_never_stored() {
        let (_d, mut s) = store();
        let tok = s.issue("x", None).unwrap();
        let raw = std::fs::read_to_string(&s.path).unwrap();
        assert!(!raw.contains(&tok), "plaintext token must not be persisted");
    }
}

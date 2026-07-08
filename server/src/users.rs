use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// A valid argon2 PHC to verify against when the requested user doesn't exist, so an
// absent-user login does the SAME work as a wrong-password login — no timing oracle
// that leaks which usernames are valid.
fn dummy_hash() -> &'static str {
    static D: OnceLock<String> = OnceLock::new();
    D.get_or_init(|| {
        let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
        Argon2::default().hash_password(b"selfsync-dummy", &salt).unwrap().to_string()
    })
}

// Namespace-safe name: no path traversal, no separators. Used for usernames and vault ids,
// which both become filesystem path segments. LOWERCASE-ONLY (SEC-1): the account store keys
// users case-sensitively, but the on-disk namespace DATA_ROOT/<user>/<vault> collapses case on
// a case-insensitive filesystem (Windows, default macOS) — so "Alice" and "alice" would map to
// the same directory while being distinct accounts, letting one read/write the other's vault.
// Forcing a single canonical case (lowercase) makes store-key == directory-segment, so no two
// distinct names can ever collide on disk.
pub fn safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_'))
        && s != "."
        && s != ".."
}

// Pure argon2 verify of a password against a stored PHC string. Kept free-standing (no lock,
// no self) so the caller can run it on a blocking thread with the users mutex already released. (SEC-2)
pub fn verify_password(phc: &str, password: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else { return false; };
    Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
}

#[derive(Serialize, Deserialize, Default)]
struct UsersFile {
    // username -> argon2id PHC string
    users: HashMap<String, String>,
}

pub struct UserStore {
    path: PathBuf,
    file: UsersFile,
}

impl UserStore {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let file: UsersFile = match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!(".users.json is corrupt ({e})"))
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => UsersFile::default(),
            Err(e) => return Err(e),
        };
        Ok(UserStore { path: path.to_path_buf(), file })
    }

    fn save(&self) -> std::io::Result<()> {
        crate::atomicfile::atomic_write(&self.path, &serde_json::to_vec(&self.file)?) // fsync-durable (R12-CC2)
    }

    pub fn is_empty(&self) -> bool { self.file.users.is_empty() }
    pub fn exists(&self, user: &str) -> bool { self.file.users.contains_key(user) }

    // Sorted usernames (for the admin user list). Never exposes password hashes.
    pub fn usernames(&self) -> Vec<String> {
        let mut v: Vec<String> = self.file.users.keys().cloned().collect();
        v.sort();
        v
    }

    // Remove an account. Returns whether it existed. (Callers purge the user's shares
    // and sessions separately.)
    pub fn remove(&mut self, user: &str) -> std::io::Result<bool> {
        if self.file.users.remove(user).is_some() {
            self.save()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn register(&mut self, user: &str, password: &str) -> std::io::Result<()> {
        if !safe_name(user) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid username"));
        }
        if self.file.users.contains_key(user) {
            return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "user exists"));
        }
        let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| std::io::Error::other(format!("hash: {e}")))?
            .to_string();
        self.file.users.insert(user.to_string(), hash);
        self.save()
    }

    // S1 (R10): (re)set an EXISTING user's password. Used to keep the bootstrap admin's stored hash
    // in sync with SYNC_PASSWORD on every boot so the admin password can be ROTATED (change env +
    // restart). No-op if the user doesn't exist — a deleted account is never resurrected.
    pub fn set_password(&mut self, user: &str, password: &str) -> std::io::Result<()> {
        if !self.file.users.contains_key(user) { return Ok(()); }
        let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| std::io::Error::other(format!("hash: {e}")))?
            .to_string();
        self.file.users.insert(user.to_string(), hash);
        self.save()
    }

    // Return (user_exists, PHC-to-verify-against). Absent users yield a dummy hash so the caller
    // does the SAME argon2 work either way — no timing oracle on which usernames are valid. (SEC-2)
    pub fn phc_for(&self, user: &str) -> (bool, String) {
        match self.file.users.get(user) {
            Some(h) => (true, h.clone()),
            None => (false, dummy_hash().to_string()),
        }
    }

    pub fn verify(&self, user: &str, password: &str) -> bool {
        // Always run an argon2 verify — against the real hash if the user exists, else a
        // dummy — so timing doesn't reveal whether the username is valid.
        let present = self.file.users.contains_key(user);
        let phc = self.file.users.get(user).map(String::as_str).unwrap_or_else(|| dummy_hash());
        let Ok(parsed) = PasswordHash::new(phc) else { return false; };
        let ok = Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok();
        present && ok
    }
}

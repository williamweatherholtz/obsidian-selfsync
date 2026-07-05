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

// Namespace-safe name: no path traversal, no separators. Used for usernames and
// vault ids, which both become filesystem path segments.
pub fn safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        && s != "."
        && s != ".."
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
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&self.file)?)?;
        std::fs::rename(tmp, &self.path)
    }

    pub fn is_empty(&self) -> bool { self.file.users.is_empty() }
    pub fn exists(&self, user: &str) -> bool { self.file.users.contains_key(user) }

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

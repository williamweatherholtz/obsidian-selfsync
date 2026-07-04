use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("hash: {e}")))?
            .to_string();
        self.file.users.insert(user.to_string(), hash);
        self.save()
    }

    pub fn verify(&self, user: &str, password: &str) -> bool {
        let Some(phc) = self.file.users.get(user) else { return false; };
        let Ok(parsed) = PasswordHash::new(phc) else { return false; };
        Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
    }
}

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
// The human-readable rule, surfaced verbatim in the "invalid" error so the UI can set expectations.
pub const NAME_RULE: &str = "use lowercase letters, digits, and . _ - + @ (max 64, no spaces or slashes)";
pub fn safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        // '+' and '@' admitted so an email address works as a username (plus-addressing included).
        // Both are safe: valid in a URL path segment and on every filesystem, and neither enables
        // traversal (no '/', and '.'/'..' whole-names stay blocked). Still lowercase-canonical (§ above).
        && s.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' | b'+' | b'@'))
        && s != "."
        && s != ".."
}

// Pure argon2 verify of a password against a stored PHC string. Kept free-standing (no lock,
// no self) so the caller can run it on a blocking thread with the users mutex already released. (SEC-2)
pub fn verify_password(phc: &str, password: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else { return false; };
    Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
}

// SEC-CMMC (IA.3.5.8): how many previous password hashes to retain + reject on change.
const PASSWORD_HISTORY: usize = 5;

#[derive(Serialize, Deserialize, Default)]
struct UsersFile {
    // username -> argon2id PHC string (current password)
    users: HashMap<String, String>,
    // IA.3.5.8 password-reuse history: username -> previous PHC strings (most-recent-first, capped at
    // PASSWORD_HISTORY). #[serde(default)] so a pre-upgrade .users.json loads with empty history.
    #[serde(default)]
    prev_hashes: HashMap<String, Vec<String>>,
    // IA.3.5.9 temporary-password / forced-change: usernames that MUST change their password before the
    // account can be used for anything but the change itself (set on admin create + admin reset).
    #[serde(default)]
    must_change: std::collections::HashSet<String>,
    // IA.3.5.3 MFA: an ENABLED account's base32 TOTP secret (username -> secret). Present ⇒ MFA required
    // at login. Secrets are a shared factor, stored server-side (a leaked .users.json would expose them,
    // same trust boundary as the password hashes — acceptable under the trusted-server model).
    #[serde(default)]
    totp_secret: HashMap<String, String>,
    // A secret mid-enrollment, not yet confirmed with a live code (so a half-finished enroll never
    // locks the account out). Promoted to totp_secret on confirm.
    #[serde(default)]
    totp_pending: HashMap<String, String>,
    // Single-use recovery codes (sha256-hashed), consumed one-per-use when the authenticator is lost.
    #[serde(default)]
    totp_recovery: HashMap<String, Vec<String>>,
    // crit-round (IA.3.5.3 replay protection): the last TOTP 30s step consumed per user. A code whose
    // step is <= this is rejected, so a captured code can't be replayed within its ~90s validity window
    // (RFC 6238 §5.2). Recovery codes are separately single-use and don't touch this.
    #[serde(default)]
    totp_last_step: HashMap<String, u64>,
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
            // Also drop the reuse history + forced-change flag + MFA state so a re-created same-name
            // account starts clean (no inherited history / stale must-change / stale TOTP secret).
            self.file.prev_hashes.remove(user);
            self.file.must_change.remove(user);
            self.file.totp_secret.remove(user);
            self.file.totp_pending.remove(user);
            self.file.totp_recovery.remove(user);
            self.file.totp_last_step.remove(user);
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

    // IA.3.5.8: true if `password` matches the user's CURRENT or any RETAINED previous password —
    // used by the self-service change path to reject reuse. Runs argon2 verifies (call off the async
    // worker). Unknown user -> false (no history to match).
    pub fn is_password_reused(&self, user: &str, password: &str) -> bool {
        let current = self.file.users.get(user);
        let prev = self.file.prev_hashes.get(user);
        current.into_iter().chain(prev.into_iter().flatten())
            .any(|phc| verify_password(phc, password))
    }

    // Rotate a user's password: push the CURRENT hash into the reuse history (capped) THEN set the new
    // one. Used by the user's own change and by an admin reset (so a reset password can't be rotated
    // back to a recent one). No-op if the user doesn't exist. (Distinct from set_password, which is a
    // force-overwrite with NO history — used to re-apply the bootstrap admin's SYNC_PASSWORD each boot.)
    pub fn rotate_password(&mut self, user: &str, password: &str) -> std::io::Result<()> {
        if !self.file.users.contains_key(user) { return Ok(()); }
        if let Some(old) = self.file.users.get(user).cloned() {
            let hist = self.file.prev_hashes.entry(user.to_string()).or_default();
            hist.insert(0, old);
            hist.truncate(PASSWORD_HISTORY);
        }
        let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| std::io::Error::other(format!("hash: {e}")))?
            .to_string();
        self.file.users.insert(user.to_string(), hash);
        self.save()
    }

    // ---- IA.3.5.3 MFA (TOTP) ----
    pub fn totp_enabled(&self, user: &str) -> bool { self.file.totp_secret.contains_key(user) }

    // Begin enrollment: mint a fresh secret, stash it as PENDING (not yet enforced), return the secret
    // for the authenticator (the caller builds the otpauth URI). A re-enroll overwrites any pending.
    pub fn totp_begin_enroll(&mut self, user: &str) -> std::io::Result<String> {
        let secret = crate::totp::generate_secret();
        self.file.totp_pending.insert(user.to_string(), secret.clone());
        self.save()?;
        Ok(secret)
    }

    // Confirm enrollment with a live code against the PENDING secret. On success: promote to enabled,
    // mint + store (hashed) recovery codes, and return the plaintext recovery codes ONCE. None if the
    // code is wrong or there's no pending enrollment.
    pub fn totp_confirm_enroll(&mut self, user: &str, code: &str, now_secs: u64) -> std::io::Result<Option<Vec<String>>> {
        let Some(secret) = self.file.totp_pending.get(user).cloned() else { return Ok(None); };
        if !crate::totp::verify(&secret, code, now_secs) { return Ok(None); }
        self.file.totp_pending.remove(user);
        self.file.totp_secret.insert(user.to_string(), secret);
        let codes = crate::totp::generate_recovery_codes(10);
        self.file.totp_recovery.insert(user.to_string(), codes.iter().map(|c| crate::totp::hash_recovery(c)).collect());
        self.save()?;
        Ok(Some(codes))
    }

    // Disable MFA for an account (drops the secret + recovery codes + any pending).
    pub fn totp_disable(&mut self, user: &str) -> std::io::Result<()> {
        let changed = self.file.totp_secret.remove(user).is_some()
            | self.file.totp_pending.remove(user).is_some()
            | self.file.totp_recovery.remove(user).is_some()
            | self.file.totp_last_step.remove(user).is_some();
        if changed { self.save() } else { Ok(()) }
    }

    // Verify a login second factor: a live TOTP code against the enabled secret, OR (fallback) a
    // single-use recovery code (consumed on match). Returns whether the factor is accepted.
    pub fn totp_verify_second_factor(&mut self, user: &str, code: &str, now_secs: u64) -> std::io::Result<bool> {
        if let Some(secret) = self.file.totp_secret.get(user).cloned() {
            if let Some(step) = crate::totp::verify_step(&secret, code, now_secs) {
                // Replay guard (RFC 6238 §5.2): reject a code from a step already consumed, so a
                // captured code can't be reused within its validity window.
                if self.file.totp_last_step.get(user).map_or(false, |&last| step <= last) {
                    return Ok(false);
                }
                self.file.totp_last_step.insert(user.to_string(), step);
                self.save()?;
                return Ok(true);
            }
        }
        // Recovery-code path: consume the matching code so it can't be reused.
        let h = crate::totp::hash_recovery(code);
        if let Some(list) = self.file.totp_recovery.get_mut(user) {
            if let Some(pos) = list.iter().position(|x| x == &h) {
                list.remove(pos);
                self.save()?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    // IA.3.5.9 forced-change flag.
    pub fn must_change(&self, user: &str) -> bool { self.file.must_change.contains(user) }
    pub fn set_must_change(&mut self, user: &str, flag: bool) -> std::io::Result<()> {
        let changed = if flag { self.file.must_change.insert(user.to_string()) }
                      else { self.file.must_change.remove(user) };
        if changed { self.save() } else { Ok(()) }
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, UserStore) {
        let d = tempdir().unwrap();
        let s = UserStore::open(&d.path().join(".users.json")).unwrap();
        (d, s)
    }

    #[test]
    fn reuse_history_rejects_current_and_recent_passwords() { // IA.3.5.8
        let (_d, mut s) = store();
        s.register("alice", "Passw0rd-1").unwrap();
        assert!(s.is_password_reused("alice", "Passw0rd-1"), "the current password is 'reused'");
        // Rotate through a few; each becomes history.
        s.rotate_password("alice", "Passw0rd-2").unwrap();
        s.rotate_password("alice", "Passw0rd-3").unwrap();
        assert!(s.is_password_reused("alice", "Passw0rd-1"), "an old password is still blocked");
        assert!(s.is_password_reused("alice", "Passw0rd-2"), "the previous password is blocked");
        assert!(s.is_password_reused("alice", "Passw0rd-3"), "the current password is blocked");
        assert!(!s.is_password_reused("alice", "Totally-New-9"), "a genuinely new password is allowed");
        // History is capped: after > PASSWORD_HISTORY rotations, the oldest ages out and can be reused.
        for i in 4..(4 + PASSWORD_HISTORY as u32 + 1) { s.rotate_password("alice", &format!("Passw0rd-{i}")).unwrap(); }
        assert!(!s.is_password_reused("alice", "Passw0rd-1"), "beyond the history window, the oldest is reusable");
    }

    #[test]
    fn must_change_flag_set_clear_and_cleared_on_remove() { // IA.3.5.9
        let (_d, mut s) = store();
        s.register("bob", "Passw0rd-1").unwrap();
        assert!(!s.must_change("bob"));
        s.set_must_change("bob", true).unwrap();
        assert!(s.must_change("bob"));
        s.set_must_change("bob", false).unwrap();
        assert!(!s.must_change("bob"));
        // Re-created same-name account never inherits a stale flag/history.
        s.set_must_change("bob", true).unwrap();
        s.rotate_password("bob", "Passw0rd-2").unwrap();
        s.remove("bob").unwrap();
        s.register("bob", "Fresh-Pass-1").unwrap();
        assert!(!s.must_change("bob"), "re-created account starts un-flagged");
        assert!(!s.is_password_reused("bob", "Passw0rd-2"), "re-created account inherits no history");
    }
}

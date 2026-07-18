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
const TOKEN_TTL_SECS: u64 = 30 * 24 * 3600; // absolute lifetime cap

// SEC-CMMC (AC.3.1.11 — terminate a session after inactivity): in addition to the 30-day ABSOLUTE
// cap, a session idle-expires after this many seconds with NO server activity. A syncing client polls
// (≤60s) + WS-pings, so an active device slides its `last_used` and never idle-expires; a device whose
// app is closed / not syncing stops touching the server and its token dies after the idle window, then
// re-login is required. Configurable via SESSION_IDLE_TIMEOUT_SECS; default 30 min. 0 disables idle
// expiry (absolute cap only). Endpoint screen-lock for a walked-away-but-open app is AC.3.1.10 (the OS).
const DEFAULT_IDLE_TTL_SECS: u64 = 30 * 60;
// last_used is persisted, but to avoid a disk write on EVERY request we only re-save the slid value
// once it has advanced by more than this; so at most one write per token per interval, not per call.
const SLIDE_PERSIST_SECS: u64 = 60;

#[derive(Serialize, Deserialize, Clone)]
struct TokenRec {
    user: String,
    expires_at: u64,
    // Last time this token was presented (epoch secs). #[serde(default)]=0 for pre-upgrade records;
    // open() grandfathers those to "now" so an upgrade doesn't instantly idle-expire live sessions.
    #[serde(default)]
    last_used: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct TokensFile {
    tokens: HashMap<String, TokenRec>, // key = sha256(token)
}

pub struct TokenStore {
    path: PathBuf,
    file: TokensFile,
    idle_ttl_secs: u64, // 0 = idle expiry disabled
}

// @audit r2 2026-07-18 — FIXED (concision): was a format!("{b:02x}") heap alloc PER BYTE on the token
// hot path (resolve/issue/revoke); now one 64-char buffer written in place.
// @audit-hash sha256:00d039a93ab3db00
fn sha256_hex(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(64);
    for b in Sha256::digest(s.as_bytes()) {
        let _ = write!(out, "{b:02x}");
    }
    out
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
        let idle_ttl_secs = std::env::var("SESSION_IDLE_TIMEOUT_SECS").ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_IDLE_TTL_SECS);
        let mut store = TokenStore { path: path.to_path_buf(), file: TokensFile::default(), idle_ttl_secs };
        let n = now();
        let before = file.tokens.len();
        // Grandfather pre-upgrade records (no last_used) to "now" so an upgrade doesn't idle-expire live
        // sessions on first load; then sweep absolutely-expired tokens (R22).
        let mut changed = false;
        for r in file.tokens.values_mut() { if r.last_used == 0 { r.last_used = n; changed = true; } }
        file.tokens.retain(|_, r| r.expires_at > n);
        store.file = file;
        if changed || store.file.tokens.len() != before { let _ = store.save(); }
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
        let n = now();
        self.file.tokens.insert(sha256_hex(&token), TokenRec { user: user.to_string(), expires_at: n + ttl_secs, last_used: n });
        self.save()?;
        Ok(token)
    }

    // Resolve a token to its user iff present, within its ABSOLUTE lifetime, AND not idle-expired
    // (AC.3.1.11). On a live resolve the `last_used` timestamp SLIDES (persisted at most once per
    // SLIDE_PERSIST_SECS to avoid a disk write per request); an expired token — absolute OR idle — is
    // pruned. idle_ttl_secs == 0 disables the idle check (absolute cap only).
    // @audit r2 2026-07-18 — clean + fail-closed (idle/absolute expiry, hashed-at-rest lookup). Deferred
    // (low): `let _ = self.save()` on the prune/slide paths swallows a disk-write error — direction is
    // fail-closed (a lost slide only makes idle-expiry MORE likely), but a log::warn would make a
    // persistently failing .tokens.json write observable.
    pub fn resolve(&mut self, token: &str) -> Option<String> {
        let h = sha256_hex(token);
        let n = now();
        let idle = self.idle_ttl_secs;
        let (user, slide) = match self.file.tokens.get(&h) {
            Some(rec) if rec.expires_at > n && (idle == 0 || n.saturating_sub(rec.last_used) <= idle) => {
                (Some(rec.user.clone()), n.saturating_sub(rec.last_used) >= SLIDE_PERSIST_SECS)
            }
            Some(_) => { self.file.tokens.remove(&h); let _ = self.save(); return None; } // expired (absolute or idle)
            None => return None,
        };
        if slide {
            if let Some(r) = self.file.tokens.get_mut(&h) { r.last_used = n; }
            let _ = self.save();
        }
        user
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
    fn idle_expires_a_stale_token_but_keeps_an_active_one() { // CMMC AC.3.1.11
        let (_d, mut s) = store();
        let active = s.issue("alice").unwrap();
        let stale = s.issue("bob").unwrap();
        // Backdate bob's last_used beyond the idle window; alice stays recent.
        let hb = sha256_hex(&stale);
        let n = now();
        s.file.tokens.get_mut(&hb).unwrap().last_used = n.saturating_sub(s.idle_ttl_secs + 100);
        assert_eq!(s.resolve(&active).as_deref(), Some("alice"), "an active token still resolves (and slides)");
        assert_eq!(s.resolve(&stale), None, "an idle token is idle-expired");
        assert!(!s.file.tokens.contains_key(&hb), "the idle-expired token is pruned");
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

use std::collections::HashMap;
use std::time::Instant;

// SEC-AUTH (audit / FR9): per-account login throttle. The design docs promised rate-limiting but it
// was never implemented — an internet-facing box with no throttle lets an attacker brute-force a weak
// password unboundedly (argon2 slows a single guess but doesn't stop sustained guessing). This caps
// FAILED attempts per USERNAME within a sliding window and then rejects further attempts for that
// account with 429 + Retry-After until the window rolls. Per-account (not per-IP) is the robust in-app
// control: it needs no proxy-supplied client IP (which behind a reverse proxy is the proxy's address),
// and it directly stops password guessing against a specific account. Per-IP flood protection remains
// the reverse proxy's job (documented). A successful login clears the account's counter, so a legitimate
// user who mistypes a few times and then succeeds is never locked. The lockout-DoS (an attacker spamming
// failures to lock a victim out) is bounded to WINDOW and to that one username — the standard tradeoff.
pub struct LoginThrottle {
    fails: HashMap<String, (u64, u32)>, // username -> (window_start_ms, failed_count)
    max_fails: u32,
    window_ms: u64,
    origin: Instant, // monotonic clock origin; now = origin.elapsed()
}

// After this many failures in the window, an account is locked out until the window rolls.
pub const DEFAULT_MAX_FAILS: u32 = 10;
pub const DEFAULT_WINDOW_MS: u64 = 5 * 60 * 1000; // 5 minutes
const MAX_TRACKED: usize = 100_000; // bound memory: prune when the map grows past this

impl LoginThrottle {
    pub fn new() -> Self {
        Self { fails: HashMap::new(), max_fails: DEFAULT_MAX_FAILS, window_ms: DEFAULT_WINDOW_MS, origin: Instant::now() }
    }

    fn now(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }

    // Called BEFORE verifying a password. Ok(()) to proceed; Err(retry_after_secs) if locked out.
    pub fn check(&mut self, user: &str) -> Result<(), u64> {
        self.check_at(user, self.now())
    }
    pub fn check_at(&mut self, user: &str, now: u64) -> Result<(), u64> {
        if let Some((start, count)) = self.fails.get(user) {
            if now.saturating_sub(*start) < self.window_ms && *count >= self.max_fails {
                return Err((self.window_ms - now.saturating_sub(*start)) / 1000 + 1);
            }
        }
        Ok(())
    }

    // Record a failed attempt (bad password / unknown user).
    pub fn fail(&mut self, user: &str) {
        let now = self.now();
        self.fail_at(user, now)
    }
    pub fn fail_at(&mut self, user: &str, now: u64) {
        if self.fails.len() > MAX_TRACKED {
            let w = self.window_ms;
            self.fails.retain(|_, (s, _)| now.saturating_sub(*s) < w);
        }
        let e = self.fails.entry(user.to_string()).or_insert((now, 0));
        if now.saturating_sub(e.0) >= self.window_ms { *e = (now, 0); } // window rolled → fresh count
        e.1 += 1;
    }

    // A successful login clears the account so honest users are never penalized for earlier typos.
    pub fn success(&mut self, user: &str) {
        self.fails.remove(user);
    }
}

impl Default for LoginThrottle {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn throttle() -> LoginThrottle {
        LoginThrottle { fails: HashMap::new(), max_fails: 3, window_ms: 1000, origin: Instant::now() }
    }

    #[test]
    fn locks_out_after_max_fails_within_window() {
        let mut t = throttle();
        assert!(t.check_at("alice", 0).is_ok());
        t.fail_at("alice", 0);
        t.fail_at("alice", 100);
        t.fail_at("alice", 200); // 3rd failure == max
        // Now locked out until the window (1000ms) rolls.
        let retry = t.check_at("alice", 300).unwrap_err();
        assert!(retry >= 1, "reports a positive retry-after");
        // A DIFFERENT account is unaffected.
        assert!(t.check_at("bob", 300).is_ok());
    }

    #[test]
    fn window_rolls_and_success_clears() {
        let mut t = throttle();
        for i in 0..3 { t.fail_at("alice", i * 10); }
        assert!(t.check_at("alice", 50).is_err()); // locked
        // After the window elapses, the next failure starts a fresh count → not immediately locked.
        t.fail_at("alice", 2000);
        assert!(t.check_at("alice", 2001).is_ok());
        // And a success wipes the counter entirely.
        for i in 0..3 { t.fail_at("bob", 3000 + i * 10); }
        assert!(t.check_at("bob", 3050).is_err());
        t.success("bob");
        assert!(t.check_at("bob", 3060).is_ok());
    }
}

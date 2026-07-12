use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_root: PathBuf,
    pub bind_addr: String,
    // Where the ADMIN surface (/admin + /api/admin/*) binds (D0021). None ⇒ MERGE onto bind_addr
    // (admin shares the public port). Some(addr) ⇒ SPLIT: admin serves only there. SAFE BY DEFAULT:
    // when ADMIN_BIND_ADDR is unset this defaults to a private localhost-only address (127.0.0.1 on
    // the public port + 1), so a naive deploy never exposes account management on the public port;
    // ADMIN_BIND_ADDR=merge is the explicit opt-out for a trusted/all-in-one single-port setup.
    pub admin_bind: Option<String>,
    pub vault: String,
    pub user: String,
    pub password: String,
    pub registration: String, // "open" | "invite" | "closed"
    pub invite_code: String,  // shared secret required when registration == "invite"
    // SEC-CMMC (AC.3.1.9 — system-use notification / consent banner). Shown to a user BEFORE they
    // authenticate. Empty ⇒ no banner. Set SYNC_LOGIN_BANNER to the operator's authorized-use notice
    // (e.g. a DoD standard consent banner for a CUI system). Surfaced by /health and rendered pre-auth.
    pub login_banner: String,
    // SEC-CMMC (IA.3.5.3 — MFA for privileged accounts). When true, a server-admin cannot perform any
    // privileged (/api/admin/*) action until they have enrolled TOTP, making MFA MANDATORY for admins
    // (not merely available). Default false for bootstrap usability + backward-compat; the operator
    // opts in with REQUIRE_ADMIN_MFA=1 (like TLS/audit-retention, an operator-configured control). A
    // non-MFA admin can still reach the (AuthToken-gated, non-admin) MFA-enrollment routes to enroll.
    pub require_admin_mfa: bool,
    // Per-file size ceiling in BYTES (env MAX_FILE_MB, default 512). The hard limit any single file
    // may reach on this server — enforced on commit. Raising it raises transient reassembly RAM
    // (≈ this × concurrent large commits), so it's an operator knob, not a client one.
    pub max_file_bytes: u64,
}

// The port from a "host:port" (or "[ipv6]:port") bind string.
fn port_of(addr: &str) -> Option<u16> {
    addr.rsplit(':').next().and_then(|p| p.parse::<u16>().ok())
}

// Derive the safe default admin address from the public bind: localhost on the public port + 1.
// Returns None (=> MERGE) when the public port is EPHEMERAL (0) or unparseable — a split can't derive
// a stable admin port there (e.g. a test/dynamic :0 bind would otherwise try to bind port 1 and fail).
// Localhost-only so it's reachable only from the host / an explicit tunnel, never off-box by default.
fn default_admin_bind(bind_addr: &str) -> Option<String> {
    match port_of(bind_addr) {
        Some(0) => None, // ephemeral public port → merge (no stable admin port to derive)
        Some(p) if p < u16::MAX => Some(format!("127.0.0.1:{}", p + 1)),
        _ => Some("127.0.0.1:8081".to_string()),
    }
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let bind_addr = env("BIND_ADDR", "0.0.0.0:8080");
        // ADMIN_BIND_ADDR: unset ⇒ safe default split (localhost:port+1); "merge" (or == bind_addr) ⇒
        // opt-out to one port; any other value ⇒ split at that explicit address.
        let admin_bind = match std::env::var("ADMIN_BIND_ADDR").ok().as_deref() {
            None | Some("") => default_admin_bind(&bind_addr),
            Some("merge") => None,
            // Same PORT as the public bind ⇒ MERGE — two listeners on one port can't coexist even on
            // different interface strings (0.0.0.0:8080 vs 127.0.0.1:8080), so this would otherwise
            // fail the second bind and refuse to start. Compare ports, not full strings. (An exotic
            // genuinely-distinct-NIC same-port split is not supported; use different ports.)
            Some(a) if port_of(a).is_some() && port_of(a) == port_of(&bind_addr) => None,
            Some(a) => Some(a.to_string()),
        };
        Config {
            data_root: PathBuf::from(env("DATA_ROOT", "./data")),
            bind_addr,
            admin_bind,
            vault: env("VAULT", "vault"),
            user: env("SYNC_USER", "admin"),
            password: env("SYNC_PASSWORD", "admin"),
            registration: env("REGISTRATION", "closed"),
            invite_code: env("INVITE_CODE", ""),
            login_banner: env("SYNC_LOGIN_BANNER", ""),
            require_admin_mfa: env("REQUIRE_ADMIN_MFA", "") == "1",
            // MAX_FILE_MB (default 512). Parse defensively: a junk/zero value falls back to 512.
            max_file_bytes: {
                let mb = env("MAX_FILE_MB", "512").parse::<u64>().ok().filter(|&m| m > 0).unwrap_or(512);
                mb.saturating_mul(1024 * 1024)
            },
        }
    }
}

/// SEC (CM.3.4.2 — establish/enforce a secure baseline): decide whether to REFUSE to boot on the
/// default/unset admin password. SYNC_PASSWORD defaults to "admin", so booting an exposed server on
/// that well-known credential is refused unless the operator explicitly opts into a weak admin
/// (ALLOW_WEAK_ADMIN=1) for a trusted LAN/dev box. Extracted as a pure predicate so the boot guard
/// is unit-testable (real behavior), not just an inline assertion in `main`.
pub fn weak_admin_refused(password: &str, allow_weak_override: bool) -> bool {
    if allow_weak_override { return false; } // explicit opt-out for a trusted LAN/dev box
    // crit-round (CMMC): the guard used to reject only the exact literal "admin". Broaden it to the
    // secure-baseline floor — a small known-weak set OR anything shorter than 8 chars is refused, so a
    // trivially-guessable bootstrap credential (SYNC_PASSWORD=password / admin123 / a 4-char pin) can't
    // ship on an exposed box. Strong passwords boot unchanged.
    const KNOWN_WEAK: &[&str] = &["admin", "password", "changeme", "admin123", "root", "test", "letmein", "secret"];
    let low = password.to_ascii_lowercase();
    password.len() < 8 || KNOWN_WEAK.contains(&low.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    // CM.3.4.2: the server must not silently ship a publicly-known admin login on an exposed box.
    #[test]
    fn refuses_boot_on_default_admin_password_unless_overridden() {
        assert!(weak_admin_refused("admin", false), "default admin password must refuse boot");
        assert!(!weak_admin_refused("admin", true), "ALLOW_WEAK_ADMIN=1 overrides for a trusted box");
        assert!(!weak_admin_refused("a-strong-secret", false), "a non-default password boots normally");
    }

    // crit-round (CMMC CM.3.4.2): the boot guard rejects the whole trivially-weak class, not just "admin".
    #[test]
    fn refuses_known_weak_and_short_bootstrap_passwords() {
        for w in ["password", "admin123", "Changeme", "root", "1234567"] {
            assert!(weak_admin_refused(w, false), "'{w}' is weak/short and must refuse boot");
        }
        assert!(!weak_admin_refused("aStrongPassphrase1", false), "a strong password boots");
        assert!(!weak_admin_refused("password", true), "override still lets a trusted box through");
    }
}

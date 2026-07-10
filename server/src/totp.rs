// SEC-CMMC (IA.3.5.3 — multifactor authentication): RFC 6238 TOTP as a second factor for privileged
// (server-admin) accounts, plus single-use recovery codes. Self-contained crypto (SHA-1 + HMAC-SHA1 +
// base32, no new dependencies) so it stays a single auditable binary; correctness is pinned to the
// RFC 4231 (HMAC) and RFC 6238 (TOTP) published test vectors in the tests below — the control is
// verified by a repeatable test, not an assertion.
use sha2::{Digest, Sha256};

// ---- SHA-1 (RFC 3174) — used ONLY for the HMAC inside TOTP (authenticator-app standard), never for
// password/secret storage (those use argon2id / SHA-256). ----
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let ml = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&ml.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 { w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1); }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let tmp = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(wi);
            e = d; d = c; c = b.rotate_left(30); b = a; a = tmp;
        }
        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b); h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d); h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for i in 0..5 { out[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes()); }
    out
}

fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    let mut k = if key.len() > 64 { sha1(key).to_vec() } else { key.to_vec() };
    k.resize(64, 0);
    let mut inner: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    inner.extend_from_slice(msg);
    let ih = sha1(&inner);
    let mut outer: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    outer.extend_from_slice(&ih);
    sha1(&outer)
}

fn hotp(secret: &[u8], counter: u64) -> u32 {
    let mac = hmac_sha1(secret, &counter.to_be_bytes());
    let off = (mac[19] & 0x0f) as usize;
    let bin = ((mac[off] as u32 & 0x7f) << 24)
        | ((mac[off + 1] as u32) << 16)
        | ((mac[off + 2] as u32) << 8)
        | (mac[off + 3] as u32);
    bin % 1_000_000 // 6 digits
}

const B32: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32_encode(data: &[u8]) -> String {
    let (mut buf, mut bits, mut out) = (0u64, 0u32, String::new());
    for &b in data {
        buf = (buf << 8) | b as u64;
        bits += 8;
        while bits >= 5 { bits -= 5; out.push(B32[((buf >> bits) & 0x1f) as usize] as char); }
    }
    if bits > 0 { out.push(B32[((buf << (5 - bits)) & 0x1f) as usize] as char); }
    out
}

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let (mut buf, mut bits, mut out) = (0u64, 0u32, Vec::new());
    for ch in s.trim_end_matches('=').bytes() {
        let v = B32.iter().position(|&x| x == ch.to_ascii_uppercase())? as u64;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 { bits -= 8; out.push((buf >> bits) as u8); }
    }
    Some(out)
}

// A fresh random base32 TOTP secret (160-bit, the RFC-recommended size).
pub fn generate_secret() -> String {
    use argon2::password_hash::rand_core::RngCore;
    let mut bytes = [0u8; 20];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    base32_encode(&bytes)
}

// The otpauth:// URI an authenticator app imports (as text or a QR). Never logged.
pub fn otpauth_uri(user: &str, secret_b32: &str) -> String {
    format!(
        "otpauth://totp/SelfSync:{u}?secret={s}&issuer=SelfSync&algorithm=SHA1&digits=6&period=30",
        u = urlencode(user), s = secret_b32
    )
}
fn urlencode(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

// The current 6-digit code for a secret at a given time — what an authenticator app would show. Exposed
// for tests (and any future server-assisted flow); generating a code still requires the secret.
pub fn code_at(secret_b32: &str, now_secs: u64) -> Option<String> {
    let secret = base32_decode(secret_b32)?;
    Some(format!("{:06}", hotp(&secret, now_secs / 30)))
}

// Verify a 6-digit TOTP code against the secret, accepting the current 30s step and ±1 for clock skew.
pub fn verify(secret_b32: &str, code: &str, now_secs: u64) -> bool {
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) { return false; }
    let Some(secret) = base32_decode(secret_b32) else { return false; };
    let Ok(code_num) = code.parse::<u32>() else { return false; };
    let step = now_secs / 30;
    [step.wrapping_sub(1), step, step + 1].iter().any(|&c| hotp(&secret, c) == code_num)
}

// Recovery codes: N single-use codes shown ONCE at enrollment; only their sha256 hashes are stored.
pub fn hash_recovery(code: &str) -> String {
    Sha256::digest(code.trim().to_uppercase().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}
pub fn generate_recovery_codes(n: usize) -> Vec<String> {
    use argon2::password_hash::rand_core::RngCore;
    (0..n).map(|_| {
        let mut bytes = [0u8; 10];
        argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
        base32_encode(&bytes) // ~16 base32 chars, unambiguous
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 4231 HMAC-SHA1 test case 2: key="Jefe", data="what do ya want for nothing?"
    #[test]
    fn hmac_sha1_rfc4231() {
        let mac = hmac_sha1(b"Jefe", b"what do ya want for nothing?");
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    }

    // RFC 6238 test vectors (SHA-1, 20-byte ASCII secret "12345678901234567890"), truncated to 6 digits.
    #[test]
    fn totp_rfc6238_vectors() {
        let secret = base32_encode(b"12345678901234567890");
        // (unix_time, expected 6-digit code) — last 6 digits of the RFC's 8-digit vectors.
        for (t, want) in [(59u64, "287082"), (1111111109, "081804"), (1111111111, "050471"), (1234567890, "005924")] {
            assert!(verify(&secret, want, t), "TOTP at t={t} should accept {want}");
            assert!(!verify(&secret, "000000", t) || want == "000000", "a wrong code is rejected at t={t}");
        }
    }

    #[test]
    fn verify_accepts_skew_window_and_rejects_junk() {
        let secret = base32_encode(b"12345678901234567890");
        // t=59 is step 1; a code from step 1 must also verify at t=59+30 (step 2 sees step1 as -1) ... check ±1.
        assert!(verify(&secret, "287082", 59));       // exact step
        assert!(verify(&secret, "287082", 59 + 29));  // same step
        assert!(!verify(&secret, "12345", 59));       // wrong length
        assert!(!verify(&secret, "abcdef", 59));      // non-digit
        assert!(!verify("not-base32-!!!", "287082", 59)); // bad secret
    }

    #[test]
    fn base32_roundtrips() {
        for s in [&b"12345678901234567890"[..], b"hello", b"\x00\xff\x10"] {
            assert_eq!(base32_decode(&base32_encode(s)).unwrap(), s);
        }
    }
}

use sha2::{Digest, Sha256};

pub fn sha256_hex(bytes: &[u8]) -> String {
    // Manual nibble→hex: allocation-free per byte (the old `format!` per byte
    // allocated a String each iteration, on the hot path for every chunk + file).
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut h = Sha256::new();
    h.update(bytes);
    let d = h.finalize();
    let mut s = String::with_capacity(64);
    for b in d {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

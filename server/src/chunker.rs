//! Content-defined chunking via a rolling gear-hash. This is a byte-for-byte port of the CLIENT
//! chunker (client/src/chunker.ts) — identical gear table, constants, rolling formula, and boundary
//! rule — so a server-side reindex produces the SAME chunk boundaries and hashes a client would. That
//! parity is load-bearing: it's what lets a reindexed file dedup against client-uploaded chunks and be
//! streamed/reassembled by the client. Do NOT change the gear table or constants (issueReindexSingleChunk).
use crate::hash::sha256_hex;

const MIN: usize = 2048;
const AVG_MASK: u32 = (1 << 14) - 1; // avg ~16 KiB
const MAX: usize = 65536;

// Fixed gear table from a seeded LCG — must match client/src/chunker.ts exactly (same seed/multiplier/
// increment, all mod 2^32). JS `Math.imul` + `>>> 0` == Rust wrapping u32 arithmetic.
fn gear() -> [u32; 256] {
    let mut g = [0u32; 256];
    let mut s: u32 = 0x1234567;
    for slot in g.iter_mut() {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        *slot = s;
    }
    g
}

/// Split `bytes` into content-defined chunks; returns `(chunk_sha256_hex, chunk_bytes)` in order.
/// A stream shorter than one boundary is a single chunk. The JS `((hash << 1) + gear) >>> 0` reduces
/// mod 2^32; `(hash << 1).wrapping_add(..)` on u32 is the identical low-32-bit result.
pub fn chunk(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let g = gear();
    let mut bounds: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    let mut hash: u32 = 0;
    for (i, &b) in bytes.iter().enumerate() {
        hash = (hash << 1).wrapping_add(g[b as usize]);
        let len = i - start + 1;
        if len >= MIN && ((hash & AVG_MASK) == 0 || len >= MAX) {
            bounds.push((start, i + 1));
            start = i + 1;
            hash = 0;
        }
    }
    if start < bytes.len() || bounds.is_empty() {
        bounds.push((start, bytes.len()));
    }
    bounds
        .into_iter()
        .map(|(s, e)| {
            let b = bytes[s..e].to_vec();
            (sha256_hex(&b), b)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic LCG byte stream — IDENTICAL to the one in client/test/chunker-golden.gen.test.ts,
    // so both chunkers see the same input.
    fn lcg_bytes(n: usize) -> Vec<u8> {
        let mut s: u32 = 0x9e3779b9;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1103515245).wrapping_add(12345);
                ((s >> 16) & 0xff) as u8
            })
            .collect()
    }

    // GOLDEN parity: the exact chunk (size:hash) list the CLIENT chunker produced for lcg_bytes(200000).
    // Generated once from client/src/chunker.ts (see chunker-golden.gen). If this ever diverges, the two
    // chunkers no longer agree → dedup + client reassembly would silently break. Keep them in lockstep.
    const GOLDEN: &str = "2584:abccd995cdf44d0784b8ec6aac1ab81ca0473dd35a009a62393a5eb16688210e,2921:8196f055f7e7f2f84a80af5068af9eb8b814f616c2d30aa7c3b137e44be93aae,16526:453efc9ba4f8f00d71201e776a05d564154f2e8684bdfa0314f01f8db62438df,23347:726d9db4ba0089bf4f9dd9511753e5594745ce964ca07718f677712d23d3bc47,2830:9750218fe1da663c3b72541187673601499bf9bad9a204ca097ef91f688640bd,32882:c48ec71066b459bba34e090892328f7f28da736d51c3037aa8771968ee048c59,14149:bb761656604405f468b5a82c57010c2c8c2583d73faa459db834ddc1ba7f97d2,2942:4f11d5a801886f5f760119a3367372d81e5929ba106ca4ba7c8a0c6f5b7fc160,24435:dfc54d4d8001c3d8ebe62cbb301d53ef252d368af8147fae1a3bc42a7c1f1d76,6622:35af1146d605806395273832b92bbca66e6f4d1e1bd8eeea3966c27c4974e5ad,3458:633ed6b8d81018361d3f2337aeafb6025dcaf117191f3e48dc282bf7bd912ac4,5096:759d0a4806c3788baad6743632c75b20f62dc9755df9d946169f377b392795e5,30018:142e67cf06ee84137a637778e37e452cb775c1443b54c9f635ce9d9cb8208e1e,16495:ffd6bc1be6d4bdaf439b168f02b473a57c011f82ef0c279291a8a59c7a5f1ec5,15695:6d3dd5a9ef0306b20f6d3862bcb2f3c2f99da5bb5befe12a285033e5750673bf";

    #[test]
    fn matches_the_client_chunker_byte_for_byte() {
        let parts = chunk(&lcg_bytes(200_000));
        let got = parts.iter().map(|(h, b)| format!("{}:{}", b.len(), h)).collect::<Vec<_>>().join(",");
        assert_eq!(got, GOLDEN, "server chunker diverged from the client chunker (dedup would break)");
    }

    #[test]
    fn reassembles_to_the_input_and_respects_size_bounds() {
        let input = lcg_bytes(200_000);
        let parts = chunk(&input);
        let joined: Vec<u8> = parts.iter().flat_map(|(_, b)| b.clone()).collect();
        assert_eq!(joined, input, "chunks must concatenate back to the original bytes");
        for (idx, (_, b)) in parts.iter().enumerate() {
            if idx + 1 < parts.len() {
                assert!(b.len() >= MIN && b.len() <= MAX, "interior chunk {} out of [MIN,MAX]: {}", idx, b.len());
            }
        }
    }

    #[test]
    fn short_input_is_a_single_chunk() {
        assert_eq!(chunk(b"tiny").len(), 1);
        assert_eq!(chunk(b"").len(), 1); // empty file → one (empty) chunk, matching the client
    }
}

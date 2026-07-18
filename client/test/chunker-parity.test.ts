import { describe, it, expect } from "vitest";
import { chunk } from "../src/chunker";

// Cross-language parity guard (issueReindexSingleChunk): the SERVER reindex chunker (server/src/chunker.rs)
// is a byte-for-byte port of THIS chunker, and a divergence would silently break dedup + streamed
// reassembly. Both sides pin the SAME golden vector for the same deterministic LCG input; if either
// chunker changes, one of the two tests fails, forcing them back into lockstep. The Rust twin is
// chunker::tests::matches_the_client_chunker_byte_for_byte.
const GOLDEN =
  "2584:abccd995cdf44d0784b8ec6aac1ab81ca0473dd35a009a62393a5eb16688210e,2921:8196f055f7e7f2f84a80af5068af9eb8b814f616c2d30aa7c3b137e44be93aae,16526:453efc9ba4f8f00d71201e776a05d564154f2e8684bdfa0314f01f8db62438df,23347:726d9db4ba0089bf4f9dd9511753e5594745ce964ca07718f677712d23d3bc47,2830:9750218fe1da663c3b72541187673601499bf9bad9a204ca097ef91f688640bd,32882:c48ec71066b459bba34e090892328f7f28da736d51c3037aa8771968ee048c59,14149:bb761656604405f468b5a82c57010c2c8c2583d73faa459db834ddc1ba7f97d2,2942:4f11d5a801886f5f760119a3367372d81e5929ba106ca4ba7c8a0c6f5b7fc160,24435:dfc54d4d8001c3d8ebe62cbb301d53ef252d368af8147fae1a3bc42a7c1f1d76,6622:35af1146d605806395273832b92bbca66e6f4d1e1bd8eeea3966c27c4974e5ad,3458:633ed6b8d81018361d3f2337aeafb6025dcaf117191f3e48dc282bf7bd912ac4,5096:759d0a4806c3788baad6743632c75b20f62dc9755df9d946169f377b392795e5,30018:142e67cf06ee84137a637778e37e452cb775c1443b54c9f635ce9d9cb8208e1e,16495:ffd6bc1be6d4bdaf439b168f02b473a57c011f82ef0c279291a8a59c7a5f1ec5,15695:6d3dd5a9ef0306b20f6d3862bcb2f3c2f99da5bb5befe12a285033e5750673bf";

describe("chunker cross-language parity (client ↔ server reindex)", () => {
  it("produces the golden chunk boundaries + hashes the Rust chunker also pins", async () => {
    let s = 0x9e3779b9 >>> 0;
    const n = 200000;
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; b[i] = (s >>> 16) & 0xff; }
    const parts = await chunk(b);
    expect(parts.map((p) => `${p.bytes.length}:${p.hash}`).join(",")).toBe(GOLDEN);
  });
});

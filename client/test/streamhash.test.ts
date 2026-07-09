import { describe, it, expect } from "vitest";
import { Sha256 } from "../src/streamhash";
import { sha256hex } from "../src/chunker"; // the trusted one-shot crypto.subtle digest

const enc = (s: string) => new TextEncoder().encode(s);

// The streaming SHA-256 is a hand-rolled integrity primitive (WebCrypto has no incremental digest),
// so it MUST match crypto.subtle exactly — that equivalence is the whole basis for trusting it to
// verify streamed downloads. These cross-check it against the one-shot reference.
describe("Sha256 (streaming) == crypto.subtle", () => {
  it("empty + known strings", async () => {
    for (const s of ["", "a", "abc", "hello world", "The quick brown fox jumps over the lazy dog"]) {
      const h = new Sha256(); h.update(enc(s));
      expect(h.hexDigest()).toBe(await sha256hex(enc(s)));
    }
  });

  it("padding boundary lengths (55/56/57/63/64/65/119/120 bytes)", async () => {
    for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128]) {
      const b = new Uint8Array(n).map((_, i) => (i * 17 + 3) & 0xff);
      const h = new Sha256(); h.update(b);
      expect(h.hexDigest()).toBe(await sha256hex(b));
    }
  });

  it("a large multi-block buffer, one-shot vs split across arbitrary boundaries", async () => {
    const buf = new Uint8Array(200_003);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 131 + 7) & 0xff;
    const expected = await sha256hex(buf);
    const one = new Sha256(); one.update(buf);
    expect(one.hexDigest()).toBe(expected);
    // fed in 7-byte pieces (crossing 64-byte block boundaries mid-update)
    const split = new Sha256();
    for (let o = 0; o < buf.length; o += 7) split.update(buf.subarray(o, Math.min(o + 7, buf.length)));
    expect(split.hexDigest()).toBe(expected);
  });

  it("empty update() calls don't perturb the digest", async () => {
    const b = enc("payload");
    const h = new Sha256();
    h.update(new Uint8Array(0)); h.update(b); h.update(new Uint8Array(0));
    expect(h.hexDigest()).toBe(await sha256hex(b));
  });
});

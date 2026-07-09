// Streaming SHA-256 (FIPS 180-4): update() incrementally, hexDigest() to finish. WebCrypto's
// crypto.subtle.digest is ONE-SHOT — it needs the whole buffer — which is unusable for verifying a
// multi-GB streamed download without re-buffering the entire file (R17). This lets streamFileToDisk
// fold each verified chunk into the file hash as it streams to disk, so the reassembled file is
// checked against the declared hash with ~one chunk in RAM at a time. Verified against crypto.subtle
// (round-trip + split-update tests) so it can be trusted as an integrity primitive.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Sha256 {
  private h = Int32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0; // total bytes fed (exact up to 2^53, ample for any file)
  private w = new Int32Array(64);
  private done = false; // hexDigest() consumes the state (appends padding) — reuse is a bug, not silent

  update(data: Uint8Array): void {
    if (this.done) throw new Error("Sha256: update() after hexDigest() — this hasher is finalized");
    this.total += data.length;
    let off = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take; off = take;
      if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
    }
    while (off + 64 <= data.length) { this.block(data, off); off += 64; }
    if (off < data.length) { this.buf.set(data.subarray(off), 0); this.bufLen = data.length - off; }
  }

  hexDigest(): string {
    if (this.done) throw new Error("Sha256: hexDigest() called twice — finalize once");
    const bitLen = this.total * 8;
    // Padding: 0x80, then zeros, then the 64-bit big-endian bit length. One or two final blocks.
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    // 64-bit length: high 32 bits then low 32, big-endian.
    const hi = Math.floor(bitLen / 0x100000000) >>> 0;
    const lo = (bitLen >>> 0);
    const dv = new DataView(tail.buffer);
    dv.setUint32(padLen, hi, false);
    dv.setUint32(padLen + 4, lo, false);
    this.update(tail); // never recurses into padding (tail is plain data); flushes final block(s)
    this.done = true;  // now finalized: any further update()/hexDigest() throws rather than mis-hash
    let out = "";
    for (let i = 0; i < 8; i++) out += (this.h[i] >>> 0).toString(16).padStart(8, "0");
    return out;
  }

  private block(p: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      w[i] = (p[off + 4 * i] << 24) | (p[off + 4 * i + 1] << 16) | (p[off + 4 * i + 2] << 8) | p[off + 4 * i + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3], e = this.h[4], f = this.h[5], g = this.h[6], hh = this.h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this.h[0] = (this.h[0] + a) | 0; this.h[1] = (this.h[1] + b) | 0; this.h[2] = (this.h[2] + c) | 0; this.h[3] = (this.h[3] + d) | 0;
    this.h[4] = (this.h[4] + e) | 0; this.h[5] = (this.h[5] + f) | 0; this.h[6] = (this.h[6] + g) | 0; this.h[7] = (this.h[7] + hh) | 0;
  }
}

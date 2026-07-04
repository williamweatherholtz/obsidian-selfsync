export interface Chunk { hash: string; bytes: Uint8Array }

const MIN = 2048, AVG_MASK = (1 << 14) - 1, MAX = 65536; // avg ~16 KiB

// Fixed gear table (do NOT change — determines chunk boundaries / dedup).
const GEAR = (() => {
  const g = new Uint32Array(256);
  let s = 0x1234567 >>> 0;
  for (let i = 0; i < 256; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; g[i] = s; }
  return g;
})();

// Precomputed byte→2-hex-digit table: avoids a toString(16)+padStart per byte on the
// hot hashing path (every chunk of every file).
const HEX: string[] = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  // A Uint8Array is a BufferSource; digest hashes exactly its view (offset+length),
  // so subarray chunks hash correctly without copying.
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let s = ""; for (let i = 0; i < d.length; i++) s += HEX[d[i]];
  return s;
}

// Content-defined chunking via a rolling gear-hash. Deterministic: identical bytes
// always split into the same chunks, so all clients agree on chunk hashes (the basis
// for dedup). A file shorter than MIN is a single chunk.
//
// Two phases so the CPU-bound boundary scan isn't interleaved with (async) hashing:
//   1. scan synchronously to cut the byte range into slices (no awaits, no allocs
//      beyond subarray views);
//   2. hash all slices — native crypto.subtle.digest calls run concurrently, and
//      Promise.all preserves order so the result is identical to a sequential hash.
export async function chunk(bytes: Uint8Array): Promise<Chunk[]> {
  const slices: Uint8Array[] = [];
  let start = 0, hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]]) >>> 0;
    const len = i - start + 1;
    if (len >= MIN && ((hash & AVG_MASK) === 0 || len >= MAX)) {
      slices.push(bytes.subarray(start, i + 1));
      start = i + 1; hash = 0;
    }
  }
  if (start < bytes.length || slices.length === 0) slices.push(bytes.subarray(start, bytes.length));

  const hashes = await Promise.all(slices.map((s) => sha256hex(s)));
  return slices.map((bytes, i) => ({ hash: hashes[i], bytes }));
}

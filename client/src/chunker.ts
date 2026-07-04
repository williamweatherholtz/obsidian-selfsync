export interface Chunk { hash: string; bytes: Uint8Array }

const MIN = 2048, AVG_MASK = (1 << 14) - 1, MAX = 65536; // avg ~16 KiB

// Fixed gear table (do NOT change — determines chunk boundaries / dedup).
const GEAR = (() => {
  const g = new Uint32Array(256);
  let s = 0x1234567 >>> 0;
  for (let i = 0; i < 256; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; g[i] = s; }
  return g;
})();

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  // A Uint8Array is a BufferSource; digest hashes exactly its view (offset+length),
  // so subarray chunks hash correctly without copying.
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let s = ""; for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

// Content-defined chunking via a rolling gear-hash. Deterministic: identical
// bytes always split into the same chunks, so all clients agree on chunk hashes
// (the basis for dedup). A file shorter than MIN is a single chunk.
export async function chunk(bytes: Uint8Array): Promise<Chunk[]> {
  const out: Chunk[] = [];
  let start = 0, i = 0, hash = 0;
  const push = async (end: number) => {
    const slice = bytes.subarray(start, end);
    out.push({ hash: await sha256hex(slice), bytes: slice });
    start = end; hash = 0;
  };
  while (i < bytes.length) {
    hash = ((hash << 1) + GEAR[bytes[i]]) >>> 0;
    const len = i - start + 1;
    if (len >= MIN && ((hash & AVG_MASK) === 0 || len >= MAX)) { await push(i + 1); }
    i++;
  }
  if (start < bytes.length || out.length === 0) await push(bytes.length);
  return out;
}

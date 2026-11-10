// Byte helpers for the E2EE core. No crypto here: hex, base64, UTF-8, little-endian u32 and concat.
// Every encoding the keyring and the frame use is fixed by the spec (§4.2, §4.4), so each helper
// is total and strict: a malformed input throws rather than returning a partial value.

const HEX = /^[0-9a-f]*$/;

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function fromHex(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 2 !== 0 || !HEX.test(s)) throw new Error("bytes: not lowercase hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
  return out;
}

export function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function fromB64(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !B64.test(s)) throw new Error("bytes: not base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Canonical only: "AR==" and "AQ==" both decode to 0x01, and the server stores the text verbatim,
  // so one record must have one spelling (review pass 1, finding 7).
  if (b64(out) !== s) throw new Error("bytes: not canonical base64");
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("bytes: u32 out of range");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function readU32le(bytes: Uint8Array, off: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(off, true);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Constant-time equality over equal-length inputs. Unequal lengths are unequal without a scan. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** WebCrypto wants a BufferSource over a plain ArrayBuffer. Every buffer here is one (chunker.ts:20 casts the same way). */
export const buf = (u: Uint8Array): BufferSource => u as BufferSource;

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

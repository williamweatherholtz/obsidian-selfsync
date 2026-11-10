// SSE1 chunk frames (D0100, spec §4.2). Deterministic so content-addressed dedup survives: the IV is
// HMAC(k_iv, pt)[0..12], the body is a 32-byte zero commitment pad then pt, the AAD is the label then
// the raw vault_id. frame = "SSE1" || iv (12) || ct_len (u32le) || ct (with the 16-byte tag). Overhead
// is 68 bytes. The decoder verifies the tag, checks all 32 pad bytes, then recomputes the IV from the
// plaintext and compares. Only then is plaintext released. The header is self-delimiting without the
// key, so the server can split a mirrored file and compute the plaintext length (spec §4.5, §4.6).
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { buf, concat, equalBytes, readU32le, u32le } from "./bytes";
import type { Subkeys } from "./subkeys";

export const MAGIC = new Uint8Array([0x53, 0x53, 0x45, 0x31]); // "SSE1"
export const IV_LEN = 12;
export const PAD_LEN = 32;
export const TAG_LEN = 16;
export const HEADER_LEN = 4 + IV_LEN + 4;
export const FRAME_OVERHEAD = HEADER_LEN + PAD_LEN + TAG_LEN; // 68

export class FrameError extends Error {
  constructor(detail: string) { super(`bad frame: ${detail}`); this.name = "FrameError"; }
}

export interface FrameHeader { iv: Uint8Array; ctLen: number; ptLen: number }

/**
 * Header of one complete frame, or null when `frame` is not exactly one well-formed SSE1 frame. Needs no
 * key: ptLen = ctLen - 48. ctLen must cover the pad and the tag, and the frame must end where ct ends.
 */
export function parseFrameHeader(frame: Uint8Array): FrameHeader | null {
  if (frame.length < HEADER_LEN) return null;
  for (let i = 0; i < 4; i++) if (frame[i] !== MAGIC[i]) return null;
  const ctLen = readU32le(frame, 4 + IV_LEN);
  if (ctLen < PAD_LEN + TAG_LEN) return null;
  if (HEADER_LEN + ctLen !== frame.length) return null;
  return { iv: frame.subarray(4, 4 + IV_LEN), ctLen, ptLen: ctLen - PAD_LEN - TAG_LEN };
}

function syntheticIv(kIv: Uint8Array, pt: Uint8Array): Uint8Array {
  return hmac(sha256, kIv, pt).subarray(0, IV_LEN);
}

export async function encodeChunk(keys: Subkeys, pt: Uint8Array): Promise<Uint8Array> {
  const iv = syntheticIv(keys.kIv, pt);
  const body = concat(new Uint8Array(PAD_LEN), pt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(keys.frameAad), tagLength: TAG_LEN * 8 }, keys.kEnc, buf(body)));
  return concat(MAGIC, iv, u32le(ct.length), ct);
}

export async function decodeChunk(keys: Subkeys, frame: Uint8Array): Promise<Uint8Array> {
  const h = parseFrameHeader(frame);
  if (h === null) throw new FrameError("not one SSE1 frame");
  let body: Uint8Array;
  try {
    body = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(h.iv), additionalData: buf(keys.frameAad), tagLength: TAG_LEN * 8 }, keys.kEnc, buf(frame.subarray(HEADER_LEN))));
  } catch {
    throw new FrameError("tag failed");
  }
  if (body.length !== PAD_LEN + h.ptLen) throw new FrameError("body length");
  let pad = 0;
  for (let i = 0; i < PAD_LEN; i++) pad |= body[i];
  if (pad !== 0) throw new FrameError("commitment pad is not zero");
  // A copy, not a view: pt.buffer is the plaintext alone, never the pad (review pass 1, finding 4).
  const pt = body.slice(PAD_LEN);
  if (!equalBytes(syntheticIv(keys.kIv, pt), h.iv)) throw new FrameError("iv does not match the plaintext");
  return pt;
}

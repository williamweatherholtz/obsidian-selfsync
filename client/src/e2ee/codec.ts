// The ONE seam between the sync engine and the content on the wire (D0104, spec section 4.7). PlainCodec
// reproduces today's bytes and hashes exactly: a chunk is its own frame, the file hash is sha256 of the
// bytes, the identity is sha256 of the bytes. E2eeCodec holds the three subkeys: a chunk becomes an SSE1
// frame, the file hash is sha256 of the frame stream, the identity is the cid over the folded path and
// the plaintext. Every call site reads identities through the codec, so the engine never compares a
// plaintext hash against a frame hash. The tag is the cache namespace and the base-ownership key suffix.
import { sha256hex } from "../chunker";
import { Sha256 } from "../streamhash";
import { decodeChunk, encodeChunk } from "./frame";
import { fileHash as frameStreamHash, fileIdentity, IdentityStream } from "./identity";
import type { Subkeys } from "./subkeys";

/** Incremental identity over a file's plaintext, fed in any split. */
export interface IdentityHasher {
  update(bytes: Uint8Array): void;
  hexDigest(): string;
}

export interface ContentCodec {
  /** "plain", or the 16-hex-char codec tag of an encrypted vault. */
  readonly tag: string;
  readonly encrypted: boolean;
  /** Plaintext chunk to the bytes stored on the server (identity when plain). */
  encodeChunk(pt: Uint8Array): Promise<Uint8Array>;
  /** Stored bytes to plaintext, after every integrity check (tag, pad, iv). */
  decodeChunk(frame: Uint8Array): Promise<Uint8Array>;
  /** The server's content address of stored bytes: sha256 of what is stored. */
  address(stored: Uint8Array): Promise<string>;
  /** FileMeta.hash: sha256 of the stored stream (the plaintext for plain, the frames for E2EE). */
  fileHash(stored: Uint8Array[]): Promise<string>;
  /** The identity the engine compares: sha256(pt) for plain, HMAC(k_id, folded path, pt) for E2EE. */
  fileIdentity(path: string, pt: Uint8Array): Promise<string>;
  identityStream(path: string): IdentityHasher;
}

class PlainCodec implements ContentCodec {
  readonly tag = "plain";
  readonly encrypted = false;
  async encodeChunk(pt: Uint8Array): Promise<Uint8Array> { return pt; }
  async decodeChunk(frame: Uint8Array): Promise<Uint8Array> { return frame; }
  address(stored: Uint8Array): Promise<string> { return sha256hex(stored); }
  async fileHash(stored: Uint8Array[]): Promise<string> {
    if (stored.length === 1) return sha256hex(stored[0]);
    const h = new Sha256();
    for (const s of stored) h.update(s);
    return h.hexDigest();
  }
  fileIdentity(_path: string, pt: Uint8Array): Promise<string> { return sha256hex(pt); }
  identityStream(_path: string): IdentityHasher { return new Sha256(); }
}

export const PLAIN_CODEC: ContentCodec = new PlainCodec();

export class E2eeCodec implements ContentCodec {
  readonly encrypted = true;
  readonly tag: string;
  private constructor(readonly keys: Subkeys) { this.tag = keys.tag; }
  static fromKeys(keys: Subkeys): E2eeCodec { return new E2eeCodec(keys); }
  encodeChunk(pt: Uint8Array): Promise<Uint8Array> { return encodeChunk(this.keys, pt); }
  decodeChunk(frame: Uint8Array): Promise<Uint8Array> { return decodeChunk(this.keys, frame); }
  address(stored: Uint8Array): Promise<string> { return sha256hex(stored); }
  async fileHash(stored: Uint8Array[]): Promise<string> { return frameStreamHash(stored); }
  async fileIdentity(path: string, pt: Uint8Array): Promise<string> { return fileIdentity(this.keys.kId, path, pt); }
  identityStream(path: string): IdentityHasher { return new IdentityStream(this.keys.kId, path); }
}

/** The chunk-cache key: the bare hash for a plain vault (byte-identical to today), tag:hash for E2EE. */
export function cacheKey(codec: ContentCodec, hash: string): string {
  return codec.encrypted ? `${codec.tag}:${hash}` : hash;
}

/** The identity of a server row through the codec: cid for E2EE (absent reads as never-equal), hash for plain. */
export function remoteIdentity(codec: ContentCodec, meta: { hash: string; cid?: string }): string {
  return codec.encrypted ? (meta.cid ?? "") : meta.hash;
}

// File identity for an encrypted vault (D0101, spec §4.3). Two identities: FileMeta.hash is sha256 of the
// frame stream, which the server verifies. cid is HMAC(k_id, u32le(len f) || f || pt) with f the
// case-folded path, which only clients compute and verify on every pull. f folds by case only, never
// by normalisation, so one f names one server row (the server's fold is Rust to_lowercase).
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { identityKey } from "../pathidentity";
import { hex, u32le, utf8 } from "./bytes";

const CID_FS = { caseInsensitive: true, normInsensitive: false } as const;

/** The server's path identity: lowercase, no normalisation. */
export function foldPath(path: string): string {
  return identityKey(path, CID_FS);
}

/** Incremental cid: feed the plaintext in any split, read the hex digest once. */
export class IdentityStream {
  private mac: ReturnType<typeof hmac.create>;
  private done = false;

  constructor(kId: Uint8Array, path: string) {
    const f = utf8(foldPath(path));
    this.mac = hmac.create(sha256, kId);
    this.mac.update(u32le(f.length)).update(f);
  }

  update(data: Uint8Array): void {
    if (this.done) throw new Error("IdentityStream: update() after hexDigest()");
    this.mac.update(data);
  }

  hexDigest(): string {
    if (this.done) throw new Error("IdentityStream: hexDigest() called twice");
    this.done = true;
    return hex(this.mac.digest());
  }
}

export function fileIdentity(kId: Uint8Array, path: string, pt: Uint8Array): string {
  const s = new IdentityStream(kId, path);
  s.update(pt);
  return s.hexDigest();
}

/** FileMeta.hash of an encrypted file: sha256 over the frame stream in order. */
export function fileHash(frames: Iterable<Uint8Array>): string {
  const h = sha256.create();
  for (const f of frames) h.update(f);
  return hex(h.digest());
}

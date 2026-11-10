// Content subkeys from VK (D0099, spec §4.1): HKDF-SHA256 with vault_id as salt, never the KDF salt, so a
// later re-wrap that rotates the KDF salt leaves every frame and every cid valid. The codec tag is a
// public name for the key, used as the codec id, the cache namespace and the base key (spec §4.2).
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { buf, concat, hex, utf8 } from "./bytes";

const INFO_ENC = utf8("selfsync/e2ee/v1/chunk-enc");
const INFO_IV = utf8("selfsync/e2ee/v1/chunk-iv");
const INFO_ID = utf8("selfsync/e2ee/v1/file-id");
const TAG_INFO = utf8("selfsync/e2ee/v1/tag");
export const FRAME_AAD_LABEL = utf8("selfsync/e2ee/v1");

export interface Subkeys {
  /** AES-256-GCM chunk key, non-extractable. */
  kEnc: CryptoKey;
  /** Synthetic-IV HMAC key. */
  kIv: Uint8Array;
  /** File-identity HMAC key. */
  kId: Uint8Array;
  /** Codec tag: hex HMAC(k_id, "selfsync/e2ee/v1/tag") cut to 16 characters. */
  tag: string;
  vaultId: Uint8Array;
  /** Frame AAD: "selfsync/e2ee/v1" then the raw 16-byte vault_id. */
  frameAad: Uint8Array;
}

export async function deriveSubkeys(vk: Uint8Array, vaultId: Uint8Array): Promise<Subkeys> {
  if (vk.length !== 32) throw new Error("deriveSubkeys: VK must be 32 bytes");
  if (vaultId.length !== 16) throw new Error("deriveSubkeys: vault_id must be 16 bytes");
  const kEncRaw = hkdf(sha256, vk, vaultId, INFO_ENC, 32);
  const kIv = hkdf(sha256, vk, vaultId, INFO_IV, 32);
  const kId = hkdf(sha256, vk, vaultId, INFO_ID, 32);
  const kEnc = await crypto.subtle.importKey("raw", buf(kEncRaw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  kEncRaw.fill(0);
  const tag = hex(hmac(sha256, kId, TAG_INFO)).slice(0, 16);
  return { kEnc, kIv, kId, tag, vaultId: new Uint8Array(vaultId), frameAad: concat(FRAME_AAD_LABEL, vaultId) };
}

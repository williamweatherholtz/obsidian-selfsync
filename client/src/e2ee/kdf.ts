// Password to KEK (D0099, spec §4.1, §4.9). Argon2id from @noble/hashes with the parameters the keyring
// stores. The Argon2id output is never a cipher key: k_wrap and k_check derive from it by HKDF with
// vault_id as salt. The absolute ceiling is a constant, twice the maximum default, and a keyring above
// it is refused before any derivation, so a lying server cannot exhaust a phone (spec §4.4).
import { argon2idAsync } from "@noble/hashes/argon2";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { utf8 } from "./bytes";

export interface KdfCost { m_kib: number; t: number; p: number }
export interface KdfParams extends KdfCost { alg: string; salt: Uint8Array }

/** Candidate default, final under D0112 once the owner's phone Measurements are recorded. */
// D0115: 32 MiB, three passes, one lane. Basis: the owner's Android Measurement e2eePhoneKdfWallTimeM1
// (4.77 s at 64 MiB in Firefox) with iOS assumed similar (st010, st011). Each keyring stores its own cost.
export const KDF_DEFAULT: KdfCost = { m_kib: 32768, t: 3, p: 1 };
/** Absolute ceiling (spec §4.4): twice the maximum default. */
export const KDF_CEILING: KdfCost = { m_kib: 131072, t: 6, p: 2 };

export const KEK_LEN = 32;
const INFO_WRAP = utf8("selfsync/e2ee/v1/keyring-wrap");
const INFO_CHECK = utf8("selfsync/e2ee/v1/keyring-check");

export class UnsupportedKdfError extends Error {
  constructor(public readonly detail: string) { super(`unsupported KDF parameters: ${detail}`); this.name = "UnsupportedKdfError"; }
}

const isPosInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;

/** Throws UnsupportedKdfError unless alg is argon2id and every cost is a positive integer at or under the ceiling. */
export function assertKdfSupported(params: KdfParams): void {
  if (params.alg !== "argon2id") throw new UnsupportedKdfError(`alg ${String(params.alg)}`);
  for (const k of ["m_kib", "t", "p"] as const) {
    const v = params[k];
    if (!isPosInt(v)) throw new UnsupportedKdfError(`${k} is not a positive integer`);
    if (v > KDF_CEILING[k]) throw new UnsupportedKdfError(`${k} ${v} above the ceiling ${KDF_CEILING[k]}`);
  }
  // Argon2 needs at least 8 KiB per lane. Below that the primitive itself refuses, so refuse here.
  if (params.m_kib < 8 * params.p) throw new UnsupportedKdfError(`m_kib ${params.m_kib} below 8 per lane`);
}

/** Argon2id(password, salt) with the keyring cost. Refuses an unsupported cost before any work. */
export async function deriveKek(password: string, params: KdfParams, onProgress?: (p: number) => void): Promise<Uint8Array> {
  assertKdfSupported(params);
  return argon2idAsync(utf8(password), params.salt, {
    t: params.t, m: params.m_kib, p: params.p, dkLen: KEK_LEN,
    // noble compares maxmem against m * 256 u32 WORDS (argon2.js:230), not bytes: the ceiling in words.
    maxmem: KDF_CEILING.m_kib * 256, onProgress,
  });
}

/** k_wrap and k_check from the KEK: HKDF-SHA256 with vault_id as salt and distinct info strings. */
export function deriveWrapKeys(kek: Uint8Array, vaultId: Uint8Array): { kWrap: Uint8Array; kCheck: Uint8Array } {
  return {
    kWrap: hkdf(sha256, kek, vaultId, INFO_WRAP, 32),
    kCheck: hkdf(sha256, kek, vaultId, INFO_CHECK, 32),
  };
}

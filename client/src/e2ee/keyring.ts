// The keyring: the per-vault record the server stores but cannot open (D0099, spec §4.4). createKeyring
// mints vault_id and VK and wraps VK under k_wrap with AES-256-GCM, a random nonce, a 32-byte zero
// commitment pad and AAD_keyring. openKeyring decides by the outcome table of §4.4 and reads no content:
// parse failure is corrupt, a cost above the ceiling is unsupported, a check mismatch is wrong password
// with no unwrap, a tag or pad failure after a check match is corrupt. The AAD is built from the stored
// fields exactly as received, so any edit to a covered field fails in the cell the table names.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { b64, buf, concat, equalBytes, fromB64, fromHex, hex, randomBytes, u32le, utf8 } from "./bytes";
import { assertKdfSupported, deriveKek, deriveWrapKeys, KDF_DEFAULT, UnsupportedKdfError, type KdfCost } from "./kdf";

export interface Keyring {
  version: 1;
  vault_id: string;
  kdf: { alg: string; m_kib: number; t: number; p: number; salt: string };
  check: string;
  wrap: { alg: "A256GCM"; nonce: string; ct: string };
}

export type KeyringOutcome = "corrupt" | "unsupported" | "wrongPassword";

export class KeyringError extends Error {
  constructor(public readonly outcome: KeyringOutcome, detail: string) {
    super(`${outcome === "wrongPassword" ? "wrong password" : outcome === "unsupported" ? "unsupported KDF parameters" : "corrupt keyring"}: ${detail}`);
    this.name = "KeyringError";
  }
}

export const VAULT_ID_LEN = 16;
export const SALT_LEN = 16;
export const NONCE_LEN = 12;
export const VK_LEN = 32;
export const PAD_LEN = 32;
export const TAG_LEN = 16;
const LABEL = utf8("selfsync-keyring-v1");
const AAD_VERSION = 1;

const corrupt = (detail: string) => new KeyringError("corrupt", detail);
const isPosInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function bytesField(obj: Record<string, unknown>, key: string, len: number, where: string): Uint8Array {
  const v = obj[key];
  if (typeof v !== "string") throw corrupt(`${where}.${key} is not a string`);
  let out: Uint8Array;
  try { out = fromB64(v); } catch { throw corrupt(`${where}.${key} is not base64`); }
  if (out.length !== len) throw corrupt(`${where}.${key} is ${out.length} bytes, expected ${len}`);
  return out;
}

/**
 * Strict shape check. Accepts the JSON text or the parsed object. Any deviation from the §4.4 record is
 * `corrupt`. The KDF cost is checked for shape here and for the ceiling in openKeyring, because the
 * table says a ceiling violation is `unsupported`, not `corrupt`.
 */
export function parseKeyring(input: unknown): Keyring {
  let raw: unknown = input;
  if (typeof input === "string") {
    try { raw = JSON.parse(input); } catch { throw corrupt("not JSON"); }
  }
  if (!isObj(raw)) throw corrupt("not an object");
  if (raw.version !== AAD_VERSION) throw corrupt(`version ${String(raw.version)}`);
  const vaultId = bytesField(raw, "vault_id", VAULT_ID_LEN, "keyring");
  if (!isObj(raw.kdf)) throw corrupt("kdf missing");
  const kdf = raw.kdf;
  if (typeof kdf.alg !== "string" || kdf.alg.length === 0 || kdf.alg.length > 64) throw corrupt("kdf.alg");
  for (const k of ["m_kib", "t", "p"] as const) {
    if (!isPosInt(kdf[k]) || (kdf[k] as number) > 0xffffffff) throw corrupt(`kdf.${k} is not a positive u32`);
  }
  const salt = bytesField(kdf, "salt", SALT_LEN, "kdf");
  if (typeof raw.check !== "string" || raw.check.length !== 64) throw corrupt("check is not 64 hex chars");
  let check: Uint8Array;
  try { check = fromHex(raw.check); } catch { throw corrupt("check is not hex"); }
  if (!isObj(raw.wrap)) throw corrupt("wrap missing");
  const wrap = raw.wrap;
  if (wrap.alg !== "A256GCM") throw corrupt(`wrap.alg ${String(wrap.alg)}`);
  const nonce = bytesField(wrap, "nonce", NONCE_LEN, "wrap");
  const ct = bytesField(wrap, "ct", PAD_LEN + VK_LEN + TAG_LEN, "wrap");
  return {
    version: 1,
    vault_id: b64(vaultId),
    kdf: { alg: kdf.alg, m_kib: kdf.m_kib as number, t: kdf.t as number, p: kdf.p as number, salt: b64(salt) },
    check: hex(check),
    wrap: { alg: "A256GCM", nonce: b64(nonce), ct: b64(ct) },
  };
}

/** AAD_keyring, the fixed byte layout of §4.4, from the stored fields. */
export function aadKeyring(k: Keyring): Uint8Array {
  const vaultId = fromB64(k.vault_id);
  const alg = utf8(k.kdf.alg);
  const salt = fromB64(k.kdf.salt);
  const check = fromHex(k.check);
  return concat(
    LABEL, u32le(k.version),
    u32le(vaultId.length), vaultId,
    u32le(alg.length), alg,
    u32le(k.kdf.m_kib), u32le(k.kdf.t), u32le(k.kdf.p),
    u32le(salt.length), salt,
    u32le(check.length), check,
  );
}

function checkValue(kCheck: Uint8Array): Uint8Array {
  return hmac(sha256, kCheck, LABEL);
}

async function importWrapKey(kWrap: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(kWrap), { name: "AES-GCM" }, false, [usage]);
}

export interface CreateOptions {
  kdf?: KdfCost;
  /** Test-vector hook only: fixed entropy instead of random. Never set in product code. */
  entropy?: { vaultId: Uint8Array; vk: Uint8Array; salt: Uint8Array; nonce: Uint8Array };
  onProgress?: (p: number) => void;
}

export interface CreatedKeyring { keyring: Keyring; vk: Uint8Array; vaultId: Uint8Array }

/** Mint vault_id, salt, VK and nonce, derive the KEK, write check, wrap VK. The result is the stored record. */
export async function createKeyring(password: string, opts: CreateOptions = {}): Promise<CreatedKeyring> {
  const cost = opts.kdf ?? KDF_DEFAULT;
  const e = opts.entropy ?? { vaultId: randomBytes(VAULT_ID_LEN), vk: randomBytes(VK_LEN), salt: randomBytes(SALT_LEN), nonce: randomBytes(NONCE_LEN) };
  if (e.vaultId.length !== VAULT_ID_LEN || e.vk.length !== VK_LEN || e.salt.length !== SALT_LEN || e.nonce.length !== NONCE_LEN) throw new Error("createKeyring: entropy lengths");
  const params = { alg: "argon2id", ...cost, salt: e.salt };
  const kek = await deriveKek(password, params, opts.onProgress);
  const { kWrap, kCheck } = deriveWrapKeys(kek, e.vaultId);
  const keyring: Keyring = {
    version: 1,
    vault_id: b64(e.vaultId),
    kdf: { alg: "argon2id", m_kib: cost.m_kib, t: cost.t, p: cost.p, salt: b64(e.salt) },
    check: hex(checkValue(kCheck)),
    wrap: { alg: "A256GCM", nonce: b64(e.nonce), ct: "" },
  };
  const body = concat(new Uint8Array(PAD_LEN), e.vk);
  const key = await importWrapKey(kWrap, "encrypt");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(e.nonce), additionalData: buf(aadKeyring(keyring)), tagLength: 128 }, key, buf(body)));
  keyring.wrap.ct = b64(ct);
  kek.fill(0); kWrap.fill(0); kCheck.fill(0);
  return { keyring, vk: e.vk, vaultId: e.vaultId };
}

export interface OpenedKeyring { vk: Uint8Array; vaultId: Uint8Array; keyring: Keyring }

/** Decide by the §4.4 table. Throws KeyringError with the outcome cell. Reads no content. */
export async function openKeyring(password: string, input: unknown, onProgress?: (p: number) => void): Promise<OpenedKeyring> {
  const keyring = parseKeyring(input);
  const params = { alg: keyring.kdf.alg, m_kib: keyring.kdf.m_kib, t: keyring.kdf.t, p: keyring.kdf.p, salt: fromB64(keyring.kdf.salt) };
  try { assertKdfSupported(params); } catch (err) {
    if (err instanceof UnsupportedKdfError) throw new KeyringError("unsupported", err.message);
    throw err;
  }
  const vaultId = fromB64(keyring.vault_id);
  const kek = await deriveKek(password, params, onProgress);
  const { kWrap, kCheck } = deriveWrapKeys(kek, vaultId);
  kek.fill(0);
  const expected = checkValue(kCheck);
  kCheck.fill(0);
  if (!equalBytes(expected, fromHex(keyring.check))) { kWrap.fill(0); throw new KeyringError("wrongPassword", "check mismatch"); }
  const key = await importWrapKey(kWrap, "decrypt");
  kWrap.fill(0);
  let body: Uint8Array;
  try {
    body = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64(keyring.wrap.nonce)), additionalData: buf(aadKeyring(keyring)), tagLength: 128 }, key, buf(fromB64(keyring.wrap.ct))));
  } catch {
    throw corrupt("wrap tag failed after a check match");
  }
  if (body.length !== PAD_LEN + VK_LEN) throw corrupt("wrap body length");
  let pad = 0;
  for (let i = 0; i < PAD_LEN; i++) pad |= body[i];
  if (pad !== 0) throw corrupt("commitment pad is not zero");
  return { vk: body.subarray(PAD_LEN), vaultId, keyring };
}

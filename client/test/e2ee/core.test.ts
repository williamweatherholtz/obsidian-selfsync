// E1 e2eeCryptoCore — RED first (sprint1_e1CryptoCore). Every clause of the e2eeCryptoCore DoD has a
// test here; the modules under client/src/e2ee are written to make them green. The construction is
// D0099 (keys), D0100 (frames), D0101 (file identity); the byte layouts are spec §4.2 and §4.4.
import { describe, it, expect } from "vitest";
import { deriveKek, assertKdfSupported, KDF_CEILING, KDF_DEFAULT, UnsupportedKdfError } from "../../src/e2ee/kdf";
import { createKeyring, openKeyring, parseKeyring, aadKeyring, KeyringError, type Keyring } from "../../src/e2ee/keyring";
import { deriveSubkeys } from "../../src/e2ee/subkeys";
import { encodeChunk, decodeChunk, parseFrameHeader, FRAME_OVERHEAD, FrameError } from "../../src/e2ee/frame";
import { foldPath, fileIdentity, IdentityStream, fileHash } from "../../src/e2ee/identity";
import { b64, hex, fromB64, fromHex } from "../../src/e2ee/bytes";
import vector from "./vector.json";

const enc = (s: string) => new TextEncoder().encode(s);
// Small KDF parameters keep the suite fast; the ceiling and the defaults are tested by value, not by running them.
const FAST = { m_kib: 64, t: 1, p: 1 };
const PW = "correct horse battery staple!";

async function freshKeyring(password = PW) {
  return createKeyring(password, { kdf: FAST });
}

describe("E1 (1) deriveKek", () => {
  it("returns 32 bytes and is deterministic for one password and salt", async () => {
    const salt = new Uint8Array(16).fill(7);
    const a = await deriveKek(PW, { alg: "argon2id", ...FAST, salt });
    const b = await deriveKek(PW, { alg: "argon2id", ...FAST, salt });
    expect(a.length).toBe(32);
    expect(hex(a)).toBe(hex(b));
    const c = await deriveKek(PW + "x", { alg: "argon2id", ...FAST, salt });
    expect(hex(c)).not.toBe(hex(a));
  });

  it("the defaults are 64 MiB, three passes, one lane; the ceiling is twice the maximum default", () => {
    expect(KDF_DEFAULT).toEqual({ m_kib: 65536, t: 3, p: 1 });
    expect(KDF_CEILING).toEqual({ m_kib: 131072, t: 6, p: 2 });
  });

  it("refuses parameters above the ceiling as unsupported before any derivation", async () => {
    const salt = new Uint8Array(16);
    for (const bad of [{ m_kib: 131073, t: 1, p: 1 }, { m_kib: 64, t: 7, p: 1 }, { m_kib: 64, t: 1, p: 3 }]) {
      expect(() => assertKdfSupported({ alg: "argon2id", ...bad, salt })).toThrow(UnsupportedKdfError);
      await expect(deriveKek(PW, { alg: "argon2id", ...bad, salt })).rejects.toBeInstanceOf(UnsupportedKdfError);
    }
    expect(() => assertKdfSupported({ alg: "argon2id", ...KDF_CEILING, salt })).not.toThrow();
  });
});

describe("E1 (2) keyring create and open", () => {
  it("createKeyring mints a random vault_id and VK, writes check and a wrapped VK, and openKeyring unwraps it", async () => {
    const { keyring, vk, vaultId } = await freshKeyring();
    expect(keyring.version).toBe(1);
    expect(fromB64(keyring.vault_id).length).toBe(16);
    expect(fromB64(keyring.kdf.salt).length).toBe(16);
    expect(keyring.kdf.alg).toBe("argon2id");
    expect(keyring.check).toMatch(/^[0-9a-f]{64}$/);
    expect(keyring.wrap.alg).toBe("A256GCM");
    expect(fromB64(keyring.wrap.nonce).length).toBe(12);
    expect(fromB64(keyring.wrap.ct).length).toBe(32 + 32 + 16);
    expect(vk.length).toBe(32);
    expect(hex(vaultId)).toBe(hex(fromB64(keyring.vault_id)));
    const opened = await openKeyring(PW, keyring);
    expect(hex(opened.vk)).toBe(hex(vk));
    expect(hex(opened.vaultId)).toBe(hex(vaultId));
    // Two creates never share a vault_id or a VK.
    const second = await freshKeyring();
    expect(second.keyring.vault_id).not.toBe(keyring.vault_id);
    expect(hex(second.vk)).not.toBe(hex(vk));
  });

  it("AAD_keyring has the fixed byte layout of spec §4.4, built from the stored fields as received", async () => {
    const { keyring } = await freshKeyring();
    const aad = aadKeyring(keyring);
    const label = enc("selfsync-keyring-v1");
    const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
    const cat = (...xs: Uint8Array[]) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };
    const alg = enc(keyring.kdf.alg);
    const expected = cat(label, u32(keyring.version), u32(16), fromB64(keyring.vault_id), u32(alg.length), alg,
      u32(keyring.kdf.m_kib), u32(keyring.kdf.t), u32(keyring.kdf.p), u32(16), fromB64(keyring.kdf.salt), u32(32), fromHex(keyring.check));
    expect(hex(aad)).toBe(hex(expected));
  });

  it("decides by the outcome table: parse failure is corrupt, ceiling is unsupported, check mismatch is wrong password, tag failure after a match is corrupt", async () => {
    const { keyring } = await freshKeyring();
    // parse failure
    expect(() => parseKeyring("{not json")).toThrow(KeyringError);
    try { parseKeyring("{not json"); } catch (e) { expect((e as KeyringError).outcome).toBe("corrupt"); }
    try { parseKeyring({ ...keyring, version: 2 }); } catch (e) { expect((e as KeyringError).outcome).toBe("corrupt"); }
    // ceiling
    const ceiling: Keyring = { ...keyring, kdf: { ...keyring.kdf, m_kib: 131073 } };
    await expect(openKeyring(PW, ceiling)).rejects.toMatchObject({ outcome: "unsupported" });
    // wrong password: check mismatch, no unwrap runs
    await expect(openKeyring(PW + "!", keyring)).rejects.toMatchObject({ outcome: "wrongPassword" });
    // altered salt or KDF field: the KEK changes, reads as wrong password
    const salt = new Uint8Array(fromB64(keyring.kdf.salt)); salt[0] ^= 1;
    await expect(openKeyring(PW, { ...keyring, kdf: { ...keyring.kdf, salt: b64(salt) } })).rejects.toMatchObject({ outcome: "wrongPassword" });
    await expect(openKeyring(PW, { ...keyring, kdf: { ...keyring.kdf, t: keyring.kdf.t + 1 } })).rejects.toMatchObject({ outcome: "wrongPassword" });
    // altered check: AAD differs and check mismatches, reads as wrong password
    const check = fromHex(keyring.check); check[0] ^= 1;
    await expect(openKeyring(PW, { ...keyring, check: hex(check) })).rejects.toMatchObject({ outcome: "wrongPassword" });
    // altered vault_id: k_check changes, reads as wrong password (the link vid and the pin catch it first)
    const vid = new Uint8Array(fromB64(keyring.vault_id)); vid[3] ^= 1;
    await expect(openKeyring(PW, { ...keyring, vault_id: b64(vid) })).rejects.toMatchObject({ outcome: "wrongPassword" });
    // altered nonce or wrap.ct: check matches, the tag fails, corrupt
    const nonce = new Uint8Array(fromB64(keyring.wrap.nonce)); nonce[0] ^= 1;
    await expect(openKeyring(PW, { ...keyring, wrap: { ...keyring.wrap, nonce: b64(nonce) } })).rejects.toMatchObject({ outcome: "corrupt" });
    const ct = new Uint8Array(fromB64(keyring.wrap.ct)); ct[40] ^= 1;
    await expect(openKeyring(PW, { ...keyring, wrap: { ...keyring.wrap, ct: b64(ct) } })).rejects.toMatchObject({ outcome: "corrupt" });
  });
});

describe("E1 (3) subkeys", () => {
  it("derives k_enc, k_iv, k_id from VK with vault_id as salt, and the codec tag from k_id", async () => {
    const { vk, vaultId } = await freshKeyring();
    const a = await deriveSubkeys(vk, vaultId);
    const b = await deriveSubkeys(vk, vaultId);
    expect(hex(a.kIv)).toBe(hex(b.kIv));
    expect(hex(a.kId)).toBe(hex(b.kId));
    expect(hex(a.kIv)).not.toBe(hex(a.kId));
    expect(a.tag).toMatch(/^[0-9a-f]{16}$/);
    expect(a.tag).toBe(b.tag);
    // a different vault_id changes every subkey and the tag
    const other = new Uint8Array(vaultId); other[0] ^= 1;
    const c = await deriveSubkeys(vk, other);
    expect(hex(c.kId)).not.toBe(hex(a.kId));
    expect(c.tag).not.toBe(a.tag);
  });
});

describe("E1 (4) (5) frames", () => {
  it("encodes an SSE1 frame with 68 bytes of overhead and the decoder round-trips it", async () => {
    const { vk, vaultId } = await freshKeyring();
    const keys = await deriveSubkeys(vk, vaultId);
    const pt = enc("hello frames");
    const frame = await encodeChunk(keys, pt);
    expect(new TextDecoder().decode(frame.subarray(0, 4))).toBe("SSE1");
    expect(frame.length).toBe(pt.length + FRAME_OVERHEAD);
    expect(FRAME_OVERHEAD).toBe(68);
    const header = parseFrameHeader(frame)!;
    expect(header.ctLen).toBe(pt.length + 32 + 16);
    expect(header.ptLen).toBe(pt.length);
    expect(new TextDecoder().decode(await decodeChunk(keys, frame))).toBe("hello frames");
    // a zero-byte file is one 68-byte frame with size 0
    const empty = await encodeChunk(keys, new Uint8Array(0));
    expect(empty.length).toBe(68);
    expect((await decodeChunk(keys, empty)).length).toBe(0);
  });

  it("is deterministic: the same plaintext under the same VK gives byte-identical frames, distinct plaintexts give distinct frames", async () => {
    const { vk, vaultId } = await freshKeyring();
    const keys = await deriveSubkeys(vk, vaultId);
    const a = await encodeChunk(keys, enc("same"));
    const b = await encodeChunk(keys, enc("same"));
    const c = await encodeChunk(keys, enc("other"));
    expect(hex(a)).toBe(hex(b));
    expect(hex(a)).not.toBe(hex(c));
  });

  it("rejects a flipped byte, a truncated frame, a wrong magic and a bad pad", async () => {
    const { vk, vaultId } = await freshKeyring();
    const keys = await deriveSubkeys(vk, vaultId);
    const frame = await encodeChunk(keys, enc("integrity"));
    const flipped = new Uint8Array(frame); flipped[frame.length - 1] ^= 1;
    await expect(decodeChunk(keys, flipped)).rejects.toBeInstanceOf(FrameError);
    await expect(decodeChunk(keys, frame.subarray(0, frame.length - 1))).rejects.toBeInstanceOf(FrameError);
    const magic = new Uint8Array(frame); magic[0] = 0x58;
    await expect(decodeChunk(keys, magic)).rejects.toBeInstanceOf(FrameError);
    expect(parseFrameHeader(magic)).toBeNull();
    // another vault's keys fail the tag
    const other = await freshKeyring();
    const okeys = await deriveSubkeys(other.vk, other.vaultId);
    await expect(decodeChunk(okeys, frame)).rejects.toBeInstanceOf(FrameError);
  });

  it("parseFrameHeader computes the plaintext length without the key and refuses an inconsistent ct_len", async () => {
    const { vk, vaultId } = await freshKeyring();
    const keys = await deriveSubkeys(vk, vaultId);
    const frame = await encodeChunk(keys, new Uint8Array(1000));
    expect(parseFrameHeader(frame)!.ptLen).toBe(1000);
    const bad = new Uint8Array(frame); new DataView(bad.buffer).setUint32(16, 10, true);
    expect(parseFrameHeader(bad)).toBeNull();
  });
});

describe("E1 (6) file identity", () => {
  it("folds by case only, never by normalisation, and binds the identity to the folded path", async () => {
    const { vk, vaultId } = await freshKeyring();
    const keys = await deriveSubkeys(vk, vaultId);
    const pt = enc("note body");
    expect(foldPath("Notes/Café.md")).toBe("notes/café.md");
    const nfc = "Café.md", nfd = "Café.md";
    expect(foldPath(nfc)).not.toBe(foldPath(nfd));
    const id1 = fileIdentity(keys.kId, "Notes/Café.md", pt);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
    expect(fileIdentity(keys.kId, "notes/café.md", pt)).toBe(id1);
    expect(fileIdentity(keys.kId, "Notes/Café.md", pt)).not.toBe(id1);
    expect(fileIdentity(keys.kId, "Other/Café.md", pt)).not.toBe(id1);
    expect(fileIdentity(keys.kId, "Notes/Café.md", enc("other body"))).not.toBe(id1);
  });

  it("the incremental IdentityStream agrees on every split of the same bytes, and fileHash is sha256 of the frame stream", async () => {
    const { vk, vaultId } = await freshKeyring();
    const keys = await deriveSubkeys(vk, vaultId);
    const pt = new Uint8Array(5000).map((_, i) => (i * 31) & 0xff);
    const whole = fileIdentity(keys.kId, "a/b.md", pt);
    for (const cut of [0, 1, 63, 64, 65, 2500, 4999, 5000]) {
      const s = new IdentityStream(keys.kId, "a/b.md");
      s.update(pt.subarray(0, cut)); s.update(pt.subarray(cut));
      expect(s.hexDigest()).toBe(whole);
    }
    const f1 = await encodeChunk(keys, pt.subarray(0, 2500));
    const f2 = await encodeChunk(keys, pt.subarray(2500));
    const joined = new Uint8Array(f1.length + f2.length); joined.set(f1); joined.set(f2, f1.length);
    const { sha256 } = await import("@noble/hashes/sha2");
    expect(fileHash([f1, f2])).toBe(hex(sha256(joined)));
  });
});

describe("E1 (9) committed test vector", () => {
  it("reproduces the frame, the cid and the tag from the fixed inputs, and opens the keyring", async () => {
    const v = vector;
    const vaultId = fromB64(v.keyring.vault_id);
    const { vk } = await openKeyring(v.password, v.keyring as Keyring);
    expect(hex(vk)).toBe(v.vk_hex);
    const keys = await deriveSubkeys(vk, vaultId);
    expect(keys.tag).toBe(v.tag);
    const pt = fromHex(v.pt_hex);
    const frame = await encodeChunk(keys, pt);
    expect(hex(frame)).toBe(v.frame_hex);
    expect(v.frame_sha256).toBe(fileHash([frame]));
    expect(fileIdentity(keys.kId, v.path, pt)).toBe(v.cid);
    expect(parseFrameHeader(frame)!.ptLen).toBe(pt.length);
  });

  it("holds one tampered keyring per outcome cell, each with its recorded outcome", async () => {
    for (const t of vector.tampered) {
      await expect(openKeyring(vector.password, t.keyring as Keyring)).rejects.toMatchObject({ outcome: t.outcome });
    }
    expect(vector.tampered.map((t) => t.outcome).sort()).toEqual(["corrupt", "corrupt", "unsupported", "wrongPassword", "wrongPassword"]);
  });
});

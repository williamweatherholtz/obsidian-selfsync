// Generator for the committed test vector (clause 9 of e2eeCryptoCore). Skipped unless E2EE_VECTOR_WRITE
// is set, when it rewrites vector.json from the fixed inputs below. core.test.ts reads the vector; the
// Rust server test of E2 reads its frame, length and cid parts. Fixed entropy goes through the
// createKeyring test hook, so the vector is reproducible and never depends on the random source.
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unsafeCreateKeyringWithFixedEntropy, type Keyring } from "../../src/e2ee/keyring";
import { deriveSubkeys } from "../../src/e2ee/subkeys";
import { encodeChunk } from "../../src/e2ee/frame";
import { fileIdentity, fileHash, foldPath } from "../../src/e2ee/identity";
import { b64, fromB64, fromHex, hex } from "../../src/e2ee/bytes";

const seq = (n: number, start: number) => new Uint8Array(n).map((_, i) => (start + i) & 0xff);

describe.skipIf(!process.env.E2EE_VECTOR_WRITE)("vector generator", () => {
  it("writes vector.json", async () => {
    // Non-ASCII, precomposed (NFC) password: the KEK is Argon2id over the raw UTF-8 of the string as
    // typed, with no normalisation (spec section 4.9), and this pins every engine to that mapping.
    const password = "correct horse Café battery staple!";
    const entropy = { vaultId: seq(16, 0x10), vk: seq(32, 0x40), salt: seq(16, 0xa0), nonce: seq(12, 0xd0) };
    const kdf = { m_kib: 64, t: 1, p: 1 };
    const { keyring, vk, vaultId } = await unsafeCreateKeyringWithFixedEntropy(password, entropy, { kdf });
    const keys = await deriveSubkeys(vk, vaultId);
    const path = "Notes/Café ΟΔΥΣΣΕΥΣ/Ünïcödé.md";
    const pt = new TextEncoder().encode("# Ünïcödé\n\nnote body for the E2EE vector, 0123456789\n");
    const frame = await encodeChunk(keys, pt);
    const mutate = (f: (k: Keyring) => Keyring) => f(JSON.parse(JSON.stringify(keyring)) as Keyring);
    const flip = (s: string, i: number) => { const u = fromB64(s); u[i] ^= 1; return b64(u); };
    const tampered = [
      { cell: "parse fails: version 2", outcome: "corrupt", keyring: mutate((k) => ({ ...k, version: 2 as 1 })) },
      { cell: "above the ceiling: m_kib 131073", outcome: "unsupported", keyring: mutate((k) => ({ ...k, kdf: { ...k.kdf, m_kib: 131073 } })) },
      { cell: "check mismatch: salt byte flipped", outcome: "wrongPassword", keyring: mutate((k) => ({ ...k, kdf: { ...k.kdf, salt: flip(k.kdf.salt, 0) } })) },
      { cell: "check mismatch: vault_id byte flipped", outcome: "wrongPassword", keyring: mutate((k) => ({ ...k, vault_id: flip(k.vault_id, 5) })) },
      { cell: "check mismatch: check byte flipped", outcome: "wrongPassword", keyring: mutate((k) => ({ ...k, check: (k.check[0] === "0" ? "1" : "0") + k.check.slice(1) })) },
      { cell: "check mismatch: KDF t raised by one, within the ceiling", outcome: "wrongPassword", keyring: mutate((k) => ({ ...k, kdf: { ...k.kdf, t: k.kdf.t + 1 } })) },
      { cell: "tag fails after a check match: nonce byte flipped", outcome: "corrupt", keyring: mutate((k) => ({ ...k, wrap: { ...k.wrap, nonce: flip(k.wrap.nonce, 0) } })) },
      { cell: "tag fails after a check match: wrap.ct byte flipped", outcome: "corrupt", keyring: mutate((k) => ({ ...k, wrap: { ...k.wrap, ct: flip(k.wrap.ct, 40) } })) },
    ];
    const vector = {
      about: "E2EE test vector, spec sections 4.1, 4.2, 4.3, 4.4. Fixed entropy, small KDF cost for test speed. The password is the raw UTF-8 of the string as typed, no normalisation.",
      password,
      keyring,
      vk_hex: hex(vk),
      vault_id_hex: hex(vaultId),
      tag: keys.tag,
      path,
      folded_path: foldPath(path),
      pt_hex: hex(pt),
      frame_hex: hex(frame),
      frame_sha256: fileHash([frame]),
      cid: fileIdentity(keys.kId, path, pt),
      tampered,
    };
    const out = fileURLToPath(new URL("./vector.json", import.meta.url));
    writeFileSync(out, JSON.stringify(vector, null, 2) + "\n");
    if (fromHex(vector.pt_hex).length !== pt.length) throw new Error("unreachable");
  });
});

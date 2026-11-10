// E3a (1) (2) (4): the ContentCodec seam. PlainCodec reproduces today's bytes and hashes exactly. E2eeCodec
// holds the three subkeys and the tag. The chunk cache is keyed by the codec tag plus the hash. RED first.
import { describe, it, expect } from "vitest";
import { PLAIN_CODEC, E2eeCodec, cacheKey, type ContentCodec } from "../../src/e2ee/codec";
import { createKeyring } from "../../src/e2ee/keyring";
import { deriveSubkeys } from "../../src/e2ee/subkeys";
import { parseFrameHeader } from "../../src/e2ee/frame";
import { fileIdentity } from "../../src/e2ee/identity";
import { chunk, sha256hex } from "../../src/chunker";
import { hex } from "../../src/e2ee/bytes";

const enc = (s: string) => new TextEncoder().encode(s);
const FAST = { m_kib: 64, t: 1, p: 1 };

async function e2eeCodec(): Promise<E2eeCodec> {
  const { vk, vaultId } = await createKeyring("correct horse battery staple!", { kdf: FAST });
  return E2eeCodec.fromKeys(await deriveSubkeys(vk, vaultId));
}

describe("E3a (1) PlainCodec reproduces today's bytes and hashes exactly", () => {
  it("is the identity on chunks, sha256 for identity and hash, tag plain", async () => {
    const c: ContentCodec = PLAIN_CODEC;
    expect(c.tag).toBe("plain");
    expect(c.encrypted).toBe(false);
    const pt = enc("hello plain");
    expect(await c.encodeChunk(pt)).toBe(pt);
    expect(await c.decodeChunk(pt)).toBe(pt);
    expect(await c.fileIdentity("a.md", pt)).toBe(await sha256hex(pt));
    expect(await c.fileIdentity("A.md", pt)).toBe(await sha256hex(pt));
    const parts = await chunk(pt);
    expect(await c.fileHash(parts.map((p) => p.bytes))).toBe(await sha256hex(pt));
    expect(await c.address(pt)).toBe(await sha256hex(pt));
    const s = c.identityStream("a.md");
    s.update(pt.subarray(0, 3)); s.update(pt.subarray(3));
    expect(s.hexDigest()).toBe(await sha256hex(pt));
  });
});

describe("E3a (1) E2eeCodec", () => {
  it("encodes to SSE1 frames, decodes back, and its identity is the cid over the folded path", async () => {
    const c = await e2eeCodec();
    expect(c.encrypted).toBe(true);
    expect(c.tag).toMatch(/^[0-9a-f]{16}$/);
    const pt = enc("secret body");
    const frame = await c.encodeChunk(pt);
    expect(parseFrameHeader(frame)!.ptLen).toBe(pt.length);
    expect(new TextDecoder().decode(await c.decodeChunk(frame))).toBe("secret body");
    expect(await c.address(frame)).toBe(await sha256hex(frame));
    const id = await c.fileIdentity("Notes/A.md", pt);
    expect(id).toBe(fileIdentity(c.keys.kId, "Notes/A.md", pt));
    expect(await c.fileIdentity("notes/a.md", pt)).toBe(id);
    expect(await c.fileIdentity("Notes/B.md", pt)).not.toBe(id);
    const s = c.identityStream("Notes/A.md");
    s.update(pt);
    expect(s.hexDigest()).toBe(id);
    const f2 = await c.encodeChunk(enc("two"));
    expect(await c.fileHash([frame, f2])).toBe(await sha256hex(new Uint8Array([...frame, ...f2])));
    expect(hex(c.keys.kId)).not.toBe(c.tag);
  });
});

describe("E3a (4) cache keys carry the codec tag", () => {
  it("the same hash under two codecs is two keys, and the plain key is the bare hash", async () => {
    const c = await e2eeCodec();
    expect(cacheKey(PLAIN_CODEC, "abc")).toBe("abc");
    expect(cacheKey(c, "abc")).toBe(`${c.tag}:abc`);
    expect(cacheKey(c, "abc")).not.toBe(cacheKey(PLAIN_CODEC, "abc"));
  });
});

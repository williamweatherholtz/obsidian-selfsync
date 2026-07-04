import { describe, it, expect } from "vitest";
import { chunk, sha256hex } from "../src/chunker";

const enc = (s: string) => new TextEncoder().encode(s);

describe("chunker", () => {
  it("sha256hex matches a known vector", async () => {
    expect(await sha256hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("small input is a single chunk that reassembles", async () => {
    const data = enc("hello world");
    const cs = await chunk(data);
    expect(cs.length).toBe(1);
    expect(cs[0].hash).toBe(await sha256hex(data));
    const joined = new Uint8Array(cs.reduce((n, c) => n + c.bytes.length, 0));
    let o = 0; for (const c of cs) { joined.set(c.bytes, o); o += c.bytes.length; }
    expect(joined).toEqual(data);
  });

  it("empty input is a single empty chunk", async () => {
    const cs = await chunk(new Uint8Array(0));
    expect(cs.length).toBe(1);
    expect(cs[0].bytes.length).toBe(0);
  });

  it("is deterministic and content-addressed (same bytes -> same chunks)", async () => {
    const data = new Uint8Array(200_000).map((_, i) => (i * 2654435761) & 0xff);
    const a = await chunk(data);
    const b = await chunk(data);
    expect(a.map((c) => c.hash)).toEqual(b.map((c) => c.hash));
    expect(a.length).toBeGreaterThan(1); // large input splits
    // reassembles exactly
    const total = a.reduce((n, c) => n + c.bytes.length, 0);
    expect(total).toBe(data.length);
    const joined = new Uint8Array(total);
    let o = 0; for (const c of a) { joined.set(c.bytes, o); o += c.bytes.length; }
    expect(joined).toEqual(data);
  });

  it("respects MIN/MAX chunk bounds on large input", async () => {
    const data = new Uint8Array(300_000).map((_, i) => (i * 40503) & 0xff);
    const cs = await chunk(data);
    // every chunk except the last must be >= MIN (2048) and <= MAX (65536)
    for (let k = 0; k < cs.length; k++) {
      expect(cs[k].bytes.length).toBeLessThanOrEqual(65536);
      if (k < cs.length - 1) expect(cs[k].bytes.length).toBeGreaterThanOrEqual(2048);
    }
  });
});

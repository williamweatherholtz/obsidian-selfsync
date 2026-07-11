import { describe, it, expect } from "vitest";
import { encodeShareLink, parseShareLink, isShareLink } from "../src/sharelink";

describe("share-link codec (D0023)", () => {
  it("encodes then parses back to the same server + token", () => {
    const link = encodeShareLink({ server: "https://sync.example", token: "abc123" });
    expect(isShareLink(link)).toBe(true);
    const back = parseShareLink(link);
    expect(back).toEqual({ server: "https://sync.example", token: "abc123" });
  });

  it("carries NO permission or vault (those are server-side)", () => {
    const link = encodeShareLink({ server: "https://s", token: "t" });
    expect(link).not.toMatch(/perm|read|vault/i);
  });

  it("normalizes the server (strips path/trailing slash)", () => {
    expect(parseShareLink(encodeShareLink({ server: "https://s.example/", token: "t" })).server).toBe("https://s.example");
  });

  it("rejects a non-share link and a link missing the token", () => {
    expect(() => parseShareLink("selfsync://connect?server=https://s&user=u")).toThrow(/Not a SelfSync share link/);
    expect(() => parseShareLink("https://evil.example")).toThrow(/Not a SelfSync share link/);
    expect(() => parseShareLink("selfsync-share://redeem?server=https://s")).toThrow(/missing server or token/);
    expect(() => encodeShareLink({ server: "https://s", token: "" })).toThrow(/token required/);
  });

  it("isShareLink distinguishes it from a setup link", () => {
    expect(isShareLink("selfsync-share://redeem?server=https://s&token=t")).toBe(true);
    expect(isShareLink("selfsync://connect?server=https://s&user=u")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { encodeShareLink, parseShareLink, isShareLink, redeemTargetError } from "../src/sharelink";

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

  it("parses a real percent-encoded link (regression: bare-label host threw 'Invalid URL' on mobile)", () => {
    const link = "selfsync-share://redeem?server=https%3A%2F%2Fnotes2.willweatherholtz.com&token=51f08f4b39804e42952e5d14575fb659";
    const back = parseShareLink(link);
    expect(back.server).toBe("https://notes2.willweatherholtz.com");
    expect(back.token).toBe("51f08f4b39804e42952e5d14575fb659");
  });

  it("isShareLink distinguishes it from a setup link", () => {
    expect(isShareLink("selfsync-share://redeem?server=https://s&token=t")).toBe(true);
    expect(isShareLink("selfsync://connect?server=https://s&user=u")).toBe(false);
  });

  describe("redeemTargetError — redeem is authenticated + server-specific", () => {
    it("a not-set-up device (empty server) gets clear guidance, NOT a URL crash", () => {
      const msg = redeemTargetError("https://notes2.willweatherholtz.com", "");
      expect(msg).toMatch(/set up selfsync and sign in/i);
      expect(msg).toContain("notes2.willweatherholtz.com");
    });
    it("a device signed in to a DIFFERENT server is told to set up against the link's server", () => {
      const msg = redeemTargetError("https://notes2.willweatherholtz.com", "https://other.example");
      expect(msg).toMatch(/this link is for https:\/\/notes2\.willweatherholtz\.com/i);
    });
    it("returns null when the device is signed in to the SAME server (redeem may proceed)", () => {
      expect(redeemTargetError("https://s.example/", "https://s.example")).toBeNull();
    });
  });
});

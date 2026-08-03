import { describe, it, expect } from "vitest";
import { encodeInviteLink, parseInviteLink, isInviteLink } from "../src/invitelink";

describe("account-creation (invite) link codec (D0037)", () => {
  it("encodes then parses back to the same server + token", () => {
    const link = encodeInviteLink({ server: "https://sync.example", token: "inv123" });
    expect(isInviteLink(link)).toBe(true);
    expect(parseInviteLink(link)).toEqual({ server: "https://sync.example", token: "inv123" });
  });

  it("normalizes the server (strips path/trailing slash)", () => {
    expect(parseInviteLink(encodeInviteLink({ server: "https://s.example/", token: "t" })).server).toBe("https://s.example");
  });

  it("rejects a non-invite link and a link missing the token", () => {
    expect(() => parseInviteLink("selfsync://connect?server=https://s&user=u")).toThrow(/Not a SelfSync invite link/);
    expect(() => parseInviteLink("selfsync-share://redeem?server=https://s&token=t")).toThrow(/Not a SelfSync invite link/);
    expect(() => parseInviteLink("selfsync-invite://register?server=https://s")).toThrow(/missing server or token/);
    expect(() => encodeInviteLink({ server: "https://s", token: "" })).toThrow(/token required/);
  });

  it("parses a real percent-encoded link (no `new URL` on the scheme-swapped string — mobile-safe)", () => {
    const link = "selfsync-invite://register?server=https%3A%2F%2Fnotes.example.com&token=deadbeefdeadbeef";
    const back = parseInviteLink(link);
    expect(back.server).toBe("https://notes.example.com");
    expect(back.token).toBe("deadbeefdeadbeef");
  });

  it("isInviteLink distinguishes it from setup and share links", () => {
    expect(isInviteLink("selfsync-invite://register?server=https://s&token=t")).toBe(true);
    expect(isInviteLink("selfsync-share://redeem?server=https://s&token=t")).toBe(false);
    expect(isInviteLink("selfsync://connect?server=https://s&user=u")).toBe(false);
  });
});

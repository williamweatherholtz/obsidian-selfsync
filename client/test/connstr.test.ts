import { describe, it, expect } from "vitest";
import { encodeSetupLink, parseSetupLink, normalizeServer } from "../src/connstr";

describe("connstr round-trip", () => {
  it("encodes then parses back to the same server+user", () => {
    const link = encodeSetupLink({ server: "https://sync.example.com", user: "will" });
    expect(link.startsWith("selfsync://")).toBe(true);
    const back = parseSetupLink(link);
    expect(back).toEqual({ server: "https://sync.example.com", user: "will" });
  });
  it("preserves http vs https and custom (non-default) ports", () => {
    const back = parseSetupLink(encodeSetupLink({ server: "http://192.168.1.9:8789", user: "a" }));
    expect(back.server).toBe("http://192.168.1.9:8789");
  });
  it("carries the vault when present, and omits it when absent", () => {
    const withVault = parseSetupLink(encodeSetupLink({ server: "https://s.example.com", user: "will", vault: "notes" }));
    expect(withVault).toEqual({ server: "https://s.example.com", user: "will", vault: "notes" });
    const without = parseSetupLink(encodeSetupLink({ server: "https://s.example.com", user: "will" }));
    expect(without.vault).toBeUndefined();
  });
  it("canonicalizes away the default port (:443/:80) — equivalent origins", () => {
    expect(normalizeServer("https://sync.example.com:443")).toBe("https://sync.example.com");
    expect(normalizeServer("http://sync.example.com:80")).toBe("http://sync.example.com");
  });
});

describe("connstr never carries a secret", () => {
  it("the encoded link contains no password (there is no password field)", () => {
    const link = encodeSetupLink({ server: "https://s.example.com", user: "will" });
    expect(link.toLowerCase()).not.toContain("password");
    expect(link).not.toContain("hunter2");
  });
});

describe("connstr validation", () => {
  it("rejects a non-selfsync string", () => {
    expect(() => parseSetupLink("https://example.com?user=x")).toThrow(/setup link/i);
  });
  it("rejects a link missing user or server", () => {
    expect(() => parseSetupLink("selfsync://connect?server=https%3A%2F%2Fs.example.com")).toThrow(/missing/i);
  });
  it("normalizeServer strips path/query and trailing slash, rejects non-http(s)", () => {
    expect(normalizeServer("https://s.example.com/base/")).toBe("https://s.example.com");
    expect(() => normalizeServer("ftp://s.example.com")).toThrow(/http/i);
    expect(() => normalizeServer("not a url")).toThrow();
  });
});

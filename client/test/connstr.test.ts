import { describe, it, expect } from "vitest";
import { encodeSetupLink, parseSetupLink, normalizeServer, isInsecureRemote, parseServerOrigin } from "../src/connstr";

describe("isInsecureRemote — block cleartext credentials to a remote host (SEC-AUTH)", () => {
  it("flags http:// to a remote host (interceptable credentials)", () => {
    for (const s of ["http://sync.example.com", "http://192.168.1.9:8080", "http://myserver:8080"]) {
      expect(isInsecureRemote(s), s).toBe(true);
    }
  });
  it("allows https anywhere and http only to loopback (local dev / same-host TLS proxy)", () => {
    for (const s of ["https://sync.example.com", "https://192.168.1.9", "http://localhost:8080",
                     "http://127.0.0.1:8080", "http://foo.localhost:8080"]) {
      expect(isInsecureRemote(s), s).toBe(false);
    }
  });
});

describe("parseServerOrigin — refined origin carrying the cleartext verdict once (parse-don't-validate)", () => {
  it("carries href (== normalizeServer) AND insecureRemote (== isInsecureRemote) computed at parse", () => {
    for (const s of ["https://sync.example.com", "http://sync.example.com", "http://localhost:8080",
                     "https://s.example.com:443", "http://127.0.0.1:8080/base/"]) {
      const o = parseServerOrigin(s);
      expect(o.href).toBe(normalizeServer(s));           // href agrees with the string normalizer
      expect(o.insecureRemote).toBe(isInsecureRemote(s)); // verdict agrees with the string predicate
    }
  });
  it("rejects the same inputs normalizeServer rejects (single parse boundary)", () => {
    expect(() => parseServerOrigin("ftp://s.example.com")).toThrow(/http/i);
    expect(() => parseServerOrigin("not a url")).toThrow();
  });
});

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

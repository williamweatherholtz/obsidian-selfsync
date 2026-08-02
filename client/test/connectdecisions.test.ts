import { describe, it, expect } from "vitest";
import { versionVerdict, vaultKeyMismatch, switchAlreadyApplied, resumeAction } from "../src/connectdecisions";

// The pure connect-effect decisions extracted from doConnect (functional-decoupling D0036) — now testable
// in isolation, instead of only through a full-connect integration test.

describe("versionVerdict — protocol compatibility (R12-PB2 fail-closed)", () => {
  it("matching versions → ok", () => {
    expect(versionVerdict(5, 5)).toEqual({ ok: true });
  });
  it("an ABSENT server version fails CLOSED (unknown, never assume-ok)", () => {
    expect(versionVerdict(undefined, 5)).toEqual({ ok: false, serverLabel: "an unknown version" });
  });
  it("a different server version → mismatch with a labeled version", () => {
    expect(versionVerdict(3, 5)).toEqual({ ok: false, serverLabel: "v3" });
    expect(versionVerdict(7, 5)).toEqual({ ok: false, serverLabel: "v7" });
  });
});

describe("vaultKeyMismatch — D0047 guard (fix ③ server-qualified + grandfather)", () => {
  it("NEW server-qualified key: same server+vault → no mismatch; DIFFERENT server, same vault name → mismatch", () => {
    expect(vaultKeyMismatch("x|/notes", "x|/notes", "/notes")).toBe(false);
    expect(vaultKeyMismatch("x|/notes", "otherhost|/notes", "/notes")).toBe(true); // cross-server, same name
  });
  it("OLD server-blind key (no `|`) is grandfathered — compared on owner/vault only (no spurious upgrade merge)", () => {
    expect(vaultKeyMismatch("/notes", "x|/notes", "/notes")).toBe(false);  // matches history → grandfathered, no merge
    expect(vaultKeyMismatch("/notes", "x|/other", "/other")).toBe(true);   // genuine vault change still trips
  });
});

describe("switchAlreadyApplied — the re-clobber guard", () => {
  it("no pending switch → not applied", () => {
    expect(switchAlreadyApplied(undefined, "x|/v", "x|/v", true)).toBe(false);
  });
  it("pending + base already the target (non-empty) → APPLIED (clear it, don't re-run)", () => {
    expect(switchAlreadyApplied("download", "x|/v", "x|/v", true)).toBe(true);
  });
  it("pending but base is still the OLD vault → NOT applied (replays, R12-CA1)", () => {
    expect(switchAlreadyApplied("upload", "x|/old", "x|/v", true)).toBe(false);
  });
  it("pending + target key but EMPTY base → not applied (nothing established yet)", () => {
    expect(switchAlreadyApplied("merge", "x|/v", "x|/v", false)).toBe(false);
  });
});

describe("resumeAction — mobile foreground/resume decision", () => {
  it("a DISCONNECTED engine (failed connect, suspended backoff) → re-attempt with a fresh connect", () => {
    expect(resumeAction("disconnected")).toBe("connect");
  });
  it("any other state → reassess (the engine gates a reconcile until connected; 'off' is left alone)", () => {
    for (const s of ["idle", "reconciling", "connecting", "off", "unloading"]) {
      expect(resumeAction(s)).toBe("reassess");
    }
  });
});

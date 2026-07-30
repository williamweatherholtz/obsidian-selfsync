import { describe, it, expect } from "vitest";
import {
  classifyConnectError, recoveryFor, linkNext, blockedTip, LINK_OK,
  ConnErrorInfo, FailureClass, LinkState,
} from "../src/connstate";

// Base info: an authed non-login call with no stored password. Override per case.
const info = (o: Partial<ConnErrorInfo>): ConnErrorInfo =>
  ({ wasLogin: false, endpoint: "other", hasStoredPassword: false, ...o });
const cls = (o: Partial<ConnErrorInfo>) => classifyConnectError(info(o)).kind;

describe("classifyConnectError — the corrected table (avoid BOTH strand and loop)", () => {
  it("network / DNS / timeout / malformed (no status) → transient", () => {
    expect(cls({ status: undefined })).toBe("transient");
  });
  it("5xx and 408 → transient; 503 → serverDegraded", () => {
    for (const s of [500, 502, 504, 408]) expect(cls({ status: s })).toBe("transient");
    expect(cls({ status: 503 })).toBe("serverDegraded");
  });
  it("429 → lockedOut, carrying Retry-After or defaulting to 60s", () => {
    const c = classifyConnectError(info({ status: 429, retryAfterSecs: 300 }));
    expect(c).toEqual({ kind: "lockedOut", retryAfterSecs: 300 });
    expect(classifyConnectError(info({ status: 429 }))).toEqual({ kind: "lockedOut", retryAfterSecs: 60 });
  });

  it("401 on LOGIN (bad creds) → authRejected — NOT a retry (the loop-prevention)", () => {
    expect(cls({ status: 401, wasLogin: true })).toBe("authRejected");
  });
  it("401 on login with an MFA body → mfaRequired", () => {
    expect(cls({ status: 401, wasLogin: true, bodyHint: "mfa required" })).toBe("mfaRequired");
    expect(cls({ status: 401, wasLogin: true, bodyHint: "enter your authenticator code" })).toBe("mfaRequired");
  });
  it("401 on an AUTHED call: no stored pw → sessionExpired; stored pw (re-login already failed) → authRejected", () => {
    expect(cls({ status: 401, wasLogin: false, hasStoredPassword: false })).toBe("sessionExpired");
    expect(cls({ status: 401, wasLogin: false, hasStoredPassword: true })).toBe("authRejected");
  });

  it("403 → forbidden; 403 password-change body → mustChangePassword", () => {
    expect(cls({ status: 403 })).toBe("forbidden");
    expect(cls({ status: 403, bodyHint: "password change required" })).toBe("mustChangePassword");
  });

  it("404 on the vault-scope status probe → vaultGone", () => {
    expect(cls({ status: 404, endpoint: "vaultStatus" })).toBe("vaultGone");
  });
  it("STRAND-PREVENTION: 404 on chunk/meta/commit is TRANSIENT, never vaultGone", () => {
    for (const e of ["chunk", "meta", "commit"] as const) {
      expect(cls({ status: 404, endpoint: e })).toBe("transient");
    }
  });

  it("synthetic conditions classify without a status", () => {
    expect(cls({ synthetic: "versionMismatch" })).toBe("versionMismatch");
    expect(cls({ synthetic: "sessionExpired" })).toBe("sessionExpired");
    expect(cls({ synthetic: "serverDegraded" })).toBe("serverDegraded");
  });

  it("residual unknown status (400 / other 4xx) → serverDegraded (bounded slow retry — never strand, never tight-loop)", () => {
    expect(cls({ status: 400 })).toBe("serverDegraded");
    expect(cls({ status: 418 })).toBe("serverDegraded");
  });
});

describe("recoveryFor — no class both strands and loops", () => {
  const all: FailureClass[] = [
    { kind: "transient" }, { kind: "serverDegraded" }, { kind: "lockedOut", retryAfterSecs: 300 },
    { kind: "authRejected" }, { kind: "sessionExpired" }, { kind: "mfaRequired" },
    { kind: "forbidden" }, { kind: "mustChangePassword" }, { kind: "versionMismatch" }, { kind: "vaultGone" },
  ];
  it("every class has a defined recovery (total)", () => {
    for (const c of all) expect(recoveryFor(c)).toBeTruthy();
  });
  it("transient → backoff; degraded/unknown → slow; lockedOut → its window", () => {
    expect(recoveryFor({ kind: "transient" })).toEqual({ kind: "retryBackoff" });
    expect(recoveryFor({ kind: "serverDegraded" })).toEqual({ kind: "retrySlow", secs: 60 });
    expect(recoveryFor({ kind: "lockedOut", retryAfterSecs: 300 })).toEqual({ kind: "retryAfter", secs: 300 });
  });
  it("STRAND-PREVENTION: every awaitUser (blocked) class still arms a slow self-heal re-probe", () => {
    for (const c of all) {
      const r = recoveryFor(c);
      if (r.kind === "awaitUser") expect(r.reprobeSecs).toBeGreaterThan(0);
    }
    // the terminal-looking classes are awaitUser+reprobe, never a dead end
    for (const k of ["authRejected", "sessionExpired", "versionMismatch", "vaultGone", "forbidden", "mustChangePassword", "mfaRequired"] as const) {
      const r = recoveryFor({ kind: k } as FailureClass);
      expect(r.kind).toBe("awaitUser");
      expect((r as { reprobeSecs: number }).reprobeSecs).toBeGreaterThan(0);
    }
  });
});

describe("linkNext — the LinkState FSM", () => {
  it("connected and userRetry both return to ok", () => {
    expect(linkNext({ kind: "blocked", reason: "authRejected", recovery: { kind: "awaitUser", reprobeSecs: 600 } }, { kind: "connected" })).toEqual(LINK_OK);
    expect(linkNext({ kind: "blocked", reason: "vaultGone", recovery: { kind: "awaitUser", reprobeSecs: 600 } }, { kind: "userRetry" })).toEqual(LINK_OK);
  });
  it("a transient failure → retrying, incrementing the attempt count", () => {
    const s1 = linkNext(LINK_OK, { kind: "failed", cls: { kind: "transient" } });
    expect(s1).toMatchObject({ kind: "retrying", attempt: 1 });
    const s2 = linkNext(s1, { kind: "failed", cls: { kind: "transient" } });
    expect(s2).toMatchObject({ kind: "retrying", attempt: 2 });
  });
  it("LOOP-PREVENTION: a login-401 failure → blocked{authRejected}, not retrying", () => {
    const s = linkNext(LINK_OK, { kind: "failed", cls: { kind: "authRejected" } });
    expect(s).toMatchObject({ kind: "blocked", reason: "authRejected" });
    expect(s.kind === "blocked" && s.recovery.kind).toBe("awaitUser");
  });
  it("a lockedOut that then fails again as authRejected transitions retrying → blocked (never re-loops)", () => {
    const locked = linkNext(LINK_OK, { kind: "failed", cls: { kind: "lockedOut", retryAfterSecs: 300 } });
    expect(locked).toMatchObject({ kind: "retrying" });
    const blocked = linkNext(locked, { kind: "failed", cls: { kind: "authRejected" } });
    expect(blocked).toMatchObject({ kind: "blocked", reason: "authRejected" });
  });
  it("every block reason has a non-empty tip", () => {
    for (const r of ["authRejected", "sessionExpired", "mfaRequired", "forbidden", "mustChangePassword", "versionMismatch", "vaultGone"] as const) {
      expect(blockedTip(r).length).toBeGreaterThan(0);
    }
  });
});

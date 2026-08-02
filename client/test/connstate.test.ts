import { describe, it, expect } from "vitest";
import {
  classifyConnectError, recoveryFor, linkNext, blockedTip, LINK_OK,
  ConnErrorInfo, FailureClass, FailureKind, RecoveryKind, LinkKind, LinkEventKind, Endpoint, SyntheticKind, BlockReason,
} from "../src/connstate";

// Base info: an authed non-login call with no stored password. Override per case.
const info = (o: Partial<ConnErrorInfo>): ConnErrorInfo =>
  ({ wasLogin: false, endpoint: Endpoint.Other, hasStoredPassword: false, ...o });
const cls = (o: Partial<ConnErrorInfo>) => classifyConnectError(info(o)).kind;

describe("classifyConnectError — the corrected table (avoid BOTH strand and loop)", () => {
  it("network / DNS / timeout / malformed (no status) → Transient", () => {
    expect(cls({ status: undefined })).toBe(FailureKind.Transient);
  });
  it("5xx and 408 → Transient; 503 → ServerDegraded", () => {
    for (const s of [500, 502, 504, 408]) expect(cls({ status: s })).toBe(FailureKind.Transient);
    expect(cls({ status: 503 })).toBe(FailureKind.ServerDegraded);
  });
  it("429 → LockedOut, carrying Retry-After or defaulting to 60s", () => {
    expect(classifyConnectError(info({ status: 429, retryAfterSecs: 300 }))).toEqual({ kind: FailureKind.LockedOut, retryAfterSecs: 300 });
    expect(classifyConnectError(info({ status: 429 }))).toEqual({ kind: FailureKind.LockedOut, retryAfterSecs: 60 });
  });

  it("401 on LOGIN (bad creds) → AuthRejected — NOT a retry (loop-prevention)", () => {
    expect(cls({ status: 401, wasLogin: true })).toBe(FailureKind.AuthRejected);
  });
  it("401 on login with an MFA body → MfaRequired", () => {
    expect(cls({ status: 401, wasLogin: true, bodyHint: "mfa required" })).toBe(FailureKind.MfaRequired);
    expect(cls({ status: 401, wasLogin: true, bodyHint: "enter your authenticator code" })).toBe(FailureKind.MfaRequired);
  });
  it("401 on an AUTHED call: no stored pw → SessionExpired; stored pw (re-login already failed) → AuthRejected", () => {
    expect(cls({ status: 401, wasLogin: false, hasStoredPassword: false })).toBe(FailureKind.SessionExpired);
    expect(cls({ status: 401, wasLogin: false, hasStoredPassword: true })).toBe(FailureKind.AuthRejected);
  });

  it("403 → Forbidden; 403 password-change body → MustChangePassword", () => {
    expect(cls({ status: 403 })).toBe(FailureKind.Forbidden);
    expect(cls({ status: 403, bodyHint: "password change required" })).toBe(FailureKind.MustChangePassword);
  });

  it("404 on the vault-scope status probe → VaultGone", () => {
    expect(cls({ status: 404, endpoint: Endpoint.VaultStatus })).toBe(FailureKind.VaultGone);
  });
  it("STRAND-PREVENTION: 404 on chunk/meta/commit is Transient, never VaultGone", () => {
    for (const e of [Endpoint.Chunk, Endpoint.Meta, Endpoint.Commit]) {
      expect(cls({ status: 404, endpoint: e })).toBe(FailureKind.Transient);
    }
  });

  it("synthetic conditions classify without a status", () => {
    expect(cls({ synthetic: SyntheticKind.VersionMismatch })).toBe(FailureKind.VersionMismatch);
    expect(cls({ synthetic: SyntheticKind.SessionExpired })).toBe(FailureKind.SessionExpired);
    expect(cls({ synthetic: SyntheticKind.ServerDegraded })).toBe(FailureKind.ServerDegraded);
  });

  it("residual unknown status (400 / other 4xx) → ServerDegraded (bounded slow retry — never strand, never tight-loop)", () => {
    expect(cls({ status: 400 })).toBe(FailureKind.ServerDegraded);
    expect(cls({ status: 418 })).toBe(FailureKind.ServerDegraded);
  });
});

describe("recoveryFor — no class both strands and loops", () => {
  const all: FailureClass[] = [
    { kind: FailureKind.Transient }, { kind: FailureKind.ServerDegraded }, { kind: FailureKind.LockedOut, retryAfterSecs: 300 },
    { kind: FailureKind.AuthRejected }, { kind: FailureKind.SessionExpired }, { kind: FailureKind.MfaRequired },
    { kind: FailureKind.Forbidden }, { kind: FailureKind.MustChangePassword }, { kind: FailureKind.VersionMismatch }, { kind: FailureKind.VaultGone },
  ];
  it("every class has a defined recovery (total)", () => {
    for (const c of all) expect(recoveryFor(c)).toBeTruthy();
  });
  it("Transient → backoff; degraded/unknown → slow; LockedOut → its window", () => {
    expect(recoveryFor({ kind: FailureKind.Transient })).toEqual({ kind: RecoveryKind.Backoff });
    expect(recoveryFor({ kind: FailureKind.ServerDegraded })).toEqual({ kind: RecoveryKind.Slow, secs: 60 });
    expect(recoveryFor({ kind: FailureKind.LockedOut, retryAfterSecs: 300 })).toEqual({ kind: RecoveryKind.After, secs: 300 });
  });
  it("STRAND-PREVENTION: every AwaitUser (blocked) class still arms a slow self-heal re-probe", () => {
    for (const k of [FailureKind.AuthRejected, FailureKind.SessionExpired, FailureKind.VersionMismatch, FailureKind.VaultGone, FailureKind.Forbidden, FailureKind.MustChangePassword, FailureKind.MfaRequired]) {
      const r = recoveryFor({ kind: k } as FailureClass);
      expect(r.kind).toBe(RecoveryKind.AwaitUser);
      expect((r as { reprobeSecs: number }).reprobeSecs).toBeGreaterThan(0);
    }
  });
});

describe("linkNext — the LinkState FSM", () => {
  const awaitUserRec = { kind: RecoveryKind.AwaitUser as const, reprobeSecs: 600 };
  it("Connected returns a blocked link to Ok", () => {
    expect(linkNext({ kind: LinkKind.Blocked, reason: FailureKind.AuthRejected, recovery: awaitUserRec }, { kind: LinkEventKind.Connected })).toEqual(LINK_OK);
    expect(linkNext({ kind: LinkKind.Blocked, reason: FailureKind.VaultGone, recovery: awaitUserRec }, { kind: LinkEventKind.Connected })).toEqual(LINK_OK);
  });
  it("a Transient failure → Retrying, incrementing the attempt count", () => {
    const s1 = linkNext(LINK_OK, { kind: LinkEventKind.Failed, cls: { kind: FailureKind.Transient } });
    expect(s1).toMatchObject({ kind: LinkKind.Retrying, attempt: 1 });
    const s2 = linkNext(s1, { kind: LinkEventKind.Failed, cls: { kind: FailureKind.Transient } });
    expect(s2).toMatchObject({ kind: LinkKind.Retrying, attempt: 2 });
  });
  it("LOOP-PREVENTION: a login-401 failure → Blocked{AuthRejected}, not Retrying", () => {
    const s = linkNext(LINK_OK, { kind: LinkEventKind.Failed, cls: { kind: FailureKind.AuthRejected } });
    expect(s).toMatchObject({ kind: LinkKind.Blocked, reason: FailureKind.AuthRejected });
    expect(s.kind === LinkKind.Blocked && s.recovery.kind).toBe(RecoveryKind.AwaitUser);
  });
  it("a LockedOut that then fails again as AuthRejected transitions Retrying → Blocked (never re-loops)", () => {
    const locked = linkNext(LINK_OK, { kind: LinkEventKind.Failed, cls: { kind: FailureKind.LockedOut, retryAfterSecs: 300 } });
    expect(locked).toMatchObject({ kind: LinkKind.Retrying });
    const blocked = linkNext(locked, { kind: LinkEventKind.Failed, cls: { kind: FailureKind.AuthRejected } });
    expect(blocked).toMatchObject({ kind: LinkKind.Blocked, reason: FailureKind.AuthRejected });
  });
  it("every block reason has a non-empty tip", () => {
    const reasons: BlockReason[] = [FailureKind.AuthRejected, FailureKind.SessionExpired, FailureKind.MfaRequired, FailureKind.Forbidden, FailureKind.MustChangePassword, FailureKind.VersionMismatch, FailureKind.VaultGone];
    for (const r of reasons) expect(blockedTip(r).length).toBeGreaterThan(0);
  });
});

// The connection-HEALTH state machine + the transport-error classifier + the recovery policy. ONE
// concern — "is the link up / retrying / blocked-and-why" — kept SEPARATE from the operational work-queue
// FSM (EngineState, syncengine.ts). Pure + total: every failure class and transition is an explicit,
// tested case, because a mis-classification is dangerous in BOTH directions — too-terminal STRANDS the
// user offline forever, too-transient LOOPS and hammers the server (the field bug + its would-be
// over-correction). classify reads ONLY tagged fields minted at the transport throw site, NEVER a message
// string (the server body overwrites the "HTTP nnn" text, so a message regex is a false safety net).
//
// THE FSM ALPHABET LIVES HERE, as enums — states, events, failure classes, recovery kinds, endpoints — so
// every consumer references a symbol (LinkKind.Blocked, FailureKind.AuthRejected …), never a magic string.
import { Phase } from "./syncstate"; // the display-projection alphabet (light) — a separate concern from the FSM state

// ---- the enums: the single source of truth for the FSM's symbols ----

// Which call failed — disambiguates the OVERLOADED 404: a vault-scope status probe 404 means the vault is
// gone (terminal), but a chunk/meta/commit 404 is a normal/transient miss (retryable, never "vault gone").
export enum Endpoint { Login = "login", VaultStatus = "vaultStatus", Chunk = "chunk", Meta = "meta", Commit = "commit", Other = "other" }

// Client-SYNTHESIZED conditions (no HTTP status of their own) — minted as typed errors, not string-matched.
export enum SyntheticKind { VersionMismatch = "versionMismatch", SessionExpired = "sessionExpired", ServerDegraded = "serverDegraded" }

// The failure taxonomy — the classifier's output alphabet.
export enum FailureKind {
  Transient = "transient",                 // network/DNS/timeout/5xx/408/malformed/overloaded-404 → retry
  ServerDegraded = "serverDegraded",       // 503 / reindex-needed / residual-unknown → slow retry
  LockedOut = "lockedOut",                 // 429 → wait the server window, then ONE retry
  AuthRejected = "authRejected",           // 401 on login (bad creds), or a still-401 authed call w/ a stored pw
  SessionExpired = "sessionExpired",       // 401 authed, no stored password → must reconfigure
  MfaRequired = "mfaRequired",             // 401 login, body indicates a second factor
  Forbidden = "forbidden",                 // 403 — access removed / share revoked
  MustChangePassword = "mustChangePassword",// 403 — password change required
  VersionMismatch = "versionMismatch",     // client/server protocol mismatch
  VaultGone = "vaultGone",                 // vault-scope 404 — vault deleted/renamed server-side
}

// The recovery policy alphabet.
export enum RecoveryKind { Backoff = "retryBackoff", After = "retryAfter", Slow = "retrySlow", AwaitUser = "awaitUser" }

// The connection-health STATES and the EVENTS that drive them.
export enum LinkKind { Ok = "ok", Retrying = "retrying", Blocked = "blocked" }
export enum LinkEventKind { Connected = "connected", Failed = "failed", UserRetry = "userRetry" }

// ---- the tagged error info (minted at the throw site; the classifier's only input) ----

export interface ConnErrorInfo {
  status?: number;          // HTTP status when there is one; ABSENT = network/DNS/timeout/malformed body
  retryAfterSecs?: number;  // parsed from the 429 Retry-After header
  wasLogin: boolean;        // did the failing call POST /login (credentials) vs. an already-authed endpoint?
  endpoint: Endpoint;       // which call failed
  synthetic?: SyntheticKind;// a client-decided condition (overrides status-based classification)
  bodyHint?: string;        // the server's short error body/code — read ONLY to split MFA / password-change
  hasStoredPassword: boolean;// is a password persisted on this device? (recoverable-expiry vs. reconfigure)
}

// ---- the failure classes + recovery policy (discriminated unions keyed by the enums) ----

export type FailureClass =
  | { kind: FailureKind.Transient }
  | { kind: FailureKind.ServerDegraded }
  | { kind: FailureKind.LockedOut; retryAfterSecs: number }
  | { kind: FailureKind.AuthRejected }
  | { kind: FailureKind.SessionExpired }
  | { kind: FailureKind.MfaRequired }
  | { kind: FailureKind.Forbidden }
  | { kind: FailureKind.MustChangePassword }
  | { kind: FailureKind.VersionMismatch }
  | { kind: FailureKind.VaultGone };

// `AwaitUser` still arms a SLOW self-heal re-probe so a TRANSIENT server-side cause (a mid-deploy 401, a
// reindex 404) recovers without the user having to act — pure no-timer would strand. `Slow` is the bounded
// bucket for unknowns: never tight (would hammer), never never (would strand).
export type Recovery =
  | { kind: RecoveryKind.Backoff }
  | { kind: RecoveryKind.After; secs: number }
  | { kind: RecoveryKind.Slow; secs: number }
  | { kind: RecoveryKind.AwaitUser; reprobeSecs: number };

const SLOW_RETRY_SECS = 60;
const SELF_HEAL_REPROBE_SECS = 600; // 10 min — one probe can't trip the 10-fails/5-min server throttle

// PURE + TOTAL. Reads only ConnErrorInfo. Ordering matters: synthetic first, then no-status (network),
// then by HTTP status. Every branch returns; the residual unknown is BOUNDED (ServerDegraded → slow retry).
export function classifyConnectError(info: ConnErrorInfo): FailureClass {
  const { status, wasLogin, endpoint, synthetic, bodyHint, retryAfterSecs } = info;
  if (synthetic === SyntheticKind.VersionMismatch) return { kind: FailureKind.VersionMismatch };
  if (synthetic === SyntheticKind.SessionExpired) return { kind: FailureKind.SessionExpired };
  if (synthetic === SyntheticKind.ServerDegraded) return { kind: FailureKind.ServerDegraded };
  if (status === undefined) return { kind: FailureKind.Transient };      // network/DNS/timeout/malformed → retry
  if (status === 429) return { kind: FailureKind.LockedOut, retryAfterSecs: retryAfterSecs ?? SLOW_RETRY_SECS };
  if (status === 503) return { kind: FailureKind.ServerDegraded };
  if (status === 408 || status >= 500) return { kind: FailureKind.Transient };
  if (status === 404) return endpoint === Endpoint.VaultStatus ? { kind: FailureKind.VaultGone } : { kind: FailureKind.Transient }; // overloaded 404
  if (status === 403) return bodyHint && /password.?change|change.?password/i.test(bodyHint)
    ? { kind: FailureKind.MustChangePassword } : { kind: FailureKind.Forbidden };
  if (status === 401) {
    if (wasLogin) return bodyHint && /\bmfa\b|authenticator|totp|two.?factor|one.?time/i.test(bodyHint)
      ? { kind: FailureKind.MfaRequired } : { kind: FailureKind.AuthRejected };
    // 401 from an AUTHED endpoint: the caller already re-logged-in ONCE before classify ran; still 401 means
    // no working session. A stored password should have re-logged in silently → treat as AuthRejected (bad/
    // stale stored creds); no stored password → SessionExpired (must reconfigure).
    return info.hasStoredPassword ? { kind: FailureKind.AuthRejected } : { kind: FailureKind.SessionExpired };
  }
  return { kind: FailureKind.ServerDegraded }; // residual unknown (400/other 4xx) → bounded slow retry
}

export function recoveryFor(fc: FailureClass): Recovery {
  switch (fc.kind) {
    case FailureKind.Transient: return { kind: RecoveryKind.Backoff };
    case FailureKind.ServerDegraded: return { kind: RecoveryKind.Slow, secs: SLOW_RETRY_SECS };
    case FailureKind.LockedOut: return { kind: RecoveryKind.After, secs: fc.retryAfterSecs };
    case FailureKind.AuthRejected:
    case FailureKind.SessionExpired:
    case FailureKind.MfaRequired:
    case FailureKind.Forbidden:
    case FailureKind.MustChangePassword:
    case FailureKind.VersionMismatch:
    case FailureKind.VaultGone:
      return { kind: RecoveryKind.AwaitUser, reprobeSecs: SELF_HEAL_REPROBE_SECS };
  }
}

// ---- the LinkState FSM (small, single-concern, instance-scoped in the engine — driven by these events) ----

// The block REASON is exactly the FailureKind that blocked (the AwaitUser classes). No parallel enum.
export type BlockReason = Exclude<FailureKind, FailureKind.Transient | FailureKind.ServerDegraded | FailureKind.LockedOut>;

export type LinkState =
  | { kind: LinkKind.Ok }                                                 // a connect completed; link is up
  | { kind: LinkKind.Retrying; recovery: Recovery; attempt: number }      // a timer is armed (transient/degraded/lockedOut)
  | { kind: LinkKind.Blocked; reason: BlockReason; recovery: Recovery };  // awaiting a user event (+ a slow re-probe)

export type LinkEvent =
  | { kind: LinkEventKind.Connected }                 // connect effect succeeded
  | { kind: LinkEventKind.Failed; cls: FailureClass } // connect effect failed with a classified cause
  | { kind: LinkEventKind.UserRetry };                // user reconnect/reconfigure — leave the blocked state and try again

// A blocked FailureClass → its BlockReason (only the AwaitUser classes reach here).
function blockReasonOf(cls: FailureClass): BlockReason | null {
  return recoveryFor(cls).kind === RecoveryKind.AwaitUser ? (cls.kind as BlockReason) : null;
}

export const LINK_OK: LinkState = { kind: LinkKind.Ok };

// PURE + TOTAL transition. `Connected` and `UserRetry` both return the link to a hopeful `Ok` (a connect
// attempt is/looks in flight); a `Failed` maps the class through recoveryFor to either a Retrying (timer
// armed) or a Blocked (await-user + self-heal re-probe) state.
export function linkNext(s: LinkState, e: LinkEvent): LinkState {
  if (e.kind === LinkEventKind.Connected || e.kind === LinkEventKind.UserRetry) return { kind: LinkKind.Ok };
  const rec = recoveryFor(e.cls);
  if (rec.kind === RecoveryKind.AwaitUser) {
    const reason = blockReasonOf(e.cls)!; // AwaitUser ⟺ a block reason exists
    return { kind: LinkKind.Blocked, reason, recovery: rec };
  }
  const attempt = s.kind === LinkKind.Retrying ? s.attempt + 1 : 1;
  return { kind: LinkKind.Retrying, recovery: rec, attempt };
}

// Build the classifier input from any thrown error + the device's stored-password fact. A non-ConnError
// (a raw network reject, a thrown string) has no HTTP status → classifies as a statusless Transient
// (retry, never strand) — the safe default for anything we didn't explicitly tag.
export function toConnErrorInfo(e: unknown, hasStoredPassword: boolean): ConnErrorInfo {
  if (e instanceof ConnError) return { ...e.info, hasStoredPassword };
  return { wasLogin: false, endpoint: Endpoint.Other, hasStoredPassword };
}

// A typed transport error carrying the classifier's inputs, minted at the throw site (never parsed back
// out of a message string). Bundled together with transport + main, so `instanceof` is reliable.
export class ConnError extends Error {
  constructor(message: string, public info: {
    status?: number; retryAfterSecs?: number; wasLogin: boolean; endpoint: Endpoint;
    bodyHint?: string; synthetic?: SyntheticKind;
  }) {
    super(message);
    this.name = "ConnError";
  }
}

// Display projection for a DOWN link (EngineState=disconnected) → the light's display `Phase` (whose
// alphabet lives in syncstate.ts, spanning both machines) + a human detail. Pure.
export function linkPhase(link: LinkState): { phase: Phase; detail: string } {
  if (link.kind === LinkKind.Blocked) return { phase: "blocked", detail: blockedTip(link.reason) };
  if (link.kind === LinkKind.Retrying && link.recovery.kind === RecoveryKind.After) {
    const m = Math.max(1, Math.round(link.recovery.secs / 60));
    return { phase: "lockedOut", detail: `Too many attempts — retrying in ${m}m` };
  }
  return { phase: "retrying", detail: "Reconnecting…" };
}

// A short, human status line for a blocked link (the status card / light tip). Pure + total over the reasons.
export function blockedTip(reason: BlockReason): string {
  switch (reason) {
    case FailureKind.AuthRejected: return "Sign-in rejected — check your password (Settings → Reconfigure)";
    case FailureKind.SessionExpired: return "Session expired — open Settings → Reconfigure to sign in again";
    case FailureKind.MfaRequired: return "Enter your authenticator code to sign in (Reconfigure)";
    case FailureKind.Forbidden: return "Access to this vault was removed";
    case FailureKind.MustChangePassword: return "You must change your password before syncing";
    case FailureKind.VersionMismatch: return "Update needed — the plugin and server versions don't match";
    case FailureKind.VaultGone: return "This vault no longer exists on the server — re-create it or switch";
  }
}

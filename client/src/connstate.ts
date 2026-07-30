// The connection-HEALTH state machine + the transport-error classifier + the recovery policy. ONE
// concern — "is the link up / retrying / blocked-and-why" — kept SEPARATE from the operational work-queue
// FSM (EngineState, syncengine.ts). Pure + total: every failure class and transition is an explicit,
// tested case, because a mis-classification is dangerous in BOTH directions — too-terminal STRANDS the
// user offline forever, too-transient LOOPS and hammers the server (the field bug + its would-be
// over-correction). classify reads ONLY tagged fields minted at the transport throw site, NEVER a message
// string (the server body overwrites the "HTTP nnn" text, so a message regex is a false safety net).

// ---- the tagged error info (minted at the throw site; the classifier's only input) ----

// Which call failed — disambiguates the OVERLOADED 404: a vault-scope status probe 404 means the vault is
// gone (terminal), but a chunk/meta/commit 404 is a normal/transient miss (retryable, never "vault gone").
export type Endpoint = "login" | "vaultStatus" | "chunk" | "meta" | "commit" | "other";

// Client-SYNTHESIZED conditions (no HTTP status of their own) — minted as typed errors, not string-matched.
export type SyntheticKind = "versionMismatch" | "sessionExpired" | "serverDegraded";

export interface ConnErrorInfo {
  status?: number;          // HTTP status when there is one; ABSENT = network/DNS/timeout/malformed body
  retryAfterSecs?: number;  // parsed from the 429 Retry-After header
  wasLogin: boolean;        // did the failing call POST /login (credentials) vs. an already-authed endpoint?
  endpoint: Endpoint;       // which call failed
  synthetic?: SyntheticKind;// a client-decided condition (overrides status-based classification)
  bodyHint?: string;        // the server's short error body/code — read ONLY to split MFA / password-change
  hasStoredPassword: boolean;// is a password persisted on this device? (recoverable-expiry vs. reconfigure)
}

// ---- the failure taxonomy ----

export type FailureClass =
  | { kind: "transient" }                          // network/DNS/timeout/5xx/408/malformed/overloaded-404 → retry
  | { kind: "serverDegraded" }                     // 503 / reindex-needed / residual-unknown → slow retry
  | { kind: "lockedOut"; retryAfterSecs: number }  // 429 → wait the server window, then ONE retry
  | { kind: "authRejected" }                       // 401 on login (bad creds), or a still-401 authed call w/ a stored pw
  | { kind: "sessionExpired" }                     // 401 authed, no stored password → must reconfigure
  | { kind: "mfaRequired" }                        // 401 login, body indicates a second factor
  | { kind: "forbidden" }                          // 403 — access removed / share revoked
  | { kind: "mustChangePassword" }                 // 403 — password change required
  | { kind: "versionMismatch" }                    // client/server protocol mismatch
  | { kind: "vaultGone" };                         // vault-scope 404 — vault deleted/renamed server-side

// Recovery policy for a class. `awaitUser` still arms a SLOW self-heal re-probe so a TRANSIENT server-side
// cause (a mid-deploy 401, a reindex 404) recovers without the user having to act — pure no-timer would
// strand. `retrySlow` is the bounded bucket for unknowns: never tight (would hammer), never never (would strand).
export type Recovery =
  | { kind: "retryBackoff" }                       // existing jittered backoff (cap 30 s)
  | { kind: "retryAfter"; secs: number }           // one-shot at the server's window
  | { kind: "retrySlow"; secs: number }            // fixed slow cadence (unknown / degraded)
  | { kind: "awaitUser"; reprobeSecs: number };    // blocked; a single slow re-probe self-heals a transient cause

const SLOW_RETRY_SECS = 60;
const SELF_HEAL_REPROBE_SECS = 600; // 10 min — one probe can't trip the 10-fails/5-min server throttle

// PURE + TOTAL. Reads only ConnErrorInfo. Ordering matters: synthetic first, then no-status (network),
// then by HTTP status. Every branch returns; the residual unknown is BOUNDED (serverDegraded → retrySlow).
export function classifyConnectError(info: ConnErrorInfo): FailureClass {
  const { status, wasLogin, endpoint, synthetic, bodyHint, hasStoredPassword, retryAfterSecs } = info;
  if (synthetic === "versionMismatch") return { kind: "versionMismatch" };
  if (synthetic === "sessionExpired") return { kind: "sessionExpired" };
  if (synthetic === "serverDegraded") return { kind: "serverDegraded" };
  if (status === undefined) return { kind: "transient" };        // network/DNS/timeout/malformed → retry
  if (status === 429) return { kind: "lockedOut", retryAfterSecs: retryAfterSecs ?? SLOW_RETRY_SECS };
  if (status === 503) return { kind: "serverDegraded" };
  if (status === 408 || status >= 500) return { kind: "transient" };
  if (status === 404) return endpoint === "vaultStatus" ? { kind: "vaultGone" } : { kind: "transient" }; // overloaded 404
  if (status === 403) return bodyHint && /password.?change|change.?password/i.test(bodyHint)
    ? { kind: "mustChangePassword" } : { kind: "forbidden" };
  if (status === 401) {
    if (wasLogin) return bodyHint && /\bmfa\b|authenticator|totp|two.?factor|one.?time/i.test(bodyHint)
      ? { kind: "mfaRequired" } : { kind: "authRejected" };
    // 401 from an AUTHED endpoint: the caller already re-logged-in ONCE before classify ran; still 401 means
    // no working session. A stored password should have re-logged in silently → treat as authRejected (bad/
    // stale stored creds); no stored password → sessionExpired (must reconfigure).
    return hasStoredPassword ? { kind: "authRejected" } : { kind: "sessionExpired" };
  }
  return { kind: "serverDegraded" }; // residual unknown (400/other 4xx) → bounded slow retry, never strand/loop
}

export function recoveryFor(fc: FailureClass): Recovery {
  switch (fc.kind) {
    case "transient": return { kind: "retryBackoff" };
    case "serverDegraded": return { kind: "retrySlow", secs: SLOW_RETRY_SECS };
    case "lockedOut": return { kind: "retryAfter", secs: fc.retryAfterSecs };
    case "authRejected":
    case "sessionExpired":
    case "mfaRequired":
    case "forbidden":
    case "mustChangePassword":
    case "versionMismatch":
    case "vaultGone":
      return { kind: "awaitUser", reprobeSecs: SELF_HEAL_REPROBE_SECS };
  }
}

// ---- the LinkState FSM (small, single-concern, instance-scoped in the engine — driven by these events) ----

export type BlockReason = "authRejected" | "sessionExpired" | "mfaRequired" | "forbidden" | "mustChangePassword" | "versionMismatch" | "vaultGone";

export type LinkState =
  | { kind: "ok" }                                                       // a connect completed; link is up
  | { kind: "retrying"; recovery: Recovery; attempt: number }            // a timer is armed (transient/degraded/lockedOut)
  | { kind: "blocked"; reason: BlockReason; recovery: Recovery };        // awaiting a user event (+ a slow re-probe)

export type LinkEvent =
  | { kind: "connected" }                 // connect effect succeeded
  | { kind: "failed"; cls: FailureClass } // connect effect failed with a classified cause
  | { kind: "userRetry" };                // user reconnect/reconfigure — leave the blocked state and try again

// A blocked FailureClass → its BlockReason (only the awaitUser classes reach here).
function blockReasonOf(cls: FailureClass): BlockReason | null {
  switch (cls.kind) {
    case "authRejected": return "authRejected";
    case "sessionExpired": return "sessionExpired";
    case "mfaRequired": return "mfaRequired";
    case "forbidden": return "forbidden";
    case "mustChangePassword": return "mustChangePassword";
    case "versionMismatch": return "versionMismatch";
    case "vaultGone": return "vaultGone";
    default: return null;
  }
}

export const LINK_OK: LinkState = { kind: "ok" };

// PURE + TOTAL transition. `connected` and `userRetry` both return the link to a hopeful "ok" (a connect
// attempt is/looks in flight); a `failed` maps the class through recoveryFor to either a retrying (timer
// armed) or a blocked (await-user + self-heal re-probe) state.
export function linkNext(s: LinkState, e: LinkEvent): LinkState {
  if (e.kind === "connected" || e.kind === "userRetry") return { kind: "ok" };
  const rec = recoveryFor(e.cls);
  if (rec.kind === "awaitUser") {
    const reason = blockReasonOf(e.cls)!; // awaitUser ⟺ a block reason exists
    return { kind: "blocked", reason, recovery: rec };
  }
  const attempt = s.kind === "retrying" ? s.attempt + 1 : 1;
  return { kind: "retrying", recovery: rec, attempt };
}

// A short, human status line for a blocked link (the status card / light tip). Pure.
export function blockedTip(reason: BlockReason): string {
  switch (reason) {
    case "authRejected": return "Sign-in rejected — check your password (Settings → Reconfigure)";
    case "sessionExpired": return "Session expired — open Settings → Reconfigure to sign in again";
    case "mfaRequired": return "Enter your authenticator code to sign in (Reconfigure)";
    case "forbidden": return "Access to this vault was removed";
    case "mustChangePassword": return "You must change your password before syncing";
    case "versionMismatch": return "Update needed — the plugin and server versions don't match";
    case "vaultGone": return "This vault no longer exists on the server — re-create it or switch";
  }
}

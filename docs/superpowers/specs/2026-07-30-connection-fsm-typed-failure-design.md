# Connection lifecycle: give the FSM's failure edge a type — design

**Date:** 2026-07-30
**Status:** DRAFT — for independent antagonistic critique before implementation
**Ships:** 1.9.1 (patch — bug fix + UX; no new capability)
**Author:** claudeOpus (with wweatherholtz)

---

## 0. Why (the field failure)

On a real device, a token rejection at reconnect put the client into `connect FAILED: unauthorized`
retried every ~15–30 s for **45+ minutes** — hammering the login endpoint (which risks the server's
own 10-fails/5-min lockout, `throttle.rs`), never prompting for re-auth, and showing "Offline —
retrying" for what is actually a *rejected sign-in*. Root cause: `SyncEngine.failToOffline` (syncengine.ts:128)
maps **every** effect failure to one `"offline"` state with one recovery (`scheduleReconnect`, backoff
capped at 30 s), and `doConnect`'s `catch` (main.ts:1303) distinguishes only *vault-gone* (404) and
*session-expired* via `lastIssue` **string regexes** — a hard auth rejection (401) or a lockout (429)
falls through to the generic retry-forever path.

## 0.5 v2 — corrections from the independent critique (MUST hold before implementation)

The critique confirmed the direction but found the naive version would *strand* users (worse than the
loop). Non-negotiable corrections, all verified against the code:

1. **classify reads TAGGED ERROR FIELDS, never `.message`.** The server body replaces the `HTTP nnn`
   string (transport.ts `errText`:48-51 → 401 arrives as `"unauthorized"`, 429 as prose, 404 as
   `"not found"`), so message-regex classification is a false safety net. Transport must mint a typed
   error carrying `{ status?, retryAfterSecs?, wasLogin, endpoint }` at **every** throw chokepoint
   (`httpReq`/`apiJson`/`apiVoid` + the bespoke `commit`/`getChunk`/`fileMeta` sites), and read
   `Retry-After` (which the server DOES send on 429, error.rs:24-29, but `apiJson` currently discards).
2. **Fix `isAuthError` FIRST, and re-login-once runs BEFORE classify can call a `status()` 401 terminal.**
   `isAuthError = /HTTP 401/` (main.ts:743) never matches `"unauthorized"` → the reactive re-login
   (main.ts:1251) never fires → a **recoverable** token-expiry (password stored & valid) would be
   mis-blocked as "Reconfigure." Fix it to read the `status` field. A stored-and-valid password must
   route to a **silent re-login**, never a user block.
3. **No safe single default → whitelist both ends; unknown ⇒ bounded `retrySlow`.** Whitelist-transient
   (no-status/network, 5xx, 408, 429, 503-reindex, malformed-body/captive-portal) AND whitelist-terminal
   (401-login, 403, versionMismatch, vault-scope 404). The residual unknown status defaults to
   `retrySlow` (60 s) — **never** tight-retry (loops) and **never** no-timer (strands).
4. **Every `blocked` class arms a SLOW self-heal re-probe (~10 min).** Pure no-timer strands a client on
   a transient server-side 401/404 (mid-deploy / reindex) forever — strictly worse than today's noisy
   self-healing loop. One 10-min re-probe cannot trip the 10-fails/5-min throttle. (Resolves Q1/Q4/C6.)
5. **Context beyond `wasLogin`, and endpoint-aware 404.** classify needs `{ status, wasLogin,
   hasStoredPassword, endpoint }`. 404 is overloaded: vault-scope `status()` 404 = `vaultGone` (terminal),
   but `getChunk`/`fileMeta`/`commit` 404 = transient/normal (**never** `vaultGone` — that strands over a
   swept chunk). Add classes **`forbidden`** / **`mustChangePassword`** (403, error.rs:36-37) and
   **`mfaRequired`** (401-login body "mfa", auth.rs:113) — each with its own label/action.

Also: `LinkState` is **instance-scoped** (a persistent `blocked` can't live in a stack frame — H3),
mutated ONLY inside the engine's pump-serialized `handle`/`failWith` (single-writer); the
`offline→disconnected` rename MUST also update `markReconciling` (syncengine.ts:83) and the connect
handler (:174); and `main.ts`'s `vaultGone`/`lastIssue` consumers (`isVaultGone`/`recreateVault`/settings)
must be re-pointed at `LinkState` (no dual source of "the why"). The `light()`/`engineStateToPhase`
switches stay exhaustive (no `default`) so a new Phase is a compile error until handled.

**The corrected status→class→action table is §5 (replaces the original).**

## 1. Goal

Every connection failure is **classified** and drives a **distinct** FSM transition + recovery + status
label, so: a rejected sign-in **stops retrying and asks the user to re-auth**; a lockout **waits the
server's Retry-After**; a version mismatch / missing vault **wait for user action**; only a genuinely
transient error backoff-retries. No infinite hammering; no "offline" mislabel.

## 2. Non-goals

- Not a rewrite of `SyncEngine` — the queue / run-to-completion / coalescing / injected-effects core is
  kept verbatim. Only the **failure edge** and its **display projection** change.
- Not touching the WS half-open liveness FSM (transportstate.ts) or the reconcile decision (decide()).
- No change to the server throttle (its behavior is correct; the client must stop *provoking* it).

## 2a. Architecture principle — multiple small FSMs, one concern each (function-scoped)

Per the owner's steer ("multi FSMs per state, scoped to functions, usually") and
`issueStateMachineOrphanedAndImplicit` (which named four *separate* implicit machines, not one), the
design is **two cooperating, single-concern FSMs plus two pure helpers** — NOT one bloated `EngineState`:

- **`EngineState`** (existing, syncengine.ts) — the **operational work-queue** lifecycle only:
  `off · connecting · reconciling · idle · unloading`. It owns the serial queue / run-to-completion /
  coalescing. **Its shape does not grow** — the failure taxonomy is explicitly NOT its concern.
- **`LinkState`** (new, `connstate.ts`, pure) — the **connection-health / failure** lifecycle only:
  `ok · retrying{recovery, attempt} · blocked{reason}`. A small total `(LinkState, LinkEvent) → LinkState`
  machine scoped to the connect function. It owns "retry vs. wait vs. give-up-until-user".
- **`classify`** (pure) and **`recoveryFor`** (pure) — the transport-error → class → policy functions the
  LinkState transitions on.

The two FSMs compose without a shared-mutable-state race: `EngineState` remains the single serialization
point (the pump); on an effect failure it asks `LinkState` *what kind* of failure and *whether/when* to
re-connect, and projects **both** to the display. Neither machine reaches into the other's state. The old
`"offline"` — which secretly encoded *both* "not connected" AND "retrying" AND "the reason" — is
decomposed: "not connected" stays an `EngineState` fact, "retrying vs blocked + why" becomes `LinkState`.

## 3. Design — the two FSMs + pure classify + pure policy

### 3.1 The pure classifier (parse-don't-validate at the transport boundary)

```ts
export type FailureClass =
  | { kind: "transient" }                          // DNS/network/timeout/5xx (except 503-reindex) → retry
  | { kind: "authRejected" }                       // 401 on a LOGIN (credentials refused) → await user
  | { kind: "sessionExpired" }                     // token-only, no stored password → await reconfigure
  | { kind: "lockedOut"; retryAfterSecs: number }  // 429 + Retry-After → wait then ONE retry
  | { kind: "versionMismatch"; server: string }    // protocol/schema mismatch → await update
  | { kind: "vaultGone" }                          // 404 vault → await user (re-create / switch)
  | { kind: "serverDegraded" };                    // 503 reindex-needed → slow retry
export function classifyConnectError(e: unknown, ctx: { wasLogin: boolean }): FailureClass;
```

Pure + total + unit-tested. Requires that transport errors carry the **status code** and (for 429) the
**Retry-After** — see §3.4. `ctx.wasLogin` distinguishes a 401 from `status()` (stale token → try
re-login once, already handled) vs a 401 from `login()` (credentials refused → `authRejected`).

### 3.2 The pure recovery policy

```ts
export type Recovery =
  | { kind: "retryBackoff" }            // transient: existing jittered backoff (cap 30s)
  | { kind: "retryAfter"; secs: number }// lockedOut: wait exactly the server's window, then ONE attempt
  | { kind: "retrySlow" }               // serverDegraded: a long fixed cadence (e.g. 60s), not tight
  | { kind: "awaitUser" };              // authRejected/sessionExpired/versionMismatch/vaultGone: NO timer
export function recoveryFor(fc: FailureClass): Recovery;
```

`awaitUser` means **no scheduled reconnect at all** — the machine rests in a blocked state until a
*user* event (reconnect / reconfigure / switch / re-create) re-enters `connect`. This is what breaks the
loop.

### 3.3 The two FSMs (each single-concern) + the decomposed `offline`

**`LinkState`** (new, pure — the connection-health machine, `connstate.ts`):
```ts
type LinkState =
  | { kind: "ok" }                                  // a connect completed; link is up
  | { kind: "retrying"; recovery: Recovery; attempt: number } // a timer is armed (transient/lockedOut/degraded)
  | { kind: "blocked"; reason: BlockReason };       // authRejected|sessionExpired|versionMismatch|vaultGone — NO timer
type LinkEvent =
  | { kind: "connected" } | { kind: "failed"; cls: FailureClass } | { kind: "userRetry" };
export function linkNext(s: LinkState, e: LinkEvent): LinkState;  // total, unit-tested
```

**`EngineState`** (existing) keeps its single concern — the work-queue lifecycle — and its shape barely
moves: `"offline"` is **renamed to `"disconnected"`** (a neutral "link is down" fact; the *why* now lives
in `LinkState`). `engineStateToPhase` projects `disconnected` together with the `LinkState` into the right
display `Phase` (§3.5). `isConnected()` = `state ∈ {reconciling, idle}` (unchanged). The `connect`
handler's "show reconnect-not-connecting on a retry" reads `LinkState.kind !== "ok"` instead of
`state === "offline"`.

**Failure path:** `failToOffline(where, e)` → `failWith(where, e)`:
1. `cls = classifyConnectError(e, ctx)`; `link = linkNext(link, {kind:"failed", cls})`.
2. `EngineState → "disconnected"`; drop in-flight path/remote/rews (as today); preserve disconnect/unload.
3. Schedule per `link.recovery`: `retryBackoff` = existing jittered backoff; `retryAfter` = one-shot at
   `secs`; `retrySlow` = fixed 60 s; `blocked` (awaitUser) = **nothing scheduled**.
4. A `lockedOut` retry that fails again 401 → `linkNext` yields `blocked{authRejected}` (never re-loops).

A user `connect` (reconnect/reconfigure) fires `{kind:"userRetry"}` → `LinkState → ok`-attempt →
`EngineState → connecting`. The two machines never write each other's state; the engine's pump remains the
sole serialization point, so there is no cross-FSM race.

### 3.4 Transport carries the status (so the classifier isn't string-matching)

`transport.ts` mints a typed error carrying `{ status?, retryAfterSecs?, wasLogin, endpoint }` at every
throw chokepoint (`httpReq`/`apiJson`/`apiVoid` + the bespoke `commit`/`getChunk`/`fileMeta` sites), and
reads `Retry-After` on 429 (server DOES send it, error.rs:24-29, but `apiJson` currently discards headers).
`classifyConnectError` reads ONLY these fields — **never `.message`** (the server body overwrites the
`HTTP nnn` string, so a message regex is a false safety net per the critique C2). Synthetic conditions
(version mismatch, health-not-ready) are minted as typed errors too, not string-matched.

### 3.5 Display — distinct Phases + labels (fixes the "offline" mislabel)

`Phase` gains: `signInRejected`, `lockedOut`, `versionMismatch`, `vaultGone` (and `retrying` keeps the
red "reconnecting" but with honest copy). `light()` maps each to its own color/tip:

| Phase | color | tip |
|---|---|---|
| `retrying` | red | "Reconnecting…" (was "Offline — retrying") |
| `signInRejected` | red | "Sign-in rejected — open Settings → Reconfigure" |
| `lockedOut` | orange | "Too many attempts — retrying in Nm" |
| `versionMismatch` | orange | "Update needed — plugin/server version mismatch" |
| `vaultGone` | orange | "This vault is gone on the server — re-create or switch" |

`effectivePhase` unchanged. The settings status card renders the same projection (one source, per the
D0049/status fix), so the card and light agree.

## 4. Code impact

- `syncengine.ts`: `EngineState` gains `retrying`/`blocked{reason}`; `failToOffline` → `failWith`
  (classify + policy + schedule); `engineStateToPhase` maps the new states. The pump/queue/coalesce/
  connect/rews/remote/path handlers are **unchanged** except `catch (e) => this.failWith(...)`.
- `connstate.ts` (**new, pure**): the `LinkState` FSM (`linkNext`) + `FailureClass` / `classifyConnectError`
  / `Recovery` / `recoveryFor` + their unit tests (the whole point — every class + transition an explicit,
  tested case). This is the single-concern connection-health machine; `EngineState` does not absorb it.
- `main.ts`: `doConnect` stops string-building `lastIssue` for the failure taxonomy — it throws a typed
  error (status-tagged) and lets the engine classify; `scheduleReconnect` honors the policy (backoff vs
  retryAfter vs slow vs none). The `getLastIssue`/status card reads the blocked reason.
- `transport.ts`: attach `status` + `retryAfterSecs` to thrown errors.
- `syncstate.ts`: new `Phase`s + `light()` cases.

## 5. Behavior table (the acceptance cases)

| Failure | Class | State | Recovery | Label |
|---|---|---|---|---|
| DNS/timeout/500 | transient | retrying | backoff | Reconnecting… |
| 401 on login | authRejected | blocked | **none** (await user) | Sign-in rejected — Reconfigure |
| token-only, no password | sessionExpired | blocked | none | Session expired — Reconfigure |
| 429 + Retry-After 300 | lockedOut | retrying | wait 300s → 1 retry | Locked out — retry in 5m |
| protocol mismatch | versionMismatch | blocked | none | Update needed |
| 404 vault | vaultGone | blocked | none | Vault gone — re-create/switch |
| 503 reindex | serverDegraded | retrying | slow 60s | Server repairing… |

## 6. Open questions for the critique

- **Q1:** Is `blocked{authRejected}` truly no-timer, or should it retry ONCE after a long delay in case
  the server was briefly wrong (e.g. a mid-deploy 401)? Trade-off: a single delayed retry vs. staying
  put until the user acts. Which is safer against a lockout?
- **Q2:** Distinguishing a 401 from `status()` (stale token) vs `login()` (bad creds) relies on `wasLogin`
  context. Is there any path where a bad *token* returns 401 from an endpoint we'd mis-tag as a login
  rejection, or vice-versa? (doConnect already re-logins once on a status() 401 — where does classify sit
  relative to that retry?)
- **Q3:** Two-FSM composition — is `EngineState` (work-queue) + `LinkState` (health) the right seam, or
  does the display need a THIRD projection that reads both (risking a re-coupling)? Does renaming
  `offline → disconnected` + reading `LinkState` in the `connect` handler leave any place that still
  assumes one lossy `offline` (e.g. `markReconciling` upgrades from `offline`)? Where exactly does
  `LinkState` live so it stays the pump's single-writer (no second mutation site)?
- **Q4:** Does a `blocked` (no-timer) state risk a *stuck* client if the only re-entry is a user event
  and the user never opens settings? Should a very-slow keepalive (e.g. 10 min) re-probe for
  authRejected/versionMismatch so a transient server-side cause self-heals without user action?
- **Q5:** The 429 path assumes the server sends `Retry-After`. Does it? If not, what's the default wait,
  and how do we avoid re-locking?

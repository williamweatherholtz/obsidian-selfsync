# Status Display = Pure FSM Projection — Design

**Date:** 2026-08-02
**Status:** approved (owner: wweatherholtz) — spec → critique → implement

## Problem (field-reported, mobile, 1.11.2)

The status card shows **"Switching vault… applying your choice"** persistently while the vault is
actually connected and synced (green dot, recent "Last synced"). The owner made no choice and is not
switching vaults. Separately, a **".obsidian file(s) in scope"** log line reads as jargon.

## Root cause

`statusDisplay()` (main.ts) is NOT a pure projection of the sync state machines. Before it consults the
`Phase`, it short-circuits on two things that are **not FSM states**:

```
if (this.settings.pendingSwitch) return { label: "Switching vault…", detail: "applying your choice" };
if (this.resuming && (phase === "connecting" || phase === "syncing")) return { label: "Resuming…", … };
```

- **`pendingSwitch`** is a *persisted config setting* (settings.ts): the switch RESOLUTION
  (download/upload/merge), kept across a restart so a mid-switch interruption replays the right
  resolution (R12-CA1). It is set by `switchToVault()` and cleared ONLY after `switchTo()`'s reconcile
  fully returns. On mobile, a large-vault switch reconcile can be suspended/killed before it returns —
  so the setting stays set, and the card latches "Switching vault…" indefinitely, re-running the
  (idempotent) merge each session. It is a SETTING's lifetime being shown as a STATUS.
- **`resuming`** is a loose boolean flag set on mobile resume, read only by the display. Same
  anti-pattern: a flag outside any machine, peeked at by the projection.
- The verified trigger this round is NOT the D0047 vault-change guard (its "base belonged to…" notice
  never appeared in the owner's log), so `pendingSwitch` was persisted by an earlier `switchToVault`
  and never cleared — a stuck SETTING, exactly the failure a setting-as-status invites.
- **"applying your choice"** is additionally a false statement whenever the D0047 guard (not the user)
  set the merge.

## State model (what exists today)

- **EngineState** (syncengine.ts) — the operational work-queue FSM: off · connecting · reconciling ·
  idle · disconnected · unloading. Real, run-to-completion.
- **LinkState** (connstate.ts) — the connection-health FSM: ok · retrying · blocked (+ lockedOut). Real.
- **Phase** (syncstate.ts) — the DISPLAY projection: off · connecting · idle · syncing · retrying ·
  lockedOut · blocked, computed purely as `state==="disconnected" ? linkPhase(link) : engineStateToPhase(state)`.
  `effectivePhase` collapses a 0-pending "syncing" (a mere *check*) to idle — the "don't show a
  transient as a state" principle, already applied correctly there.

The two FSMs + the pure Phase are sound. The defect is the two rogue reads layered ON TOP of Phase.

## Design

**Invariant: the status card is a PURE function of `(Phase, syncPending, realtimeConnected,
vaultReadOnly)` — nothing else.** No display surface reads a persisted setting or a loose flag.

1. **Remove both rogue reads** from `statusDisplay()`. A vault switch and a mobile resume are
   *transient* — per the owner's directive ("don't display transitive states"), they collapse into the
   normal projection: during a switch the engine is `reconciling` → `syncing` → "Syncing… (N pending)",
   and on completion → `idle` → "Fully synced". A switch that can't finish in one session therefore
   shows honest "Syncing…", never a stuck "Switching vault…", and can never latch on a stale setting.
2. **Delete the `resuming` machinery** (field + `isResuming()` + its assignments) — it exists solely to
   feed the removed label and gates no other logic.
3. **Keep `pendingSwitch` as the reconcile-resolution setting** (R12-CA1 persistence is legitimate) —
   it just stops being a display source.
4. **Diagnostics:** when a persisted `pendingSwitch` drives a `switchTo` on connect, log it (non-notice)
   so the owner's debug log reveals *why* a switch is (re)running — closing the loop on the stuck-setting
   root cause without guessing.
5. **Copy:** `config sync ON — N .obsidian file(s) in scope` → plain language, e.g.
   `syncing N Obsidian settings file(s)`.

## Non-goals

- Not redesigning the two FSMs (they are correct). This is purely about the projection boundary.
- Not making the switch reconcile itself resumable/incremental (a separate, larger effort); the fix
  makes an unfinished switch harmless to the DISPLAY, and the diagnostic will tell us if a stuck
  `pendingSwitch` needs a follow-up.

## Tests

- `statusDisplay` is a pure projection: with `settings.pendingSwitch = "merge"` set AND `resuming = true`
  set, a `"syncing"` phase still yields "Syncing…" and an `"idle"` phase still yields "Fully synced" —
  the setting/flag no longer changes the label.
- The existing per-phase label assertions (Syncing/idle/read-only/connecting/retrying/blocked) stay
  green; the "Switching vault…" and "Resuming…" assertions are removed.
- Copy: the config-scope log string is asserted plain (no "in scope").

## Critique reconciliation (independent antagonistic pass, 2026-08-02)

The pre-implement critique found the display fix ALONE was unsafe — three findings adopted:

- **[HIGH] Hiding the display masks a lossy re-run.** `pendingSwitch` can be `download`/`upload` —
  *authoritative overwrites*. A stuck one re-runs every connect and **re-clobbers local edits**; removing
  the visible "Switching vault…" made that invisible. **Fix (now in scope, not just a diagnostic):** an
  ALREADY-APPLIED guard — if the base already belongs to the target vault (`baseVaultKey ===
  vaultIdentityKey()` && non-empty), the switch has taken effect, so clear `pendingSwitch` and reconcile
  NORMALLY instead of repeating the overwrite. A not-yet-applied switch (base still the old vault) still
  replays (preserves R12-CA1). This bounds the loop AND stops the re-clobber. Surfaced via a notice.
- **[MEDIUM] Settings-card dot vs ribbon dot diverge on polling.** `settings.ts` called `light(phase)`
  (realtime defaulted true → green) while the ribbon passed `realtimeConnected` (→ yellow). **Fix:**
  `realtimeConnected` is now public; the settings card passes it into `light()` — one realtime-aware color
  source, matching the "surfaces never diverge" invariant.
- **[LOW] A long user-initiated switch now reads as a bare "Connecting…".** Accepted: it's honest and
  transient per the owner's directive; the already-applied guard + diagnostic cover the failure case.

A genuinely never-completing switch (a huge-vault reconcile killed before it ever reaches the target base)
remains outside scope — that needs an incremental/resumable switch reconcile; the diagnostic log surfaces
it, and the guard prevents the re-clobber once any pass completes.

## Follow-up field finding (same day, on 1.11.4): the initial reconcile faked "Synced"

The owner's next log showed the switch now correctly ABORTING on the DNS outage (`connect FAILED …
retrying in 3s`, the 1.11.4 fix) — but the card still read "Synced (polling)" during the failing attempts.
Root cause, one layer deeper in the FSM: `markReconciling()` optimistically flipped `connecting`/
`disconnected` → `reconciling` (→ phase "syncing") the moment the health check passed, BEFORE the initial
reconcile. When that reconcile transferred nothing (failing on DNS), `syncPending` stayed 0 and
`effectivePhase` collapsed `syncing`-0-pending → **idle → "Synced (polling)"** for the whole 30s attempt.

A normal POLL never had this problem: it doesn't pre-flip — `beginReconcile()` escalates `idle` →
`reconciling` only when there's genuine work, so a no-op poll stays idle without needing the collapse.

**Fix:** make connect behave like a poll. Removed `markReconciling()`; broadened `beginReconcile()` to
escalate from `idle` OR an in-flight connect (`connecting`/`disconnected`); and `onProgress(pending>0)` now
calls it too. So the initial reconcile shows "Connecting…" and becomes "Syncing… N" ONLY while actually
transferring — a failing/empty connect stays "Connecting…"/"Reconnecting…" and can never collapse to a
false "Synced." `beginReconcile` is now the single door into `reconciling`. (Ships 1.11.5.)

## Acceptance

Ships PATCH (bugfix). Full client vitest + tsc + keel green. Independent antagonistic critique before
implement (per the standing rule — it has caught real defects each time).

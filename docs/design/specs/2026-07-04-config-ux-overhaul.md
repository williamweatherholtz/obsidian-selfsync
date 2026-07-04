# Design: SelfSync config/settings UX overhaul (goal #1)

**Status:** approved (brainstormed 2026-07-04). **Scope:** client-only. **Predecessor context:**
M1–M6 shipped; this is the deferred original goal #1 — a genuinely simple, coherent config
experience for the fresh SelfSync plugin (not a de-crufting of LiveSync, whose code we don't inherit).

---

## 1. Goal & principles

Deliver a config UX that a moderately-technical self-hoster finds obvious *and* a non-technical
user can complete, by:

- **Progressive disclosure** — an everyday surface of *status + Connection + What syncs*; everything
  else defaults sanely and lives under one collapsed **Advanced**. No LiveSync-style
  intersection-visibility (level × mode × wizard) — a row is either always shown or under Advanced.
- **Eliminate, don't mask** — every existing knob is judged; several are removed from the standing
  surface entirely (see §4).
- **Guided first run** — a focused, auto-opening **wizard modal** for the 0→syncing path (official
  Obsidian Sync makes users navigate three sidebar sections themselves; a real wizard is our
  improvement), plus a paste-a-link / scan-a-QR bootstrap for additional devices.
- **Plain vocabulary** — adopt official Obsidian Sync's spatial/ownership language (remote vault,
  connect, unlock is N/A, conflict resolution, sync log), never database/replication jargon.
- **One truth** — both surfaces read/write the same persisted `settings`; no buffered or
  dialogue-only pseudo-settings (LiveSync's `preset`/`syncMode` duplication is designed out).
- **Auth-agnostic** — renders "Signed in as X · Sign out"; builds on today's login→token flow and
  leaves clean seams for B7 (durable/revocable tokens, optional E2EE).

**Non-goals (explicitly out of scope):**
- **E2E content encryption** — our model is trusted-server + TLS-in-transit (via the shipped Caddy
  proxy). E2EE (a separate encryption password) is deferred to the B7 security milestone; the wizard
  is structured to admit an encryption-password step later.
- **Version history / "Deleted files → Restore"** — not offered; handled at the NAS/storage layer.
- **Server changes** — login/register/vaults/status/health endpoints already exist; this overhaul is
  client-only.
- **Attachment opt-in bucket** — official Sync makes images/audio/video/PDF opt-in *because it meters
  storage*; a self-hosted server has no quota, so attachments sync by default and no such bucket is
  built. (A size/type exclusion could be added under Advanced later — YAGNI now.)

---

## 2. Two surfaces, one truth

All configuration lives in the already-persisted `NewLiveSyncSettings` object (already excluded from
sync by M6). Two surfaces render it:

- **Settings tab** (`NewLiveSyncSettingTab`) — the always-visible, scannable reference.
- **Setup wizard** (`SetupWizardModal`) — a focused, auto-opening first-run flow that writes the same
  fields, then closes and triggers a reconnect.

Pure logic (status-line text, wizard step gating, connection-string encode/parse) is split into
Obsidian-free modules so it is unit-testable; the modal and tab are thin renderers over that logic +
the transport + the sync FSM.

---

## 3. Settings-tab layout

### Unconfigured (fresh install)
```
● Not set up
Sync your notes to your own server.
[ Set up SelfSync ]        ← opens the wizard
```
Nothing else is shown until configured.

### Configured
```
┌───────────────────────────────────────────┐
│  ● Fully synced                            │  status card
│  Signed in as will · Remote vault 'notes'  │
│  Last synced just now                      │
│  [ Reconnect ]        [ Add a device ]     │
└───────────────────────────────────────────┘

Connection
  Server         https://sync.example.com      [edit]
  Account        will                           [Sign out]
  Remote vault   notes                          [Switch vault]

What syncs
  Notes & attachments      Always
  Obsidian settings        On — 2 plugins excluded   ▸   (expands to the M6 panel)

▸ Advanced   (collapsed)
    Conflict resolution   ◉ Automatically merge   ○ Create conflict file
    Device name           WILLIAMS-PC              [edit]
    Diagnostics           [Show sync log] [Copy debug info] □ Detailed logging
    Danger zone           [Disconnect]   ← unbinds this vault, keeps local files
```

### Status-card states (text + color from the `syncstate` FSM `light()` — single color source)
| FSM phase | Dot | Card text | Primary action |
|---|---|---|---|
| off / unconfigured | grey | Not set up | Set up SelfSync |
| connecting | amber | Connecting… | — |
| syncing | amber | Syncing… | — |
| idle | green | Fully synced | — |
| offline | red | Offline — retrying | Reconnect |
| server vault error (M5) | red | Server vault needs repair | (reindex guidance) |

- `[Add a device]` opens the connection-string / QR modal (server + username, never password).
- `[Sign out]` clears the token + password and returns to the unconfigured state.
- `[Disconnect]` unbinds the vault (clears `vaultId`) without touching local files.
- `[Copy debug info]` packages server URL (host only), vault, app/plugin version, FSM phase, and the
  recent log tail — the official-style support escape hatch (no password included).

---

## 4. The elimination pass (every current knob judged)

| Current setting | Verdict | Detail |
|---|---|---|
| `serverUrl`, `username`, `vaultId` | **Keep** (Connection) | Irreducible. `vaultId` shown as "Remote vault". |
| `password` (visible field on tab) | **Remove from tab** | Needed only at login/re-auth. Lives in the wizard + a re-auth prompt when a token is rejected. Not a standing setting row. |
| `conflictStrategy` | **Default + demote** | Default `auto-merge` (merge Markdown, conflict-copy binary). Under Advanced as radios labelled "Automatically merge" / "Create conflict file". |
| `deviceName` | **Auto-derive + demote** | Defaults to OS hostname (`os.hostname()` via the app where available, else a stable generated name); editable only under Advanced. No longer a required field. |
| `verbose` | **Rename + relocate** | "Detailed logging" checkbox in Advanced → Diagnostics. |
| `configSync` (M6) | **Keep, collapse** | One-line summary under "What syncs"; expands to the existing `renderSelectiveSync` panel. |

Everyday surface after the pass: **status + Connection + What syncs** (three areas); conflict / device
/ diagnostics all default sanely under one collapsed Advanced.

---

## 5. Setup wizard flow

A single modal, linear steps; **Next is disabled until the step validates** (guardrails, not knobs):

```
Step 1 · Welcome      "Sync your notes to your own server."
                      [ Get started ]   [ I have a setup link ▸ ]
Step 2 · Server       Server URL [__________]  [ Test connection ]
                      green "Reachable ✓" enables Next; else inline error
Step 3 · Account      ◉ Log in  ○ Create account
                      Username [__]   Password [__]      [ Back ] [ Log in → ]
Step 4 · Remote vault ◉ notes  ○ personal  ○ + Create new: [____]
                                                            [ Back ] [ Start syncing → ]
Step 5 · Done         ● Fully synced. "SelfSync is now syncing 'notes'."   [ Done ]
```

- **"I have a setup link"** — paste a `selfsync://` link (or scan the QR): prefills Server + Username,
  jumps to Step 3 with only the password to type, then vault pick. (Device-#2 bootstrap.)
- **Step 5 · Done** closes the modal and triggers `reconnect()`.
- **Auto-open:** the wizard opens automatically on first run (when unconfigured) via
  `onLayoutReady`; re-runnable from the tab's `[ Set up SelfSync ]` / `[Switch vault]`.

### Connection string / QR
Human-inspectable, **no secrets**:
```
selfsync://sync.example.com:443?user=will
```
Generated by `[Add a device]`; the same URI is rendered as a QR (QR generation is self-contained — a
small pure-TS/inline generator or SVG, no external host, matching the plugin's no-external-fetch
posture). Carries **server + username only**.

### Error copy (plain, actionable)
| Condition | Message |
|---|---|
| Server unreachable | "Couldn't reach that server. Check the URL and that the server is running." |
| Bad credentials | "Wrong username or password." |
| Registration closed (server 401) | "This server doesn't allow new accounts. Ask the admin for login details." |
| Vault name invalid | inline: "Use letters, numbers, dashes." |

### Re-auth (not the full wizard)
When a stored token is rejected mid-session and the stored password also fails/absent, a small
"Session expired — re-enter password" prompt, not the wizard.

---

## 6. Auth mechanism for goal #1 (honest statement)

Today's server tokens are **in-memory and non-expiring** (durable/revocable tokens are B7). To keep
reconnect seamless *now*:

- After login, **store the token** and **also keep the password locally** (never synced — M6 excludes
  SelfSync's own folder; protected in transit by TLS).
- `reconnect()` tries the token; on 401 it **silently re-logins with the stored password**; only if
  that also fails does it show the re-auth prompt.
- The connection string never carries the password.

When **B7** lands durable/revocable tokens, flip to token-only and drop the stored password. UX copy
is already auth-agnostic, so no redraw is needed.

---

## 7. Components / files

| File | Change | Responsibility |
|---|---|---|
| `client/src/connstr.ts` | **new** (pure) | `encodeSetupLink({server,user})` / `parseSetupLink(str)` — the `selfsync://` format; validated; no secrets. |
| `client/src/wizardsteps.ts` | **new** (pure) | `canAdvance(step,state)`, `nextStep(step,state)`, and `statusLine(phase,{user,vault,lastSyncedAt})` (returns the card's text lines). |
| `client/src/setupwizard.ts` | **new** (replaces `onboarding.ts`) | The stepped `SetupWizardModal`; thin renderer over the pure step logic + transport calls. |
| `client/src/settings.ts` | **restructure** | Status card → Connection → What syncs → collapsed Advanced; keeps `renderSelectiveSync` nested under "What syncs". |
| `client/src/main.ts` | **extend** | Token persistence + silent password re-login + re-auth prompt; `lastSynced` stamp; connection-string generate; `disconnect()`; auto-open wizard on first run. |
| `client/src/transport.ts` | **extend** | `testConnection()` → `GET /health` (already exists). |
| `client/src/syncstate.ts` | reuse | `light()` remains the single color source for the status card. |
| `client/src/settings.ts` (`NewLiveSyncSettings`) | **extend** | Add `authToken?: string`, `lastSyncedAt?: number`. `deviceName` default becomes hostname-derived. |
| `client/src/onboarding.ts` | **remove** | Superseded by `setupwizard.ts`. |

**Data flow:** wizard writes `settings` (server, username, vaultId) + stores token → `saveSettings`
→ `reconnect`. Tab renders from `settings` + FSM phase + `lastSyncedAt`. Connection string derives
from `settings`.

---

## 8. Testing

- **Pure unit tests** (headless, vitest — like `configsync.test.ts`):
  - `connstr`: encode/parse round-trip; reject malformed; **assert no password ever appears** in the
    encoded link; URL edge cases (ports, trailing slash, missing scheme).
  - `wizardsteps`: `canAdvance` gating per step; `nextStep` transitions incl. the setup-link shortcut
    skipping to Step 3; `statusLine(phase,{user,vault,lastSyncedAt})` text for every FSM phase
    (off/connecting/syncing/idle/offline/server-error) and the configured/unconfigured cases.
- **E2E** (extend `client/test/e2e.spec.ts` against the real server): `testConnection` ping to
  `/health`; a wizard-happy-path data flow (login → listVaults → createVault → reconnect) asserting
  the resulting `settings` + that sync then works.
- **Manual checklist** (in Obsidian — `Modal`/`Setting` DOM can't render headlessly): wizard steps +
  Next-gating, auto-open on first run, tab layout + Advanced collapse, Add-a-device QR render/scan,
  re-auth prompt, Disconnect/Sign out behavior.

**No server-side tests** — no server code changes.

---

## 9. Risks

- **DOM-heavy code is manual-test-only.** Mitigated by pushing all decision logic into the pure,
  unit-tested `connstr` / `wizardsteps` modules; the renderers stay thin.
- **Hostname derivation** for `deviceName` may be unavailable on mobile — fall back to a stable
  generated label ("Obsidian on <platform>"); never block setup on it.
- **QR generation must be self-contained** (no external host) to respect the plugin CSP posture —
  inline generator/SVG only.
- **Applying a synced `community-plugins.json`** (M6) can name a plugin not installed on this device —
  the M6 reload path already tolerates that; unchanged here.
- **M6 default divergence from official** (we default Appearance OFF / community plugins ON; official
  is the reverse) is deliberate and left as-is; revisit only if user testing argues otherwise.

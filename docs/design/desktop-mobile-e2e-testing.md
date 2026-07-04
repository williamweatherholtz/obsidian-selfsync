# SelfSync — Desktop & Mobile E2E Testing Guide

> A hands-on checklist for validating a build on **real Obsidian desktop + mobile** against a
> running server. This is the human L3/L4 layer; the automated L1/L2 + headless full-stack layers
> are in [`e2e-process.md`](./e2e-process.md) and must be green first (`scripts/e2e.ps1`). This doc
> assumes those pass and focuses on the GUI glue and platform realities that can't be tested headlessly.

**Covers:** setup wizard, status card, note sync (create/edit/delete/rename/binary/dedup), three-way
merge + conflict copies, selective config/plugin sync (incl. the never-sync-SelfSync rule),
add-a-device (link + QR), server-error/reindex recovery, offline/reconnect, and mobile specifics.

---

## 0. Before you start

### 0.1 What you need
- A machine running the **server** (`cargo run` in `server/`, or the Docker image).
- **Two Obsidian desktop vaults** (Vault A, Vault B) — quickest to iterate.
- **One mobile device** (iOS or Android) with Obsidian installed — for the mobile suite.
- The built plugin: `client/main.js`, `client/manifest.json`, `client/styles.css` (run `npm run build`
  in `client/` first; `main.js` is git-ignored and built locally).

### 0.2 Server for desktop vs mobile — the networking gotcha
- **Desktop:** the dev server binds `127.0.0.1:8789` (see `e2e-process.md` for why 8789/IPv4, not 8080).
  Desktop vaults use `http://127.0.0.1:8789`.
- **Mobile: `127.0.0.1` will NOT work** — that's the phone itself. The phone must reach the server over
  the network:
  - **LAN:** bind the server to `0.0.0.0:8789` (`$env:BIND_ADDR='0.0.0.0:8789'`) and use the machine's
    LAN IP from the phone, e.g. `http://192.168.1.50:8789`. Phone must be on the same Wi-Fi.
  - **Recommended (matches production):** put the server behind the **Caddy reverse proxy** from the
    compose example so it's `https://<your-host>`. iOS App Transport Security and general hygiene make
    **HTTPS strongly preferred on mobile** — test at least once over HTTPS, not just LAN HTTP.
- **`Test connection` in the wizard is your friend** — it pings `/health` and tells you immediately if
  the phone can't reach the server, before you fight the login step.

### 0.3 Installing the plugin
- **Desktop:** copy `main.js`, `manifest.json`, `styles.css` into
  `<vault>/.obsidian/plugins/obsidian-selfsync/`, then enable it in Settings → Community plugins.
  (`scripts/e2e.ps1` stages Vault A/B with the plugin pre-installed.)
- **Mobile (sideload):** Obsidian mobile has no plugin-file picker. Get the three files into
  `<vault>/.obsidian/plugins/obsidian-selfsync/` on the device by either:
  1. letting the folder **sync from a desktop** (note: SelfSync will never sync *its own* plugin folder,
     so the *first* install must be copied manually — via Files app / USB / a temporary transfer), or
  2. using the Files app (iOS) / a file manager (Android) to drop the files in.
  Then enable Community plugins → toggle SelfSync on.

### 0.4 Reset between runs
`./scripts/e2e.ps1 -Clean` resets server data + staged vault notes. For mobile, remove the vault's
files manually or use a throwaway vault. Each fresh vault should be **unconfigured** so the wizard
auto-opens.

---

## 1. Desktop suite

> Run these with Vault A + Vault B open on desktop and the server running. Record pass/fail in §5.

### 1.1 First-run setup wizard (goal #1)
| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| D1 | **Wizard auto-opens** | Open a fresh (unconfigured) vault | The "Set up SelfSync" wizard opens automatically on load |
| D2 | **Server step gates on reachability** | On the Server step, enter a bad URL → **Test connection** | Shows "Couldn't reach that server…"; **Next stays disabled**. Fix URL → Test → "Reachable ✓" → Next enables |
| D3 | **Bad login is clear** | Account step: wrong password → Log in | "Wrong username or password." (no cryptic error); Next stays disabled |
| D4 | **Register (if server allows)** | Account step: choose "Create account", pick new creds → Create & log in | Account created + logged in → advances to vault step. (If server registration is closed: "This server doesn't allow new accounts…") |
| D5 | **Pick/create vault + finish** | Vault step: create a new vault "notes" → Start syncing → Done | Done screen "SelfSync is now syncing 'notes'"; on close the status card goes to connecting → green |

### 1.2 Status card & settings tab
| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| D6 | **Status card reflects state** | Watch the settings tab / status bar during connect | Grey "Not set up" → amber "Connecting…/Syncing…" → green **"Fully synced"** with "Signed in as … · Remote vault 'notes'" and a "Last synced …" line |
| D7 | **Progressive disclosure** | Open the settings tab | Everyday view = status card + Connection + What syncs. **Advanced is collapsed**; expanding shows conflict resolution, device name, detailed logging, diagnostics, Disconnect. No password field on the tab |
| D8 | **Copy debug info has no secret** | Advanced → Copy debug info → paste into a note | Contains phase/server-host/vault/log tail; **contains NO password** |

### 1.3 Note sync (core)
| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| D9 | **Create → propagate** | Vault A: create `n1.md` = "hello from A" | Appears in Vault B within ~1–2 s, same content |
| D10 | **Edit → propagate** | Vault B: edit `n1.md` → "edited in B" | Reflects in Vault A within ~1–2 s |
| D11 | **Delete → propagate** | Vault A: delete `n1.md` | Disappears in Vault B |
| D12 | **Rename → propagate** | Vault A: create `r.md`, let it sync, rename to `r2.md` | Vault B ends with `r2.md` only |
| D13 | **Binary round-trips** | Vault A: add an image/PDF | Byte-identical in Vault B |
| D14 | **Dedup** | Vault A: duplicate a large note under a new name | Second file syncs without re-uploading its chunks (watch the log / no full re-transfer) |
| D15 | **No echo loop** | After any propagation, watch the sync log | Settles; no runaway pull→push chatter on unchanged content |

### 1.4 Conflict handling (M3)
| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| D16 | **Markdown three-way merge** | Take both vaults offline (stop server). In A edit line 1 of a shared note; in B edit a *different* line. Restart server; let both reconcile | Both edits survive (merged); no data lost |
| D17 | **Binary conflict copy** | Same offline divergence but on an image/binary | Second reconciler keeps its own copy as `… (conflict <device> <ts>).ext`; neither version is clobbered; a notice fires |
| D18 | **Conflict strategy toggle** | Advanced → Conflict resolution → "Create conflict file"; repeat D16 | Markdown now also creates a conflict copy instead of merging |

### 1.5 Selective config / plugin sync (M6)
| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| D19 | **Off by default** | Fresh setup, don't touch "What syncs" | Only notes/attachments sync; `.obsidian/` is not synced |
| D20 | **Enable config sync** | What syncs → expand → toggle "Sync Obsidian settings" on | On next reconnect, `app.json`/`core-plugins.json`/`hotkeys.json` + community plugin folders propagate to the other vault |
| D21 | **SelfSync's own config NEVER syncs** | With config sync ON, change SelfSync's own server URL on Vault A | Vault B's SelfSync server URL is **unchanged** (its `.obsidian/plugins/obsidian-selfsync/` is never synced) — this is the critical safety check |
| D22 | **Theming opt-out holds** | Leave Appearance/Themes/Snippets off (default); change a theme on A | Vault B's appearance is **unchanged** until you explicitly enable that category |
| D23 | **Per-plugin exclude** | Uncheck one plugin in the per-plugin checklist | That plugin's folder stops propagating; others still do |
| D24 | **Live reload is non-fatal** | After a synced plugin's config lands on B | Either the plugin reloads live, or a "…will apply after you reload Obsidian" notice — never a crash |

### 1.6 Resilience (M5 + durability)
| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| D25 | **Offline → red → auto-recover** | Stop the server while a vault is synced | Status goes **red "Offline — retrying"**; on server restart it reconnects and returns to green (no stale-green) |
| D26 | **Server vault error → reindex** | Corrupt the server index (`DATA_ROOT/<user>/<vault>/.sync-index.json`) and restart the server | Client shows the vault is in error / refuses to sync (no data deleted). Run `POST /api/v/<vault>/reindex` (or the operator step) → status returns to ready and sync resumes |
| D27 | **Bind-mount is real truth** | Open files under `DATA_ROOT/<user>/<vault>/vault/` | They are the actual current note contents (browsable/backup-able) |
| D28 | **Concurrent clients** | Have A and B both sync a burst of changes at once | No deadlock/errors; both converge (RwLock lets reads run concurrently) |

### 1.7 Add a device
| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| D29 | **Add-a-device link + QR** | Status card → **Add a device** | Modal shows a scannable QR + a copyable `selfsync://connect?server=…&user=…` link. Confirm the link/QR contain the server + username but **no password** |

---

## 2. Mobile suite

> Obsidian mobile (iOS/Android). Sync is **foreground-only** on mobile (a known caveat — see §4).
> Do these with the server reachable per §0.2 (LAN IP or HTTPS), and a desktop vault available as the
> other side.

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| M1 | **Sideload + enable** | Install per §0.3(2); enable SelfSync in Community plugins | Plugin loads; status bar / settings show the "Not set up" card |
| M2 | **Wizard on mobile** | Setup opens; enter the **LAN IP or HTTPS** URL → Test connection | "Reachable ✓" (if not: you used 127.0.0.1, or wrong network, or HTTP blocked — see §0.2) |
| M3 | **Bootstrap via QR from desktop** | On desktop: Add a device → QR. On phone: scan the QR **with the phone's camera app** to get the `selfsync://` text, copy it, then in Obsidian mobile Setup → "I have a setup link" → paste | Server + username prefill; you only type the password. (The `selfsync://` scheme does not deep-link into Obsidian — the camera app just yields the text you paste.) |
| M4 | **Login + vault pick** | Finish the wizard: log in, pick the existing vault | Status goes green "Fully synced" |
| M5 | **Desktop → mobile propagation** | Create/edit a note on desktop (app in foreground on phone) | Appears on mobile within a couple seconds |
| M6 | **Mobile → desktop propagation** | Create/edit a note on mobile | Appears on desktop |
| M7 | **Binary on mobile** | Add a photo/attachment on mobile | Round-trips to desktop byte-identical |
| M8 | **Foreground-only reality** | Put Obsidian in the background on the phone for a while, edit on desktop, reopen Obsidian mobile | Sync catches up **when the app returns to foreground** (not while backgrounded) — this is expected, not a bug |
| M9 | **Config sync on mobile** | With config sync on, confirm hidden `.obsidian/` files sync to/from mobile | Config propagates; **SelfSync's own folder still never syncs** (mobile keeps its own server URL) |
| M10 | **Mobile offline/reconnect** | Toggle airplane mode on the phone | Status goes red; on reconnect returns to green, converges |
| M11 | **HTTPS path** | Repeat M2–M6 once with the server behind the HTTPS reverse proxy | Works over HTTPS (the recommended mobile setup) |

---

## 3. Cross-device conflict & config matrix

Do at least one full loop with **desktop + mobile as the two devices** (not two desktops):

| # | Scenario | Expected |
|---|----------|----------|
| X1 | **Same note edited on desktop & mobile while one is offline** | Three-way merge (markdown) or conflict copy (binary) — nothing lost |
| X2 | **Enable a community plugin on desktop with config sync on** | The plugin's config propagates to mobile; mobile keeps its own SelfSync connection settings |
| X3 | **Switch a device to a different remote vault** | Connection → Switch vault → that device now syncs the other vault only; no cross-vault bleed |

---

## 4. Known caveats to expect (not bugs)

- **Mobile sync is foreground-only** — no background sync; it catches up on foreground (M8).
- **First mobile install is manual** — SelfSync never syncs its own plugin folder, so device #1→#2
  bootstrap of the *plugin files themselves* can't ride SelfSync; copy them once (§0.3).
- **`127.0.0.1` never works from the phone** — use LAN IP or HTTPS (§0.2).
- **No E2E content encryption / no version history** — deliberate (trusted-server + TLS; history at the
  NAS layer). Don't test for an encryption password or a restore-previous-version UI; they don't exist.
- **`selfsync://` is not a deep link** — the QR/link is scanned by the camera app and pasted into the
  wizard, not opened directly by Obsidian.

---

## 5. Recording results

Copy this table per test run (fill device + build/commit):

```
Run: <date>  Build: <git short sha>  Devices: <desktop OS> / <phone OS + Obsidian version>  Transport: <LAN http | HTTPS>

Desktop:  D1 ▢  D2 ▢  D3 ▢  D4 ▢  D5 ▢  D6 ▢  D7 ▢  D8 ▢  D9 ▢  D10 ▢  D11 ▢  D12 ▢  D13 ▢  D14 ▢  D15 ▢
          D16 ▢ D17 ▢ D18 ▢ D19 ▢ D20 ▢ D21 ▢ D22 ▢ D23 ▢ D24 ▢ D25 ▢ D26 ▢ D27 ▢ D28 ▢ D29 ▢
Mobile:   M1 ▢  M2 ▢  M3 ▢  M4 ▢  M5 ▢  M6 ▢  M7 ▢  M8 ▢  M9 ▢  M10 ▢ M11 ▢
Cross:    X1 ▢  X2 ▢  X3 ▢

Blockers / notes:
```

Save completed runs alongside the milestone results in `docs/design/plans/` (e.g. append to the
relevant `mN-e2e-results.md`). The **must-pass gates before shipping** are: D21 (SelfSync config never
leaks), D25/D26 (no data loss on failure), D16/D17 (no conflict data loss), and one full mobile loop
(M2–M6) over HTTPS.
```

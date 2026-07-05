# SelfSync — manual verification checklist (0.8.0)

Covers the thin real-client glue the automated suites can't reach (Obsidian UI, `requestUrl`
transport, vault-adapter I/O, mobile constraints). Run against the current release. Mark
**P**ass / **F**ail / **–** (skipped) and jot notes. Tracks the `l3GuiPass` (desktop) and
`l4MobileOndevice` (mobile) delivery items.

Setup: a server reachable over TLS (see `docs/deployment.md`) + the plugin installed via BRAT.

## L3 — Desktop (Obsidian on macOS/Windows/Linux)

| # | Check | Steps | Expected | P/F |
|---|-------|-------|----------|-----|
| D1 | First-run wizard | Install into a fresh vault; open Obsidian | Setup wizard auto-opens; connect to server; pick/create a vault; ends synced | |
| D2 | Settings groups | Open SelfSync settings | Four sections render (Setup & transitions · Connection · What syncs · Advanced); Disconnect is under Connection | |
| D3 | Config-sync dials | Toggle "Obsidian settings" + individual dials | Enabling syncs the chosen `.obsidian` surfaces to a second device; SelfSync's own folder never syncs | |
| D4 | One indicator | Watch the status bar during sync | Status bar shows state (color + glyph); NO duplicate ribbon on desktop | |
| D5 | Editor indicator (opt-in) | Advanced → "Show sync status in the editor" ON | A status icon appears on open notes; OFF removes it | |
| D6 | Create/edit/delete/rename | On device A, create → edit → rename → delete a note | Each propagates to device B within ~1–2 s; server `vault/` reflects it | |
| D7 | Conflict handling | Edit the same note on A and B while one is offline, then both sync | Non-conflicting edits merge; a true conflict keeps both (a conflict-copy), nothing lost | |
| D8 | Switch vault (own) | Switch to another of your vaults with local data present | Prompt offers Merge / Download / Upload; chosen mode behaves | |
| D9 | Store-password toggle | Advanced → turn "Store password on this device" OFF | Password removed from data.json; sync continues on the token; on token expiry, setup re-opens | |
| D10 | Disconnect / sign out | Connection → Disconnect; then sign out | Disconnect stops sync (local files kept); sign out returns to Not-set-up | |

## L3 — Sharing + admin (`/admin` web UI + the plugin)

| # | Check | Steps | Expected | P/F |
|---|-------|-------|----------|-----|
| S1 | Admin loads | Browse to `https://<server>/admin`, sign in | Page loads; shows your vaults; server-admin also sees Accounts/Registration/Invites | |
| S2 | Create account | Admin → Accounts → create `bob` | `bob` appears in the list | |
| S3 | Registration + invite | Set registration Closed; issue an invite token | Token shown once; a new user can register with it once (not twice) | |
| S4 | Grant a share | Share one of your vaults to `bob` (read-write) | Grant shows under that vault | |
| S5 | Consume a share | As `bob` in a plugin: Switch vault → "Shared with you" → pick it | Vault syncs; `bob`'s edits flow back to the owner | |
| S6 | Read-only share | Share read-only to `carol`; `carol` edits locally | `carol` pulls updates; her local edits are NOT pushed (kept as a local copy) | |
| S7 | Revoke | Revoke `bob`'s share (or delete `bob`) | `bob` loses access immediately; deleting `bob` also drops his shares + sessions | |

## L4 — Mobile (Obsidian iOS / Android)

| # | Check | Steps | Expected | P/F |
|---|-------|-------|----------|-----|
| M1 | Transport works | Set up SelfSync on mobile against your server | `requestUrl` + WebSocket reach the server; initial sync completes | |
| M2 | Foreground sync | Edit on desktop; open/foreground the mobile app | Changes arrive on foreground; editing on mobile propagates out | |
| M3 | Resumable | Background the app mid-initial-sync, then reopen | Sync resumes cleanly; no corruption/duplication | |
| M4 | Indicator (ribbon) | Watch the ribbon icon during sync | Ribbon reflects state (color + glyph) — it's the indicator on mobile (no status bar) | |
| M5 | Attachments | Add a moderate image/PDF on one side | Round-trips byte-identical within mobile memory (files > 200 MiB are skipped by design) | |

Record outcomes here or in `docs/design/plans/`; when green, the `l3GuiPass` / `l4MobileOndevice`
delivery items can be marked done.

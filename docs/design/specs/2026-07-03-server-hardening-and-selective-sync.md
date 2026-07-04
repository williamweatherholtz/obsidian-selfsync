# Approved designs: (M5) server hardening + (M6) selective config/plugin sync

Two independent features, brainstormed + approved 2026-07-03. Server hardening was
research-critiqued (fail-loud consensus from SQLite/Postgres/git; retry-storm
postmortems; Erlang/OTP supervision; axum error idioms) and **de-risked** from the
original auto-rebuild proposal. Build order: M5 then M6.

---

## M5 — Server error hardening + coarse health status (de-risked)

**Verdict from research:** error-hardening + a reported status label are clear wins;
auto-rebuild-on-corruption and resume-on-mutex-poison are foot-guns (invert the
fail-loud consensus; can trigger a fleet-wide re-sync storm). So:

### Build
1. **Typed errors.** Add `src/error.rs`: `AppError` enum (`thiserror`-style, or hand-rolled)
   implementing axum `IntoResponse`: `NotFound`→404, `BadRequest(String)`→400,
   `Unauthorized`→401, `Conflict`→409, `Unavailable(String)`→503, `Internal(String)`→500.
   Handlers return `Result<T, AppError>` and use `?`. Remove ad-hoc `StatusCode` mapping.
2. **No panics on the request path.** Replace `.lock().unwrap()` and io `unwrap()` in handlers
   with fallible paths; do fallible work outside the critical section so a panic can't poison
   the vault lock. On a poisoned lock, **propagate** (503) — do NOT `into_inner()`-and-resume.
3. **Coarse per-vault status label** (observability only, NOT a side-effecting FSM):
   `VaultStatus { Ready | Degraded(String) | Error(String) }` stored in `VaultHandle`
   (`Arc<Mutex<VaultStatus>>`). Set `Error` when `Vault::open` hits a corrupt index (fail loud,
   don't rebuild); set `Degraded` on a recoverable anomaly (e.g. missing chunk on read).
   New route `GET /api/v/{vault}/status` → `{ state, detail, version }`.
4. **Operator reindex** (explicit, not automatic): `POST /api/v/{vault}/reindex` (auth) rebuilds
   the index from the bind-mount `vault/` files. **Version-preserving + deterministic:** where a
   file's bytes are unchanged vs the current index, keep its version + chunk list; only genuinely
   new/changed files advance. Same files ⇒ byte-identical index (test this). Refuse writes while
   an `Error` vault hasn't been reindexed; still serve reads if the chunk store is intact.
5. **Client light reflects server state:** after a successful reconcile, read `/status`; map
   Ready→green, Degraded/Rebuilding→amber (tooltip = detail), Error/unreachable→red.

### Tests
Unit: `AppError`→status mapping; corrupt-index → `Error` (NOT auto-rebuilt); reindex is
version-preserving (unchanged files keep version) + deterministic (byte-identical index twice).
Integration: `/status` reports Error after corruption; a write to an Error vault → 503; reindex → Ready.

### Explicitly NOT doing
Silent auto-rebuild on open; resume-on-poison; a rich circuit-breaker-style FSM. (Per critique.)

---

## M6 — Selective config / plugin / theme sync

Today the engine syncs only real vault files (`app.vault.getFiles()` — notes/attachments); it
does not touch `.obsidian/`. This adds **opt-in/out sync of the `.obsidian/` config surface**
through the same reconcile engine, gated by a path filter, with a settings panel.

### Rules (defaults)
- **Always exclude** `.obsidian/plugins/<SelfSync id>/**` — its `data.json` holds server URL /
  credentials / vaultId, which are per-device. Non-optional (greyed in the panel). ("IP may
  differ, don't override.")
- **Theming excluded by default, opt-in:** `.obsidian/appearance.json`, `.obsidian/themes/**`,
  `.obsidian/snippets/**`.
- **Synced by default:** `app.json`, `core-plugins.json`, `community-plugins.json`,
  `hotkeys.json`, and other plugins' folders `.obsidian/plugins/<id>/**`.

### Panel (category toggles + per-plugin checklist)
Top toggles: **Core settings · Community plugins · Appearance/Themes · Snippets · Hotkeys**
(Appearance/Themes default OFF, rest ON). Under Community plugins, a **per-plugin checklist**
(all ON except SelfSync, which is greyed/forced-off) so a single plugin can be excluded. Persist
the selection in settings (a set of enabled categories + a per-plugin allow/deny map).

### Mechanism
- Extend `ObsidianVaultIo` to also enumerate/read/write `.obsidian/**` via `app.vault.adapter`
  (hidden config files), producing a second path space fed through the SAME reconcile engine.
- A **`shouldSync(path)` filter** (from the panel selection + the hard SelfSync-self exclusion)
  applied in `list()` and before any write/push. Excluded paths are never uploaded and never
  overwrite locally.
- **Apply behavior: write + attempt live reload.** After writing a config/plugin file, best-effort
  reload the affected surface: `app.workspace.trigger` / disable+enable the plugin via
  `app.plugins.disablePlugin/enablePlugin`, reload appearance via the theme API. **Guarded:** never
  reload SelfSync itself; wrap reloads in try/catch and fall back to "changes apply on next restart"
  (LiveSync's live-reload was a top bug source — keep it non-fatal). Notice on reload failure.

### Tests
Unit: `shouldSync` honors defaults + SelfSync-self exclusion + theming opt-in + per-plugin deny.
E2E: enabling plugin sync propagates a plugin's `data.json` between vaults but NEVER the SelfSync
folder; theming stays local until opted in.

### Risks (from critique history)
Live-reload fragility → guarded + fallback. Applying a synced `community-plugins.json` could try to
enable a plugin whose code isn't present yet → reload must tolerate missing plugins. Hidden-file
mtime churn (LiveSync's HiddenFileSync was unreliable on mtime) → we key on content hash (our base
store already does), avoiding the mtime trap.

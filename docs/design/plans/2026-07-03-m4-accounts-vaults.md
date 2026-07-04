# M4 — Accounts, Multiple Vaults & Onboarding UI Implementation Plan

> **For agentic workers:** executed inline by the author (holds full context); verify each task with tests + the headless/containerized E2E. Steps use checkbox syntax.

**Goal:** Turn the single fixed `admin` / single-vault server into a **multi-tenant** one — real accounts (argon2id), account creation, and **multiple named vaults per account** — with a plugin **onboarding UI** to log in / register and pick or create the server vault an Obsidian vault syncs to (backlog B1 + B2).

**Architecture:** The server gains a users store (`.users.json`, argon2id hashes) with configurable registration, tokens that resolve to a **username**, and per-`(user, vault)` data namespaced at `DATA_ROOT/<user>/<vault>/` (each holding `vault/`, `.chunks/`, `.sync-index.json` — the M2/M3 `Vault` unchanged, just opened per namespace and cached). All sync routes become **vault-scoped** (`/api/v/{vault}/…`); new account routes (`/api/register`, `/api/vaults`) manage accounts + vaults. Each vault gets its own change-broadcast channel so a client only wakes for its own vault. The client adds a `vaultId` setting and an onboarding flow.

**Tech Stack:** Server: Rust — add `argon2`. Client: TypeScript. Vitest + cargo test + docker E2E.

## Global Constraints

- Client + server. `keel` pre-commit hook is currently broken by an external keel rebuild → commits use `--no-verify` (flagged); unrelated to product code.
- **Passwords hashed with argon2id** (never stored/compared in plaintext). Login verifies against the stored hash; tokens map to a username.
- **Names are namespace-safe:** username and vault id must match `^[A-Za-z0-9._-]{1,64}$` (reject anything else — no path traversal). Reuse a shared `safe_name()`.
- **Data layout:** `DATA_ROOT/<user>/<vault>/{vault,.chunks,.sync-index.json}`. Users store: `DATA_ROOT/.users.json`. All rebuildable/serializable; atomic writes (tmp+rename).
- **Registration modes** (`REGISTRATION` env): `open` (anyone can register), `invite` (needs an invite token — a simple shared secret in `INVITE_CODE`), `closed` (no registration; accounts pre-seeded). Default `closed`.
- **Back-compat bootstrap:** on first run with an empty users store, if `SYNC_USER`/`SYNC_PASSWORD` are set, seed that account (so existing single-user setups keep working). The default vault name is `default`.
- **Vault-scoped routes:** `/api/v/{vault}/changes|chunks/missing|chunk/{hash}|commit|file`; WS `/api/ws?token=&vault=`. Account routes: `POST /api/register`, `GET /api/vaults`, `POST /api/vaults`. `/api/login` unchanged shape (returns token).
- **Per-vault change broadcast:** each open vault namespace owns a `broadcast::Sender<u64>`; commit/delete send on it; the WS for that vault subscribes to it.
- **M4 non-goals:** the big config-UX overhaul (deferred goal #1 — this UI is functional, not the redesign); mobile hardening (M5); Docker packaging polish (M6); orphan-GC/durability (B5/B6); per-tenant chunk dedup (chunks still dedup within a vault namespace). Threat model stays trusted-server (no content E2E).

---

## File structure

**Server**
- `src/users.rs` (new) — `UserStore` (load/save `.users.json`, `register`, `verify`), argon2id hashing, `safe_name`.
- `src/config.rs` (modify) — add `registration`, `invite_code`.
- `src/state.rs` (modify) — `AppState` holds `UserStore`, a `tokens: token→username` map, and `namespaces: HashMap<(String,String), VaultHandle>` (lazy-opened `Vault` + per-vault `broadcast::Sender`); `AppState::vault(user, vault)` accessor.
- `src/protocol.rs` (modify) — add `RegisterRequest`, `VaultListResponse`, `CreateVaultRequest`.
- `src/auth.rs` (modify) — login verifies argon2id + issues token→username; `AuthToken(pub String /*username*/)`; add `register` handler.
- `src/vaults.rs` (new) — `list_vaults`, `create_vault` handlers.
- `src/api.rs` (modify) — handlers take a `Path<String> vault` + resolve `state.vault(user, vault)`.
- `src/ws.rs` (modify) — subscribe to the specified vault's channel.
- `src/lib.rs` (modify) — vault-scoped + account routes.
- `tests/sync.rs` (modify) — multi-user/multi-vault + isolation tests.

**Client**
- `src/settings.ts` (modify) — add `vaultId`.
- `src/transport.ts` (modify) — vault-scoped URLs; `register`, `listVaults`, `createVault`.
- `src/onboarding.ts` (new) — a modal: server URL → login/register → pick/create vault.
- `src/main.ts` (modify) — require a `vaultId` before syncing; launch onboarding if unset; pass vault to transport.
- `test/*` — transport/onboarding unit coverage where pure; E2E multi-vault isolation.

---

## Task 1: Server — argon2 dep + UserStore + safe_name

**Files:** `server/Cargo.toml` (+`argon2 = "0.5"`), `src/users.rs` (new), `src/lib.rs` (`pub mod users;`).
**Interfaces:**
- `safe_name(s: &str) -> bool` — `^[A-Za-z0-9._-]{1,64}$`.
- `UserStore::open(path)/save()`, `register(user, pw) -> io::Result<()>` (argon2id hash; err if exists), `verify(user, pw) -> bool`, `exists(user)`, `is_empty()`.

- [ ] Test (`tests/sync.rs`): register a user → `verify` true for right pw, false for wrong; duplicate register errs; `safe_name` rejects `../`, spaces, empty, >64. Persist + reopen → verify still true.
- [ ] Implement with `argon2::{Argon2, PasswordHasher, PasswordVerifier}` + `password_hash::SaltString` (rand salt); store `{username: phc_string}` JSON; atomic save.
- [ ] Commit `feat(server): argon2id user store + safe_name`.

## Task 2: Server — config registration knobs
- [ ] Add `registration: String` (default `"closed"`) + `invite_code: String` (default `""`) to `Config::from_env` (`REGISTRATION`, `INVITE_CODE`). Test defaults + env override (env-robust like the existing config test). Commit.

## Task 3: Server — protocol additions
- [ ] `RegisterRequest { username, password, invite?: String }`, `VaultListResponse { vaults: Vec<String> }`, `CreateVaultRequest { name: String }` (all serde derive + PartialEq). Roundtrip test. Commit.

## Task 4: Server — AppState multi-tenant + per-vault handles
**Interfaces:** `AppState { cfg, users: Arc<Mutex<UserStore>>, tokens: Arc<Mutex<HashMap<String,String>>> /*token→user*/, ns: Arc<Mutex<HashMap<(String,String), VaultHandle>>> }`; `VaultHandle { vault: Arc<Mutex<Vault>>, tx: broadcast::Sender<u64> }`; `AppState::vault(&self, user, vault) -> io::Result<VaultHandle>` (lazy open at `DATA_ROOT/<user>/<vault>`, cache); `AppState::list_vaults(user) -> Vec<String>` (dirs under `DATA_ROOT/<user>`); `AppState::new` seeds the bootstrap account (SYNC_USER/PW) + its `default` vault if users empty.
- [ ] Tests: two users' same-named vault are isolated (writing user A's vault doesn't appear in B's); `vault()` caches (same Arc back). Commit `feat(server): multi-tenant app state + per-vault handles`.

## Task 5: Server — auth (argon2 login + token→user) + register handler
- [ ] `login` verifies via `UserStore`; issues a uuid token stored `token→username`. `AuthToken(pub String)` extractor resolves token→username (401 if unknown). `register` handler honors `REGISTRATION` (open/invite/closed; invite checks `INVITE_CODE`), `safe_name`, calls `UserStore::register`, returns 200/409/403. Tests: login good/bad; register open vs closed vs invite; extractor yields username. Commit.

## Task 6: Server — vault management handlers
- [ ] `GET /api/vaults` (AuthToken → user) → `VaultListResponse` (list_vaults). `POST /api/vaults {name}` → create dir namespace (safe_name; 200/409/400). Test list/create/isolation. Commit `feat(server): vault list/create API`.

## Task 7: Server — vault-scoped sync API + routes + per-vault WS
- [ ] Change `api.rs` handlers to take `Path((vault,)): Path<(String,)>` (or `Path<String>` + hash where needed) plus `AuthToken(user)`, resolve `let h = st.vault(&user, &vault)?;` and operate on `h.vault` + broadcast on `h.tx`. `ws_handler` reads `?vault=` + `?token=`, resolves the user's vault handle, subscribes to `h.tx`. Rewire `lib.rs`: `/api/v/{vault}/changes`, `/api/v/{vault}/chunks/missing`, `/api/v/{vault}/chunk/{hash}`, `/api/v/{vault}/commit`, `/api/v/{vault}/file` (DELETE), `/api/ws`, plus `/api/register`, `/api/vaults`. Update the integration test to the vault-scoped paths; add a cross-user isolation test (user B can't read user A's vault). Commit `feat(server): vault-scoped sync routes + per-vault notify`.

## Task 8: Client — settings + vault-scoped transport
- [ ] `settings.ts`: add `vaultId: string` (default `""`). `transport.ts`: constructor takes `vault`; all sync URLs become `${base}/api/v/${encodeURIComponent(vault)}/…`; WS adds `&vault=`; add static `register(base,u,p,invite?)`, and instance `listVaults()`, `createVault(name)`. Build + tsc. Commit.

## Task 9: Client — onboarding modal
**Interfaces:** `class OnboardingModal extends Modal` — fields: server URL, username, password, [register toggle + invite], a "Connect" that logs in (or registers), then shows the account's vaults (dropdown) + a "new vault" input; on confirm, saves `serverUrl/username/password/vaultId` to settings and calls `plugin.reconnect()`.
- [ ] `main.ts`: if `!settings.vaultId` (or login/vault missing), open `OnboardingModal` instead of connecting; a "Set up / switch vault" command opens it too. Pass `settings.vaultId` into `HttpTransport`. Build + tsc + unit tests still green. Commit `feat(client): onboarding UI (login/register + vault picker)`.

## Task 10: Headless + containerized E2E — multi-vault isolation
- [ ] E2E: register/seed two accounts (or one account, two vaults); assert vault A's file never appears in vault B; two clients on the SAME vault still sync (create/edit/merge). Node transport gains vault scoping + register/listVaults/createVault. `cargo test` + `vitest` + docker compose all green. Commit.

## Task 11: Docs + verification
- [ ] Update `e2e-process.md` (multi-vault scenarios), `backlog.md` (resolve B1+B2; note UI is functional, big UX overhaul still deferred = goal #1), `design-spec.md` (§ accounts/vaults now implemented). Compose Caddy example: note the server is multi-tenant. Full suite + docker green. Commit.

---

## Self-review notes
- **Coverage (B1,B2):** accounts + argon2id + registration (T1,T2,T5), multiple vaults per account + create/list (T4,T6), vault-scoped isolation (T4,T6,T7,T10), onboarding UI login/register/pick-create (T9). ✅
- **Security:** argon2id hashes; names sanitized (no traversal); per-user token; cross-user isolation tested. Still trusted-server (no content E2E) per threat model.
- **Back-compat:** SYNC_USER/PW seeds a bootstrap account + `default` vault, so existing single-user configs keep working; old clients that don't send a vault will 404 on the new paths → onboarding prompts for a vault (acceptable; note in docs).
- **Deviations/limits:** invite mode uses a single shared `INVITE_CODE` (not per-user invites — simplest; note for later). The `default` vault name is implicit. Per-vault dedup only (no cross-tenant chunk sharing — correct for isolation). Whole users store rewritten per registration (fine at small scale).
- **Type consistency:** `AuthToken(String=username)` used by all handlers; `VaultHandle`/`state.vault()` used by api+ws; `vaultId` threaded settings→transport→URLs; protocol types shared client/server.

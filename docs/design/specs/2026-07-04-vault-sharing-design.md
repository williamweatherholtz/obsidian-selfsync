# SelfSync — Vault Sharing & Management Interface (design spec)

**Date:** 2026-07-04 · **Status:** design, pending review · **Tracks Need:** `nVaultSharing`

## Goal

Let a vault owner share a vault with **other users on the same server**, and give the server a
**management interface** (a server-hosted web admin UI) to administer accounts and shares. This
is a new capability that deliberately relaxes the strict per-user isolation of M4 — so it is
fundamentally an **authorization** feature (an ACL on a vault) plus an admin surface.

Decisions locked in brainstorming (2026-07-04):
- Management interface = **server-hosted web admin UI** (browser), served by the axum server.
- Share permission = **owner picks per share: read-only or read-write**.
- Recipients = **existing accounts** on the server.
- Account provisioning = **admin-controlled registration policy** (closed by default; admin can
  enable open self-registration, or issue single-use **invite tokens** while closed).
- Ship **Phase 1** (server ACL + authorization + web admin) first; **Phase 2** (plugin
  consumption of shared vaults) is a tracked follow-up.

## Scope

**In (Phase 1):**
- A sharing ACL + its storage.
- Owner-qualified vault addressing + an authorization layer over vault routes.
- A registration-policy + invite-token system.
- A server-hosted web admin UI (+ its JSON API) for user management and share management.

**Out (Phase 2, deferred — tracked as `shareClientConsume`):**
- The Obsidian plugin picking and syncing a vault shared *with* you (vault switcher shows
  owned + shared; read-only shares disable push). Sharing isn't end-user-usable until this
  lands, but Phase 1 is independently shippable and testable via the API/admin UI.

## Data model (new, all filesystem JSON — no DB, per D0005)

- **`DATA_ROOT/.shares.json`** — central grant list. Each grant: `{ owner, vault, grantee,
  perm }` where `perm ∈ {read, readWrite}`. Central (not per-vault) so both "who can see this
  vault" and "what's shared with me" are cheap. Atomic write (`.tmp` + rename) like the others.
- **`DATA_ROOT/.registration.json`** — registration policy: `{ mode: "closed" | "open" }` +
  the set of live invite tokens `{ token(hash), createdBy, createdAt, expiresAt?, used? }`.
  Tokens are stored hashed (never plaintext at rest); a token is single-use.
- Accounts stay in **`.users.json`** (username → argon2id) — unchanged shape; the admin API
  adds create/remove and (via registration policy) redemption.

## Vault addressing + authorization

- **Routes become owner-qualified:** `/api/v/{owner}/{vault}/…` (your own vault = owner is
  you). This replaces the implicit-self `/api/v/{vault}/…`; it is a protocol change that the
  client transport must adopt (Phase 2 for shared vaults; Phase 1 keeps own-vault working by
  addressing `owner = self`).
- **Authorization layer** (new, over today's bearer-token *authentication*), applied to every
  vault-scoped request: allow iff `user == owner` **OR** a matching grant exists. **Write
  operations** (`commit`, `PUT /chunk`, `DELETE /file`) additionally require `perm ==
  readWrite`; **reads** (`changes`, `meta`, `GET /chunk`, `chunks/missing`) accept any grant.
  The M4 invariant is restated: *no access without ownership or a grant* — still tested.

## Web admin UI (server-hosted)

- Served by axum at `/admin` (self-contained HTML page; inline CSS/JS; same TLS, same
  login/token as the sync API). HTML is the **human lens** over a `/api/admin/*` JSON API that
  is the **authority** (dual-surface). Password hashes are never returned.
- **Roles:** a distinguished **server-admin** = the bootstrap account (`SYNC_USER`).
  - *Server-admin* can: manage accounts (create/remove), set registration mode
    (open/closed), issue/revoke invite tokens, and view/manage all shares.
  - *Any vault owner* can: list their vaults, see each vault's shares, grant a share to an
    existing username (read-only / read-write), and revoke.
- **JSON API (authority):**
  - `GET /api/admin/me` → { username, isServerAdmin }
  - `GET /api/admin/vaults` → my vaults + their grants
  - `POST /api/admin/shares` { vault, grantee, perm } / `DELETE /api/admin/shares` { vault, grantee }
  - `GET/POST /api/admin/users`, `DELETE /api/admin/users/{name}` (server-admin)
  - `GET/PUT /api/admin/registration` { mode } (server-admin)
  - `POST /api/admin/invites` → new token; `GET/DELETE /api/admin/invites` (server-admin)
  - `POST /api/register` { username, password, token? } — honored per registration policy
    (open: token optional; closed: valid single-use token required).

## Security considerations

- Authorization is enforced **server-side** on every request, never trusted from the client.
- Invite tokens: hashed at rest, single-use, optional expiry; redemption is rate-limited and
  constant-time-compared.
- Admin endpoints are role-checked; sharing endpoints check vault ownership.
- Revoking a share takes effect immediately (checked per request; tokens/sessions are not
  long-lived caches of authorization).
- No password hash, token plaintext, or another user's vault content leaks through the admin API.
- The admin UI is same-origin with the sync API and behind the same TLS reverse proxy.

## Testing

- **Server unit/integration:** grant → grantee can read; read-only grantee is refused writes;
  revoke → access denied; non-grantee denied (isolation still holds); owner-qualified routing;
  registration closed rejects tokenless register, accepts a valid token once (not twice), open
  mode accepts registration.
- **Admin API:** role checks (non-admin can't manage users/registration; owner-only share
  management); no hash/plaintext leakage.
- **Web UI:** a headless check that the page loads, authenticates, and round-trips a
  share create/revoke through the JSON API.

## Phasing / milestones

- **Phase 1 (this spec):** `.shares.json` + `.registration.json`, owner-qualified routing +
  authorization, registration policy + invite tokens, web admin UI + `/api/admin/*`.
- **Phase 2 (deferred):** plugin consumption — vault switcher lists owned + shared vaults,
  read-only shares disable push, transport adopts owner-qualified routes.

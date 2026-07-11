# SelfSync — Capability Share-Links (design spec)

**Status:** proposed (awaiting review). Extends vault sharing (D0008). Serves `nVaultSharing`.

## Goal

Let a vault owner share a vault with another person by sending them a **link** — no need to know or
type the recipient's username, and no admin involvement. The recipient pastes the link into their
SelfSync plugin and gains access to the shared vault. This is the ergonomic, in-plugin sharing path
that complements D0008's username-based ACL grants.

## Motivation

Today an owner shares by **username**: they must know the grantee's exact account name (the admin page
offers a `/api/admin/usernames` autocomplete, which is a private/admin surface and a username-listing
attack surface). That's clumsy for end users and couples sharing to knowing account names. A capability
link ("anyone I send this to can get in") is the familiar model (Google Docs, Dropbox) and removes the
username-listing surface from the sharing flow entirely.

## Core decision: redeem **binds to an account** (not an anonymous capability)

A share-link is a **single-use invitation to a share**, not a standing bearer credential:

- The link carries an **opaque token** + the server URL — nothing else (no permission, no vault data).
- When a **logged-in account** redeems it, the server mints a normal D0008 grant
  `{owner, vault, grantee=<redeemer>, perm}` in `.shares.json` and **consumes the link**.
- From then on it is an ordinary username ACL grant: it appears in the owner's share list, is revoked
  per-user the existing way, and every access by the grantee is attributable to their account in the
  audit log.

**Rejected: anonymous capability** (the link *is* the credential, no account needed). It would (a) lose
attribution — the audit trail becomes "whoever held the link", (b) make the link a long-lived bearer
secret that bypasses the per-user token/session model, and (c) give only per-link (not per-user)
revocation. Binding to an account at redemption keeps audit, per-user revoke, and session semantics
intact, and reuses the proven invite-token machinery.

## Data model (new filesystem JSON — no DB, per D0005)

`DATA_ROOT/.share-links.json`: a map of `id → ShareLink`:

```
ShareLink {
  id:          string   // random, non-secret (for listing/revoke)
  owner:       string    // the vault owner (creator)
  vault:       string
  perm:        "read" | "readWrite"   // held SERVER-SIDE, never encoded in the link
  token_hash:  string    // sha256 of the link's secret token (the secret is shown once, never stored)
  label:       string    // optional, owner's note ("for Dana")
  created_at:  iso8601
  expires_at:  iso8601 | null          // default TTL (see below); null only if the owner opts out
  redeemed_by: string | null            // the account that consumed it (single-use)
  redeemed_at: iso8601 | null
}
```

The secret token (the thing in the link) is generated with the same CSPRNG + hashing as invite tokens
(`registration.rs`), stored only as `token_hash`, and shown to the owner exactly once at creation.

## Link (wire) format

Reuse the existing setup/device-link encoding style, a distinct scheme so the plugin can route it:

```
selfsync-share://<base64url({ server, token, vault?, label? })>
```

- `server` + `token` are required. `vault`/`label` are cosmetic hints for the redeem UI only.
- The **permission is NOT in the link** — it lives in the server `ShareLink` record, so a leaked link
  can't be edited from read to read-write.

## Server endpoints (owner-scoped; on the shared surface, like the other owner share ops)

- `POST /api/share-links` — owner creates a link for one of **their own** vaults. Body `{vault, perm, label?, ttl_secs?}`. Returns `{id, token}` (token shown once). Owner-scoped (the caller must own `vault`).
- `GET  /api/share-links` — list the caller's own share-links (never returns the token; shows id/vault/perm/label/expiry/redeemed_by).
- `DELETE /api/share-links/:id` — revoke a **pending** link (caller must own it). Does not affect an already-redeemed grant (that's revoked via the existing share-revoke).
- `POST /api/share-links/redeem` — body `{token}`, **AuthToken-gated** (the redeemer must be logged in). On success: validate (exists, not expired, not already redeemed), mint the `.shares.json` grant `{owner, vault, grantee=caller, perm}`, mark the link redeemed, return `{owner, vault, perm}` so the client can start syncing it. A self-redeem (owner redeeming their own link) is a no-op success.

All four are AuthToken-gated; create/list/delete are additionally owner-scoped to the named vault.
Consistent with the D0021 split, they live on the **shared** base (reachable on the public port), like
the existing `/api/admin/shares` owner endpoints.

## Plugin UI (in-plugin, no admin)

- **Create** (in the existing Share modal / vault management): pick vault + read / read-write + optional
  label + TTL → server returns the token → show the `selfsync-share://…` link with a Copy button (same
  affordance as "Add a device"). Shown once.
- **Manage**: list the owner's pending + redeemed links (label, perm, expiry, redeemed-by), with Revoke
  for pending ones. Redeemed grants continue to be managed in the existing shares list.
- **Redeem**: a "Redeem a share link" action (and auto-detect when a `selfsync-share://` link is pasted,
  mirroring the setup-link paste in the wizard) → calls redeem → the shared vault appears in the vault
  switcher, ready to sync (owner-qualified route, D0008).

## Security considerations

- **A link is a bearer secret until redeemed** — anyone who obtains it can redeem it. Mitigations:
  **single-use** (consumed on first redeem), a **default TTL** (e.g. 7 days; owner may shorten, opt-out
  only deliberately), the owner **sees `redeemed_by`** and can revoke, and the permission is server-side.
- **Redeem binds to the caller's account** → full attribution + per-user revoke; the link never becomes
  a standing credential.
- **Wrong-redeemer race** (link leaks before the intended person redeems): bounded by single-use + TTL +
  the owner seeing who redeemed and being able to revoke the resulting grant immediately.
- **No enumeration**: redeem returns a uniform error for expired / unknown / already-redeemed tokens
  (no oracle distinguishing them); create/list never expose other users.
- **Audit**: `SHARE_LINK_CREATE` / `SHARE_LINK_REDEEM` / `SHARE_LINK_REVOKE` events (actor, vault,
  outcome, source-IP), alongside the existing share grant/revoke events.
- Tokens hashed at rest; CSPRNG-generated; the same machinery as invite tokens.

## Testing

- Server (reqwest): create→redeem mints a grant + the redeemer can read (and write iff read-write);
  single-use (second redeem 401); expired link rejected; revoke a pending link (redeem then 401);
  non-owner can't create/list/revoke another owner's links; permission can't be escalated (server-held);
  self-redeem no-ops; uniform error for unknown/expired/consumed (no oracle).
- Client (vitest): the `selfsync-share://` encode/parse round-trip (pure, like `connstr`); redeem wiring
  calls the endpoint and adds the shared vault; a leaked read link never yields write.
- Playwright/DOM: the create-link + manage + redeem UI flows.

## Non-goals

- **Anonymous / account-less access** — explicitly rejected (see the core decision).
- Changing the underlying ACL — this is **additive**: a redemption layer over D0008's `.shares.json`.
- Public/"anyone on the internet" links — a redeemer still needs an account on this server (invite-only
  registration remains the recommended posture).
- It does **not** address the open-registration username-enumeration item (that's `/api/register`,
  orthogonal, dispositioned separately as an accepted operator-guidance item).

## Relationship to prior decisions

Extends **D0008** (vault sharing via server ACL) — this is a new *grant mechanism* (link redemption)
under the same Need `nVaultSharing`, and a concrete piece of the deferred Phase-2 `shareClientConsume`
(plugin consumption of shared vaults). Reuses **D0005** (filesystem JSON, no DB) and the invite-token
design. No change to the trusted-server model (**D0007**).

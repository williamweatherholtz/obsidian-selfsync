# Deploying SelfSync securely

SelfSync uses a **trusted-server + TLS-in-transit** model (decision D0007): your notes are
encrypted in transit to *your own* server and stored there as real files. There is **no
client-side end-to-end encryption yet**, so the server (and anyone with access to its disk)
can read your notes — run it on infrastructure you control.

The server speaks **plain HTTP/WS** and is meant to sit **behind a TLS-terminating reverse
proxy**. It ships as a **prebuilt image** (`ghcr.io/williamweatherholtz/obsidian-selfsync-server`,
published on every release), so the Compose files just pull it — no local build. Two ready-to-use
stacks live in [`deploy/`](../deploy/): `docker-compose.yml` (bundled Caddy, automatic HTTPS) and
`docker-compose.noproxy.yml` (server only, for your own proxy/tunnel).

## Quick start (Caddy, automatic HTTPS)

1. Point your domain's DNS at the host.
2. Create `deploy/.env`:
   ```
   SELFSYNC_DOMAIN=sync.example.com
   SYNC_USER=admin
   SYNC_PASSWORD=<a long random password>
   ```
3. From `deploy/`: `docker compose up -d`  (upgrade later with `docker compose pull && docker compose up -d`)

Caddy provisions a Let's Encrypt certificate for your domain, terminates TLS, and proxies
to the server. In the plugin's setup wizard, use `https://sync.example.com`.

Pin `image:` to a version tag (e.g. `:1.0.15`) in production for reproducible upgrades; `:latest`
tracks the newest release.

## Why TLS is not optional for remote access

The login request sends your **password** over the wire, and every sync request carries a
**bearer token** and your **note content**. Without TLS these are exposed to anyone on the
network path. (The connection string / QR the plugin shares carries only server + username —
never the password — but the initial login still transmits it.) **Always use TLS for any
non-localhost access.** Plain HTTP is fine only for `127.0.0.1` testing.

## Public-exposure hardening checklist

- **Set a strong `SYNC_PASSWORD`.** Never leave the `admin`/`admin` default on an exposed server.
  (The server refuses to boot on the literal default password unless `ALLOW_WEAK_ADMIN=1`.) User
  accounts must use a password of at least 8 characters (enforced on registration).
- **Brute-force protection is built in, but add per-IP limiting at the proxy.** The server
  rate-limits **per account** (after ~10 failed logins in 5 minutes an account is locked out with
  HTTP 429 + `Retry-After` until the window rolls; a successful login clears it). It does **not** do
  per-IP throttling — that's the reverse proxy's job. On an internet-facing box, add a per-IP rate
  limit / fail2ban in front of `/api/login` and `/api/register` to blunt distributed guessing and
  request floods.
- **Runs as a non-root user.** The container process runs as an unprivileged user (`selfsync`,
  UID 10001), not root. If you mount a host directory for `/data`, make it writable by that UID.
- **Security audit log (for CMMC/compliance-style deployments).** Every security-relevant event —
  login success/failure, lockout, logout, account create/delete, admin grant/revoke, password
  change/reset, session revoke, registration-policy change, invite create/redeem/revoke, share
  grant/revoke, vault create/delete/reindex/prune, and authorization denials — is emitted as a
  single-line **JSON** record on the `audit` log target with a UTC timestamp, the acting user, the
  target, the outcome, and the client IP (`{"ts":…,"actor":…,"action":…,"target":…,"outcome":…,"source":…}`).
  For an attributable, retainable trail (NIST SP 800-171 AU-3.3.1/3.3.2), ship these to a **separate,
  append-only sink** (e.g. filter your log processor on the JSON `action` field or the `audit` target)
  and set a retention policy. The client IP is taken from `X-Forwarded-For`/`X-Real-IP`, so your reverse
  proxy must set it honestly (Caddy does by default).
- **Session inactivity timeout.** A session token idle-expires after `SESSION_IDLE_TIMEOUT_SECS`
  (default **1800** = 30 min) of no server activity, in addition to the 30-day absolute lifetime; an
  actively-syncing device slides its own timer and never expires. Lower it for stricter environments;
  set `0` to disable idle expiry (absolute cap only). Endpoint screen-lock for a walked-away device is
  the operating system's job, not the server's.
- **Never publish the server's `:8080` port to the internet.** Only the reverse proxy's `443`
  should be public. In the Caddy stack the sync port has **no host `ports:` at all** — Caddy reaches
  it over the private Docker network, so it's never bound on the host. The `noproxy` stack binds it
  to `127.0.0.1:8080` (host loopback only) for a same-host proxy. Either way, publishing `:8080` to
  `0.0.0.0` would bypass TLS — don't.
- **Keep registration closed — and know it's a first-run seed.** `REGISTRATION` in the compose file
  sets the policy **only on the first boot** (when `/data/.registration.json` doesn't exist yet).
  After that the policy is runtime state, managed from `/admin` and persisted in the data volume:
  **editing `REGISTRATION` later has no effect, and if you open registration in `/admin` it stays
  open across reboots regardless of the env value.** To close it again, do so in `/admin` (or delete
  `.registration.json` to re-seed). It defaults to closed (invite-only); create accounts, open
  registration, or issue **single-use invite tokens** from `/admin`. Open registration lets anyone
  who can reach the server create an account — only do it deliberately.
- **Owner tasks don't need the admin page.** Managing your OWN vaults' shares and changing your
  own password are done from the plugin over the public port (owner-scoped, authenticated) — the
  private `/admin` page is only for server-owner tasks (accounts, registration, invites, deletes).
- **Sessions are safe by construction:** tokens are hashed at rest, expire after 30 days, and
  are revoked when you delete an account (from `/admin`). Deleting an account also removes its
  shares.
- **Back up the data volume** (`selfsync-data` → `/data`): it holds `.users.json`, the sharing
  ACL, the chunk store, and every vault's materialized files.
- **The admin surface is PRIVATE by default (D0021).** The `/admin` page and `/api/admin/*` bind to
  a **separate, localhost-only port** (default `127.0.0.1:<public port + 1>`, e.g. `:8081`), NOT the
  public sync port — so account management is never reachable through the public reverse proxy even
  if the proxy is misconfigured. Reach it from the host (`http://127.0.0.1:8081/admin`) or over an
  SSH/VPN tunnel. Override with `ADMIN_BIND_ADDR=<host:port>`. **Opt out** with `ADMIN_BIND_ADDR=merge`
  to serve `/admin` on the public port (single-port, for a trusted/all-in-one setup only).
  - **Upgrade note:** if you ran an earlier single-port build and *want* `/admin` on the public port,
    set `ADMIN_BIND_ADDR=merge`; otherwise the admin page moves to the private port automatically.

## Using your own reverse proxy

Use [`deploy/docker-compose.noproxy.yml`](../deploy/docker-compose.noproxy.yml): it runs the server
alone and binds sync to `127.0.0.1:8080` (host loopback). Bring it up with
`docker compose -f docker-compose.noproxy.yml up -d`, then point your proxy at it. Any proxy works —
just forward to the server's `:8080` **with WebSocket upgrade** for the `/api/ws` endpoint. For
example, nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

(Caddy handles the upgrade automatically, so the shipped `Caddyfile` needs no special config.)

## Trust model, stated plainly

- **Protected:** note content, passwords, and tokens are encrypted **in transit** (your TLS)
  and the data lives at rest on **your** server.
- **Not protected:** a compromised or malicious server can read your notes — there is no
  content E2EE yet. Optional client-side encryption is tracked but deferred (D0007). If that
  threat matters to you, keep the server on trusted, access-controlled infrastructure.

# Deploying SelfSync securely

SelfSync uses a **trusted-server + TLS-in-transit** model (decision D0007): your notes are
encrypted in transit to *your own* server and stored there as real files. There is **no
client-side end-to-end encryption yet**, so the server (and anyone with access to its disk)
can read your notes — run it on infrastructure you control.

The server speaks **plain HTTP/WS** and is meant to sit **behind a TLS-terminating reverse
proxy**. A ready-to-use Caddy example lives in [`deploy/`](../deploy/).

## Quick start (Caddy, automatic HTTPS)

1. Point your domain's DNS at the host.
2. Create `deploy/.env`:
   ```
   SELFSYNC_DOMAIN=sync.example.com
   SYNC_USER=admin
   SYNC_PASSWORD=<a long random password>
   ```
3. From `deploy/`: `docker compose up -d`

Caddy provisions a Let's Encrypt certificate for your domain, terminates TLS, and proxies
to the server. In the plugin's setup wizard, use `https://sync.example.com`.

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
- **Never publish the server's `:8080` port to the internet.** Only the reverse proxy's `443`
  should be public — the example does this (the server uses `expose:`, not `ports:`). Publishing
  `:8080` would bypass TLS.
- **Keep registration closed.** It defaults to closed (invite-only). Create accounts, open
  registration, or issue **single-use invite tokens** from the `/admin` page. Open registration
  lets anyone who can reach the server create an account — only do it deliberately.
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

Any proxy works — just forward to the server's `:8080` **with WebSocket upgrade** for the
`/api/ws` endpoint. For example, nginx:

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

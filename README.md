# SelfSync

A self-hosted sync for [Obsidian](https://obsidian.md): run one small server on
infrastructure you control and keep your notes, attachments, and optionally your
settings and plugins in step across every device — desktop and mobile.

It's built to feel like official Obsidian Sync, without the subscription and without the
operational weight of CouchDB-based alternatives: a **single Rust binary** you run as one
container, a **guided in-app setup**, real files on disk, and content-addressed
de-duplicated storage.

> **No end-to-end encryption yet.** Your notes are encrypted in transit by your TLS and
> stored as real files on **your** server — so run it on infrastructure you trust. See the
> [trust model](docs/deployment.md#trust-model-stated-plainly).

## Features

- **Full vault sync** — notes and attachments, any file type, byte-exact including binaries.
- **Fast, deduplicated transfer** — content-addressed chunks: an unchanged or duplicated
  file uploads nothing; only changed chunks move.
- **Automatic conflict handling** — divergent Markdown is 3-way merged; anything that can't
  be merged is kept side-by-side as a clearly-named conflict copy, so nothing is ever lost,
  and surfaced in the plugin for one-click resolution.
- **Optional settings & plugin sync** — opt in per category — core settings, hotkeys,
  appearance, snippets — and per community plugin via an allowlist. SelfSync **never** syncs
  its own folder, so one device's server credentials never overwrite another's.
- **Vault sharing** — grant another account read-only or read-write access to a vault you
  own, straight from the plugin.
- **Mobile-friendly** — works on iOS and Android; streams large files instead of buffering them.
- **Multi-device onboarding** — set up the first device with a guided wizard, then add more
  with a shareable setup link that never carries your password.

## How it works

```
 Obsidian + SelfSync plugin  ──HTTPS/WSS──►  Caddy, TLS  ──►  SelfSync server  ──►  your data volume
 desktop & mobile                                            one Rust binary       real files + chunks
```

The plugin watches your vault and reconciles changes against the server; the server keeps a
per-vault SQLite index in WAL mode and a de-duplicated chunk store, and materializes every
file on disk so your data is never locked inside a proprietary database.

## Quick start

### 1. Run the server

The server speaks plain HTTP/WS and sits behind a TLS-terminating reverse proxy. A ready-to-run
Caddy + Docker Compose example lives in [`deploy/`](deploy/):

```bash
cd deploy
cat > .env <<'EOF'
SELFSYNC_DOMAIN=sync.example.com
SYNC_USER=admin
SYNC_PASSWORD=a-long-random-password   # never leave the default
EOF
docker compose up -d
```

Caddy provisions a Let's Encrypt certificate for your domain and proxies to the server. Full
deployment, hardening, and reverse-proxy guidance — including using your own proxy — is in
[`docs/deployment.md`](docs/deployment.md).

### 2. Install the plugin with BRAT

SelfSync installs with [BRAT](https://github.com/TfTHacker/obsidian42-brat) and requires
Obsidian **1.11.0+**:

1. Install and enable **BRAT** from Obsidian's Community Plugins.
2. In BRAT: **Add beta plugin** → `williamweatherholtz/obsidian-selfsync`.
3. Enable **SelfSync** in Community Plugins.

### 3. Set up

On first enable, SelfSync opens a guided wizard: enter your server URL such as
`https://sync.example.com`, sign in, and pick or create a vault. That's it — your vault
starts syncing.

To add another device, open **Add a device** in SelfSync's settings for a setup link — server
and username only, never your password — then paste it into the new device's wizard.

## Managing your account

All from the plugin's settings tab:

- **Sharing** — **Share** on your vault lists who has access and lets you grant or revoke
  read-only or read-write access by username.
- **Change password** — rotates your password and signs out every other device, so a leaked
  password or token is self-remediable with no admin needed.
- **Settings & plugin sync** — the **Obsidian configuration** section opts categories and
  individual community plugins in or out.

Server-owner tasks — creating accounts, opening registration, issuing invite tokens, deleting
accounts — live on the private `/admin` page, by default bound to localhost only. See the
[hardening checklist](docs/deployment.md#public-exposure-hardening-checklist).

## Server configuration

Set via environment variables. See [`deploy/docker-compose.yml`](deploy/docker-compose.yml):

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_USER` / `SYNC_PASSWORD` | `admin` / `admin` | Bootstrap admin account. **Always set a strong password.** |
| `BIND_ADDR` | `0.0.0.0:8080` | Sync and login port; put it behind TLS. |
| `ADMIN_BIND_ADDR` | private, `port + 1` | Private admin surface. Set to `merge` to serve `/admin` on the public port for single-port setups only. |
| `DATA_ROOT` | `./data` | Where accounts, the ACL, chunks, and vault files live — **back this up.** |
| `REGISTRATION` | `closed` | `closed` is invite-only; `open` lets anyone register. |
| `LOG_LEVEL` | `info` | One of `error`, `warn`, `info`, `debug`. |

## Status

**1.0** — the core sync contract is implemented, tested, and hardened: integrity, durability,
conflict handling, multi-tenant isolation, config and plugin sync, and sharing. There is no
client-side end-to-end encryption yet; it is tracked and deferred — see the trust model.

## License

[MIT](LICENSE) © William Weatherholtz.

# SelfSync

Self-hosted sync for [Obsidian](https://obsidian.md). Keep your notes on a server you own,
in step across every device — desktop and mobile — without a subscription and without a
database to babysit.

> **No end-to-end encryption yet.** Your notes travel encrypted in transit by your TLS and
> rest as real files on **your** server, so run it on infrastructure you trust. See the
> [trust model](docs/deployment.md#trust-model-stated-plainly).

## The idea

You write in Obsidian across a laptop, a desktop, and a phone, and you want one vault that
follows you everywhere — on hardware you control, not someone else's cloud. The usual
self-hosted answer, obsidian-livesync, is powerful but hard to live with: a CouchDB to
operate, dozens of cryptic toggles to misconfigure, and its best conflict-merge locked behind
sponsorship.

SelfSync is the alternative. One small Rust server — a single container, its own storage, no
external database — and a lean plugin with a guided setup. Storage is content-addressed and
de-duplicated, conflict merge is real and free for everyone, and your data stays as plain
files you can read on disk.

## What using it is like

**You set it up once, then again on each device in a minute.** The first time you enable the
plugin, a wizard walks you through it: point it at your server, sign in or create an account,
pick or create a vault, and sync starts. To bring on a second device you copy a setup link —
server and username only, never your password — paste it on the new device, and your vault
downloads. Adopting an empty device is automatic; a device that already has notes asks once
whether to download, upload, or merge.

**Then it just keeps working.** An edit on one device appears on the others in about a second
over a live channel; anything you change while offline reconciles the moment you reconnect.
Large files stream to disk instead of loading whole into memory, and on a phone a single
indicator tells you the sync state at a glance — no fiddling, no status bar to hunt for.

**Nothing you write is ever lost.** Edit the same note in two places and SelfSync merges the
non-conflicting changes automatically; when two versions genuinely collide, or the file is
binary, it keeps both as a clearly-named conflict copy and flags it for a one-click choice —
it never picks a winner behind your back. Deletion is just as careful: a file is removed
locally only when the server truly recorded a deletion, never because a wrong, fresh, or
half-restored server merely lacks it. Point a full vault at an empty server by mistake and it
restores your files rather than wiping them.

**Your whole setup travels, not just the notes.** Turn on settings sync per category and per
community plugin, and your app settings, hotkeys, theme, snippets, and chosen plugins appear
on your other devices. It's additive and adjudicated: a device that opts out of a category is
never touched, one device never silently overwrites another's configuration, and when two
devices genuinely disagree about the same setting you decide which wins. SelfSync's own folder
— which holds this device's server address and login — is never synced, so no device can
overwrite another's connection or leak a credential into the vault.

**Share a vault when you want to.** Grant another account on your server read-only or
read-write access to a vault you own, straight from the plugin. A read-only guest can pull but
never push; a read-write collaborator gets the same conflict-safety you do; and a share never
exposes your other vaults or your login.

**And you run the whole thing.** The server is one container with its own storage and no DBMS
to maintain. An admin page — private by default, reachable only from the host — lets you
create accounts, manage shares, and keep registration closed or open it with single-use
invites. Everything persists to your own filesystem, durably and self-healing, with nothing
external to provision.

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

On first enable, the wizard opens: enter your server URL such as `https://sync.example.com`,
sign in, and pick or create a vault. Then open **Add a device** in settings to get the setup
link for your next device.

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

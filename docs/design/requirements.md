# Design Requirements & Use Cases — Self-Hosted Obsidian Sync

> Working name: **new-livesync** (TBD). Forward-looking design requirements for an open-source, self-hosted **drop-in replacement for Obsidian's official Sync**: an Obsidian plugin + a single **Rust** server shipped as a **Docker image**. Optimized for flawless **desktop↔mobile** sync of one user's vaults, dead-simple to run on your own hardware. Baseline/critique in `../architecture/` (esp. `90-critique-and-direction.md`, `91-benchmark-obsidian-sync.md`).

## Threat model (DECIDED 2026-07-02)

**Trusted-server / home-NAS model.** The server materializes **plaintext** vault files in a bind mount and therefore *can* read notes. Security = **TLS in transit + account auth + host disk security** (optionally OS-level at-rest encryption). This is **NOT zero-knowledge**, and **content E2EE is out of scope** (may return later as an optional per-vault "private mode," at the cost of the browsable bind mount). Rationale: the primary use is hosting on hardware the user trusts, where a browsable/backup-able on-disk vault is worth more than hiding data from oneself.

## Recorded decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Trusted server + **plaintext bind mount** (not zero-knowledge) | Enables browsable/backup-able on-disk vaults; user hosts on trusted hardware |
| D2 | **No version history** | User doesn't need it; simplifies the store (latest-state only) |
| D3 | **No P2P / WebRTC** | Dropped earlier; removes risk surface + complexity |
| D4 | **Chunked delta transfer (FastCDC)**, not whole-file | Whole-file copy (as official Sync appears to do) is wasteful; beat it on efficiency |
| D5 | **Real-time push over WebSocket + per-vault monotonic version counter** | The mechanism behind official Sync's "instant" desktop↔mobile feel; server authoritative on *ordering* |
| D6 | **Rust server, single binary, Docker image, configurable bind mount** | Dead-simple self-host; no external DB |
| D7 | **Account-based; multiple vaults per account** | User requirement |
| D8 | **Drop-in Obsidian-Sync UX via plugin** (login → auto-sync + settings) | Familiar, low-friction adoption |
| D9 | **Multi-user (multi-tenant) server** | One server can host several people (family/team), each with isolated accounts + vaults; tenants trust the host operator (who can read plaintext) |
| D10 | **Bind mount is read/backup-only in v1** (only clients originate changes) | Simpler, loop-free v1; server-side external-edit sync (FR12) deferred to v2 |
| D11 | **No TLS/reverse proxy baked into the image** — server speaks plain HTTP/WS on an internal port behind the user's own reverse proxy; ship a **docker-compose example with Caddy** | User already runs a reverse proxy; keeps the image single-purpose |
| D12 | **Fresh, lean plugin — not a fork.** Build a new Obsidian plugin reusing select proven pieces (diff-match-patch merge, chunking concepts); the original LiveSync fork is archived under `obsolete/` | LiveSync's four coexisting extension mechanisms, god-barrel `types.ts`, and dead code are a maintenance liability |

## Functional requirements

- **FR1 — Accounts & auth (multi-tenant).** Server hosts multiple user accounts (people); each account isolated. The plugin logs in with credentials and holds a per-device session token. Passwords hashed (argon2id). Optional admin/registration controls.
- **FR2 — Multiple vaults per account.** One account → many vaults; each maps to its own directory in the bind mount.
- **FR3 — Configurable bind mount as source of truth.** The server stores each vault's **current files as real plaintext files** under a configurable host path, per-tenant: `/<data-root>/<user>/<vault>/…`, always up to date, usable by external tools and backups (read/backup only in v1 — see FR12).
- **FR4 — Automatic sync.** Real-time on change + reconcile-on-connect; **offline-first** with reconcile on reconnect.
- **FR5 — Efficient transfer.** Content-defined chunking (FastCDC) + dedup; only changed blocks cross the wire; server reassembles whole files into the bind mount.
- **FR6 — Conflict handling.** Detect concurrent edits; **Markdown three-way merge** (diff-match-patch / `mergeSensibly`-class); **binaries never silently clobbered** (conflict-copy). User-configurable (auto-merge vs conflict file), à la official Sync ≥1.9.7.
- **FR7 — Settings/UX parity.** Mirror official Sync options: enable/disable, sync interval / on-save, folder & file-type include/exclude, etc.
- **FR8 — Cross-platform client.** Desktop (Win/Mac/Linux) + mobile (iOS/Android) inside the Obsidian plugin sandbox — **no Node/Electron on mobile**; browser/Capacitor APIs only.
- **FR9 — Transport & auth security.** Server speaks **plain HTTP/WS internally**; **TLS terminated by the user's external reverse proxy** (compose example with Caddy provided). Hashed credentials (argon2id); token rotation; rate limiting; per-tenant path isolation; (optional) at-rest encryption of the bind mount is a host/ops concern.
- **FR10 — Initial sync.** Efficient, **resumable** first sync in both directions (new device ← server; new vault → server).
- **FR11 — Deletion semantics.** Deletes propagate everywhere; **no resurrection** (fixes the LiveSync soft-delete class of bugs); safe for binaries.
- **FR12 — Server-side external edits (DEFERRED to v2).** Files changed directly in the bind mount (e.g. another tool, a script) are detected and synced out to clients. Requires FS-watching + self-write filtering. **v1: bind mount is read/backup-only** (only clients originate changes).

## Use cases

- **UC1 — First-time setup.** User runs the Docker image with a bind-mount volume, creates an account, logs in from the desktop plugin, points it at a folder → it uploads to the server bind mount.
- **UC2 — Add a device.** Install the plugin on mobile, log in, select an existing vault → it downloads the current files, then auto-syncs.
- **UC3 — Live edit.** Edit a note on desktop → it appears on mobile within seconds (real-time push).
- **UC4 — Offline edit + reconcile.** Edit offline on two devices → on reconnect, non-conflicting changes merge; conflicting Markdown three-way-merges; conflicting binary → conflict copy.
- **UC5 — Multiple vaults.** User syncs several distinct vaults under one account, each in its own bind-mount subdirectory.
- **UC6 — Direct server-side access.** User backs up / greps / reads the plaintext vault files directly in the bind mount. (v1: read/backup only; editing-and-sync-out is v2 per FR12.)
- **UC7 — Large file/vault.** Syncing a large vault or large note transfers only changed chunks; feasible within mobile budgets.
- **UC8 — Delete.** Delete a note on one device → gone everywhere, never resurrected.

## Non-functional requirements (the four goals, reinterpreted)

- **NFR1 — Dead simple.** One `docker run` + a volume; no external database; account/vault setup in-plugin.
- **NFR2 — Secure (trusted-server).** TLS, strong auth, host disk security; optional at-rest.
- **NFR3 — Performant.** Chunked delta; low CPU/battery; fast large-vault sync; bounded memory (no whole-file buffering).
- **NFR4 — Mobile-capable.** Works in the Obsidian mobile sandbox; **foreground-first, resumable, chunk-bounded**; respects iOS ~30s / Android background limits.

## Open items / risks (to resolve during design)

1. ~~Single-user vs multi-user server.~~ **RESOLVED: multi-user/multi-tenant (D9).** Layout `/<data-root>/<user>/<vault>`.
2. ~~Server-side external-edit watching (FR12/UC6).~~ **RESOLVED: deferred to v2 (D10);** v1 bind mount is read/backup-only.
3. **Mobile on-device spike.** Even without content E2EE, validate: chunk-hashing throughput, IndexedDB/OPFS quotas/eviction, `requestUrl`/WebSocket behavior, and background limits on real devices.
4. **Migration/import.** From existing LiveSync or official-Sync vaults (likely "just point at the folder," but worth confirming).
5. **Conflict UX parity** with official Sync (merge vs conflict-file, naming).
6. ~~Auth transport.~~ **RESOLVED: external reverse proxy terminates TLS (D11);** compose example ships Caddy. Server is plain HTTP/WS internally.

## De-scoped / not doing
- Content E2EE / zero-knowledge (per threat-model decision; possible future per-vault option).
- Version history / snapshots.
- P2P / WebRTC.
- Real-time multi-author collaboration (single-user-multi-device only → no CRDT).

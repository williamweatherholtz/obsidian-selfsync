# Design Spec — Self-Hosted Obsidian Sync ("new-livesync", working name)

> Design specification for the v1 system. Derived from `requirements.md` (decisions D1–D11), the as-built baseline (`../architecture/`), the sync-architecture research, and the official-Sync benchmark (`../architecture/91-benchmark-obsidian-sync.md`). This says *what we build and how it fits together*; the implementation plan follows separately.
>
> **One-line:** a multi-tenant **Rust** server (single binary, Docker, behind your reverse proxy) that materializes each vault as **real files in a bind mount**, plus a lean **Obsidian plugin** that syncs in real time over WebSocket + HTTP using **content-defined chunked deltas**, with **client-side three-way Markdown merge** and **conflict-copies for binaries**. No CouchDB, no version history, no P2P, no content E2EE (trusted-server model).

---

## 1. Components & topology

```
┌─────────────────────────┐        wss:// + https://        ┌──────────────────────────────┐
│  Obsidian plugin (client)│  ── control (WS) + data (HTTP) ─▶│  Reverse proxy (user's own;    │
│  desktop + mobile        │◀────  real-time push (WS)  ─────│  Caddy example) — terminates TLS│
└─────────────────────────┘                                  └───────────────┬────────────────┘
                                                                    plain HTTP/WS :8080
                                                              ┌────────────────▼────────────────┐
                                                              │  new-livesync server (Rust)      │
                                                              │  axum + tokio, single binary     │
                                                              │  ├─ auth (argon2id, tokens)      │
                                                              │  ├─ sync engine (versioned)      │
                                                              │  ├─ chunk store (blake3, refcnt) │
                                                              │  └─ SQLite index (rebuildable)   │
                                                              └──────┬───────────────────┬───────┘
                                                       bind mount (real files)      chunk store
                                                    /data/<user>/<vault>/…       /data/.chunks/…
```

- **Server:** stateless-ish Rust service; source of truth is the **bind-mount files**; a SQLite index + content-addressed chunk store accelerate sync and can be rebuilt from the files.
- **Client:** Obsidian plugin, one codebase for desktop + mobile (browser/Capacitor APIs only on mobile — no Node/Electron).
- **Transport split (deliberate):** **WebSocket = the "wake-up bell"** (auth, per-vault version subscribe, real-time "vault changed" notifications); **HTTP REST = the actual work** (manifests, chunk GET/PUT, commits). This keeps the WS channel tiny and makes every transfer independently **resumable** — critical for mobile and large vaults, and it fixes LiveSync's all-or-nothing/restart-on-gap fragility by construction.

---

## 2. Server data model

**Bind mount (truth):** `/<data-root>/<user>/<vault>/<relative-path>` — real plaintext files, always current.

**Chunk store (transfer/dedup cache):** `/<data-root>/.chunks/<aa>/<hash>` — content-addressed (blake3) chunk blobs, refcounted. Deduplicated **per vault** in v1 (simpler; per-tenant later). Rebuildable by re-chunking the files.

**SQLite index** (`/<data-root>/index.db`; rebuildable from files + chunks):
- `users(id, username UNIQUE, pw_hash, created_at, role)` — role ∈ {admin,user}.
- `devices(id, user_id, name, token_hash, created_at, last_seen)`.
- `vaults(id, user_id, name, version INTEGER)` — `version` = per-vault monotonic counter.
- `files(vault_id, path, file_hash, size, mtime, deleted BOOL, version_updated)` — current manifest; `version_updated` = vault version at last change (drives "changes since Vc").
- `file_chunks(vault_id, path, seq, chunk_hash)` — ordered chunk list per file.
- `chunks(vault_id, hash, size, refcount)` — GC when refcount → 0.
- `deletions(vault_id, path, version)` — tombstone log; prunable below the min device cursor.

**Why this is safe where LiveSync wasn't:** with **no version history and no conflict-leaves on the server** (conflicts are resolved to a single winner *before* commit), a chunk is live **iff** referenced by a current non-deleted file. Refcount GC is then trivially correct — the hazard that made LiveSync's chunk-GC and soft-delete dangerous doesn't exist here.

---

## 3. Content addressing & chunking

- **Chunking:** FastCDC (Rust `fastcdc` crate; JS/WASM on the client) — min/avg/max ≈ 16/64/256 KiB (tunable; most notes are a single chunk, so dedup mainly benefits large notes/attachments and near-duplicate files). Chosen over LiveSync's Rabin-Karp per the research (~10× faster, +10–20% dedup, boundary-shift-proof).
- **Hashing:** **blake3** for both chunk IDs and whole-file hashes (fast, strong, parallel; not used as a security primitive — it's a content address).
- **File identity:** `file_hash` = blake3 of full content → O(1) change detection; `chunk list` = ordered blake3 chunk IDs → delta transfer.

---

## 4. Sync protocol

### 4.1 Auth & session
- `POST /api/login {username, password}` → `{token}` (random 256-bit; stored server-side as a hash; per device). argon2id verify. Rate-limited.
- All subsequent calls: `Authorization: Bearer <token>`. Token rotation + expiry; `POST /api/logout`.
- `GET /api/vaults` → the caller's vaults; `POST /api/vaults {name}` → create.

### 4.2 WebSocket (control / notifications)
- `GET /api/ws` (upgraded). After auth, client sends `subscribe {vault_id, version}` per vault.
- Server → client push: `changed {vault_id, version}` whenever the vault advances (from *another* device's commit). The client reacts by running a REST pull (§4.3). WS carries **no file data** — just the bell.
- Heartbeat/ping; on reconnect the client re-subscribes with its last known version (resumable).

### 4.3 Pull (server → client), REST
1. `GET /api/vaults/{id}/changes?since={Vc}` → `{ version: Vs, upserts:[{path, file_hash, size, mtime, chunks:[hash…]}], deletes:[{path}] }`.
2. Client computes, per upsert, which `chunk` hashes it lacks locally → `POST /api/vaults/{id}/chunks/missing {hashes:[…]}` → `{missing:[…]}` (or client just GETs and 404-skips those it has).
3. `GET /api/vaults/{id}/chunk/{hash}` → chunk bytes (served from the content-addressed chunk store; the recompute-from-files mode is a §9.7 option). Cacheable, range-able.
4. Client reassembles files locally and applies them (see §5 reconcile), then records the new base = `Vs`.

### 4.4 Push (client → server), REST
1. Client chunks each locally-changed file; `POST …/chunks/missing` to learn which to upload; `PUT …/chunk/{hash}` for each missing chunk (idempotent by hash; refcount handled at commit).
2. `POST /api/vaults/{id}/commit { changes:[{path, op:upsert|delete, file_hash, chunks:[…], mtime, base_hash}] }`.
   - **Optimistic concurrency:** server checks each change's `base_hash` against the current `files.file_hash`. If equal (or file absent for a create) → apply. If different → that entry is **rejected as a conflict** and returned in the response; the client resolves (§5) and re-commits.
   - Applied changes: write/replace/delete the file in the bind mount, update `files`/`file_chunks`, adjust chunk refcounts (GC at 0), append to `deletions` for deletes, **bump `vaults.version`** once per commit, then WS-`changed`-notify other devices.
   - Server serializes commits per vault (per-vault async lock) so the version counter and manifest stay consistent.

### 4.5 Initial sync (resumable, chunk-bounded)
- **New vault → server:** client walks the vault, pushes changes in batches; interrupted → resume by re-diffing local vs `GET …/changes?since=0`. Idempotent.
- **New device ← server:** pull manifest, fetch missing chunks, reassemble. Interrupted → resume by re-diffing. No all-or-nothing; each chunk/file is independent.

---

## 5. Conflict & delete semantics

**Base = the client's last-synced content.** Every client keeps, per file, the last-synced `file_hash` (+ recoverable content via its local chunk cache). This is the common ancestor — so **three-way merge needs no server-side history** (the "no version history" decision costs us nothing here).

**Reconcile decision (per path), on pull or on a rejected commit:**
| Local vs base | Remote vs base | Action |
|---|---|---|
| unchanged | changed | **Fast-forward:** apply remote. |
| changed | unchanged | **Push:** upload local (commit). |
| unchanged | unchanged | No-op. |
| changed | changed | **Conflict** → resolve by type ↓ |

**Conflict resolution (client-side):**
- **Markdown (`.md`):** three-way merge (`base`, `local`, `remote`) using diff-match-patch / LiveSync's `mergeSensibly` (kept — validated by research and matches official Sync). Clean merge → write + commit. Unmergeable region or **base unavailable** → fall back to conflict-copy.
- **Everything else (binary, canvas, JSON, PDFs, images):** **conflict-copy** — keep the remote as the canonical file and write the local as `name (conflict <device> <YYYYMMDDHHmm>).ext` (or vice-versa, deterministic), then commit both. **Never silently clobber.** (JSON key-merge is a v2 nicety.)
- User-configurable per official Sync ≥1.9.7: **auto-merge** (default, markdown) vs **always conflict-file**.

**Deletes:**
- Delete carries `base_hash`. If the server's file is unchanged since base → delete (remove from bind mount, `deletions` += version, decref chunks). Propagates to other devices via `changes.deletes`.
- **Delete-vs-edit conflict → edit wins (content preserved), with a user notice.** We never lose edited content to a concurrent delete; the user can re-delete. (Directly avoids the LiveSync resurrection/data-loss dilemma — the decision is explicit and safe, not an mtime coin-flip.)
- A client applying a remote delete while holding a local edit uses the same edit-wins rule locally.

---

## 6. Client (Obsidian plugin)

**A fresh, lean plugin** that borrows specific proven pieces from LiveSync (the `diff-match-patch` merge; chunking concepts; the `ServiceHub`/platform-adapter *idea*) rather than forking its codebase — the critique found four coexisting extension mechanisms, a god-barrel `types.ts`, and heavy dead code that would be a liability to carry. *(DECIDED 2026-07-02: fresh plugin; the original fork is archived under `obsolete/`.)*

- **Local sync-state store:** per vault, per file → `{base_hash, chunk map, mtime}`; a small local chunk cache to reconstruct base content for merges. **OPFS (sync-access-handle in a Worker) preferred; IndexedDB fallback** (both proven in the mobile WebView; IndexedDB is ITP-eviction-exempt inside the app, `localStorage` is out at ~10 MiB). Vault files themselves live in the Obsidian vault via the `DataAdapter`/`Vault` API. **Caveat (spike): `readBinary` loads a whole file into memory with no byte-range/streaming API** → guard large attachments with a size threshold rather than assuming partial reads.
- **Engine:** watch vault events (debounced) → chunk changed files → push; handle WS `changed` → pull; run reconcile (§5). All chunking/hashing via WASM (blake3 + FastCDC) — **no Node/Electron**, and **no content crypto on mobile** (E2EE is out), removing the biggest mobile-CPU risk.
- **UX (drop-in Obsidian-Sync feel):** Settings → server URL + login → pick/enable vaults → auto-sync toggle + options (sync-on-save/interval, include/exclude globs, conflict strategy). Status indicator; conflict notices.
- **Mobile posture (spike-confirmed):** **foreground-ONLY** — not merely foreground-first. iOS WKWebView halts all plugin JS when backgrounded and Obsidian exposes no background-task bridge, so sync runs only while Obsidian is open (on launch, on foreground-return, and on in-app file changes); every step is idempotent/resumable so a mid-sync background/lock is safe to resume. **Transport on mobile:** prefer `fetch` + permissive CORS to our own server (streaming, no size limit) — *verify on-device that Obsidian mobile permits `fetch`/WebSocket to our origin*; fall back to `requestUrl` with small per-chunk requests (it can't stream and struggles past ~20–50 MB, so never move whole large files in one request — our chunked protocol already avoids this).

---

## 7. Server tech & packaging

- **Stack:** Rust — `axum` + `tokio` (+ `tokio-tungstenite` for WS), `rusqlite`/`sqlx` (SQLite), `fastcdc`, `blake3`, `argon2`, `tower`/`tower-http` (auth, rate-limit, body limits). Single static binary.
- **Config (env/flags):** `DATA_ROOT` (bind mount), `BIND_ADDR` (default `0.0.0.0:8080`, plain HTTP/WS), `DB_PATH`, `REGISTRATION` (`open`|`invite`|`closed`), chunk params, size limits.
- **Image:** distroless/debian-slim; runs as non-root; the only volume is `DATA_ROOT`.
- **No TLS in-app** (D11) — plain HTTP/WS behind the reverse proxy.

---

## 8. Deployment (compose + Caddy example)

Reference `docker-compose.yml` (the user's real proxy can replace Caddy — just proxy to `:8080` **with WebSocket upgrade**):

```yaml
services:
  new-livesync:
    image: ghcr.io/<org>/new-livesync:latest
    environment:
      DATA_ROOT: /data
      BIND_ADDR: 0.0.0.0:8080
      REGISTRATION: invite
    volumes:
      - /srv/obsidian-vaults:/data      # ← configurable bind mount (real vault files live here)
    restart: unless-stopped

  caddy:                                 # EXAMPLE ONLY — omit if you have your own proxy
    image: caddy:2
    ports: ["443:443", "80:80"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on: [new-livesync]
volumes: { caddy_data: {} }
```

`Caddyfile` (automatic HTTPS; WS upgrade is transparent in Caddy):
```
sync.example.com {
    reverse_proxy new-livesync:8080
}
```

Docs will also show: "already have a proxy? Point it at the container's `:8080` and allow WebSocket upgrades on `/api/ws`."

---

## 9. Open decisions & risks (to resolve before/within implementation)

1. ~~Fresh plugin vs fork LiveSync (§6).~~ **DECIDED 2026-07-02: fresh, lean plugin reusing select libs; the original LiveSync fork is archived under `obsolete/`.**
2. ~~Mobile on-device spike.~~ **DONE (qualitative) — see `spikes/mobile-spike-findings.md`.** Feasibility confirmed (LiveSync ships the same primitives); four design-changing constraints folded in (foreground-only sync; `readBinary` whole-file memory; `requestUrl` large-transfer limits → `fetch`+CORS preferred; OPFS/IndexedDB cache). **Remaining = quantitative:** run the on-device benchmark (published Artifact / `spikes/mobile-benchmark.html`) for chunking/hash/crypto/storage MB/s + `readBinary` OOM ceiling, and confirm `fetch`/WS-to-our-origin works from Obsidian mobile.
3. **Path normalization** across Windows/macOS/Linux/mobile (case sensitivity, Unicode NFC/NFD, illegal chars) — a real cross-platform correctness area; define a canonical path form.
4. **FastCDC parameters** for markdown-heavy vaults (small files) — tune min/avg/max; consider a whole-file fast-path below a threshold.
5. **Registration/onboarding** for multi-tenant (open vs invite vs admin-creates) and account recovery.
6. **Migration/import** from official Sync or LiveSync (likely "point the plugin at the existing folder and let initial sync run").
7. **Chunk-store disk** (materialized files + chunk cache ≈ up to ~2× before dedup). Acceptable for v1; offer a "no chunk cache, recompute-on-serve" mode later if disk-constrained.

## 10. v1 scope vs later
- **v1:** multi-tenant server; accounts + multiple vaults; bind-mount materialization (read/backup only); WS push + REST pull; FastCDC chunked delta + dedup; markdown three-way merge + binary conflict-copy; safe deletes; resumable initial sync; desktop + mobile plugin; compose + Caddy example.
- **Later:** server-side external-edit watching (FR12); JSON key-merge; optional per-vault E2EE "private mode"; advanced selective-sync; per-tenant chunk dedup; LAN acceleration.

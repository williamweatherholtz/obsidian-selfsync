# End-to-End Testing Process

> How we verify the self-hosted Obsidian sync system works, end to end, before calling a milestone done. Repeatable per milestone. Harness: `scripts/e2e.sh`.

## Why a process (not ad-hoc)

E2E recurs at every milestone (M1…M6), and the most valuable checks — real files syncing between two real Obsidian vaults through the real server — can't be fully automated headlessly (Obsidian is a GUI app). So this process splits E2E into layers, automates everything automatable, and gives the human a fixed, low-friction checklist for the rest.

## Layers

| Layer | What | How | Automated? |
|-------|------|-----|:---:|
| **L1 — Unit / logic** | Pure sync logic (`pull`/`pushLocal`), protocol types | `client` vitest | ✅ CI-able |
| **L2 — Server protocol integration** | Real axum server over real HTTP+WS: auth, changes/get/put/delete, WS push, **two-client propagation**, large-file (>2 MB) | `server` `cargo test` (spawns the app on a real port, drives it with reqwest + a WS client) | ✅ CI-able |
| **L3 — Obsidian GUI integration** | Two real Obsidian vaults ↔ the running server: create/edit/delete/rename propagation, initial sync, bind-mount truth | **Manual** (this doc's checklist), staged by `scripts/e2e.sh` | ⚠️ Manual |
| **L4 — On-device mobile** (future) | Plugin inside Obsidian mobile (iOS/Android) | On-device (see `spikes/mobile-benchmark.html`) | ⚠️ Manual, M5 |

**Gate rule:** L1 + L2 must be green (`scripts/e2e.sh` aborts if not) before doing L3. A milestone is "done" only after L1+L2 green **and** the L3 checklist passes for that milestone's scenarios.

## Running it

**Windows / PowerShell** (native — sets env vars correctly, and by default starts the server for you):

```powershell
./scripts/e2e.ps1            # build + L1/L2 tests + stage two vaults + start server
./scripts/e2e.ps1 -Clean     # also reset server data + vault notes to empty
./scripts/e2e.ps1 -NoServe   # set everything up but don't start the server
./scripts/e2e.ps1 -SkipTests # build + stage only
```

**macOS / Linux / git-bash**:

```bash
bash scripts/e2e.sh          # build + L1/L2 tests + stage two vaults (prints server cmd)
bash scripts/e2e.sh --clean  # also reset server data + vault notes to empty
```

> On PowerShell, do **not** use the bash inline-env form (`DATA_ROOT=... cargo run`) — that's a bash-ism. Set env vars first: `$env:DATA_ROOT='...'; $env:BIND_ADDR='127.0.0.1:8789'; $env:SYNC_USER='admin'; $env:SYNC_PASSWORD='admin'; cargo run` (the `.ps1` does this for you, or prints it under `-NoServe`).

Both harnesses build the server + plugin, run L1/L2, then stage `.e2e/vaultA` and `.e2e/vaultB` (gitignored) each with the plugin installed **and pre-configured** (server URL + admin/admin seeded, plugin marked enabled). The server materializes files at `.e2e/data/vault/`.

> **Ports (learned the hard way):** the dev server binds **`127.0.0.1:8789`**, not `localhost:8080`. Port **8080 is commonly held by Docker Desktop / WSL**, and on Windows `localhost` resolves to IPv6 `::1` first — so `http://localhost:8080` from the plugin hit Docker's proxy and returned `405`. Using `127.0.0.1` forces IPv4 and `8789` sidesteps the collision. (Production, behind a reverse proxy, still binds `0.0.0.0:8080` per the design spec.)

### Headless full-stack E2E (no Obsidian) — the primary automated gate

`client/test/e2e.spec.ts` (runs under `npx vitest run`) spawns the real server binary and drives **two real sync clients** — the actual `sync.ts` engine + a Node HTTP transport + real files on disk — asserting create/edit/delete/large-file propagation and the bind-mount. This exercises the whole stack (server + protocol + client engine) **without Obsidian**, so most regressions are caught automatically; the manual L3 GUI pass is only needed to verify the thin Obsidian glue (`requestUrl` transport + vault-adapter I/O). It skips itself if the server binary isn't built (or targets `SYNC_SERVER_URL` if set — see the Docker compose).

## Manual scenarios (L3 checklist)

Start the server + open both vaults (harness prints exact commands). Then:

| # | Scenario | Steps | Expected (pass) |
|---|----------|-------|-----------------|
| S1 | **Create → propagate** | In vault A create `n1.md` = "hello from A" | Within ~1–2 s `n1.md` appears in vault B with same content; `.e2e/data/vault/n1.md` exists on disk with that content |
| S2 | **Edit → propagate** | Edit `n1.md` in vault B → "edited in B" | Change reflects in vault A within ~1–2 s; disk file updated |
| S3 | **Delete → propagate** | Delete `n1.md` in vault A | `n1.md` disappears in vault B and from `.e2e/data/vault/` |
| S4 | **Rename → propagate** | Create `r.md`, let it sync, then rename to `r2.md` in vault A | Vault B ends with `r2.md` (not `r.md`); disk shows `r2.md` only |
| S5 | **Initial upload of existing content** | Stop server; put a few `.md` files directly in vault A (or use `--clean` then add files before connecting); start server + connect A | All pre-existing A files upload to the server and appear in vault B |
| S6 | **New device pulls everything** | With content on the server, connect vault B fresh (or `--clean` B only) | Vault B downloads the full current set of notes |
| S7 | **Large file (>2 MB)** | Create a markdown note >2 MB in vault A (regression for the body-limit fix) | Syncs to B without a 413/error |
| S8 | **Bind mount is real truth** | `grep`/open files under `.e2e/data/vault/` | Files are the actual current note contents (browsable, backup-able) |
| S9 | **No echo loop** | After any propagation, watch the console/logs | Content settles; no runaway pull→push→pull chatter on unchanged content |

Record results (pass/fail + notes) in `docs/design/plans/mN-e2e-results.md` for the milestone under test.

## Known caveats while testing (M1)

Test **markdown/text only** — binary attachments are M2 (would corrupt today). Conflicts resolve **last-write-wins** with no merge yet (M3). Sync is **foreground-only** on mobile (M5). Deletions/version are **not persisted across a server restart** yet (M4) — don't restart the server mid-scenario when testing deletes. Full list: `docs/design/plans/m1-e2e-results.md`.

## How this process grows per milestone

- **M2 (chunking + binary):** add L2 assertions for chunk dedup/delta; add L3 scenarios for binary attachments (images/PDFs) round-tripping intact, and large-vault/large-file transfer efficiency.
- **M3 (conflict/merge):** add L3 scenarios for concurrent offline edits to the same note → three-way Markdown merge (not LWW); binary conflict-copy; delete-vs-edit safety.
- **M4 (durable persistence + multi-tenant):** add scenarios for server restart mid-delete (no resurrection), multiple accounts/vault isolation.
- **M5 (mobile):** promote L4 — run the plugin in Obsidian mobile against the server; verify foreground sync, resumable initial sync, and the on-device benchmark budget.
- **M6 (packaging):** add a scenario that runs the whole thing via `docker compose` + a reverse proxy over TLS.

# M1 walking skeleton — end-to-end verification results

**Date:** 2026-07-03

## What M1 delivered

- **Server** (`server/`): a Rust/axum HTTP + WebSocket service with token login
  (`POST /api/login`), a files-as-truth vault (`PUT`/`GET`/`DELETE
  /api/vault/file`, `GET /api/vault/changes?since=`), and a WebSocket
  (`/api/ws?token=`) that pushes a `{"type":"changed",...}` notification to
  connected clients when the vault changes.
- **Plugin** (`client/`): an Obsidian plugin (`sync.ts` + supporting modules)
  that talks to the server over the same HTTP/WS API, builds clean, and is
  unit-tested.

## Server + protocol: verified programmatically (automated)

The full client-server-client propagation path — the substance of what Task
12 asked to prove manually — is instead verified end-to-end through the real
server and real protocol via `cargo test` integration tests in
`server/tests/sync.rs`:

- `login_issues_token_and_rejects_bad_creds` — auth issues a bearer token for
  valid creds and rejects bad ones (401).
- `put_get_changes_delete_roundtrip` — a single client's PUT is readable via
  GET, appears in `changes`, and DELETE removes it (subsequent GET 404s).
- `ws_notifies_on_put` — a connected WebSocket client receives a `"changed"`
  push notification when another request PUTs a file.
- `two_client_propagation` (new, this task) — proves the full two-client
  scenario the brief's manual steps describe, using two independently
  logged-in tokens (A and B, standing in for two devices/vaults sharing one
  server):
  1. Client A opens a WebSocket. Client B `PUT`s `shared/note.md` = `from B`.
  2. Client A's WS receives a `"changed"` frame within 2s (real push, not a
     mock).
  3. Client A then independently pulls `GET /api/vault/changes?since=0` and
     confirms `shared/note.md` is listed, and `GET /api/vault/file` returns
     the actual bytes `from B` — i.e. A can see and read what B wrote, not
     just that *something* changed.
  4. Client B `DELETE`s the file (200). Client A's WS receives a second
     `"changed"` push, A's `changes` since the file's put-version lists it
     under `deletes` (and no longer under `upserts`), and a direct `GET` by A
     now 404s.

This exercises the same server binary, the same HTTP/WS wire protocol, and
the same vault-on-disk storage the plugin uses — the only thing it does not
exercise is the Obsidian GUI/vault-file-watcher wiring on the client side.

**Final `cargo test` result (server/):** `9 passed; 0 failed` — the 8
pre-existing tests in `server/tests/sync.rs` (including the 3 named above)
plus the new `two_client_propagation`.

## Manual Obsidian verification (still required — needs a GUI, do this on your machine)

The plugin's Obsidian-side wiring (vault file-watcher → sync.ts → server, and
server push → applying a file into the real vault) cannot be exercised
headlessly and still needs a human pass with two real vaults:

1. **Build the plugin:**
   ```bash
   cd client && npm run build
   ```
2. **Install into two test vaults.** For each of two local Obsidian vaults
   `VaultA` and `VaultB`:
   ```bash
   mkdir -p "<VaultX>/.obsidian/plugins/new-livesync"
   cp client/main.js client/manifest.json "<VaultX>/.obsidian/plugins/new-livesync/"
   ```
3. **Start the server:**
   ```bash
   cd server && DATA_ROOT=./e2e-data SYNC_USER=admin SYNC_PASSWORD=admin cargo run
   ```
4. **Enable + configure the plugin** in each vault: Community Plugins → enable
   "New LiveSync" → set Server URL `http://localhost:8080`, username/password
   `admin`/`admin`.
5. **Verify create + real-time propagation:** in VaultA, create `hello.md`
   with text `from A`. Within a second or two it should appear in VaultB (WS
   `changed` → pull). Confirm `server/e2e-data/vault/hello.md` exists on disk
   with `from A`.
6. **Verify edit + delete propagation:** edit `hello.md` in VaultB → the
   change reflects in VaultA and on disk. Delete it in VaultA → it disappears
   from VaultB and from `server/e2e-data/vault/`.
7. **Verify the bind mount is real:** `cat server/e2e-data/vault/hello.md`
   (before deletion) shows the current content — confirming files-as-truth,
   not an opaque DB blob.
8. **Watch for (and note if seen):** echo loops (a server-driven write
   causing the plugin to treat its own applied change as a new local edit
   and re-PUT it), or missed events (a WS drop that isn't caught by a
   subsequent poll/reconnect).

## Known M1 limitations (by design)

- **Whole-file transfer** — no chunking/delta sync yet; every PUT sends the
  full file body. Chunking is deferred to M2.
- **Last-write-wins, no merge** — concurrent edits from two clients are
  resolved by whichever PUT lands last; there is no conflict detection or
  three-way merge. Proper conflict handling is deferred to M3.
- **Deletions and version state are not persisted across a server restart**
  — the vault's change log/version counter is in-memory only. Durable
  persistence is deferred to M4.
- **Sync is foreground-only on mobile** — there is no background sync
  process; the plugin only syncs while Obsidian is running and active.
- **Echo suppression is content-equality based** — the plugin's guard
  against re-uploading a server-applied change compares content, not a
  base/version handshake, so it is best-effort (Obsidian may still fire a
  spurious local `modify` event after a server-driven write). Full
  base/version-aware echo handling is deferred to M3.

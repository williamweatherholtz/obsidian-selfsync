# Peer-to-Peer (WebRTC) Sync

> As-built reverse-engineering baseline for critique. Read-only analysis of
> `src/features/P2PSync/` plus the boundary into `src/lib/src/replication/trystero/`
> and `src/lib/src/rpc/transports/`. The `src/lib` internals (RPC framing, the
> Nostr/Trystero binding internals, `replicateShim`) are owned by the commonlib
> agent; this document describes the P2P sync *model* and the feature-layer glue,
> and marks the boundary explicitly where it defers to commonlib.

## Purpose & responsibilities

The P2P Sync feature is a **CouchDB-free backend alternative**: instead of every
device replicating against a shared CouchDB server over HTTP, devices connect
**directly to each other over WebRTC** and replicate PouchDB-to-PouchDB across
that data channel. It exists to let two or more Obsidian vaults stay in sync
with **no self-hosted or cloud CouchDB** — the only shared infrastructure is a
lightweight *signalling* relay (Nostr WebSocket relays) used to bootstrap the
WebRTC connection, plus optional TURN servers for NAT traversal. No note data
transits the relay.

The `src/features/P2PSync/` directory contains **only the Obsidian-side UI and
lifecycle glue** — panes, modals, a menu, and the wiring that registers views
and commands. All of the actual P2P/replication logic lives in
`src/lib/src/replication/trystero/` (the `LiveSyncTrysteroReplicator` and its
`TrysteroReplicator` / `P2PHost` collaborators). The feature layer's
responsibilities are:

- Register two Obsidian views: the **P2P Status** pane (primary, new UI) and the
  **P2P Replicator** pane (labelled "Old UI").
- Register commands ("Replicate now by P2P", "P2P: Sync with targets", open
  panes) and a ribbon icon.
- Provide the **`openReplicationUI` / `openRebuildUI` factories** — Obsidian
  modal callbacks the headless replicator invokes when it needs a human to pick
  a peer (dependency-injected so the CLI/headless build can omit them).
- Render peer discovery/acceptance/watch/sync state and translate button clicks
  into `LiveSyncTrysteroReplicator` method calls.

The feature is explicitly **experimental** — the pane header renders the i18n
string `P2P.Note.important_note_sub`: *"This feature is still on the bleeding
edge. Please be aware that ensure your data is backed up before using this
feature."* (`en.json:559`).

## Files & LOC (table)

All files live under `src/features/P2PSync/P2PReplicator/`.

| File | LOC | Kind | Role |
|------|----:|------|------|
| `P2PServerStatusPane.svelte` | 891 | Svelte | **Primary "P2P Status" pane** — signalling status, per-peer accept/deny/watch/sync controls, active-remote picker |
| `P2PReplicatorPane.svelte` | 502 | Svelte | **"Old UI" replicator pane** — connection settings form (non-Obsidian), peer list, broadcast toggle |
| `P2POpenReplicationPane.svelte` | 313 | Svelte | Modal body — lists peers, Sync / Sync&Close / rebuild buttons |
| `P2PServerStatusCard.svelte` | 309 | Svelte | Reusable signalling-status card (connection, peer id, room suffix, diag stats, broadcast/diag toggles) |
| `PeerStatusRow.svelte` | 258 | Svelte | One peer row in the Old-UI table (chips, accept/deny/revoke, sync/watch, "..." menu) |
| `P2PReplicatorPaneView.ts` | 195 | TS | Obsidian `ItemView` for the Old-UI pane; builds the per-peer context menu; applies remote config |
| `P2PReplicationUI.ts` | 131 | TS | `createOpenReplicationUI` / `createOpenRebuildUI` factories (bidirectional pull-then-push; rebuild = pull-only) |
| `P2POpenReplicationModal.ts` | 80 | TS | Obsidian `Modal` wrapper that mounts `P2POpenReplicationPane` |
| `P2PServerStatusPaneView.ts` | 43 | TS | Obsidian `ItemView` for the Status pane |
| **Total** | **2722** | | |

Closely related glue (outside the feature dir, in scope as the boundary):

| File | Role |
|------|------|
| `src/serviceFeatures/useP2PReplicatorUI.ts` | ServiceFeature that registers both views, commands, ribbon; constructs `P2PLogCollector`; opens the status pane on layout-ready (Obsidian only) |

## Key types / data structures

Defined in `src/lib` (boundary — commonlib owns them), consumed throughout the feature:

- **`LiveSyncTrysteroReplicator`** (`LiveSyncTrysteroReplicator.ts`) — the object
  the UI holds. Extends `LiveSyncAbstractReplicator` (the same base class the
  CouchDB replicator implements), so it plugs into the plugin's generic
  replicator slot. Owns a `P2PHost` (`_p2pHost`) and a `TrysteroReplicator`
  (`_replicator`).
- **`TrysteroReplicator`** (`TrysteroReplicator.ts`) — the sync engine: RPC
  command table, `replicateFrom`, `requestSynchroniseToPeer`, `sync`, live
  `enableBroadcastChanges`, watch set, tweak-value check.
- **`P2PHost` = `TrysteroReplicatorP2PServer`** (`TrysteroReplicatorP2PServer.ts`)
  — the room/signalling layer: joins the Trystero room, tracks advertisements,
  peer acceptance decisions, serves RPC objects, exposes diagnostics.
- **`Advertisement`** = `{ peerId, name, platform }` (`types.ts`) — the discovery
  beacon each device broadcasts on the "ad" action.
- **`PeerInfo`** = `Advertisement & { isAccepted, isTemporaryAccepted }`.
- **`P2PServerInfo`** = `{ isConnected, knownAdvertisements: PeerInfo[],
  serverPeerId, roomId, diag: DiagRTCStats }` — the payload of `EVENT_SERVER_STATUS`,
  the main state object the panes render.
- **`P2PReplicatorStatus`** = `{ isBroadcasting, replicatingTo[], replicatingFrom[],
  watchingPeers[] }` — payload of `EVENT_P2P_REPLICATOR_STATUS`.
- **`P2PReplicationReport`** — per-peer fetching/sending progress (`EVENT_P2P_REPLICATOR_PROGRESS`).
- **`PeerStatus`** / **`AcceptedStatus`** / **`ConnectionStatus`**
  (`P2PReplicatorPaneCommon.ts`) — the Old-UI view model derived in
  `P2PReplicatorPane.svelte`.
- **`AcceptanceDecision`** = `{ peerId, name, decision, isTemporary }` and
  **`RevokeAcceptanceDecision`** = `{ peerId, name }` — the accept/deny verbs the
  panes send via `makeDecision` / `revokeDecision`.
- **P2P settings** (`setting.type.ts:551-619`): `P2P_Enabled`, `P2P_relays`
  (comma-separated Nostr relay WSS URLs), `P2P_roomID`, `P2P_passphrase`,
  `P2P_AppID`, `P2P_AutoStart`, `P2P_AutoBroadcast`, `P2P_turnServers`,
  `P2P_useDiagRTC?`, `P2P_AutoAccepting` (`AutoAccepting` enum), `P2P_AutoAcceptingPeers`,
  `P2P_IsHeadless?`, plus (referenced in the feature) `P2P_AutoSyncPeers`,
  `P2P_AutoWatchPeers`, `P2P_SyncOnReplication`, `P2P_ActiveRemoteConfigurationId`,
  `P2P_RebuildFrom`. Device name is stored separately as a "small config" under
  `SETTING_KEY_P2P_DEVICE_NAME`.

Communication between the `src/lib` layer and the Svelte panes is entirely via
the global `eventHub` (see the event constants exported from
`TrysteroReplicatorP2PServer.ts`): `EVENT_SERVER_STATUS`,
`EVENT_P2P_REPLICATOR_STATUS`, `EVENT_P2P_REPLICATOR_PROGRESS`,
`EVENT_REQUEST_STATUS`, `EVENT_ADVERTISEMENT_RECEIVED`, `EVENT_P2P_CONNECTED`,
`EVENT_P2P_DISCONNECTED`, `EVENT_DEVICE_LEAVED`. The feature layer subscribes to
these in `onMount` and pushes commands back by calling replicator methods.

## P2P model & data flow (DEEP)

### 1. Discovery & signalling (how peers find each other)

There is **no application server**. Bootstrapping uses **Trystero over Nostr**
(`@trystero-p2p/nostr`). `TrysteroReplicatorP2PServer.start()` builds room
options via `generateJoinRoomOptions(settings)` (`trysteroUtils.ts`) and calls
`joinRoom(options, roomId, { handshakeTimeoutMs: 30000, ... })`.

Room-join options (`trysteroUtils.ts`):

- **`appId`** ← `P2P_AppID` (default `"self-hosted-livesync"`).
- **`password`** ← a short base-36 hash of `P2P_passphrase` (`mixedHash`). This
  is the Trystero room password; it encrypts the signalling handshake and
  namespaces the room, so only devices with the same passphrase can pair.
- **`relayConfig.urls`** ← comma-split `P2P_relays` (Nostr WSS relays;
  `manualReconnection: true`). These relays are the **signalling channel** — they
  ferry WebRTC SDP offers/answers and ICE candidates between peers. The default
  relay button inserts `wss://exp-relay.vrtmrz.net` (the plugin author's relay).
- **`turnConfig`** ← optional `P2P_turnServers` (+ username/credential) for TURN
  relaying when direct/STUN NAT traversal fails.
- **`rtcPolyfill`** ← the platform `RTCPeerConnection`, or a diagnostic wrapper
  (`createDiagRTCPeerConnectionConstructor`) when `P2P_useDiagRTC` is set (feeds
  the "Stats" grid in `P2PServerStatusCard`).

The `roomId` argument is `P2P_roomID` (a user-chosen string; `generateP2PRoomId()`
can mint a random one). Devices sharing **appId + password(passphrase) + roomId**
land in the same Trystero room and WebRTC-connect to each other.

Once WebRTC connectivity is up, `onAfterJoinRoom()` creates typed data-channel
actions via `room.makeAction(...)`:

- **`"ad"`** — advertisements. On `room.onPeerJoin`, the server calls
  `sendAdvertisement(peerId)` sending `{ peerId, name, platform }`; on receipt,
  `onAdvertisement` populates `_knownAdvertisements` and emits
  `EVENT_ADVERTISEMENT_RECEIVED` + `EVENT_SERVER_STATUS`. This is how the panes
  learn "which devices are here right now." Note the periodic re-broadcast timer
  is **commented out** — advertisement is join-triggered only.
- **`"rpc2"`** — the RPC transport (an `RpcRoom` with `TRYSTERO_RPC_DEFAULTS`),
  used for all data-plane calls. `canAcceptRequest` gates every method except
  `!reqAuth` behind `isAcceptablePeer`.

`selfId` (from Trystero) is this device's `serverPeerId`. Peer identity for
*acceptance* is keyed by **device name** for permanent decisions and by **peerId**
for session decisions (see below).

### 2. Connection acceptance (trust gate)

Discovery does not imply trust. `isAcceptablePeer(peerId)` resolves in order:
temporary (session) decision by peerId → stored permanent decision by name →
regex allow-list `P2P_AutoAcceptingPeers` / deny-list `P2P_AutoDenyingPeers` →
if headless (`P2P_IsHeadless`) deny → otherwise prompt the user
(`confirmUserToAccept`, a 4-option dialog: Accept / Ignore / Accept Temporarily /
Ignore Temporarily, 30s timeout). Permanent decisions persist in a
`StoredMapLike` (`p2p-device-decisions`). The panes drive this via `makeDecision`
/ `revokeDecision`; `P2PServerStatusPane.svelte` exposes PERMANENT and SESSION
accept/deny buttons, `PeerStatusRow.svelte` the "Accept / Accept in session /
Deny / Revoke" buttons.

### 3. Sync exchange (how replication happens with no server)

The trick: **each device serves its local PouchDB over RPC**, and the other
device runs an ordinary PouchDB replication against that *proxied* remote DB.

- `startService()` binds a **hosting DB** (`createHostingDB`, `ProxiedDB.ts`)
  exposing `info, changes, revsDiff, bulkDocs, bulkGet, put, get` and registers
  each as an RPC method (`serveObject`).
- On the fetching side, `TrysteroReplicatorP2PClient` builds a
  **`PouchDBShim`** — the same 7 methods, but each is a thunk that does
  `rpcRoom.session(peerId).call(method, args)` over the data channel. To the
  replicator this shim *looks like* a remote PouchDB.
- `TrysteroReplicator.replicateFrom(peerId)` then: (1) `requestAuthenticate`
  (`!reqAuth` RPC), (2) `checkTweakValues` (pulls the peer's `getTweakSettings`;
  passphrase mismatch aborts because chunk IDs would diverge; other mismatches
  warn only), (3) calls **`replicateShim(this.db, remoteDB, onDocs, { live:false,
  rewind })`** — the shared PouchDB replication engine — piping fetched docs into
  `processReplicatedDocs` → `services.replication.parseSynchroniseResult(docs)`
  (the **same** document-ingestion path the CouchDB replicator uses).

Direction and orchestration:

- **Pull** = `replicateFrom(peerId)` (I read the peer's DB).
- **Push** = `requestSynchroniseToPeer(peerId)` → RPC-invokes the peer's `reqSync`
  command, which makes *the peer* call `replicateFrom(me)` — i.e. push is
  "ask the remote to pull from me." There is no direct write-to-remote; every
  transfer is a pull, initiated by whichever side should receive.
- **Bidirectional sync** = pull then push. The feature's
  `createOpenReplicationUI` (`P2PReplicationUI.ts`) does `replicateFrom` then, on
  `ok`, `requestSynchroniseToPeer`. `TrysteroReplicator.sync()` does the same.
- **Live / broadcast mode** = `enableBroadcastChanges()` subscribes to local
  `db.changes({ since:"now", live:true, selector:{_id:{$gt:"_local/"}} })`; on
  each change it `notifyProgress()` → RPC `onProgress` to every accepted peer.
  A peer that is **watching** that source (`_watchingPeers`) responds by calling
  `replicateFrom(source)`. This is the closest thing to continuous LiveSync:
  producer broadcasts change notifications, watchers pull. Both `isBroadcasting`
  (producer) and per-peer watch (consumer) must be enabled for live flow; the
  UI surfaces both ("Live-push to peers" toggle; per-peer 🔔/🔕 watch toggle).

### 4. The "at least one device online" constraint

Because no server stores the data, **a device can only fetch from a peer that is
currently connected and serving**. `knownAdvertisements` reflects only *presently
connected* peers (entries are deleted on `onPeerLeave`). If the only other device
holding newer data is offline, there is nothing to sync from — the Status pane
shows "No devices available. Waiting for other devices to connect...". So for two
devices that are never online at the same time, P2P sync cannot converge; a
CouchDB (or bridge/relay-server) backend is required for true store-and-forward.
This is the fundamental architectural difference from the CouchDB path.

### 5. Config sharing & rebuild

`getRemoteConfig(peerId)` (RPC `getAllConfig`) lets a new device pull another
device's settings so it can join with matching parameters, then optionally
**rebuild** its local DB from that peer (`P2P_RebuildFrom`, `remoteType =
REMOTE_P2P`, `rebuilder.scheduleFetch()`). Config transfer is encrypted with a
**separate user-entered passphrase** (HKDF `encryptWithEphemeralSalt`). If the
serving side supplies an empty passphrase, it returns a randomized **decoy**
payload as an anti-brute-force / anti-stalking measure (see the `getAllConfig`
comment in `TrysteroReplicator.ts`). The rebuild UI is `createOpenRebuildUI`
(pull-only, brackets the pull in `setOnSetup`/`clearOnSetup`).

## Relationship to the CouchDB replication path (shared vs distinct)

**Shared:**

- `LiveSyncTrysteroReplicator extends LiveSyncAbstractReplicator` — it satisfies
  the same replicator interface, so the plugin selects it transparently when
  `settings.remoteType == REMOTE_P2P` (wired in
  `useP2PReplicatorFeature.getNewReplicator`).
- The **document ingestion path is identical**: fetched docs go through
  `services.replication.parseSynchroniseResult`, so conflict handling, chunking
  reassembly, and the local DB write are the same as CouchDB sync.
- **PouchDB replication itself is reused** via `replicateShim` — the transport is
  swapped (RPC-over-WebRTC instead of PouchDB's HTTP adapter to CouchDB) but the
  replication algorithm (`changes` / `revsDiff` / `bulkGet` / `bulkDocs`) is the
  same PouchDB machinery.
- Tweak/passphrase compatibility is enforced (`checkTweakValues`) just as the
  CouchDB path requires matching E2EE passphrase for consistent chunk IDs.

**Distinct:**

- **No remote database object.** Many `LiveSyncAbstractReplicator` methods are
  stubbed/unsupported: `tryResetRemoteDatabase`, `tryCreateRemoteDatabase`,
  `markRemoteLocked`, `resetRemoteTweakSettings`, `getRemoteStatus`,
  `getRemotePreferredTweakValues`, `fetchRemoteChunks`, `getConnectedDeviceList`
  all throw or return `false`/no-op. `isChunkSendingSupported` is **`false`** and
  `getReplicationPBKDF2Salt` returns a zero salt.
- **Push is indirect** (ask-remote-to-pull via `reqSync`) rather than a direct
  replicate-to-remote.
- **Transport lifecycle is peer/relay-based**: `disconnectFromServer` closes
  Nostr relay sockets (`getRelaySockets`, `pauseRelayReconnection`); there is no
  persistent remote endpoint, only live peers.
- **Trust is per-peer and interactive** (accept/deny/session), which has no
  analogue in the CouchDB path.
- **Availability semantics differ** — see the "at least one device online"
  constraint above; CouchDB is a store-and-forward hub, P2P is not.

## Function/class inventory (per file)

### `P2PReplicationUI.ts`
- `createOpenReplicationUI(app)` → factory returning per-replicator
  `(showResult) => Promise<boolean|void>`. Opens `P2POpenReplicationModal` whose
  `onSync`/`onSyncAndClose` do **pull then push** (`replicateFrom` → on `ok`
  `requestSynchroniseToPeer`); `onSyncAndClose` also closes the replicator.
- `createOpenRebuildUI(app)` → factory for **rebuild mode**: pull-only
  (`replicateFrom`) bracketed by `setOnSetup`/`clearOnSetup`, title "P2P Rebuild",
  with a guarded single-resolve.

Both factories are dependency-injected into `LiveSyncTrysteroReplicatorEnv`
(`env.openReplicationUI` / `env.openRebuildUI`); the headless build omits them.

### `P2POpenReplicationModal.ts`
- `class P2POpenReplicationModal extends Modal` — mounts `P2POpenReplicationPane`;
  fields `liveSyncReplicator`, `callback`, `showResult`, `title`, `rebuildMode`,
  `onClosed`.
  - `onSync(peerId)` / `onSyncAndClose(peerId)` — delegate to the callback (and
    `close()` on the latter).
  - `onOpen()` / `onClose()` — Svelte `mount` / `unmount` lifecycle.
- `type P2POpenReplicationModalCallback = { onSync, onSyncAndClose }`.

### `P2PReplicatorPaneView.ts`
- `const VIEW_TYPE_P2P = "p2p-replicator"`.
- `addToList` / `removeFromList(item, csv)` — comma-list helpers for the peer-name
  settings (`P2P_AutoSyncPeers` etc.).
- `class P2PReplicatorPaneView extends SvelteItemView`:
  - `get replicator()`, `replicateFrom(peer)`, `replicateTo(peer)`.
  - `getRemoteConfig(peer)` — pulls remote config, prompts DROP / KEEP / CANCEL,
    applies via `services.setting.applyExternalSettings`, then `scheduleFetch`
    (rebuild) or `scheduleRestart`.
  - `toggleProp(peer, "syncOnConnect"|"watchOnConnect"|"syncOnReplicationCommand")`
    — maps to `P2P_AutoSyncPeers` / `P2P_AutoWatchPeers` / `P2P_SyncOnReplication`
    and persists via `applyPartial`.
  - constructor wires `EVENT_P2P_PEER_SHOW_EXTRA_MENU` → builds the per-peer
    context `Menu` (Only Fetch / Only Send / Get Configuration / toggle sync/watch/select).
  - `getViewType`/`getDisplayText`/`getIcon` ("waypoints"), `onClose`,
    `instantiateComponent` → mounts `P2PReplicatorPane`.

### `P2PServerStatusPaneView.ts`
- `const VIEW_TYPE_P2P_SERVER_STATUS = "p2p-server-status"`.
- `class P2PServerStatusPaneView extends SvelteItemView` — mounts
  `P2PServerStatusPane`; view type/display text ("P2P Status")/icon.

### `P2PReplicatorPane.svelte` (Old UI)
- Two-way-bound settings form (`eP2PEnabled`, `eRelay`, `eRoomId`, `ePassword`,
  `eAppId`, `eDeviceName`, `eAutoStart`, `eAutoBroadcast`, `eAutoAccept`) with
  per-field `is-dirty` derivations; form only shown when **not** on Obsidian
  (Obsidian uses the plugin settings tab).
- `saveAndApply()` / `revert()` / `applyLoadSettings(d, force)`.
- `useDefaultRelay()`, `chooseRandom()` (`generateP2PRoomId`).
- `openServer()`/`closeServer()` (`cmdSync.open()`/`.close()`),
  `startBroadcasting()`/`stopBroadcasting()`.
- `peers` derived from `advertisements` → `PeerStatus[]` (acceptance/connection/
  fetching/sending/watching flags). Subscribes to `EVENT_SERVER_STATUS`,
  `EVENT_P2P_REPLICATOR_STATUS`, `setting-saved`, `EVENT_LAYOUT_READY`. Persists
  collapse state of notice/setting `<details>` in small config.

### `P2PServerStatusPane.svelte` (primary UI)
- Active **P2P remote configuration** picker: `listP2PRemoteOptions`,
  `refreshP2PRemoteOptions`, `applyP2PActiveRemoteSelection`, `onP2PRemoteSelected`,
  `createAndSelectP2PRemote` (opens `SetupRemoteP2P` wizard, serializes via
  `ConnectionStringParser`), `updateSelectedP2PRemote`, `canEditP2PSettings`.
- Peer decisions: `makeDecision(peer, decision, isTemporary)`, `revokeDecision`,
  `isAccepted`, acceptance label/class helpers.
- Replication: `startReplication(peer)` (pull then push), `toggleWatch`,
  `isWatching`, `toggleSyncTarget`/`isSyncTarget` (edits `P2P_SyncOnReplication`
  on the active remote), `isCommunicating` + `markCommunicating` (2.5s activity
  hold, drives the 📡 pulse). Subscribes to server/replicator/progress/settings
  events. Header gear opens P2P settings (`EVENT_REQUEST_OPEN_P2P_SETTINGS`).

### `P2PServerStatusCard.svelte`
- Reusable status card: connection state, `onOpenConnection`
  (`makeSureOpened`), `onDisconnect`, room-suffix (`extractP2PRoomSuffix`), peer
  id, device count, diag stats grid. `toggleBroadcast()`
  (enable/disableBroadcastChanges), `toggleDiagRTC()` (persists `P2P_useDiagRTC`).
  `requestServerStatus()` emits `EVENT_REQUEST_STATUS`.

### `PeerStatusRow.svelte`
- Renders one peer row from a `PeerStatus`. Derives `statusChips`
  (WATCHING/FETCHING/SENDING), `acceptedStatusChip`, `isAccepted`/`isDenied`/`isNew`,
  `peerAttrLabels` (✔ SYNC/WATCH/SELECT). Actions: `makeDecision`,
  `revokeDecision`, `sync`, `startWatching`/`stopWatching`, `moreMenu` (fires
  `EVENT_P2P_PEER_SHOW_EXTRA_MENU`). Gets the replicator from Svelte context
  `"getReplicator"`.

### `useP2PReplicatorUI.ts` (serviceFeature, boundary glue)
- `useP2PReplicatorUI(host, core, replicator)` — registers `VIEW_TYPE_P2P` and
  `VIEW_TYPE_P2P_SERVER_STATUS` view factories (each passing a `P2PPaneParams`:
  `{ replicator, p2pLogCollector, storeP2PStatusLine }`); adds commands
  (`open-p2p-replicator` ["Old UI"], `open-p2p-server-status`,
  `replicate-now-by-p2p-default-peer`, `replicate-now-by-p2p`, `p2p-sync-targets`);
  adds the "P2P Status" ribbon; auto-opens the status pane on layout-ready
  (Obsidian only). Note the two "replicate now" commands have **identical bodies**
  (both call `openReplication(settings,false,true,false)`).

## Dependencies / Consumed by

**P2P / WebRTC libraries (all reached through `src/lib`, not imported directly by
the feature):**

- **`@trystero-p2p/nostr`** — Trystero fork providing `joinRoom`, `selfId`,
  `Room`, `makeAction`, `getRelaySockets`, `pause/resumeRelayReconnection`, and
  `BaseRoomConfig`/`RelayConfig` types. Trystero handles WebRTC signalling over
  **Nostr WSS relays** and sets up RTCPeerConnections/data channels.
- **WebRTC** — platform `RTCPeerConnection` (or the diagnostic polyfill in
  `DiagRTCPeerConnections`), STUN/TURN via `turnConfig`.
- **`pouchdb-core`** — the local DB served/replicated; `replicateShim`
  (`@lib/pouchdb/ReplicatorShim`) drives replication over the RPC-proxied DB.
- **`@lib/rpc`** (`RpcRoom`, `TransportAdapter`) + `TrysteroTransport` /
  `trysteroUtils` — the request/response framing over Trystero data channels.
- **`octagonal-wheels`** — hashing (`mixedHash`, `sha1`), HKDF encryption
  (`encryptWithEphemeralSalt`), concurrency locks (`shareRunningResult`,
  `serialized`, `skipIfDuplicated`, `scheduleOnceIfDuplicated`), `Computed`,
  `reactiveSource`, promise utils (`delay`, `fireAndForget`).

**Internal dependencies (feature layer):**

- `@lib/replication/trystero/*` — `LiveSyncTrysteroReplicator`, `TrysteroReplicator`,
  `TrysteroReplicatorP2PServer` (events + `PeerInfo`/`P2PServerInfo`),
  `P2PReplicatorPaneCommon` (`PeerStatus`, `AcceptedStatus`, `ConnectionStatus`,
  `EVENT_P2P_PEER_SHOW_EXTRA_MENU`), `UseP2PReplicatorResult` (`P2PPaneParams`),
  `P2PLogCollector`.
- `@/common/SvelteItemView`, `@/common/events` (`eventHub`, `EVENT_LAYOUT_READY`,
  `EVENT_REQUEST_OPEN_P2P`, `EVENT_REQUEST_OPEN_P2P_SETTINGS`), `@/deps` (Obsidian
  `App`/`Modal`/`Menu`/`WorkspaceLeaf`), `@/LiveSyncBaseCore`, `svelte`
  (`mount`/`unmount`).
- `core.services.*` — `setting`, `config`, `vault`, `API`, `confirm`, `rebuilder`,
  `appLifecycle`. Setup wizard: `SetupManager`, `SetupRemoteP2P.svelte`,
  `ConnectionStringParser`, `remoteConfig` helpers.

**Consumed by:**

- `src/serviceFeatures/useP2PReplicatorUI.ts` instantiates the views/commands,
  which is registered by the plugin bootstrap.
- `useP2PReplicatorFeature.ts` (`src/lib`) constructs the shared
  `LiveSyncTrysteroReplicator` and injects the feature's UI factories; it also
  registers it as the active replicator when `remoteType == REMOTE_P2P`.
- Other consumers of the same `src/lib` P2P layer (outside this feature):
  `src/apps/cli/commands/p2p.ts`, `src/apps/webpeer/src/P2PReplicatorShim.ts`,
  `src/apps/webapp/main.ts` — confirming the `src/lib` core is host-agnostic and
  the `features/P2PSync` dir is the Obsidian-specific presentation only.

## Design observations (factual; for critique)

1. **Self-declared experimental.** The pane renders `P2P.Note.important_note_sub`
   ("bleeding edge… ensure your data is backed up"). The primary command to open
   the old pane is literally named "P2P Sync : Open P2P Replicator (Old UI)",
   indicating the feature has already been through one UI generation and both
   panes still ship.

2. **Two overlapping UIs coexist.** `P2PReplicatorPane` (Old UI, 502 LOC) and
   `P2PServerStatusPane` (primary, 891 LOC) both render peer lists, acceptance,
   watch, and sync controls with **duplicated logic** (`addToList`/`removeFromList`,
   acceptance-status label/class helpers are re-implemented in each). This is
   maintenance surface and a divergence risk.

3. **No store-and-forward.** The "at least one device online" constraint is
   inherent: with no server, a device can only pull from a *currently connected*
   peer, and `knownAdvertisements` is pruned on peer-leave. Two devices never
   online simultaneously cannot converge over P2P alone. Not a bug, but a hard
   capability gap vs the CouchDB backend the feature is meant to substitute for.

4. **Availability depends on a third-party relay.** The default relay button
   inserts the author's `wss://exp-relay.vrtmrz.net`. Signalling (and TURN, if
   configured) are external dependencies; relay downtime blocks *new* connections
   even though note data never traverses the relay.

5. **Push is indirect and asymmetric.** "Push" = RPC-ask the remote to pull from
   me (`reqSync`). Both directions are pulls. This means a successful push depends
   on the remote accepting *me* and successfully running its own `replicateFrom` —
   error/atomicity semantics are split across two devices, and the bidirectional
   `sync` is "pull then push" with no transactional guarantee if the push half fails.

6. **Advertisement is join-triggered only.** The periodic re-broadcast timer
   (`ADVERTISEMENT_REBROADCAST_INTERVAL_MS`, `startAdvertisementBroadcast`) is
   commented out. Peer presence is refreshed on join/leave events and manual
   "Refresh"; a missed join event could leave a stale/empty peer list until a
   reconnect.

7. **Capability stubs.** `LiveSyncTrysteroReplicator` inherits many
   `LiveSyncAbstractReplicator` methods it cannot honor: remote reset/create/lock,
   remote status, remote tweak fetch, chunk fetch, connected-device list — all
   throw or silently return `false`. `isChunkSendingSupported = false`. Callers
   written against the generic replicator interface must special-case P2P or they
   will hit thrown errors (e.g. `tryResetRemoteDatabase` throws outright).

8. **Security posture is passphrase-derived and interactive.** Room secrecy
   reduces to a **base-36 hash of the passphrase** as the Trystero password
   (`trysteroUtils.ts`); the `getReplicationPBKDF2Salt` override returns a
   **zero-filled 32-byte salt**. Config sharing adds a separate passphrase +
   HKDF, with a randomized **decoy** response on empty passphrase as an
   anti-brute-force measure — a hint that unsolicited config-sharing requests are
   a recognized abuse vector. The accept/deny trust model is per-device and can
   auto-accept via regex allow-lists (`P2P_AutoAcceptingPeers`), which if broad
   could admit unintended peers in a shared room. (Depth of the crypto is
   commonlib's domain; flagged here as an as-built fact for critique.)

9. **Tweak/passphrase mismatch handling is lenient except for passphrase.**
   `checkTweakValues` aborts only on passphrase mismatch (chunk-ID divergence);
   other config mismatches merely log a NOTICE and proceed, which can yield
   inefficient or partially-incompatible replication without a hard stop.

10. **Two identical commands.** `replicate-now-by-p2p-default-peer` and
    `replicate-now-by-p2p` (in `useP2PReplicatorUI.ts`) have byte-identical
    callbacks — likely an unfinished distinction (default-peer vs interactive).

### Coverage gaps / boundary notes

- The `src/lib/src/replication/trystero/` internals (RPC framing in
  `TrysteroTransport.ts`, `RpcRoom`, `DiagRTCPeerConnections`, `P2PReplicatorCore`,
  `P2PReplicatorBase`, `addP2PEventHandlers`, `useP2PReplicatorCommands`,
  `P2PLogCollector`) and `replicateShim` were read only to the depth needed to
  explain the model; their line-by-line correctness is **owned by the commonlib
  agent**. The exact WebRTC handshake, ICE/TURN behavior, and RPC retry/timeout
  semantics live inside Trystero and `@lib/rpc` and were not audited here.
- The crypto strength assessment (base-36 password hash, zero salt, HKDF config
  sharing) is stated as as-built fact, not evaluated cryptographically — defer to
  a security-focused review.

# Commonlib: Replication Engine

> AS-BUILT reverse-engineering of `src/lib/src/replication/` (livesync-commonlib). Read-only
> analysis; symbol names and paths verified against source. Where behavior is ambiguous it is
> flagged **(unclear)**.

## Purpose & responsibilities

The replication engine moves the local PouchDB document store (`EntryDoc` records: notes,
metadata, and content-addressed `leaf` chunks) to and from a remote, and applies inbound
documents back into the local store. It is the "heart" of Obsidian LiveSync.

It is deliberately **backend-polymorphic**. A single abstract contract
(`LiveSyncAbstractReplicator`) is implemented by three concrete replicators selected at runtime
by `settings.remoteType`:

| `remoteType`     | Replicator                    | Transport                                  |
|------------------|-------------------------------|--------------------------------------------|
| `REMOTE_COUCHDB` | `LiveSyncCouchDBReplicator`   | CouchDB HTTP + PouchDB live/one-shot replication |
| `REMOTE_MINIO`   | `LiveSyncJournalReplicator`   | S3/MinIO object storage (append-only journal) |
| `REMOTE_P2P`     | `LiveSyncTrysteroReplicator`  | WebRTC via Trystero over Nostr relays (peer-to-peer) |

Core responsibilities, regardless of backend:
- Connect to / authenticate against the remote (basic auth, JWT, S3 creds, or P2P room).
- Negotiate protocol/version compatibility and remote lock/clean state (milestone document).
- Manage the encryption **Security Seed** (PBKDF2 salt) stored in sync-parameters on the remote.
- Drive sync (push/pull), track sequence checkpoints, and report progress statistics.
- Hand inbound documents to the storage/apply pipeline via
  `env.services.replication.parseSynchroniseResult(docs)`.
- Serve on-demand chunk fetches (`fetchRemoteChunks`) for the `readChunksOnline` mode.

## Files & LOC (table)

| File | LOC | Role |
|------|-----|------|
| `couchdb/LiveSyncReplicator.ts` | 1378 | **CouchDB backend** — the primary/reference replicator. |
| `journal/JournalSyncCore.ts` | 889 | Object-storage journal engine (pack/send/receive streams, checkpoints). |
| `trystero/TrysteroReplicator.ts` | 799 | P2P orchestration core (open/close, RPC handlers, replicateFrom/sync). |
| `trystero/TrysteroReplicatorP2PServer.ts` | 633 | P2P room join, advertisement, peer acceptance, RPC wiring (`P2PHost`). |
| `trystero/LiveSyncTrysteroReplicator.ts` | 447 | P2P adapter implementing the abstract contract; peer-selection UI. |
| `journal/LiveSyncJournalReplicator.ts` | 342 | Journal backend adapter implementing the abstract contract. |
| `journal/objectstore/MinioStorageAdapter.ts` | 222 | S3/MinIO `IJournalStorage` implementation (AWS SDK v3). |
| `LiveSyncAbstractReplicator.ts` | 187 | Abstract base class + `LiveSyncReplicatorEnv` + `ReplicationStat`. |
| `SyncParamsHandler.ts` | 168 | Fetch/create/cache remote sync-parameters + PBKDF2 salt. |
| `trystero/P2PReplicatorCore.ts` | 176 | `useP2PReplicator()` lifecycle/service-feature factory (see note). |
| `httplib.ts` | 226 | Credential/auth header generation (Basic + JWT signing). |
| `trystero/TrysteroReplicatorP2PClient.ts` | 108 | Per-peer remote handle exposing a `PouchDBShim` over RPC. |
| `trystero/types.ts` | 111 | P2P shared types, RPC request/response, constants. |
| `trystero/useP2PReplicatorFeature.ts` | 130 | P2P feature wiring (commands, lifecycle) — Obsidian glue-ish. |
| `trystero/P2PLogCollector.ts` | 94 | Reactive P2P status-line renderer. |
| `trystero/addP2PEventHandlers.ts` | 76 | Wires P2P events to the replicator instance. |
| `trystero/useP2PReplicatorCommands.ts` | 58 | Command palette bindings for P2P. |
| `trystero/P2PReplicatorPaneCommon.ts` | 47 | Shared P2P pane helpers. |
| `trystero/TrysteroReplicatorP2PConnection.ts` | 44 | Re-export shim (`TrysteroReplicatorP2PServer as TrysteroConnection`). |
| `MinioStorageAdapter.integration.spec.ts` | — | Integration test (excluded from LOC-of-interest). |
| `trystero/ProxiedDB.ts` | 26 | `createHostingDB()` — wraps local PouchDB as a 7-method RPC-servable object. |
| `trystero/P2PReplicatorBase.ts` | 22 | `interface P2PReplicatorBase` shared shape. |
| `journal/JournalSyncTypes.ts` | 16 | `CheckPointInfo` type + default. |
| `journal/objectstore/JournalStorageAdapter.ts` | 17 | `IJournalStorage` interface (storage abstraction seam). |
| `trystero/UseP2PReplicatorResult.ts` | 12 | Result/params types for the P2P feature. |
| `journal/LiveSyncJournalReplicatorEnv.ts` | 9 | Marker env interface for journal replicator. |
| `trystero/rpcCompat.ts` | 7 | `toRpcMethodName()` RPC namespace mapper. |

Total (excluding `.spec.ts`): ~6,244 LOC.

> **Naming note (as-built vs requested):** `P2PReplicatorCore.ts` actually contains
> `useP2PReplicator()` (a lifecycle factory), not a class named `P2PReplicatorCore`. The P2P
> orchestration "core" is `TrysteroReplicator` in `TrysteroReplicator.ts`.
> `TrysteroReplicatorP2PConnection.ts` is now only a re-export (`TrysteroConnection` =
> `TrysteroReplicatorP2PServer`); its former class is fully commented out.

## Key types / data structures (replication state, checkpoints, batches)

**`LiveSyncAbstractReplicator` instance state** (`LiveSyncAbstractReplicator.ts:50`):
- `syncStatus: DatabaseConnectingStatus` — one of `NOT_CONNECTED` / `STARTED` / `CONNECTED` /
  `PAUSED` / `COMPLETED` / `ERRORED` / `CLOSED` (+ journal-specific `JOURNAL_SEND` /
  `JOURNAL_RECEIVE`).
- `docArrived` / `docSent`, and four sequence counters: `lastSyncPullSeq`, `maxPullSeq`,
  `lastSyncPushSeq`, `maxPushSeq`. These feed `updateInfo()` →
  `services.replicator.replicationStatics.value` (a `ReplicationStat`).
- `controller?: AbortController` — the single in-flight replication guard (only one at a time).
- Remote-state flags: `remoteLocked`, `remoteCleaned`, `remoteLockedAndDeviceNotAccepted`,
  `tweakSettingsMismatched`, `preferredTweakValue?: TweakValues`.
- `nodeid` — random 10-char device id, persisted in the local `NODEINFO_DOCID` doc.

**`ReplicationStat`** (`LiveSyncAbstractReplicator.ts:19`) — the derived progress view: `sent`,
`arrived`, `maxPullSeq`, `maxPushSeq`, `lastSyncPullSeq`, `lastSyncPushSeq`, `syncStatus`.

**CouchDB checkpoints:**
- PouchDB manages its own replication checkpoint documents internally (per source/target).
- LiveSync adds a **chunk-send checkpoint**, `_local/max_seq_on_chunk-${remoteID}`
  (`getEmptyMaxEntry`, `getLastTransferredSeqOfChunks`, `updateMaxTransferredSeqOnChunks`):
  `{ maxSeq, remoteID, seqStatusMap: Record<seq, boolean> }`. `remoteID` is the remote milestone
  `created` timestamp, so a rebuilt remote invalidates the checkpoint. `maxSeq` is advanced only
  across a *contiguous* prefix of `true` entries in `seqStatusMap`, so an out-of-order gap stops
  the resume point (correct but conservative).

**Journal checkpoints** (`JournalSyncTypes.ts`) — `CheckPointInfo`:
`{ lastLocalSeq, journalEpoch, knownIDs:Set, sentIDs:Set, receivedFiles:Set, sentFiles:Set }`,
persisted per-remote in a `SimpleStore` under `bucketsync-checkpoint-${hash}`. `knownIDs`/`sentIDs`
are dedupe caches keyed by `getDocKey` (`_id` for chunks, `_id-_rev` for docs). `journalEpoch`
= `${protocolVersion}:${pbkdf2salt}` — the wipe-detection anchor (see flow).

**Sync parameters** (`SyncParamsHandler.ts`) — `SyncParameters` (with `pbkdf2salt`,
`protocolVersion`) fetched/created once per server and cached as a shared promise; the decoded
salt (`pbkdf2saltDecoded: Uint8Array`) is memoized.

**Milestone document** (`EntryMilestoneInfo`, id `MILESTONE_DOCID` for CouchDB /
`_00000000-milestone.json` for journal) — remote-side coordination record:
`{ created, locked, cleaned, accepted_nodes[], node_chunk_info, node_info, tweak_values }`.

**P2P types** (`trystero/types.ts`) — `Advertisement {peerId,name,platform}`,
`Request`/`Response`/`Payload`, `DeviceDecisions` enum (ACCEPT/REJECT/IGNORE), `KnownDevices`,
`ReplicatorHostEnv` (settings/db/simpleStore/processReplicatedDocs), RPC timeouts
`DEFAULT_RPC_TIMEOUT=30000`, `BULK_GET_RPC_TIMEOUT=40000`.

## Replication flow (DEEP)

### Modes

`openReplication(setting, keepAlive, showResult, ignoreCleanLock)` (CouchDB,
`LiveSyncReplicator.ts:213`) branches:
- **Continuous / live** (`keepAlive=true`) → `openContinuousReplication`.
- **One-shot / periodic** (`keepAlive=false`) → `openOneShotReplication(..., "sync", ...)`.

`replicateAllToServer` / `replicateAllFromServer` are one-shot `pushOnly` / `pullOnly` variants.
The distinction between "periodic" and "one-shot" is external: the sync-core schedules repeated
one-shot calls; the replicator itself only knows one-shot vs live.

**Live replication is bootstrapped by a pull first**: `openContinuousReplication`
(`:881`) runs a `pullOnly` one-shot, then opens a PouchDB `localDB.sync(db, {live:true, retry:true,
heartbeat: useTimeouts?false:30000, ...})`. This front-loads inbound data before entering the
bidirectional live stream.

### Connectivity / negotiation (`checkReplicationConnectivity`, `:781`)

Before any transfer: connect (`connectRemoteCouchDBWithSetting`), verify version
(`checkRemoteVersion`), then `ensureDatabaseIsCompatible(...)` which returns one of `OK` /
`INCOMPATIBLE` / `LOCKED` / `NODE_LOCKED` / `NODE_CLEANED` / `["MISMATCHED", tweak]`. These set the
`remoteLocked*` / `tweakSettingsMismatched` flags and can abort. `update_seq` from the remote info
seeds `maxPullSeq`; local `info().update_seq` seeds `maxPushSeq`. Sync options
(`batches_limit`, `batch_size`) come straight from settings.

### Event pump (`genReplication` + `processSync`)

`genReplication` (`:80`) adapts the PouchDB event emitter (`change`/`active`/`complete`/`error`/
`denied`/`paused` + promise settle → `finally`) into an **async generator** backed by a bounded
`StreamInbox` (capacity 10000). It is driven by an `AbortController`; on abort or `finally` it
calls `s.cancel()` and closes the inbox. A full queue logs a verbose warning and, for
`error`/`denied`/`complete`, tears down.

`processSync` (`:300`) consumes the generator and returns
`"DONE" | "NEED_RETRY" | "NEED_RESURRECT" | "FAILED" | "CANCELLED"`:
- **Pacing/backpressure:** each event acquires `globalConcurrencyController.tryAcquire(1,
  REPLICATION_BUSY_TIMEOUT)`; if it cannot acquire in time it returns `FAILED` ("stopped for busy").
  The releaser is released immediately — this throttles/serializes against the rest of the app
  rather than holding a lock for the work.
- On `change`, updates `lastSyncPull/PushSeq` (parsed from `last_seq` split on `-`), then
  `replicationChangeDetected` → for `pull`, feeds docs to `parseSynchroniseResult` and increments
  `docArrived`; for `push`, increments `docSent`.
- **`NEED_RESURRECT`:** while `retrying`, if transferred docs exceed `batch_size*2`, it bails to
  restart with the *original* (full-size) settings — i.e. once the small-batch retry proves the
  link healthy, it resurrects normal throughput.
- On `error`, if `services.remote.hadLastPostFailedBySize` and status is `413` → `FAILED` with a
  user notice; otherwise `NEED_RETRY`.

### Retry / batch de-escalation

On `NEED_RETRY` (both one-shot `:743` and continuous `:944`) the settings are deep-cloned and
`batch_size`/`batches_limit` are **halved + 2**, recursing until both drop `<= 5`, at which point
it gives up. `NEED_RESURRECT` recurses with the original settings. `openOneShotReplication` and
`openContinuousReplication` are wrapped in `shareRunningResult("oneShotReplication" /
"continuousReplication", ...)` to coalesce concurrent callers.

### Chunk fetch ("read chunks on-line" / on-demand)

Content is stored as content-addressed `leaf` chunks (`_id` starting `h:`). When
`setting.readChunksOnline` is true, pull replication uses `selectorOnDemandPull =
{selector:{type:{$ne:"leaf"}}}` (`:66`) — **leaves are excluded from the replication stream**.
Missing chunks are fetched lazily:
- `ChunkFetcher` (`src/lib/src/managers/ChunkFetcher.ts`) listens for `EVENT_MISSING_CHUNKS`,
  batches up to `BATCH_SIZE=100` ids, respects a min-interval + concurrency, then calls
  `replicator.fetchRemoteChunks(requestIDs, false)`.
- CouchDB `fetchRemoteChunks` (`:1186`) does a single `remoteDB.allDocs({keys, include_docs:true})`.
  If *any* row is an error, the **whole batch returns `false`** (all-or-nothing), whereupon each id
  is re-emitted as `EVENT_MISSING_CHUNK_REMOTE`. Fetched chunks are validated
  (`_id` + `data` are strings) and written via `chunkManager.write(..., {skipCache:true,
  force:true})`.
- Journal `fetchRemoteChunks` returns `[]` (no per-chunk fetch — journals ship all leaves inline).
- P2P `fetchRemoteChunks` returns `false` (unsupported).

### Bulk chunk pre-send (CouchDB only, `sendChunks`, `:473`)

Before a push, CouchDB can bulk-upload leaves so the subsequent replication only carries
metadata. Flow: read local `_changes` since the chunk checkpoint filtered to `type:"leaf"`;
probe the remote with `allDocs({keys})` to find `not_found` chunks; queue them in a `Trench`
(disk-backed ephemeral store, keyed `sc-`); drain into byte/count-bounded batches
(`sendChunksBulkMaxSize` MB, max 200 docs) uploaded with `Semaphore(4)` concurrency via
`bulkDocs(..., {new_edits:false})` after `preprocessOutgoing` (encryption); update the
`seqStatusMap` checkpoint after each batch. Triggered from `ReplicationService.replicateAllToRemote`
behind a yes/no dialog when `isChunkSendingSupported`.

### Journal (object-storage) flow — `JournalSyncCore`

Fundamentally different: **append-only journal of compressed doc packs** in a bucket, no live
connection.
- **Send** (`sendLocalJournal`, `:585`): a 3-stage `ReadableStream → TransformStream →
  WritableStream` pipeline. `_createJournalPack` reads `db.changes` since `lastLocalSeq`
  (`limit=batchSize=100`, `style:"all_docs"`, `conflicts:true`), then `bulkGet(revs:true)` to
  materialize every leaf revision; dedupes against `knownIDs`/`sentIDs`. The transform serializes
  each doc (chunks use a compact `~id<US>data<LF>` form via `serializeDoc`; others JSON), buffers to
  ~250 docs / 10 MB, and `wrappedDeflate`s (level 8). The writable encrypts and uploads each pack
  as `${Date.now()}-docs.jsonl.gz`, then advances the checkpoint (`lastLocalSeq`, `sentIDs`,
  `sentFiles`). Note: **`style:"all_docs"` intentionally has no `_changes` filter** — a change entry
  can carry a winner plus a conflict tombstone, so per-revision dedupe is done after `bulkGet`.
- **Receive** (`receiveRemoteJournal`, `:836`): `_getRemoteJournals` lists bucket files after the
  last `receivedFiles` key (S3 `StartAfter`); a pipeline downloads → `decryptDownloaded` →
  `wrappedInflate` → splits on `\n` → reconstructs docs. `processDocuments` (`:643`) splits chunks
  vs docs: chunks are written with `new_edits:true` if not already present (content-immutable);
  docs use `revsDiff` then `bulkDocs(new_edits:false)` and are fed to `parseSynchroniseResult`.
  Received files are recorded in the checkpoint.
- `sync()` (`:867`) = receive-then-send, and **aborts the send if receive fails** ("prevent unwanted
  mass transfers").
- **Wipe detection** (`ensureCheckpointCachesAreFresh`, `:235`): the `journalEpoch` (protocol +
  salt) is compared; on change it probes the remote for the last `sentFiles` key via `listFiles`
  StartAfter to decide whether the bucket was wiped, and only then clears the dedupe caches. This
  guards against re-uploading everything after a benign protocol bump while still resetting after a
  true reset.

### P2P flow — `TrysteroReplicator` / `TrysteroReplicatorP2PServer`

Symmetric peers, no fixed server. Each node runs a `P2PHost` that `joinRoom` (Trystero over Nostr
relays) using `roomID`/`P2P_passphrase`/`P2P_AppID`/`P2P_relays`, broadcasts an `Advertisement`,
and serves its **local** PouchDB over RPC. To fetch, a node becomes the requester: `getConnection`
→ `TrysteroReplicatorP2PClient` builds a `PouchDBShim` whose methods are RPC calls; `replicateShim`
(`pouchdb/ReplicatorShim.ts`) then runs a **CouchDB-style checkpointed replication** over that shim
(checkpoint doc `_local/replication-checkpoint-mark-*`, with `rewind` for restart). `sync(peerId)`
= a local `replicateFrom` pull plus a `reqSync` RPC asking the peer to pull back (two one-way
pulls, not atomic). Peer acceptance is gated (`isAcceptablePeer`: persistent `acceptedPeers`,
temporary accepts, auto-accept/deny regex, or interactive dialog; headless auto-rejects).
Live change broadcasting: `db.changes({since:"now",live:true,selector:{_id:{$gt:"_local/"}}})` →
`onProgress` RPC nudges watching peers to pull.

## Backend abstraction (CouchDB vs object-storage/journal vs P2P)

**Shared seam:** `LiveSyncAbstractReplicator` (abstract class). All three backends implement its
contract; consumers (`ReplicationService`, `ChunkFetcher`, sync-core) hold a
`LiveSyncAbstractReplicator` and never branch on concrete type — they only consult
`isChunkSendingSupported`. Selection is via a **handler chain**, not a switch:
`services.replicator.getNewReplicator` collects handlers registered by
`ModuleReplicatorCouchDB` (`new LiveSyncCouchDBReplicator`), `ModuleReplicatorMinIO` (returns a
`LiveSyncJournalReplicator` iff `remoteType==REMOTE_MINIO`), and `useP2PReplicator` (returns a
fresh `LiveSyncTrysteroReplicator` iff `remoteType==REMOTE_P2P`); `getActiveReplicator()` yields the
active one.

**Shared infrastructure (not per-backend):**
- `SyncParamsHandler` — sync-parameters + PBKDF2 salt (used by CouchDB and journal; P2P returns a
  zeroed salt).
- `EntryMilestoneInfo` milestone doc + `ensureRemoteIsCompatible` / `ensureDatabaseIsCompatible`
  compatibility logic (CouchDB and journal share the semantics: OK/LOCKED/NODE_LOCKED/
  NODE_CLEANED/MISMATCHED/INCOMPATIBLE). P2P has no milestone.
- `parseSynchroniseResult` — the single storage-apply entry point every backend calls with inbound
  docs (a `handlers().all()` chain in `ReplicationService`).
- Encryption (`preprocessOutgoing`, `octagonal-wheels` encrypt/decrypt, HKDF v2 with fallback to
  v1) applied at the edge of each backend.

**Swappable within journal:** `IJournalStorage` (`JournalStorageAdapter.ts`) is a second-level
abstraction — `upload/download/listFiles/deleteFiles/isAvailable/getUsage/applyNewConfig`. Only
`MinioStorageAdapter` (AWS SDK v3 S3) implements it today, but `IJournalStorageAdapterClass` lets
another object store drop in without touching `JournalSyncCore`.

**What each backend does *not* support** (the divergence surface):
- Journal: `isChunkSendingSupported=false`, `fetchRemoteChunks→[]`, `countCompromisedChunks→0`,
  `getConnectedDeviceList→false`. No live sync (poll-only).
- P2P: nearly all remote-management ops are stubs (see inventory). No salt, no locking, no reset,
  no on-demand chunk fetch, no live PouchDB `.sync` (uses shim replication instead).

## Function/class inventory (per file)

### `LiveSyncAbstractReplicator.ts`
- `abstract class LiveSyncAbstractReplicator` — base contract + shared state/`updateInfo`.
- `initializeDatabaseForReplication()` — creates/reads the `NODEINFO_DOCID` doc and assigns
  `nodeid`.
- `ensurePBKDF2Salt(setting, showMessage, useCache)` — validates the salt via the abstract
  `getReplicationPBKDF2Salt`.
- `sendChunks(...)` — default no-op (only CouchDB overrides).
- Abstract members: `isChunkSendingSupported`, `getReplicationPBKDF2Salt`, `terminateSync`,
  `openReplication`, `tryConnectRemote`, `replicateAllToServer`, `replicateAllFromServer`,
  `closeReplication`, `tryReset/CreateRemoteDatabase`, `markRemoteLocked/Resolved`,
  `reset/setPreferredRemoteTweakSettings`, `fetchRemoteChunks`, `getRemoteStatus`,
  `getRemotePreferredTweakValues`, `countCompromisedChunks`, `getConnectedDeviceList`.
- Types: `ReplicationCallback`, `ReplicationStat`, `LiveSyncReplicatorEnv`, `RemoteDBStatus`.

### `couchdb/LiveSyncReplicator.ts`
- `class LiveSyncCouchDBReplicator extends LiveSyncAbstractReplicator` — the reference backend.
- `getInitialSyncParameters/getSyncParameters/putSyncParameters` — remote sync-params via direct
  doc fetch/put; `getReplicationPBKDF2Salt` wires them through `createSyncParamsHanderForServer`.
- `openReplication` → `openContinuousReplication` (live) or `openOneShotReplication` (one-shot).
- `openOneShotReplication(setting, showResult, retrying, syncMode, ignoreCleanLock)` — builds
  `localDB.sync` / `.replicate.from` / `.replicate.to`, runs `processSync`, and handles
  `NEED_RETRY`/`NEED_RESURRECT` by returning a thunk to recurse.
- `openContinuousReplication` — pull-first then `localDB.sync({live:true,retry:true,...})`.
- `processSync(...)` — the event-consumption state machine (returns DONE/NEED_RETRY/NEED_RESURRECT/
  FAILED/CANCELLED). **Non-trivial**: pacing via `globalConcurrencyController`, seq tracking, 413
  handling.
- `genReplication(sync, signal)` (module fn) — emitter→async-generator bridge over `StreamInbox`.
- `sendChunks(...)` — bulk leaf pre-upload with `Trench` queue + `Semaphore(4)`. **Non-trivial.**
- Chunk checkpoint helpers: `getEmptyMaxEntry`, `getLastTransferredSeqOfChunks`,
  `updateMaxTransferredSeqOnChunks` (contiguous-prefix `maxSeq` advance).
- `checkReplicationConnectivity(...)` — connect + version + `ensureDatabaseIsCompatible` →
  lock/clean/mismatch flags + sync options. **Non-trivial gatekeeper.**
- `connectRemoteCouchDBWithSetting(...)` — assembles auth (basic/JWT) + options and calls
  `services.remote.connect`.
- `fetchRemoteDocument/putRemoteDocument/_ensureConnection` — direct remote doc IO.
- `fetchRemoteChunks(missingChunks, showResult)` — `allDocs({keys})`; all-or-nothing.
- Remote management: `tryReset/CreateRemoteDatabase`, `markRemoteLocked/Resolved`,
  `reset/setPreferredRemoteTweakSettings`, `getRemotePreferredTweakValues`, `compactRemote`,
  `getRemoteStatus`, `countCompromisedChunks`, `getConnectedDeviceList`, `tryConnectRemote`.
- Lifecycle: `terminateSync`/`closeReplication` (abort the controller); the `replication*`
  callbacks (`Activated`/`ChangeDetected`/`Completed`/`Denied`/`Errored`/`Paused`) update status.

### `journal/JournalSyncCore.ts`
- `class JournalSyncCore` — the object-storage engine (not itself a `LiveSyncAbstractReplicator`).
- `getSyncParameters/putSyncParameters/getInitialSyncParameters/getReplicationPBKDF2Salt` — sync
  params stored as a bucket object `DOCID_JOURNAL_SYNC_PARAMETERS`.
- Checkpoint: `getCheckpointInfo` (rehydrates `Set`s from arrays/objects), `updateCheckPointInfo`,
  `resetCheckpointInfo`, `ensureCheckpointCachesAreFresh` (**epoch/wipe detection, non-trivial**).
- `_createJournalPack(override?)` — reads changes + `bulkGet` all revisions, dedupes. **Non-trivial
  comment warns against a `_changes` filter.**
- Send pipeline: `_createSendReadableStream`, `_createSendCompressTransformStream`,
  `_createSendUploadWritableStream`, `sendLocalJournal`.
- Receive pipeline: `_getRemoteJournals`, `_createReceiveReadableStream`,
  `_createReceiveTransformStream`, `_createReceiveWritableStream`, `receiveRemoteJournal`,
  `processDocuments` (chunk-vs-doc split, `revsDiff`, `new_edits:false`).
- `decryptDownloaded/encryptForUpload` — HKDF-v2 with v1 fallback; `serializeDoc` (module fn) — the
  compact leaf encoding.
- `sync`, `resetBucket`, `requestStop`, `updateInfo`, `getDocKey`, `getHash`.

### `journal/LiveSyncJournalReplicator.ts`
- `class LiveSyncJournalReplicator extends LiveSyncAbstractReplicator` — adapter delegating to a
  lazily-built `JournalSyncCore` (`setupJournalSyncClient`, `MinioStorageAdapter`).
- `openReplication`→`client.sync`; `replicateAllTo/FromServer`→send/receive.
- `checkReplicationConnectivity` — `isAvailable` + `ensureCheckpointCachesAreFresh` +
  `ensureBucketIsCompatible` (milestone in bucket).
- `fetchRemoteChunks→[]`, `countCompromisedChunks→0`, `getConnectedDeviceList→false`.
- Remote management writes the bucket milestone JSON (lock/resolve/tweaks).

### `journal/objectstore/MinioStorageAdapter.ts`
- `class MinioStorageAdapter implements IJournalStorage` — AWS SDK v3 `S3` client with
  `ConfiguredRetryStrategy(4, ...)`, custom-header middleware, and an MD5 body-checksum middleware.
  `upload/download/listFiles/deleteFiles/isAvailable/getUsage/applyNewConfig`. Bucket-prefixed keys;
  `listFiles` uses `StartAfter` for pagination.

### `SyncParamsHandler.ts`
- `createSyncParamsHanderForServer(key, {put,get,create})` — per-server memoized handler.
- `createSyncParamsHandler(...)` — `_fetchSyncParameters` (**non-trivial**: fetch → on-not-found
  create+put+retry → ensure salt → decode), promise-cached in `taskFetchParameters`.
- Errors: `SyncParamsHandlerError`/`FetchError`/`NotFoundError`/`UpdateError`. `clearHandlers()`.

### `httplib.ts`
- `generateCredentialObject(settings)` — basic vs JWT.
- `class BasicHeaderGenerator` — cached `Basic base64(user:pass)`.
- `class JWTTokenGenerator` — imports HS256/512 (HMAC) or ES256/512 (ECDSA) keys via WebCrypto,
  signs a JWT with `_couchdb.roles:["_admin"]`, and **auto-refreshes near expiry** (`requiresUpdate`
  margin logic, non-trivial).
- `class AuthorizationHeaderGenerator` — dispatches basic vs bearer.

### `trystero/*` (P2P)
- `LiveSyncTrysteroReplicator` (`LiveSyncTrysteroReplicator.ts`) — abstract-contract adapter/facade
  holding a `TrysteroReplicator` + `P2PHost`. Real: `open/close`, `openReplication`,
  `replicateAllFromServer` (interactive `selectPeer` rebuild), `closeReplication`,
  `_buildEnv` (bridges to `ReplicatorHostEnv`, wires `processReplicatedDocs`). Stubs: `terminateSync`,
  `tryConnectRemote→false`, `replicateAllToServer→false`, `fetchRemoteChunks→false`,
  `getReplicationPBKDF2Salt→zeroed 32 bytes`, `getRemoteStatus/PreferredTweakValues→false`,
  `countCompromisedChunks→0`, `getConnectedDeviceList→false`. Throws: `tryReset/CreateRemoteDatabase`,
  `markRemoteLocked`, `resetRemoteTweakSettings`.
- `TrysteroReplicator` (`TrysteroReplicator.ts`) — orchestration core: `open/close`, RPC handlers
  (`reqSync`, `!reqAuth`, `getTweakSettings`, `onProgress`, `getAllConfig`, `requestBroadcasting`),
  `replicateFrom`, `sync`, broadcast/watch.
- `TrysteroReplicatorP2PServer` (alias `P2PHost`) — room join, advertisement, peer
  acceptance/decisions, `RpcRoom` wiring, `serveObject`, `getConnection`.
- `TrysteroReplicatorP2PClient` — per-peer handle exposing a `PouchDBShim` `remoteDB` +
  `invokeRemoteFunction`.
- `ProxiedDB.ts` — `createHostingDB(env)`/`HostingDB`: exposes exactly
  `{info,changes,revsDiff,bulkDocs,bulkGet,put,get}` for RPC serving.
- `rpcCompat.ts` — `toRpcMethodName()` → `db.*` / `legacy/*` namespaces.
- `P2PReplicatorCore.ts` — `useP2PReplicator(host, viewTypeAndFactory?)`: lifecycle factory
  (registers the `getNewReplicator` handler, lifecycle open/close, commands, ribbon).
- `types.ts`, `P2PLogCollector.ts`, `addP2PEventHandlers.ts`, `useP2PReplicator*.ts`,
  `P2PReplicatorBase.ts`, `TrysteroReplicatorP2PConnection.ts` (re-export) — supporting types,
  status line, event wiring, command bindings.

## Dependencies (storage layer, chunking, rpc) / Consumed by

**Depends on:**
- Local store: `env.services.database.localDatabase` (a `LiveSyncLocalDB`) and its raw PouchDB
  (`.localDatabase`). All backends read via `db.changes`/`allDocs`/`bulkGet` and write via
  `bulkDocs`.
- Storage-apply pipeline: `env.services.replication.parseSynchroniseResult(docs)` — the boundary to
  the sync-core (covered by another agent).
- Encryption: `pouchdb/encryption.ts` (`preprocessOutgoing`), `octagonal-wheels/encryption`
  (encrypt/decrypt + HKDF), `SyncParamsHandler` salt.
- Negotiation: `pouchdb/negotiation.ts` (`checkRemoteVersion`, `countCompromisedChunks`),
  `pouchdb/LiveSyncDBFunctions.ts` (`ensureDatabaseIsCompatible`, `ensureRemoteIsCompatible`).
- Concurrency/util: `octagonal-wheels` (`shareRunningResult`, `Semaphore`, `Trench`, `StreamInbox`,
  `Computed`), `globalConcurrencyController`, `arrayToChunkedArray`.
- Compression: `pouchdb/compress.ts` (`wrappedDeflate`/`wrappedInflate`) — journal only.
- Remote connect: `env.services.remote.connect(...)` (CouchDB); `@aws-sdk/client-s3` (journal);
  `@trystero-p2p/nostr` + `@lib/rpc` (P2P).

**Consumed by:**
- `services/base/ReplicationService.ts` — the primary orchestrator (`replicateAllToRemote`,
  `replicateAllFromRemote`, `getActiveReplicatorFor`); consults `isChunkSendingSupported` and calls
  `sendChunks`.
- `managers/ChunkFetcher.ts` — on-demand `fetchRemoteChunks` for `readChunksOnline`.
- `modules/core/ModuleReplicatorCouchDB.ts` / `ModuleReplicatorMinIO.ts` +
  `trystero/P2PReplicatorCore.ts` — backend registration/selection.
- `serviceModules/Rebuilder.ts` — rebuild/fetch flows.

## Design observations (factual; for critique)

- **Single global in-flight replication.** State (`controller`, seq counters, `docSent/Arrived`,
  `originalSetting`) lives on the replicator instance and `processSync` aborts any prior controller
  at entry. Concurrency is coalesced via `shareRunningResult`, but there is only ever one logical
  replication; overlapping requests are dropped/merged, not queued.

- **Batch de-escalation is one-way and resets by recursion.** `NEED_RETRY` halves batch sizes and
  deep-clones settings each recursion; a persistently large-payload failure walks all the way down
  to the `<=5` floor and then aborts. `NEED_RESURRECT` jumps back to full size once retry proves the
  link — an oscillation between the two is possible under intermittent 413s. (No fix implied; just
  noting the control loop.)

- **All-or-nothing on-demand chunk fetch.** `LiveSyncReplicator.fetchRemoteChunks` returns `false`
  for the entire batch if any single key errors, forcing every id in the 100-chunk batch to be
  re-queued as remote-missing even when 99 succeeded. `ChunkFetcher` then re-emits all as
  `MISSING_CHUNK_REMOTE`. Potentially redundant refetch traffic. There is also a code comment
  "Now I am wondering why it happened..." around chunk validation — an acknowledged unknown.

- **Chunk-send checkpoint conservatism / recycling.** `updateMaxTransferredSeqOnChunks` advances
  `maxSeq` only across a contiguous `true` prefix of `seqStatusMap`; a hole (a chunk that failed or
  arrived out of order) permanently pins the resume point below later successes until the gap fills.
  The `seqStatusMap` is also merged/accumulated indefinitely (`{...previous.seqStatusMap, ...}`),
  growing without a documented prune.

- **Journal send aborts on receive failure by design**, but a *successful* receive followed by a
  send failure leaves the remote with a partially-advanced journal and local `sentFiles`/`sentIDs`
  updated only per-uploaded-pack — resumable, but interruption mid-pipeline relies on the
  next run re-scanning from `lastLocalSeq`.

- **Journal wipe-detection is heuristic.** `ensureCheckpointCachesAreFresh` infers a remote wipe
  from a single `listFiles` probe of the last sent file; on probe exception it assumes a wipe
  (`remoteWipeConfirmed=true`) and clears caches — a transient listing error can therefore trigger a
  full re-send. Conversely it depends on timestamp-named files "virtually never" colliding across
  remote lifetimes (documented assumption, not enforced).

- **JWT embeds `_admin` role unconditionally.** `httplib.ts` sets
  `"_couchdb.roles":["_admin"]` in every generated payload; least-privilege is not expressed here.

- **P2P has no security seed and name-based acceptance.** `getReplicationPBKDF2Salt` returns a
  zero-filled salt for P2P, and peer acceptance is keyed on the self-reported `Advertisement.name`
  — a peer advertising another's name could inherit acceptance **(flagged by P2P sub-analysis;
  verify against `TrysteroReplicatorP2PServer.isAcceptablePeer`)**. Passphrase comparison uses a
  180s time-bucketed hash that can straddle a boundary. P2P `sync` is two independent one-way pulls,
  not atomic.

- **Dual P2P RPC paths coexist.** The legacy `Payload`/`__onRequest`/`__onResponse` mechanism
  remains in the tree alongside the newer `RpcRoom`; `TrysteroReplicatorP2PClient.__onResponse` is a
  no-op. **(unclear)** whether the legacy path still carries any live traffic.

- **Naming drift** (see note under Key types): the requested `P2PReplicatorCore.ts` /
  `TrysteroReplicatorP2PConnection` symbols do not match the as-built content (a `useP2PReplicator`
  factory and a re-export, respectively).

### Coverage gaps / not fully traced
- Deep internals of `TrysteroReplicator.ts` / `TrysteroReplicatorP2PServer.ts` (633+799 LOC) were
  summarized via a secondary analysis, not line-by-line verified here; acceptance, RPC-auth, and
  reconnection details should be re-read for a security-grade critique.
- `ReplicatorShim.ts` (the shim replication + `_local/replication-checkpoint-mark-*` checkpoint) and
  `pouchdb/negotiation.ts` / `LiveSyncDBFunctions.ts` compatibility logic live outside
  `replication/` and were only referenced, not audited.
- The exact scheduling of "periodic" vs "live" (who calls `openReplication` and when) is owned by
  the sync-core / `ReplicationService`, partially outside this subsystem.

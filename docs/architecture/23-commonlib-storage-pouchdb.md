# Commonlib: Storage / Database Layer & Public API

> AS-BUILT reverse-engineering baseline for the `livesync-commonlib` storage subsystem.
> Scope: `src/lib/src/pouchdb/`, `src/lib/src/dataobject/`, `src/lib/src/interfaces/`,
> `src/lib/src/API/`. Where behavior depends on out-of-scope code (notably
> `managers/EntryManager/`), that is noted explicitly. All symbol names and paths were
> verified by reading the source.

## Purpose & responsibilities

This subsystem is the persistence core of Obsidian LiveSync. It:

1. **Wraps PouchDB** into a typed local database (`LiveSyncLocalDB`) over the
   `EntryDoc` document union, and assembles the PouchDB build (adapters + plugins)
   used in browser, HTTP-only, and test contexts.
2. **Defines/enforces the on-disk document schema** — notes (metadata) that reference
   content-addressed **chunks** (`leaf` docs), plus milestone/version/sync bookkeeping docs.
3. **Provides transform-pouch hooks** for transparent **encryption** (V1 PBKDF2 / V2 HKDF,
   plus path obfuscation and "Eden" inline-chunk encryption) and **compression** on the
   PouchDB read/write path.
4. **Abstracts the remote** (CouchDB over HTTP) behind PouchDB adapters, a custom
   streaming initial-sync fetcher (`StreamingFetch`), and a transport-agnostic
   replication shim (`ReplicatorShim`). (Object-storage/S3-style remotes are journal-based
   and live outside this subsystem — see Remote section.)
5. **Declares the service/module interfaces** (`interfaces/`) that decouple the DB core
   from the host app (Obsidian vault vs. headless CLI).
6. **Exposes the public consumer API** — `DirectFileManipulator` (`API/`), a headless
   file-level CRUD/watch facade over a remote CouchDB, plus settings QR/URI codecs.

## Files & LOC (table)

| File | LOC | Role |
|------|-----|------|
| `pouchdb/LiveSyncLocalDB.ts` | 531 | Core PouchDB wrapper class; raw CRUD, doc iteration, chunk enumeration, delegation to managers |
| `pouchdb/encryption.ts` | 556 | transform-pouch incoming/outgoing encryption (V1 PBKDF2 + V2 HKDF), path obfuscation, Eden encryption |
| `pouchdb/StreamingFetch.ts` | 361 | Streaming `_changes` initial-sync from CouchDB → PouchDB via WritableStream + backpressure |
| `pouchdb/chunks.ts` | 346 | Unreferenced-chunk GC, chunk balancing/transfer between DBs, remote `_purge` |
| `pouchdb/ReplicatorShim.ts` | 231 | Transport-agnostic checkpoint replication (`replicateShim`, `upsert`) |
| `pouchdb/LiveSyncDBFunctions.ts` | 194 | Remote compatibility negotiation (`ensureRemoteIsCompatible` / milestone doc) |
| `pouchdb/pouchdb-browser.ts` | 144 | PouchDB build w/ IDB + IndexedDB + HTTP adapters; `purgeMulti` prototype patch |
| `pouchdb/negotiation.ts` | 128 | Remote version check/bump, syncinfo probe, compromised-chunk count |
| `pouchdb/pouchdb-http.ts` | 136 | PouchDB build w/ HTTP adapter only (+ `purgeMulti`) — used by headless/API |
| `pouchdb/compress.ts` | 101 | fflate deflate/inflate; `replicationFilter` transform-pouch compression |
| `pouchdb/pouchdb-test.ts` | 23 | PouchDB build w/ IDB + memory adapters (tests) |
| `pouchdb/utils_couchdb.ts` | 43 | URI validation, 404 detection, raw authenticated CouchDB fetch |
| `pouchdb/StreamingFetch.{unit,integration}.spec.ts` | 101/119 | Tests (not documented in depth) |
| `API/DirectFileManipulatorV2.ts` | 551 | Public headless file CRUD/watch API over remote CouchDB |
| `API/processSetting.ts` | 203 | Settings ↔ QR code / setup-URI encode/decode |
| `API/DirectFileManipulator.ts` | 2 | Re-export shim → V2 |
| `API/processSetting.unit.spec.ts` | 81 | Tests |
| `interfaces/StorageAccess.ts` | 68 | Vault/filesystem abstraction interface (`StorageAccess`, `IStorageAccessManager`) |
| `interfaces/ServiceModule.ts` | 85 | Service-feature composition types + helpers |
| `interfaces/FileHandler.ts` | 35 | `IFileHandler` — DB↔storage file transfer/conflict interface |
| `interfaces/DatabaseFileAccess.ts` | 33 | `DatabaseFileAccess` — high-level file store/fetch/conflict interface |
| `interfaces/Confirm.ts` | 27 | User-prompt abstraction |
| `interfaces/StorageEventManager.ts` | 20 | `FileEvent` type + abstract watch/queue manager |
| `interfaces/DatabaseRebuilder.ts` | 17 | `Rebuilder` — rebuild/fetch orchestration interface |
| `interfaces/KeyValueDatabase.ts` | 9 | Generic KV store interface (IndexedDB-shaped) |
| `dataobject/StoredMap.ts` | 48 | `StoredMapLike` — cached prefixed KV wrapper over a `SimpleStore` |

## Data model / document schema (DEEP: docs, chunks, metadata, revisions, tombstones)

The canonical types are defined in `src/lib/src/common/models/db.type.ts`,
`db.definition.ts`, and `db.const.ts` (re-exported through `common/types.ts`). The
subsystem operates on the `EntryDoc` union.

### Identity & prefixes

- `_id: DocumentID` (a `TaggedType<string>`). Note IDs are derived from file path via
  `path2id` (may be obfuscated with prefix `f:` = `IDPrefixes.Obfuscated`).
- **Chunk IDs are content-addressed** and carry prefix `h:` (`IDPrefixes.Chunk`); encrypted
  chunks use `h:+` (`IDPrefixes.EncryptedChunk`). Chunk generation itself lives in
  `managers/` (out of scope), but iteration/GC here keys off the `h:` prefix and
  `type == "leaf"`.
- Reserved doc IDs (`db.const.ts`): `VERSIONING_DOCID = "obsydian_livesync_version"`,
  `MILESTONE_DOCID = "_local/obsydian_livesync_milestone"`,
  `NODEINFO_DOCID = "_local/obsydian_livesync_nodeinfo"`, `SYNCINFO_ID = "syncinfo"`.
  (Note the intentional legacy misspelling "obsydian".)

### Document types (`EntryTypes`, `db.const.ts`)

`notes` (NOTE_LEGACY, inline data), `newnote` (NOTE_BINARY, chunked), `plain`
(NOTE_PLAIN, chunked text), `internalfile`, `leaf` (CHUNK), `chunkpack` (CHUNK_PACK),
`versioninfo`, `syncinfo`, `sync-parameters`, `milestoneinfo`, `nodeinfo`.

### Entry shapes

- **`DatabaseEntry`** (base): `_id`, `_rev?`, `_deleted?`, `_conflicts?` — the PouchDB
  metadata envelope.
- **`EntryBase`**: `ctime`, `mtime`, `size`, and a soft **`deleted?: boolean`** flag
  (distinct from PouchDB's `_deleted`; see tombstones).
- **`NoteEntry`** (`type: "notes"`, legacy): `data: string | string[]` stored inline.
- **`NewEntry`** (`newnote`) / **`PlainEntry`** (`plain`): the modern shape.
  `children: string[]` is an **ordered list of chunk IDs** ("h:…") reconstituting the
  file body. Both also carry `EntryWithEden`.
- **`EntryWithEden`**: `eden: Record<DocumentID, EdenChunk>` where
  `EdenChunk = { data: string; epoch: number }`. "Eden" is an **inline small-chunk cache
  embedded in the metadata doc**, avoiding separate chunk docs for tiny/hot content.
- **`InternalFileEntry`**: hidden/config-file variant of `NewEntry` with `deleted?`.
- **`EntryLeaf`** (`type: "leaf"`): a **chunk**. `data: string`, optional
  `isCorrupted?: boolean`. Content-addressed by `_id`.
- **`EntryChunkPack`** (`chunkpack`): `data: string` bundling multiple chunks.
- **Runtime views** (not stored shapes): `LoadedEntry` (= AnyEntry + resolved
  `data` + `datatype`), `SavingEntry` (data as `Blob`), `MetaEntry` (AnyEntry guaranteed
  to have `children`). `isMetaEntry(e)` = `"children" in e`.
- **Bookkeeping docs**: `EntryVersionInfo` (`versioninfo`, `version:number`),
  `EntryMilestoneInfo` (accepted nodes, per-node `node_chunk_info` ChunkVersionRange,
  `node_info`, `locked`, `cleaned?`, `tweak_values`), `EntryNodeInfo`, `SyncInfo`.

### Revisions

- PouchDB rev tree is used natively. `getNoFromRev(rev)` parses the leading generation
  integer (`"12-abc"` → 12).
- The local DB is created with `revs_limit: 100`, `auto_compaction: false`, and
  **`deterministic_revs: true`** (LiveSyncLocalDB.initializeDatabase) — meaning identical
  content deterministically yields the same rev, important for chunk de-dup and
  conflict-free convergence.
- Chunks are typically written with `{ new_edits: false }` (see `transferChunks`,
  `StreamingFetch`) so replicated rev histories are preserved verbatim.

### Tombstones / deletions (correctness-sensitive)

There are **two independent deletion representations**, and this dual model is the crux of
deleted-file-resurrection behavior. Deletion logic proper lives in
`managers/EntryManager/EntryManagerImpls.ts::deleteDBEntryByPath` (out of scope but read
for accuracy):

- **Hard tombstone** — PouchDB `_deleted = true`. Removes the doc body; only the rev
  tombstone replicates.
- **Soft delete** — the `deleted: boolean` field on the metadata doc, with `mtime` bumped
  to `Date.now()`, while the doc (and its `children` chunk refs) **remain live** in the
  database.

`deleteDBEntryByPath` chooses per type:
- `leaf` → no-op (chunks are never deleted via this path; GC handles them).
- `notes` (legacy) → always hard `_deleted = true`.
- `newnote`/`plain` → **soft delete** (`obj.deleted = true`, `mtime = now`) **unless** the
  `deleteMetadataOfDeletedFiles` setting is on, in which case it *also* sets
  `_deleted = true`. A revision-scoped deletion (`opt.rev` present) always hard-deletes.
- `put` is called with `{ force: !revDeletion }`, deliberately creating a **forced/conflict
  revision** rather than a linear one for non-rev deletes.

Read paths honor the soft flag: `EntryManagerImpls` computes
`deleted = obj.deleted ?? obj._deleted ?? undefined` and, unless `includeDeleted`, returns
`false` for soft-deleted entries. **Risk:** because soft-deleted docs stay live with
their content and only a `deleted` flag + `mtime`, resurrection is possible if a
concurrent/older non-deleted revision from another device wins conflict resolution, or if
`mtime` comparison favors a stale edit — the deletion is a normal editable revision, not a
terminal tombstone. `allChunks` treats `_deleted` leaves as absent (unless
`includeDeleted`), but conflicted deleted metadata docs are still walked for retained
`children` (see PouchDB wrapper).

## PouchDB wrapper & CRUD/revision handling (DEEP)

`LiveSyncLocalDB` (`pouchdb/LiveSyncLocalDB.ts`) is the central class. It holds
`localDatabase: PouchDB.Database<EntryDoc>` and an `env: LiveSyncLocalDBEnv` that provides
the service hub (`API`, `database`, `databaseEvents`, `replicator`, `setting`, `path`).
Higher-level entry logic is delegated to `LiveSyncManagers` (chunk/entry/conflict managers,
in `managers/`).

**Lifecycle**
- `constructor(dbname, env)` seeds empty auth, wires an instance logger, calls
  `refreshSettings()` (pulls current settings + prepares hash functions).
- `initializeDatabase()` closes any prior instance, creates the PouchDB instance via
  `env.services.database.createPouchDBInstance(dbname + SuffixDatabaseName, { auto_compaction:false, revs_limit:100, deterministic_revs:true })`,
  constructs `LiveSyncManagers`, fires `onDatabaseInitialisation` / `onDatabaseHasReady`
  lifecycle hooks (modules may veto readiness), registers a `close` listener that tears
  down managers and stops replication, and subscribes to the cross-instance
  `REMOTE_CHUNK_FETCHED` event via a `FallbackWeakRef` (auto-unsubscribes when GC'd).
- `close()` / `onunload()` remove listeners and notify `databaseEvents.onUnloadDatabase`.
- `resetDatabase()` tears down managers, stops replication, fires `onResetDatabase`
  (vetoable), `destroy()`s the PouchDB, and re-initializes.

**Raw CRUD (thin PouchDB passthrough, typed to `EntryDoc`)**
- `getRaw`, `putRaw`, `removeRaw`, `allDocsRaw`, `bulkDocsRaw`.
- `removeRevision(docId, rev)` — loads a specific rev, sets `_deleted = true`, `put`s it
  (prunes a single conflicting branch); swallows 404.

**Iteration** (async generators, paged at 100, using `\u{10ffff}` as the high sentinel):
- `findEntries` / `findAllDocs` / `findAllNormalDocs` yield note docs (`newnote`/`plain`),
  skipping `_`-prefixed and chunk ranges.
- `findEntryNames` / `findAllDocNames` yield IDs, skipping `_`-prefixed and
  `VERSIONING_DOCID`. Ranges are hand-partitioned around the `h:`, `i:`, `ix:`, `ps:`
  prefix families.

**`allChunks(includeDeleted)`** — the reference-tracking scan. Walks the `_changes` feed
(paged, `conflicts:true`, `style` = `all_docs`|`main_only`) building:
- `existing`: Map of live `leaf` chunks;
- `used`: Set of chunk IDs referenced by any doc's `children`, **including refs held only
  in conflicting revisions** — it fetches `_revs_info`, computes which conflicted revs to
  keep, and `bulkGet`s them to union their `children`. This conservative union is what
  prevents GC from deleting chunks still referenced by an unmerged conflict.

**Delegated (to `managers.entryManager` / `conflictManager`)**:
`isTargetFile`, `getDBEntryMeta`, `getDBEntry`, `getDBEntryFromMeta`, `deleteDBEntry`,
`putDBEntry(note, onlyChunks?, conflictBaseRev?)`, `getConflictedDoc`, `tryAutoMerge`.
The actual note↔chunk splitting, hashing, dedup, and delete semantics live there.

**`purgeMulti` prototype patch** (`pouchdb-browser.ts` / `pouchdb-http.ts`): both PouchDB
builds monkey-patch `PouchDB.prototype.purgeMulti` (via `adapterFun`) to purge many
docs/revs at once using `_getRevisionTree` + `findPathToLeaf` + adapter `_purge`, then
append `_local/purges` bookkeeping (bounded by `purged_infos_limit`). Used by chunk GC.

## Remote & backend interfaces (how CouchDB/object-storage are abstracted)

**PouchDB builds (adapter selection)** — the remote CouchDB is abstracted primarily as a
PouchDB HTTP database:
- `pouchdb-browser.ts`: IDB + IndexedDB + **HTTP** + mapreduce + replication + find +
  transform. Full plugin app build.
- `pouchdb-http.ts`: **HTTP only** + mapreduce/replication/find/transform — used by the
  headless `DirectFileManipulator` / CLI (no local IDB).
- `pouchdb-test.ts`: IDB + **memory** adapter for tests.

**Direct authenticated CouchDB access** — `utils_couchdb.ts::_requestToCouchDBFetch`
builds Basic-auth JSON requests via the environment's `_fetch`; used for operations PouchDB
doesn't expose (e.g. remote `_purge` in `chunks.ts::purgeChunksRemote`).
`isValidRemoteCouchDBURI`, `isCloudantURI`, `isErrorOfMissingDoc` (404) are helpers.

**Compatibility negotiation** (`LiveSyncDBFunctions.ts`) — before replicating, the device
reconciles a shared **milestone doc** (`_local/obsydian_livesync_milestone`):
`ensureRemoteIsCompatible` records this node's `node_chunk_info` (ChunkVersionRange),
`node_info`, and `tweak_values`; computes the global compatible chunk-version window
across accepted nodes; and returns `"OK" | "INCOMPATIBLE" | "LOCKED" | "NODE_LOCKED" |
"NODE_CLEANED" | ["MISMATCHED", TweakValues]`. `ensureDatabaseIsCompatible` wraps it
around a real PouchDB. `negotiation.ts` handles the version doc (`checkRemoteVersion` /
`bumpRemoteVersion`, `VER = 12`), `checkSyncInfo` (writes a random `syncinfo` doc to prove
decryptability), and `countCompromisedChunks` (finds mis-prefixed `leaf` docs).

**Transform-pouch pipeline** — remotes are made transparent via two `db.transform`
layers installed on the PouchDB instance:
- `compress.ts::replicationFilter` — `incoming` deflates doc `data` (fflate, marker
  `MARK_SHIFT_COMPRESSED`) when compression is enabled; `outgoing` always inflates.
- `encryption.ts::enableEncryption` — `incoming` encrypts chunk/syncinfo `data`, obfuscates
  paths, and encrypts Eden + metadata; `outgoing` decrypts. Two algorithms:
  **V1** (`incomingEncryptV1`/`outgoingDecryptV1`, PBKDF2, optional dynamic iteration
  count, header `%`) and **V2** (`incomingEncryptHKDF`/`outgoingDecryptHKDF`, HKDF with a
  PBKDF2 salt fetched via `getPBKDF2Salt`, header `%=`, plus full metadata encryption under
  `ENCRYPTED_META_PREFIX = "/\:"`). `E2EEAlgorithm` (`V2` default, `ForceV1` legacy) selects
  the pair; V2 decrypt path falls back to V1 for forward-compat. Actual crypto runs in a
  background worker (`@lib/worker/bgWorker`).

**Streaming initial sync** (`StreamingFetch.ts`) — `fetchChangesForInitialSync` bypasses
PouchDB replication for the first bulk pull: it opens CouchDB `_changes?feed=continuous&
include_docs=true&style=all_docs&conflicts=true&revs=true`, parses the NDJSON stream line by
line, decrypts each doc, and writes batches (100 docs / 2 MB) into PouchDB with
`{ new_edits:false }` via a `WritableStream` that provides natural backpressure. Targets a
computed `update_seq`, reports progress, checkpoints per batch, and aborts the fetch once
the target sequence is reached.

**Transport-agnostic replication** (`ReplicatorShim.ts`) — `replicateShim(target, source,
progress, opt)` implements a CouchDB-style checkpoint replication over any object
satisfying `PouchDBShim` (a real DB **or an RPC proxy**). It maintains a source-side
`mark` (rebuild detection → rewind) and a target-side `since` checkpoint in `_local/…`
docs, loops `changes → revsDiff → bulkGet(missing) → bulkDocs(new_edits:false)`, and
re-fetches written docs to emit them to `progress` in source-sequence order. `upsert`
is a get-or-seed helper tolerant of RPC-shaped not-found errors.

**Object-storage remotes** are *not* handled in this subsystem — S3/bucket sync is
journal-based (`src/lib/src/replication/journal/…`, e.g. `JournalSyncCore` which itself
consumes these DB types). `DirectFileManipulator`'s settings carry S3 fields
(`accessKey`/`secretKey`/`bucket`/`region`/`endpoint`) but zeroes them; the API targets
CouchDB.

**Chunk maintenance** (`chunks.ts`) — GC and cross-DB balancing operate directly on
PouchDB: a `_design/chunks/collectDangling` map-reduce view counts references; `collectChunks`
classifies `INUSE`/`DANGLING`/`ALL`; `purgeUnreferencedChunks` reports sizes, backs local
chunks up into `_local/…` before `purgeMulti`, or issues remote `_purge`; `balanceChunkPurgedDBs`
/ `fetchAllUsedChunks` / `transferChunks` reconcile chunk sets between local and remote using
`QueueProcessor` pipelines.

## Public API surface (what plugin/apps call)

The subsystem's public entry points, and their consumers (verified by grep):

- **`LiveSyncLocalDB`** — consumed by the service layer (`services/base/DatabaseService.ts`,
  `IService.ts`), the entry managers, and `LiveSyncBaseCore.ts`. The plugin/core interacts
  with it through the `LiveSyncLocalDBEnv` service-hub contract and the delegated
  `get/put/deleteDBEntry` methods.
- **`DirectFileManipulator`** (`API/`, exported via `DirectFileManipulator.ts` → V2) —
  the documented external API for headless/CLI use (`apps/cli/commands/runCommand.ts`,
  `cli/APITest.sample.ts`, `SetupManager.ts`). It implements `LiveSyncLocalDBEnv` itself,
  builds a `HeadlessServiceHub`, opens an HTTP-only PouchDB against a remote CouchDB, and
  offers file-level operations:
  - `get(path, metaOnly)`, `getById(id, metaOnly)`, `getByMeta(doc)`, `rawGet<T>(id)`
  - `put(path, data, info, type)`, `delete(path)`
  - `enumerate*` / `_enumerate` (async iterators over normal docs)
  - `beginWatch`/`endWatch` (live `changes` feed, filters out `leaf`, auto-reconnect),
    `followUpdates` (one-shot pull-filtered change catch-up)
  - `getSyncParameters`/`putSyncParameters`/`getReplicationPBKDF2Salt` for E2EE params.
- **`processSetting.ts`** — settings interchange used by setup flows
  (`serviceFeatures/setupObsidian/qrCode.ts`, `setupUri.ts`):
  `encodeSettingsToQRCodeData`/`decodeSettingsFromQRCodeData`,
  `encodeQR` (with aggregator-split fallback), `encodeSettingsToSetupURI`/
  `decodeSettingsFromSetupURI`.
- **`interfaces/`** — the port definitions apps implement to plug their storage/UX in:
  `StorageAccess`/`IStorageAccessManager`, `DatabaseFileAccess`, `IFileHandler`,
  `Rebuilder`, `KeyValueDatabase`, `Confirm`, `StorageEventManager`+`FileEvent`,
  and `ServiceModule` composition helpers (`createServiceFeature`, `serviceFeature`).

## Function/class inventory (per file: signature + purpose)

### `pouchdb/LiveSyncLocalDB.ts`
- `class LiveSyncLocalDB` — see wrapper section. Notable members: `localDatabase`,
  `managers` (throws if accessed before init), `isReady`, `env`.
  - `initializeDatabase(): Promise<boolean>`, `close()`, `onunload()`, `resetDatabase()`,
    `refreshSettings()`, `clearCaches()`, `_prepareHashFunctions()`, `onNewLeaf(chunk)`.
  - `allChunks(includeDeleted=false)` — reference/existence scan (conservative, conflict-aware).
  - `findEntries/findAllDocs/findAllNormalDocs/findEntryNames/findAllDocNames` — paged async gens.
  - `removeRevision`, `getRaw`, `removeRaw`, `putRaw`, `allDocsRaw`, `bulkDocsRaw` — raw CRUD.
  - Delegators: `isTargetFile`, `getDBEntryMeta`, `getDBEntry`, `getDBEntryFromMeta`,
    `deleteDBEntry`, `putDBEntry`, `getConflictedDoc`, `tryAutoMerge`.
- `getNoFromRev(rev): number` — parse rev generation.
- `interface LiveSyncLocalDBEnv` — `{ services: Pick<IServiceHub, "API"|"database"|
  "databaseEvents"|"replicator"|"setting"|"path"> }`.
- types `ChunkRetrievalResult{Success,Error}`, `GeneratedChunk`, const `REMOTE_CHUNK_FETCHED`.

### `pouchdb/encryption.ts`
- `enableEncryption(db, passphrase, useDynamicIterationCount, migrationDecrypt, getPBKDF2Salt, algorithm)` — install transform.
- `getConfiguredFunctionsForEncryption(...)` — returns `{incoming, outgoing}` per algorithm.
- `incomingEncryptHKDF` / `outgoingDecryptHKDF` / `incomingEncryptV1` / `outgoingDecryptV1`
  (internal) — the four transform pipelines.
- `encryptMetaWithHKDF`/`decryptMetaWithHKDF` (internal) — metadata (path/mtime/ctime/size/children) crypto.
- `tryDecryptV1AsFallback`, `getEncryptionVersion` (internal).
- Eden guards: `shouldEncryptEden`, `shouldEncryptEdenHKDF`, `shouldDecryptEden`, `shouldDecryptEdenHKDF`.
- `disableEncryption()` (resets module-level `preprocessIncoming`/`preprocessOutgoing` no-ops).
- Re-exports worker crypto: `encrypt`,`decrypt`,`encryptHKDF`,`decryptHKDF`.
- consts `EDEN_ENCRYPTED_KEY`, `EDEN_ENCRYPTED_KEY_HKDF`.

### `pouchdb/StreamingFetch.ts`
- `fetchChangesForInitialSync(downloadToDB, remoteDbUrl, authHeader, decryptFunction, since, onProgress?, onCheckpoint?)` — streamed initial pull.
- `generatePouchDBWriteStream(...)` (internal) — batching `WritableStream`.
- helpers `reachedTargetSequence`, `setParamsToURL`; type `FetchChangesForInitialSyncProgress`.

### `pouchdb/chunks.ts`
- `purgeUnreferencedChunks(db, dryRun, connSetting?, performCompact=false)` — top-level GC.
- `collectChunks(db, "INUSE"|"DANGLING"|"ALL")`, `collectChunksUsage(db)`,
  `collectUnreferencedChunks(db)`, `collectUnbalancedChunkIDs(local, remote)`.
- `purgeChunksLocal(db, docs)` (backs up to `_local/` then `purgeMulti`),
  `purgeChunksRemote(setting, docs)` (CouchDB `_purge`).
- `transferChunks(key, label, dbFrom, dbTo, items)` — QueueProcessor copy pipeline.
- `balanceChunkPurgedDBs(local, remote)`, `fetchAllUsedChunks(local, remote)`.
- `prepareChunkDesignDoc(db)` (internal) — installs `_design/chunks`.

### `pouchdb/ReplicatorShim.ts`
- `replicateShim(targetDB, sourceDB, progress, option?)` — checkpointed pull.
- `upsert(db, id, func)` — get-or-seed (RPC-tolerant).
- helpers `parseSeq`, `buildRevsDiffParam`, `sortBySeq`; types `PouchDBShim`, `ShimReplicationOption*`, `ProgressInfo`.

### `pouchdb/LiveSyncDBFunctions.ts`
- `ensureRemoteIsCompatible(infoSrc, setting, deviceNodeID, currentVersionRange, nodeDeviceInfo, updateCallback): Promise<ENSURE_DB_RESULT>`.
- `ensureDatabaseIsCompatible(db, setting, deviceNodeID, currentVersionRange, nodeDeviceInfo)`.
- type `ENSURE_DB_RESULT`.

### `pouchdb/negotiation.ts`
- `checkRemoteVersion(db, migrate, barrier=VER)`, `bumpRemoteVersion(db, barrier=VER)`,
  `checkSyncInfo(db)`, `countCompromisedChunks(db)`.

### `pouchdb/compress.ts`
- `replicationFilter(db, compress)` — install compression transform.
- `compressDoc(doc)`/`decompressDoc(doc)`, `_compressText`/`_decompressText`,
  `wrappedInflate`/`wrappedDeflate`, `wrapFflateFunc`, const `MARK_SHIFT_COMPRESSED`.

### `pouchdb/utils_couchdb.ts`
- `isValidRemoteCouchDBURI(uri)`, `isCloudantURI(uri)`, `isErrorOfMissingDoc(ex)`,
  `_requestToCouchDBFetch(baseUri, user, pass, path?, body?, method?)`.

### `pouchdb/pouchdb-browser.ts` / `pouchdb-http.ts` / `pouchdb-test.ts`
- Configured `PouchDB` export per environment; browser/http also patch
  `PouchDB.prototype.purgeMulti` (`appendPurgeSeqs` helper).

### `API/DirectFileManipulatorV2.ts`
- `class DirectFileManipulator implements LiveSyncLocalDBEnv` — see Public API section.
  Members: `init`, `getBoundDatabaseService`, `$$id2path`/`$$path2id`/`path2id`,
  `getInitialSyncParameters`, `getSyncParameters`, `putSyncParameters`,
  `getReplicationPBKDF2Salt`, `$everyOnInitializeDatabase`, `settings` getter,
  `get`/`getById`/`getByMeta`/`rawGet`, `put`/`delete`, `enumerate*`/`_enumerate`,
  `beginWatch`/`endWatch`/`followUpdates`, `close`.
- guards `isNoteEntry`, `isReadyEntry`; types `DirectFileManipulatorOptions`,
  `ReadyEntry`, `MetaEntry`, `FileInfo`, `EnumerateConditions`.

### `API/processSetting.ts`
- `encodeSettingsToQRCodeData`, `decodeSettingsFromQRCodeData`, `encodeQR`,
  `encodeSettingsToSetupURI`, `decodeSettingsFromSetupURI`; enum `OutputFormat`; type `SplitQRCodeData`.

### `dataobject/StoredMap.ts`
- `class StoredMapLike<U>` — prefixed, memory-cached wrapper over `SimpleStore`:
  `get`/`set`/`delete`/`has`, `addPrefix`. **Note:** constructor ignores the `prefix`
  argument (never assigns `this._prefix`), so `addPrefix` always emits `"-key"` (see observations).

### `interfaces/*`
- `StorageAccess` / `IStorageAccessManager` (vault file access), `DatabaseFileAccess`
  (high-level store/fetch/conflict), `IFileHandler` (DB↔storage transfer), `Rebuilder`,
  `KeyValueDatabase`, `Confirm`, `StorageEventManager` (+`FileEvent`),
  `ServiceModules`/`createServiceFeature`/`serviceFeature` composition types.

## Dependencies / Consumed by

**Depends on (out of subsystem):**
- `@lib/common/types` + `common/models/*` (the `EntryDoc` schema — the true data-model home).
- `@lib/managers/*` — `LiveSyncManagers`, `EntryManager` (note↔chunk splitting, delete
  semantics, conflict resolution), `ChunkFetcher`, `ConflictManager`. **The most
  correctness-critical logic (put/delete/merge) lives here, not in this subsystem.**
- `@lib/services/*` — `IServiceHub`, `HeadlessServiceHub`, `DatabaseService`, setting/path services.
- `@lib/worker/bgWorker` (crypto), `@lib/replication/SyncParamsHandler`, `@lib/hub/hub` (eventHub).
- `octagonal-wheels` (QueueProcessor, locks, SimpleStore, task utils, FallbackWeakRef), `pouchdb-*`, `transform-pouch`, `fflate`, `qrcode-generator`.

**Consumed by:** `LiveSyncBaseCore.ts`, `services/base/DatabaseService.ts` + `IService.ts`,
`managers/EntryManager/*`, `replication/journal/JournalSyncCore.ts`,
`serviceFeatures/setupObsidian/{qrCode,setupUri}.ts`, `modules/features/SetupManager.ts`,
`features/LocalDatabaseMainte/CmdLocalDatabaseMainte.ts`, `apps/cli/commands/runCommand.ts`,
`cli/APITest.sample.ts`, `lib/src/index.ts`.

## Design observations (factual; correctness risks; no fixes)

1. **Dual deletion model (tombstone vs. soft flag) is the resurrection surface.**
   `newnote`/`plain` deletes are, by default, *soft* (`deleted:true` + bumped `mtime`,
   doc + chunk refs still live) rather than PouchDB `_deleted` tombstones. A soft-deleted
   doc is an ordinary editable revision, so an older/other-device non-deleted revision can
   win conflict resolution or mtime comparison and effectively resurrect the file. Hard
   tombstoning only happens for legacy `notes`, rev-scoped deletes, or when
   `deleteMetadataOfDeletedFiles` is enabled. (Logic in `managers/EntryManager`.)

2. **Deletes intentionally create conflict/forced revisions** (`put(obj, { force:
   !revDeletion })`), so deletion propagation relies on downstream conflict resolution
   converging correctly across devices.

3. **Chunk GC correctness depends on the conservative reference union.** `allChunks` and the
   `_design/chunks` reduce must count chunks referenced only by *conflicting* revisions;
   `allChunks` does the `_revs_info`/`bulkGet` walk, but the design-doc `collectDangling`
   view (used by `collectChunks`) emits refs only for the winning revision's `children`
   (`"children" in doc`) — a conflicted-but-not-winning revision's chunk refs may not be
   counted by the map-reduce path, a potential over-aggressive GC risk on databases with
   unresolved conflicts.

4. **`StoredMapLike` prefix bug.** The constructor accepts `prefix` but never assigns
   `this._prefix` (stays `""`), so all keys collapse to `"-<key>"`. Any consumer relying on
   per-instance prefixing would collide. (Confirmed by reading; behavior, not inference.)

5. **Chunks are never deleted through the file-delete path** (`leaf` → no-op); chunk
   lifecycle is entirely GC-driven (`purgeUnreferencedChunks`). If GC is not run, deleted
   files' chunks persist indefinitely (by design, aids recovery, but grows the DB).

6. **`StreamingFetch` writes with `new_edits:false` from a raw CouchDB stream** and parses
   NDJSON by hand with fallbacks for malformed final lines; a mis-parsed line is skipped
   (logged), so a corrupt change line silently drops a document from initial sync.

7. **Two encryption algorithm generations coexist** with fallback chains (V2→V1 on decrypt).
   `getEncryptionVersion` returning `UNKNOWN` throws; mixed-version chunk sets rely on the
   `%`/`%=` header discrimination. `countCompromisedChunks` (negotiation.ts) exists
   specifically to detect chunks written with a wrong/legacy prefix.

8. **`DirectFileManipulator.enumerate` is a stub** (fully commented out; `// Untested`
   notes on related methods), and settings-loading/saving handlers `console.warn` and no-op.
   The headless API is functional for get/put/delete/watch but incomplete for enumeration.

9. **Milestone/version bookkeeping is safety-critical and lock-bearing.**
   `ensureRemoteIsCompatible` can return `LOCKED`/`NODE_LOCKED`/`NODE_CLEANED`/`MISMATCHED`,
   gating replication; the chunk-version window is computed as
   `max(min)…min(max)` across accepted nodes and returns `INCOMPATIBLE` when the window
   inverts (unless `ignoreVersionCheck`). Correct device-node identity and `tweak_values`
   handling are prerequisites for safe sync.

### Coverage gaps
- **Chunk *generation*, note↔chunk splitting, hashing/dedup, `putDBEntry`, and full
  `deleteDBEntry`/auto-merge logic live in `managers/EntryManager` & `ConflictManager`
  (out of scope)** — this doc describes their contracts/effects but not their internals.
- The `.spec.ts` test files were not analyzed in depth.
- Worker-side crypto primitives (`bgWorker`, HKDF/PBKDF2 impl) are out of scope.
- Object-storage/journal sync (`replication/journal/*`) is only referenced, not documented.

# Commonlib: Services & Managers

*As-built reverse-engineering of the service/DI infrastructure and the higher-level managers
in `livesync-commonlib` (`src/lib/src/`). Read-only analysis; symbol names and paths verified
against source. Where behaviour is unclear or self-flagged in the code, it is called out
explicitly.*

Scope covered:
- `src/lib/src/services/` — service contracts, base classes, the `ServiceHub` service locator,
  the `Injectable*`/`Browser*`/`Headless*` implementation tiers, and the `HandlerUtils`
  late-binding machinery that underpins the whole DI approach.
- `src/lib/src/managers/` — the coordinating managers owned by `LiveSyncLocalDB`
  (entry/chunk/hash/conflict/change) plus the platform-agnostic `StorageEventManager`.
- `src/lib/src/serviceModules/` — service-level file/DB access modules built on services.
- `src/lib/src/serviceFeatures/` — higher-level feature functions bound onto service hooks.

---

## Purpose & responsibilities

This layer is the *coordination and infrastructure* tier of commonlib. It sits between the
low-level primitives (PouchDB wrapper, replicators, crypto, path/string utilities) and the
application shells (the Obsidian plugin, the CLI, the web/peer apps). It has two distinct
architectural halves:

1. **The service / DI infrastructure** (`services/`, `serviceModules/`, `serviceFeatures/`).
   A dependency-injection system where each capability is defined as an abstract *service*
   (a typed contract + event hooks), assembled into a single `ServiceHub` service locator, and
   made platform-specific through an inheritance/late-binding chain. Cross-cutting features
   (scanning, setup export, remote-size checks, target filtering) are written as free functions
   that *register handlers* onto service hooks rather than as methods.

2. **The managers** (`managers/`). A set of objects that coordinate the actual data plane —
   splitting notes into content-addressed chunks, hashing them, reading/writing them through a
   layered pipeline, watching the local database change feed, fetching missing chunks from the
   remote, resolving conflicts, and translating vault file-system events into the sync pipeline.
   The managers are owned and orchestrated by `LiveSyncLocalDB` (in the `pouchdb/` subsystem) via
   the `LiveSyncManagers` aggregator; they are the architecturally central objects the DB layer
   delegates to.

---

## Files & LOC (grouped by dir)

LOC are `wc -l` on source. `*.unit.spec.ts` / `*.unit.test.ts` are tests and are **excluded**
from the source tables; the test-LOC total is noted at the end (tests substantially outweigh
source in several dirs).

### `services/base/` — service contracts + abstract base classes

| File | LOC | Symbol |
|------|----:|--------|
| `IService.ts` | 429 | All `IXxxService` interfaces + `IServiceHub`, `IControlService` |
| `SettingService.ts` | 644 | `abstract SettingService` |
| `ReplicationService.ts` | 320 | `abstract ReplicationService` |
| `RemoteService.ts` | 296 | `abstract RemoteService` |
| `ReplicatorService.ts` | 179 | `abstract ReplicatorService` |
| `AppLifecycleService.ts` | 176 | `abstract AppLifecycleService` |
| `KeyValueDBService.ts` | 158 | `abstract KeyValueDBService` |
| `APIService.ts` | 140 | `abstract APIService` |
| `ControlService.ts` | 137 | `ControlService` (meta/orchestration) |
| `DatabaseService.ts` | 118 | `abstract DatabaseService` |
| `VaultService.ts` | 109 | `abstract VaultService` |
| `PathService.ts` | 108 | `abstract PathService` |
| `ConflictService.ts` | 73 | `abstract ConflictService` |
| `DatabaseEventService.ts` | 48 | `abstract DatabaseEventService` |
| `TweakValueService.ts` | 47 | `abstract TweakValueService` |
| `UnresolvedErrorManager.ts` | 46 | `UnresolvedErrorManager` (plain class) |
| `FileProcessingService.ts` | 35 | `FileProcessingService` (concrete) |
| `TestService.ts` | 35 | `abstract TestService` |
| `ConfigService.ts` | 13 | `abstract ConfigService` |
| `ServiceBase.ts` | 9 | `ServiceBase`, `ServiceContext` |

### `services/` (root) — hub + registries

| File | LOC | Symbol |
|------|----:|--------|
| `HeadlessServices.ts` | 175 | `HeadlessServiceHub` (+ headless service wiring) |
| `BrowserServices.ts` | 124 | `BrowserServiceHub` (+ browser service wiring) |
| `ServiceHub.ts` | 124 | `abstract ServiceHub`, `ServiceInstances` |
| `InjectableServices.ts` | 2 | re-export of `InjectableServiceHub` |

### `services/lib/` — DI machinery

| File | LOC | Symbol |
|------|----:|--------|
| `HandlerUtils.ts` | 737 | `handlers<T>()` builder + `Binder`/`Dispatch`/`*Handler` classes |
| `logUtils.ts` | 39 | `createInstanceLogFunction`, `LogFunction` |

### `services/implements/` — implementation tiers (concrete "how")

| File | LOC | Tier |
|------|----:|------|
| `browser/BrowserAPIService.ts` | 359 | browser |
| `base/SvelteDialog.ts` | 211 | shared UI |
| `headless/HeadlessAPIService.ts` | 168 | headless |
| `injectable/InjectableServiceHub.ts` | 162 | injectable hub |
| `browser/BrowserConfirm.ts` | 107 | browser |
| `browser/SvelteDialogBrowser.ts` | 81 | browser |
| `browser/Menu.ts` | 71 | browser |
| `base/UIService.ts` | 63 | shared UI |
| `injectable/InjectablePathService.ts` | 50 | injectable (`PathServiceCompat`) |
| `injectable/InjectableServices.ts` | 38 | injectable (`InjectableServiceInstances` type) |
| `injectable/InjectableSettingService.ts` | 37 | injectable |
| `browser/BrowserUIService.ts` | 37 | browser |
| `browser/ConfigServiceBrowserCompat.ts` | 30 | browser |
| `injectable/InjectableVaultService.ts` | 21 | injectable (`InjectableVaultServiceCompat`) |
| `browser/ui/renderMessageMarkdown.ts` | 21 | browser |
| `injectable/InjectableAPIService.ts` | 19 | injectable |
| `injectable/InjectableAppLifecycleService.ts` | 17 | injectable |
| `obsidian/ObsidianServiceContext.ts` | 16 | obsidian |
| `injectable/InjectableConflictService.ts` | 14 | injectable |
| `injectable/InjectableTweakValueService.ts` | 13 | injectable |
| `injectable/InjectableTestService.ts` | 8 | injectable |
| `injectable/InjectableReplicatorService.ts` | 7 | injectable |
| `browser/BrowserDatabaseService.ts` | 7 | browser |
| `headless/HeadlessDatabaseService.ts` | 7 | headless |
| `injectable/InjectableRemoteService.ts` | 6 | injectable |
| `injectable/InjectableDatabaseEventService.ts` | 6 | injectable |
| `injectable/InjectableReplicationService.ts` | 4 | injectable |
| `injectable/InjectableFileProcessingService.ts` | 4 | injectable |

### `managers/` — coordinating managers

| File | LOC | Symbol |
|------|----:|--------|
| `StorageEventManager.ts` | 689 | `abstract StorageEventManagerBase` |
| `EntryManager/EntryManagerImpls.ts` | 646 | free functions: `putDBEntry`, `getDBEntry*`, `createChunks`, … |
| `ConflictManager.ts` | 410 | `ConflictManager` |
| `LayeredChunkManager.ts` | 309 | `LayeredChunkManager` (aliased `ChunkManager`) |
| `ChunkFetcher.ts` | 167 | `ChunkFetcher` |
| `LiveSyncManagers.ts` | 161 | `LiveSyncManagers` (aggregator) |
| `ChangeManager.ts` | 132 | `ChangeManager<T>` |
| `EntryManager/EntryManager.ts` | 113 | `EntryManager` (thin OO facade) |
| `HashManager/HashManagerCore.ts` | 165 | `abstract HashManagerCore` |
| `HashManager/XXHashHashManager.ts` | 135 | XXHash32/64 + WASM-fallback managers |
| `HashManager/HashManager.ts` | 115 | `HashManager` (selector) |
| `HashManager/PureJSHashManager.ts` | 105 | PureJS/SHA1 + fallback managers |
| `StorageProcessingManager.ts` | 58 | `StorageAccessManager` (file lock/touch) |
| `ChunkManager.ts` | 2 | re-export alias `LayeredChunkManager as ChunkManager` |

**`managers/LayeredChunkManager/`** (read/write pipeline layers): `CacheLayer.ts` (206),
`ArrivalWaitLayer.ts` (124), `DatabaseReadLayer.ts` (99), `DatabaseWriteLayer.ts` (65),
`ChunkLayerInterfaces.ts` (50), `types.ts` (36), `HotPackLayer.ts` (20).

**`managers/adapters/`** (StorageEventManager platform interfaces): `IStorageEventWatchAdapter.ts`
(23), `IStorageEventConverterAdapter.ts` (18), `IStorageEventManagerAdapter.ts` (19),
`IStorageEventPersistenceAdapter.ts` (17), `IStorageEventTypeGuardAdapter.ts` (17),
`IStorageEventStatusAdapter.ts` (9), `index.ts` (6).

### `serviceModules/` — service-level file/DB access

| File | LOC | Symbol |
|------|----:|--------|
| `ServiceFileHandlerBase.ts` | 541 | `abstract ServiceFileHandlerBase` (implements `IFileHandler`) |
| `Rebuilder.ts` | 510 | `ServiceRebuilder` (implements `Rebuilder`) |
| `ServiceDatabaseFileAccessBase.ts` | 390 | `ServiceDatabaseFileAccessBase` (implements `DatabaseFileAccess`) |
| `ServiceFileAccessBase.ts` | 373 | `ServiceFileAccessBase` (implements `StorageAccess`) |
| `FileAccessBase.ts` | 328 | `FileAccessBase<TAdapter>` (native FS wrapper) |
| `ServiceModuleBase.ts` | 18 | `abstract ServiceModuleBase` |
| `adapters/*` | 6–63 | `IFileSystemAdapter` + 5 sub-adapter interfaces |

### `serviceFeatures/` — feature functions bound onto hooks

| File | LOC | Purpose |
|------|----:|---------|
| `offlineScanner.ts` | 807 | Full bidirectional vault↔DB reconciliation scan |
| `remoteConfig.ts` | 321 | Multiple named remote configs + migration |
| `targetFilter.ts` | 235 | `isTargetFile` filter pipeline (middleware) |
| `checkRemoteSize.ts` | 216 | Warn/act when remote storage exceeds threshold |
| `prepareDatabaseForUse.ts` | 90 | DB init + vault scan on startup |
| `setupObsidian/setupUri.ts` | 72 | Export settings as encrypted setup URI |
| `setupObsidian/qrCode.ts` | 71 | Export settings as QR code |
| `setupObsidian/types.ts` | 3 | `SetupFeatureHost` host type |

**Tests (excluded above):** the four dirs carry heavy `*.unit.spec.ts` / `*.unit.test.ts`
suites — notably `StorageEventManager.unit.spec.ts` (1612), `ConflictManager.unit.spec.ts`
(1022), `EntryManagerImpls.unit.spec.ts` (1020), `offlineScanner.unit.spec.ts` (2038),
`FileAccessBase.unit.spec.ts` (882), `HandlerUtil.unit.test.ts` (762). Test LOC exceed source
LOC in the managers/serviceFeatures/serviceModules directories.

---

## The service / DI infrastructure

### The contract layer — `IService.ts`

`services/base/IService.ts` (429 LOC) is the single interface file for the whole system. It
declares one `IXxxService` interface per capability — `IAPIService`, `IPathService`,
`IDatabaseService`, `IDatabaseEventService`, `IReplicatorService`, `IFileProcessingService`,
`IReplicationService`, `IRemoteService`, `IConflictService`, `IAppLifecycleService`,
`ISettingService`, `ITweakValueService`, `IVaultService`, `ITestService`, `IUIService`,
`IConfigService`, `IKeyValueDBService`, `IControlService` — plus the aggregate `IServiceHub`
that names one field per service. Everything downstream is typed against these interfaces
(managers and features declare their needs as `NecessaryServices<"path" | "setting", …>`
subsets rather than importing concrete classes), which keeps the coupling nominal.

### The inheritance chain (base → injectable → platform)

Every service is a class hierarchy rooted at `ServiceBase<T extends ServiceContext>`
(`base/ServiceBase.ts`, 9 LOC) — a trivial base storing a `context`. The chain is:

```
ServiceBase
  └─ base/XxxService              abstract "what": the contract + event hooks (may be abstract)
       └─ injectable/InjectableXxxService   DI scaffolding: unfilled methods become bindable handlers
            └─ browser/BrowserXxxService     concrete browser/DOM implementation
            └─ headless/HeadlessXxxService   concrete Node/no-UI implementation
```

Not every service has all four tiers: `APIService` and `DatabaseService` have full
Browser+Headless variants; most others stop at the `Injectable` tier and are shared across
platforms. Many injectable classes are near-empty (e.g. `InjectableRemoteService`, 6 LOC, just
`extends RemoteService`); they exist to fix the tier in the graph and to declare late-bound
handler fields. The Obsidian plugin adds a fifth concrete hub, `ObsidianServiceHub extends
InjectableServiceHub` (`src/modules/services/ObsidianServiceHub.ts`).

### The late-binding mechanism — `HandlerUtils.ts`

The key DI idiom is **late-bound handlers**, not constructor injection of implementations.
`services/lib/HandlerUtils.ts` (737 LOC) exports a `handlers<T>()` builder returning a family of
registration strategies:

- `.binder("name")` / `.lazyBinder("name")` — a single assignable handler (`Binder` /
  `LazyBinder`). Injectable services declare methods this way, e.g.
  `InjectableAPIService.addLog = handlers<IAPIService>().binder("addLog")` — the method body is
  supplied at runtime by the host via `.assign(callback)`, throwing if invoked unassigned
  (or, for lazy, waiting until assigned).
- `.all` / `.bailFirstFailure` — run all registered handlers sequentially (until one returns
  false, for the bail variant).
- `.allParallel` / `.dispatchParallel` — run all in parallel.
- `.anySuccess` — succeed if any handler succeeds.
- `.firstResult` — return the first non-undefined result.

This is what turns the lifecycle/event fields on `AppLifecycleService` (`onLoad`, `onReady`,
`onUnload`, …), `DatabaseEventService`, `ConflictService`, `VaultService.isTargetFile`, etc.
into **extension points**: `serviceFeatures/*` functions call `host.services.vault.isTargetFile.
add/use(...)` (or the equivalent) to plug behaviour in, rather than the base class implementing
it. `serviceModules` register onto `fileProcessing.processFileEvent` and
`replication.processSynchroniseResult`. The result is an event-bus/middleware style layered on
top of a service locator.

### The service locator — `ServiceHub`

`services/ServiceHub.ts` (124 LOC) is an `abstract ServiceHub<T> implements IServiceHub`. It
holds one `protected abstract _xxx` per service and exposes a getter per service that prefers an
injected override (`this._injected.xxx`) over the abstract default — i.e. a service locator with
a per-slot override channel (`ServiceInstances<T>` is the override bag).
`InjectableServiceHub` (`implements/injectable/InjectableServiceHub.ts`, 162 LOC) is the
concrete assembly point: its constructor takes a bag of already-constructed services and wires
defaults for the optional ones (e.g. it constructs `InjectableRemoteService`,
`InjectableReplicationService`, `ControlService` inline if not provided), threading dependencies
between them manually. `BrowserServiceHub` and `HeadlessServiceHub` (in `services/`) are the
two reference assemblies: each `new`s every concrete service in dependency order and passes the
full bag up via `super(context, serviceInstances satisfies Required<ServiceInstances<T>>)`.

### `ControlService` — the meta-service

`base/ControlService.ts` (137 LOC) is explicitly documented in-file as "meta-service … it is
orchestrating services." It is the only base service that may depend on any other service
(constructor takes `appLifecycleService`, `replicatorService`, `settingService`,
`databaseService`, `fileProcessingService`, `APIService`). It owns the plugin's overall
control flow: `onLoad()`/`onReady()`/`onUnload()` sequence the app-lifecycle events;
`applySettings()` runs the suspend → realise-setting → commit-pending → resume dance; and
`_onLiveSyncUnload()` performs teardown (emit unload events, cancel all periodic tasks/processors,
close the local DB and active replicator, `eventHub.offAll()`). It also exposes an `activated`
promise resolved when `appLifecycle.onLoaded` fires.

### `serviceModules/` — infrastructure built on services

`ServiceModuleBase` (18 LOC) is the abstract base for modules that sit on top of services but
aren't themselves core services (file handling, DB access). It provides only a `name` (from the
constructor name) and a `_log`, and mandates that subclasses declare dependencies explicitly in
their constructors to avoid circular deps. The three service-file classes form a bridge:

- `ServiceFileAccessBase` (implements `StorageAccess`) — the storage/vault side: read/write/stat
  files and hidden files on plain paths and stubs, recursive listing with include/exclude and
  ignore-file honouring, delete/trash (pruning empty parent folders), touch tracking, and
  bridging storage file-watch events into the pipeline. Wraps a `FileAccessBase<TAdapter>`, which
  is the platform-agnostic native-FS wrapper (adapter pattern) that serialises all I/O through an
  `IStorageAccessManager` and dedupes writes by comparing existing content.
- `ServiceDatabaseFileAccessBase` (implements `DatabaseFileAccess`) — the DB side: convert
  between `UXFileInfo`/paths and PouchDB entries (`store`/`createChunks`/`storeContent`/
  `storeAsConflictedRevision`, `fetch`/`fetchEntry*`, `delete`, `getConflictedRevs`), emitting
  `EVENT_FILE_SAVED` on writes.
- `ServiceFileHandlerBase` (implements `IFileHandler`) — the policy layer above both. It holds
  `storage` and `db` and drives the bidirectional bridge: `storeFileToDB` (storage→DB with
  mtime/content diffing), `dbToStorage` (DB→storage with conflict/corruption/size guards),
  `deleteFileFromDB`, `resolveConflictedByDeletingRevision`, `createAllChunks` (semaphore-limited
  full scan). It registers `_anyHandlerProcessesFileEvent` on `fileProcessing.processFileEvent`
  and `_anyProcessReplicatedDoc` on `replication.processSynchroniseResult`.

`ServiceRebuilder` (implements `Rebuilder`) coordinates destructive rebuild/fetch flows:
`fetchLocal` / `fetchLocalDBFast` (reset local DB, pull everything from remote; the fast variant
streams a CouchDB `_changes` feed with a resumable `FastFetchCheckpoint` in small config),
`rebuildRemote` (reset remote, push local), and `rebuildEverything` (reset both). It suspends
storage↔DB reflection during the operation and can defer to next startup via `scheduleRebuild`/
`scheduleFetch` (flag file + restart).

### `serviceFeatures/` — cross-cutting features as hook registrations

These are free functions following a `useXxx(host)` convention that register handlers onto
service hooks (see inventory below). They are the "wired-in behaviour" of the DI system:
`useOfflineScanner` binds the reconciliation scan to `vault.scanVault`; `useTargetFilters`
registers a prioritised middleware chain on `vault.isTargetFile`; `usePrepareDatabaseForUse`
binds init to `databaseEvents.initialiseDatabase`; `useCheckRemoteSize`, `useRemoteConfiguration`,
`useSetupQRCodeFeature`, `useSetupURIFeature` register commands and subscribe to `eventHub`
events. Their host argument is typed as a `NecessaryServices<...>` subset — features declare
exactly which services they touch.

---

## Managers explained (DEEP)

The managers are owned by `LiveSyncLocalDB` (`src/lib/src/pouchdb/LiveSyncLocalDB.ts`, the
`pouchdb` subsystem) through the `LiveSyncManagers` aggregator. `LiveSyncLocalDB` exposes them as
`localDatabase.managers.*` and delegates most of its public entry/conflict API straight to them.

### `LiveSyncManagers` — the aggregator/lifecycle owner

`LiveSyncManagers` (161 LOC) is a plain container constructed with `{ database,
databaseService, settingService, pathService, replicatorService, APIService }`. In
`getManagerMembers()` it constructs the whole manager graph in dependency order and wires them
together:

```
ChangeManager(database)
HashManager({ settingService })
ContentSplitter({ settingService })            // from the ContentSplitter subsystem
ChunkManager = LayeredChunkManager({ changeManager, database, settingService })
ChunkFetcher({ chunkManager, replicatorService, settingService })
EntryManager({ database, hashManager, chunkManager, splitter, pathService, settingService })
ConflictManager({ entryManager, database, pathService })
```

It also owns lifecycle: `initialise()` (initialise splitter + hash function), `reinitialise()`
(teardown then rebuild + initialise), `teardownManagers()` (teardown ChangeManager, destroy
ChunkFetcher and ChunkManager), `clearCaches()`, and `prepareHashFunction()`. So `LiveSyncManagers`
is the single choke point for constructing/destroying the data-plane managers, driven by the
DB open/reset lifecycle.

### `ChangeManager` — the PouchDB change feed fan-out

`ChangeManager<T>` (132 LOC) wraps a single live PouchDB `changes({ since:"now", live:true,
include_docs:true })` feed and fans each change out to registered callbacks. Callbacks are held
as `FallbackWeakRef`s (dead refs are pruned on each dispatch) so listeners can be GC'd without
explicit deregistration — a deliberate memory-leak guard. `addCallback` returns an unregister
fn. `teardown`/`restartWatch` manage the feed. The `ChunkManager` is its principal subscriber
(to learn when chunks arrive locally).

### `HashManager` — content-addressing hash selection

Chunks are content-addressed: a chunk's DB `_id` is derived from a hash of its content, so
identical content deduplicates. `HashManagerCore` (165 LOC) is the abstract base: it derives a
salted `hashedPassphrase`/`hashedPassphrase32` from settings (`SALT_OF_ID` + a prefix of the
passphrase), toggles encryption via `settings.encrypt`, and defines `computeHash` (prefixing an
encrypted hash with `+`, `HashEncryptedPrefix`). `HashManager` (115 LOC) is the selector: from a
priority list `[XXHash64, XXHash32Raw, SHA1, PureJS, FallbackWasm, FallbackPureJS]` it picks the
first available for `settings.hashAlg` and delegates to it. The XXHash implementations
(`XXHashHashManager.ts`) use a WASM module with a WASM-fallback; the PureJS/SHA1 implementations
(`PureJSHashManager.ts`) are the always-available fallbacks retained for compatibility. Only
`EntryManager.prepareChunk` calls `computeHash`.

### `LayeredChunkManager` (aka `ChunkManager`) — the chunk read/write engine

`LayeredChunkManager` (309 LOC, re-exported as `ChunkManager` by the 2-line `ChunkManager.ts`) is
the heart of chunk storage. It runs each request through an ordered chain of middleware layers,
each getting a `next` continuation for items it didn't handle:

- **Read pipeline: `Cache → Database → ArrivalWait`.**
  - `CacheLayer` (206 LOC) — in-memory LRU keyed by id, plus a reverse content→id index
    (`getChunkIDFromCache`) used for write-time dedup; serves hits, forwards misses.
  - `DatabaseReadLayer` (99 LOC) — bulk `allDocs({ keys, include_docs })`; forwards genuine 404s
    downstream, throws `LiveSyncError` on other row errors.
  - `ArrivalWaitLayer` (124 LOC) — terminal layer for chunks absent locally: emits
    `EVENT_MISSING_CHUNKS` (unless `preventRemoteRequest`) and awaits each chunk's arrival with a
    timeout (default 15 s; `timeout <= 0` → immediate all-`false`). `onChunkArrived`/
    `onMissingChunk` resolve the waiters.
- **Write pipeline: `(HotPack →) Database → Cache`.**
  - `HotPackLayer` (20 LOC) — a pass-through placeholder (currently disabled in the pipeline
    array); intended for "hot pack" bundling. `processed.hotPack` is never incremented.
  - `DatabaseWriteLayer` (65 LOC) — `bulkDocs` with `new_edits: !options.force`; treats 409s as
    `duplicated`, throws on other failures. Carries a `// TODO: Handle conflict resolution`.
  - `CacheLayer` (again) — caches written chunks and reports `processed.cached`.

The manager subscribes to `ChangeManager` (`onChange` routes `leaf`-type docs to
`arrivalWaitLayer.onChunkArrived`), and to `EVENT_CHUNK_FETCHED` / `EVENT_MISSING_CHUNK_REMOTE`
from the `ChunkFetcher`. It exposes `read(ids, options, preloadedChunks?)`,
`write(chunks, options, origin)`, cache helpers, and a `transaction()` that counts concurrent
transactions and runs a (currently empty) `_stabilise()`/`__stabilise()` hook when the count
returns to zero — a placeholder for hot-pack flushing.

### `ChunkFetcher` — on-demand remote chunk retrieval

`ChunkFetcher` (167 LOC) closes the loop for chunks that aren't local. It listens for
`EVENT_MISSING_CHUNKS` from the `ChunkManager`, accumulates missing ids into a `queue`, and
throttles requests by `minimumIntervalOfReadChunksOnline` and `concurrencyOfReadChunksOnline`
(from settings). It splices `BATCH_SIZE=100` ids, calls
`replicatorService.getActiveReplicator().fetchRemoteChunks(ids, false)`, validates the returned
chunks, writes valid ones back via `chunkManager.write(..., { skipCache:true, force:true })`, and
regardless of write success emits `EVENT_CHUNK_FETCHED` per chunk and `EVENT_MISSING_CHUNK_REMOTE`
per still-missing id (so the `ArrivalWaitLayer` waiters resolve). It reschedules itself while the
queue is non-empty. This is what makes "receive only metadata, fetch chunk bodies on demand"
(on-demand chunking) work for CouchDB remotes.

### `EntryManager` — note ⇄ chunked-document translation

`EntryManager` (`EntryManager/EntryManager.ts`, 113 LOC) is a thin OO facade over free functions
in `EntryManagerImpls.ts` (646 LOC); the facade builds a `serviceHost` shim
(`{ services: { setting, path } }`) and forwards. It is the read/write path for note documents:

- **`putDBEntry(note, onlyChunks?, conflictBaseRev?)`** → `createChunks` splits the note via the
  `ContentSplitter`, hashes each piece to a content-addressed chunk id (`prepareChunk`, using the
  cache reverse-index first, else `hashManager.computeHash`), and writes chunks in ≤2 MB buffered
  flushes through `chunkManager.write`. The parent doc (`PlainEntry`/`NewEntry`, listing the
  `children` chunk ids) is then written under a `serialized("file:"+filename)` lock, taking the
  existing `_rev` (or `conflictBaseRev`) with `{ force: true }`. Wrapped in a
  `chunkManager.transaction`.
- **`getDBEntryMeta` / `getDBEntry` / `getDBEntryFromMeta`** → load metadata, then reassemble
  content by reading `children` via `chunkManager.read`. The retrieval timeout/remote-request
  policy is computed by `computeChunkRetrievalMethod` from `waitForReady` + remote type
  (on-demand fetch vs sequential MinIO replicator vs local-only), yielding
  `LEAF_WAIT_TIMEOUT`/`LEAF_WAIT_ONLY_REMOTE`/`LEAF_WAIT_TIMEOUT_SEQUENTIAL_REPLICATOR`/0. Legacy
  `notes`-type docs and `eden` inline-chunk maps are still supported for back-compat.
- **`deleteDBEntry`** → tombstones the doc (`deleted`/`_deleted` depending on rev-deletion mode
  and `deleteMetadataOfDeletedFiles`).
- **`isTargetFile`** → `syncOnlyRegEx`/`syncIgnoreRegEx`/internal-file gating.

### `ConflictManager` — three-way merge / conflict resolution

`ConflictManager` (410 LOC) resolves PouchDB document conflicts, reading revisions through the
`EntryManager`. `tryAutoMerge(path, enableMarkdownAutoMerge)` is the entry point: it loads the
doc with `{ conflicts:true, revs_info:true }`, short-circuits identical conflicting leaves
(returns them for no-new-revision resolution), and otherwise attempts an automatic merge if the
path qualifies (`isSensibleMargeApplicable` for text, `isObjectMargeApplicable` for JSON). The
merge finds a common base revision from `_revs_info`, then:

- `mergeSensibly` — a line-level three-way merge built on `diff-match-patch` (`diff_linesToChars_`
  → `diff_main` → `diff_charsToLines_`), reconciling the base→left and base→right diffs; on
  ambiguous edits it bails (returns `false`, one branch is even flagged `//TODO: SHOULD BE
  PANIC`). Insertions on both sides are ordered by mtime.
- `mergeObject` — a JSON key-level merge (`generatePatchObj`/`flattenObject`/`applyPatch`),
  aborting when the same key is changed to different values.

If auto-merge doesn't apply, it returns a `UserActionRequired` object (`leftRev`/`rightRev` +
leaves) for the UI to resolve. `getConflictedDoc` fetches and decodes a specific revision's
content (binary via `readString(decodeBinary(...))` for `newnote`, plain otherwise).

### `StorageEventManager` — vault file-watch → sync pipeline

`StorageEventManagerBase<TAdapter>` (689 LOC) is platform-agnostic and uses the adapter pattern
(`IStorageEventManagerAdapter` bundling typeGuard/persistence/watch/status/converter adapters);
concrete subclasses are in the app shells (`StorageEventManagerObsidian`, `StorageEventManagerCLI`,
`StorageEventManagerFSAPI`). It translates raw vault events (create/change/delete/rename/raw/
editor) into a debounced, batched, crash-recoverable processing queue feeding
`fileProcessing.process(Optional)FileEvent`:

- **Ingestion** (`appendQueue`) filters ignored/oversized/folder/non-target files, honours
  `recentlyTouched` (skips events for files this process just wrote, avoiding echo), and enqueues
  `FileEventItem`s with a random `atomicKey`.
- **Batching** — when `batchSave` is on and `liveSync` is off, CREATE/CHANGED events wait in a
  `_waitingMap` between `batchSaveMinimumDelay` and `batchSaveMaximumDelay`; a later same-file or
  same-type event, a DELETE, or `skipBatchWait` cancels/proceeds the prior wait. Concurrency is
  capped by a `Semaphore(5)`.
- **Ordering** — DELETE events push a `SENTINEL_FLUSH` marker so the queue drains (`waitForIdle`)
  before the delete runs, since a deleted file can no longer be read. `runQueuedEvents` is guarded
  by `skipIfDuplicated`.
- **Crash recovery** — the pending queue is continuously snapshotted via the persistence adapter
  (`_takeSnapshot`, throttled) and restored on startup (`_restoreFromSnapshot`, marking restored
  items `skipBatchWait`). `restoreState()` sets `snapShotRestored`, awaited by `beginWatch`.
- **Status** — `updateStatus` pushes `{ batched, processing, totalQueued }` counts to the UI via
  the status adapter.

Rename is decomposed into an atomic DELETE(oldPath)+CREATE(new) pair (both `skipBatchWait`).
`StorageProcessingManager.ts` provides a small companion `StorageAccessManager` (per-path
`serialized` read/write locks + a bounded `touchedFiles` recency ring buffer).

---

## Function/class inventory

*(Managers are described in prose above; this section captures the service infrastructure and
feature/module functions in list form. Signatures are given where load-bearing.)*

### `services/base/` classes (all `extends ServiceBase<T>` unless noted)

- **`APIService`** (abstract, `IAPIService`) — host-app API abstraction: `getCustomFetchHandler`,
  `addLog`, `isMobile`, `showWindow`/`showWindowOnRight`, `getAppID`/`getSystemVaultName`/
  `getPlatform`/`getAppVersion`/`getPluginVersion`, `getCrypto`, `addCommand`, `registerWindow`,
  `addRibbonIcon`, `registerProtocolHandler`, `get confirm`, `webCompatFetch`/`nativeFetch`
  (`nativeFetch` throws by default), `setInterval`/`clearInterval`, `addStatusBarItem`,
  `getSystemConfigDir`; reactive `requestCount`/`responseCount`, `get isOnline`.
- **`AppLifecycleService`** (abstract, `IAppLifecycleService`) — lifecycle event bus (`onLoad`,
  `onInitialise`, `onReady`, `onLoaded`, `onUnload`, `onSuspending`/`onResuming`/`onResumed`, …
  all handler fields) + ready/suspended state (`isReady`/`markIsReady`, `isSuspended`/
  `setSuspended`) + restart (`performRestart`/`askRestart`/`scheduleRestart`, abstract).
- **`ConfigService`** (abstract, `IConfigService`) — `getSmallConfig`/`setSmallConfig`/
  `deleteSmallConfig` (abstract kv store).
- **`ConflictService`** (abstract, `IConflictService`) — queue/resolve conflicts:
  `queueCheckFor(IfOpen)`, `ensureAllProcessed`, `resolve`, `resolveByNewest`,
  `resolveByDeletingRevision`, `resolveAllConflictedFilesByNewerOnes`, `resolveByUserInteraction`
  (firstResult hook), reactive `conflictProcessQueueCount`.
- **`DatabaseEventService`** (abstract, `IDatabaseEventService`) — pure hook hub for local-DB
  lifecycle (`onDatabaseInitialisation`/`onDatabaseInitialised`/`onResetDatabase`/
  `onCloseDatabase`/`onUnloadDatabase`/`onDatabaseHasReady`/`initialiseDatabase`).
- **`DatabaseService`** (abstract, `IDatabaseService`; deps `{path,vault,setting,API}`) — owns the
  `LiveSyncLocalDB`: `createPouchDBInstance`, `openDatabase`, `isDatabaseReady`, `resetDatabase`,
  `get localDatabase`/`localDatabaseDirect`.
- **`FileProcessingService`** (concrete, `IFileProcessingService`) — file-event dispatch:
  `processFileEvent`/`processOptionalFileEvent` (anySuccess hooks), `commitPendingFileEvents`,
  `onStorageFileEvent`, reactive `batched`/`processing`/`totalQueued`.
- **`KeyValueDBService`** (abstract, `IKeyValueDBService`; deps `{databaseEvents,vault,
  appLifecycle}`) — owns the `<vault>-livesync-kv` IndexedDB store: `openSimpleStore`,
  `get simpleStore`/`kvDB`; opens/closes/resets in step with DB + setting lifecycle.
- **`PathService`** (abstract, `IPathService`; deps `{settingService}`) — id↔path conversion:
  `id2path`, `path2id`, `getPath`, `compareFileFreshness`, `markChangesAreSame`/`unmarkChanges`/
  `isMarkedAsSameChanges` (abstract), `normalizePath`.
- **`RemoteService`** (abstract, `IRemoteService`; deps `{APIService,appLifecycle,setting}`) —
  remote CouchDB/compat client: `connect(uri, auth, disableRequestURI, passphrase, …)`,
  `performFetch`, `get hadLastPostFailedBySize`, `showError`/`clearErrors`. Owns an
  `UnresolvedErrorManager`.
- **`ReplicationService`** (abstract, `IReplicationService`) — replication workflow:
  `isReplicationReady`, `performReplication`, `replicate`/`replicateByEvent` (throttled),
  `replicateAllToRemote`/`replicateAllFromRemote`, `markLocked`/`markUnlocked`/`markResolved`,
  result-processing hooks (`processSynchroniseResult`, `parseSynchroniseResult`,
  `processVirtualDocument`, …), reactive `databaseQueueCount`/`storageApplyingCount`/
  `replicationResultCount`. Delegates transfer to `replicatorService.getActiveReplicator()`.
- **`ReplicatorService`** (abstract, `IReplicatorService`) — owns the single active replicator's
  lifecycle: `getActiveReplicator`, `getNewReplicator` (firstResult factory, supplied
  externally), selects by `remoteType` (CouchDB/MinIO/P2P), disposes/recreates on reset/init,
  clears salts; reactive `replicationStatics`.
- **`SettingService`** (abstract, `ISettingService`; deps `{APIService}`) — central settings
  store: `loadSettings`/`saveSettingData`, `currentSettings`, `updateSettings`, `applyPartial`/
  `applyExternalSettings`, `adjustSettings` (migrations), `decryptSettings`/encrypt-decrypt of
  connection fields, passphrase handling, device/vault name, small-config, and setting lifecycle
  hooks (`onRealiseSetting`, `onSettingLoaded`/`Changed`/`Saved`, `suspendAllSync`, …). Storage
  primitives (`saveData`/`loadData`/`getItem`/…) abstract.
- **`TestService`** (abstract, `ITestService`) — `test`/`testMultiDevice` (bailFirstFailure
  hooks), `addTestResult`.
- **`TweakValueService`** (abstract, `ITweakValueService`) — reconcile local vs remote tweak
  settings: `fetchRemotePreferred`, `checkAndAskResolvingMismatched`, `askResolvingMismatched`,
  `checkAndAskUseRemoteConfiguration`, `askUseRemoteConfiguration`.
- **`UnresolvedErrorManager`** (plain class; ctor takes `AppLifecycleService`) — dedup error/
  notice registry: `showError`, `clearError`/`clearErrors`, `countErrors`; emits
  `EVENT_ON_UNRESOLVED_ERROR`. Instantiated ad-hoc by Remote/Replication/Replicator services.
- **`VaultService`** (abstract, `IVaultService`; deps `{settingService,APIService}`) — vault/FS
  abstraction: `vaultName`/`getVaultName`, `scanVault`, `isTargetFile`/`isTargetFileInExtra`/
  `isIgnoredByIgnoreFile` (hooks), `isFileSizeTooLarge`, `shouldCheckCaseInsensitively`,
  `getActiveFilePath`/`isStorageInsensitive`/`isValidPath` (abstract).

### `services/lib/`

- **`HandlerUtils.ts`** — `handlers<T>()` builder + strategy classes `Binder`, `LazyBinder`,
  `MultiBinder`, `Dispatch`, `DispatchParallel`, and `*Handler` families (`AllHandler`,
  `AnySuccessHandler`, `FirstResultHandler`, `BooleanHandlerBase`, …) and matching factory
  functions. The single-binder `assign()` throws if a handler is already assigned unless
  `override`; `invoke()` throws if unassigned.
- **`logUtils.ts`** — `createInstanceLogFunction(serviceName, APIService?)` (prefixes `[name]`
  below NOTICE level, routes through `APIService.addLog` or global `Logger`); markers
  `MARK_LOG_SEPARATOR`, `MARK_LOG_NETWORK_ERROR`.

### `serviceModules/`

- **`ServiceModuleBase`** — abstract base (`name`, `_log`).
- **`FileAccessBase<TAdapter>`** — native FS wrapper (adapter pattern): `isFile`/`isFolder`,
  `getPath`/`normalisePath`, `nativeFileToUXFileInfoStub`, `adapter*`/`vault*` read/write/list/
  append/remove ops (serialised via storage-access manager, write-deduped by content),
  `delete`/`trash`, `getAbstractFileByPath`, `touch`/`recentlyTouched`, `reconcileInternalFile`.
- **`ServiceFileAccessBase`** (`StorageAccess`) — see infrastructure section above.
- **`ServiceDatabaseFileAccessBase`** (`DatabaseFileAccess`) — see above.
- **`ServiceFileHandlerBase`** (`IFileHandler`) — see above; `storeFileToDB`, `dbToStorage`,
  `deleteFileFromDB`, `createAllChunks`, event handlers.
- **`ServiceRebuilder`** (`Rebuilder`) — `$performRebuildDB`, `fetchLocal`, `fetchLocalDBFast`
  (checkpointed CouchDB streaming), `rebuildRemote`, `rebuildEverything`, `resetLocalDatabase`,
  `scheduleRebuild`/`scheduleFetch`, `suspend/resumeReflectingDatabase`, `finishRebuild`.
- **`adapters/`** — `IFileSystemAdapter` composite over `IPathAdapter`, `ITypeGuardAdapter`,
  `IConversionAdapter`, `IStorageAdapter` (raw I/O), `IVaultAdapter` (high-level vault ops).

### `serviceFeatures/` (exported functions)

- **`offlineScanner.ts`** — `performFullScan` (orchestrator, overloaded), `useOfflineScanner`,
  `synchroniseAllFilesBetweenDBandStorage`, `getFilePairState`/`resolveFilePairAction`
  (state→action matrix; modes `DB_APPLY`/`NEWER_WINS`, extras `ExtraOnRemote`/`ExtraOnLocal`),
  `collectFilesOnStorage`/`collectDatabaseFiles`, `syncFileBetweenDBandStorage`,
  `updateToDatabase`/`updateToStorage`, `collectDeletedFiles`, `canProceedScan`, `convertCase`,
  `getPathFromEntry`, `normaliseFullScanOptions`. Persists a per-file last-seen-mtime
  `fileStatusMap` in the KV DB to distinguish offline deletion from never-synced under
  NEWER_WINS.
- **`checkRemoteSize.ts`** — `onNotifyRemoteSizeNotConfiguredFactory`,
  `onNotifyRemoteSizeExceedFactory`, `scanAllStat`, `useCheckRemoteSize`.
- **`remoteConfig.ts`** — `migrateLegacyRemoteConfigurationsInPlace`,
  `createRemoteConfigurationId`, `migrateP2PActiveRemoteConfigurationIdInPlace`,
  `migrateToMultipleRemoteConfigurations`, `activateRemoteConfiguration`,
  `activateP2PRemoteConfiguration`, `commandSwitchActiveRemote`,
  `commandReplicateWithSpecificRemote`, `useRemoteConfigurationMigration`,
  `useRemoteConfiguration`.
- **`targetFilter.ts`** — `isAcceptedAlwaysFactory` (pri 100),
  `isAcceptedInFilenameDuplicationFactory` (pri 10), `isAcceptedByLocalDBFactory` (pri 30),
  `isAcceptedByIgnoreFilesFactory` (pri 20), `useTargetFilters`.
- **`prepareDatabaseForUse.ts`** — `prepareDatabaseForUse`, `usePrepareDatabaseForUse`.
- **`setupObsidian/`** — `encodeSetupSettingsAsQR`/`useSetupQRCodeFeature`;
  `copySetupURI`/`copySetupURIFull`/`askEncryptingPassphrase`/`useSetupURIFeature`;
  `SetupFeatureHost` type.

---

## Dependencies / Consumed by

**Consumes (upstream):**
- `octagonal-wheels` (external) — concurrency (`serialized`, `skipIfDuplicated`, `Semaphore`,
  task/processor cancellation), `promiseWithResolvers`, `FallbackWeakRef`, `ReactiveSource`,
  hashing (`mixedHash`, XXHash WASM), logger, `SimpleStore`.
- Sibling commonlib subsystems: `common/types` (the `EntryDoc`/`LoadedEntry`/`SavingEntry`/…
  type universe), `pouchdb/LiveSyncLocalDB` (the DB the managers wrap), `replication/*`
  (`LiveSyncAbstractReplicator`), `ContentSplitter/*`, `hub/hub` (`eventHub` + core events),
  `interfaces/*` (`StorageAccess`, `DatabaseFileAccess`, `IFileHandler`, `Rebuilder`,
  `StorageEventManager`, adapter interfaces), `string_and_binary/path`, `common/utils`,
  `diff-match-patch` (external, in ConflictManager).

**Consumed by (downstream):**
- **`LiveSyncLocalDB`** (`src/lib/src/pouchdb/`) constructs `LiveSyncManagers` and delegates its
  entry/conflict API to `managers.entryManager` / `managers.conflictManager`
  (`getDBEntry`, `putDBEntry`, `deleteDBEntry`, `getConflictedDoc`, `tryAutoMerge`, …). This is
  the primary manager consumer.
- **Application shells** build the concrete service hubs and storage-event managers:
  `ObsidianServiceHub extends InjectableServiceHub` and `StorageEventManagerObsidian extends
  StorageEventManagerBase` (`src/`); `StorageEventManagerCLI`/`CLIServiceModules` (`src/apps/cli`);
  `StorageEventManagerFSAPI`/`FSAPIServiceModules` (`src/apps/webapp`); `BrowserServiceHub` used
  by the web/peer app (`src/apps/webpeer`).
- **Core + feature modules** receive the hub as `services: InjectableServiceHub` in their
  `onBindFunction(core, services)` (`LiveSyncBaseCore`, `ModuleLiveSyncMain`,
  `ModuleConflictChecker`/`Resolver`, `ModuleResolveMismatchedTweaks`, `CmdConfigSync`,
  `CmdHiddenFileSync`, …). Features call `serviceFeatures` `useXxx(host)` functions to register
  their behaviour onto service hooks.

---

## Design observations (factual)

- **Two DI idioms coexist.** The system is simultaneously a service locator (`ServiceHub` with a
  fixed slot per service + injected-override channel) and a handler/event bus (`HandlerUtils`
  late-binding). Behaviour is split between class methods and externally-assigned handler fields,
  so understanding "what a service actually does" often requires finding the `useXxx`/`.assign`/
  `.add` call sites, not just reading the class. This is powerful but indirect.
- **Deep, wide inheritance for services.** The `ServiceBase → base → injectable → {browser,
  headless,obsidian}` chain produces many near-empty files (several injectable classes are 4–7
  LOC), and the tier is inconsistent per service (only API/Database reach Browser+Headless). The
  ratio of scaffolding files to behaviour is high.
- **Manual, order-sensitive hub assembly.** `InjectableServiceHub`, `BrowserServiceHub`, and
  `HeadlessServiceHub` each hand-construct and thread dependencies between ~18 services in a fixed
  order; `InjectableServiceHub` carries a `// TODO reorder to resolve dependencies` comment. There
  is no automatic dependency resolution — a wiring change touches all three hubs.
- **`LiveSyncManagers` is a small god-assembler; `ControlService`/`StorageEventManager` are the
  large coordinators.** `LiveSyncManagers` centralises manager construction (good), but the actual
  complexity concentrates in `StorageEventManagerBase` (689 LOC — batching, ordering, semaphores,
  crash-snapshotting, and platform event routing in one class) and the merge logic in
  `ConflictManager` (410 LOC of hand-rolled three-way diff/merge, one branch self-labelled
  `//TODO: SHOULD BE PANIC`). These two are the highest-complexity/hardest-to-test units in the
  subsystem (reflected by their 1600/1000-LOC spec files).
- **Placeholder/half-built machinery in the chunk pipeline.** `HotPackLayer` is a pass-through,
  the write-pipeline array has it commented out, `ChunkManager.__stabilise()` and
  `transaction()`'s stabilisation are empty hooks, and `DatabaseWriteLayer` carries a
  `// TODO: Handle conflict resolution` on the 409 path. The layered architecture anticipates a
  "hot pack" bundling feature that is not yet implemented.
- **Free-function managers with an OO shim.** `EntryManager` is a facade whose real logic lives in
  `EntryManagerImpls.ts` as free functions taking a synthesised `serviceHost`/`NecessaryManagers`
  bag. This keeps the functions unit-testable in isolation but means the `EntryManager` class
  itself is almost pure delegation, and the `serviceHost` shim (`{ services: { setting, path },
  serviceModules: {} }`) is a small impedance-matcher between the two styles.
- **Global mutable state in the offline scanner.** The reconciliation scanner keeps module-level
  singletons (`fileMaps`, `saveFileStatusTimeout`) rather than per-host state — safe for the
  single-instance assumption, but a latent hazard if multiple hosts ever coexist in one process
  (flagged by the inventory).
- **Self-flagged uncertainty in file/DB sync policy.** `ServiceFileHandlerBase` contains author
  comments explicitly stating the deletion-with-conflicts semantics are not fully verified
  ("BUT I NOTICED THAT I AM NOT SURE"), and `ServiceFileAccessBase.removeHidden` has an
  un-awaited Promise in a truthiness guard that appears to make that branch effectively dead —
  both candidate latent bugs, reported here as-found without fixes.
- **Coupling to `settings.currentSettings()` is pervasive.** Managers and layers read the live
  settings object directly on nearly every operation (chunk intervals, hash algorithm, cache size,
  target regexes, remote type). Behaviour is therefore highly setting-dependent and settings
  changes generally require a manager `reinitialise()`/`ControlService.applySettings()` cycle
  rather than being picked up transparently.
</content>
</invoke>

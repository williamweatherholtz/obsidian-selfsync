# Obsidian Sync Core & Managers

> Scope: `src/modules/core/`, `src/modules/coreObsidian/`, `src/managers/`. This is the
> **Obsidian-side glue** over the platform-agnostic replication engine that lives in
> `src/lib/` (the "commonlib", vendored copy of `octagonal-wheels` + the plugin's shared
> `@lib` tree). It drives *when* replication runs, turns raw Obsidian vault events into the
> shared file-event pipeline, and turns pulled remote documents back into vault writes.
> Verified by reading every file in scope plus the boundary classes
> (`ReplicationService`, `StorageEventManagerBase`, `LiveSyncCouchDBReplicator`,
> `AbstractModule`).

## Purpose & responsibilities

This subsystem is a thin orchestration layer with five jobs:

1. **Select which replicator implementation to use** for the configured remote type
   (CouchDB / MinIO-journal / P2P) — `ModuleReplicatorCouchDB`, `ModuleReplicatorMinIO`.
2. **Decide *when* to replicate** — on start, on save, on a timer, on resume —
   `ModuleReplicatorCouchDB._everyAfterResumeProcess`, `ModulePeriodicProcess`, and the
   `EVENT_FILE_SAVED` hook in `ModuleReplicator`.
3. **Process remote-change results into the vault** — `ModuleReplicator._parseReplicationResult`
   hands pulled docs to `ReplicateResultProcessor`, which queues, de-dupes, gathers full
   content, and applies each note to storage.
4. **Convert Obsidian vault events into the shared storage-event pipeline** —
   `StorageEventManagerObsidian` + `ObsidianStorageEventManagerAdapter` adapt Obsidian's
   `vault.on(...)` callbacks and `TFile` objects into the platform-agnostic
   `StorageEventManagerBase`.
5. **Provide Obsidian-native conversion + UI primitives** — `utilObsidian.ts` (TFile →
   `UXFileInfo`) and `dialogs.ts` (modal dialogs used for the locked/cleaned prompts).

None of these files implement the replication protocol itself; they are wiring around the
commonlib engine (see Boundary section).

## Files & LOC (table)

| File | LOC | Role |
|------|-----|------|
| `src/modules/core/ReplicateResultProcessor.ts` | 486 | Remote→local: queue, de-dupe, gather, apply pulled docs to vault |
| `src/modules/core/ModuleReplicator.ts` | 291 | Central replication module: wires handlers, owns the processor, handles replication-failed dialogs |
| `src/modules/core/ModuleReplicatorCouchDB.ts` | 42 | Factory for `LiveSyncCouchDBReplicator`; opens continuous/eventual replication on resume |
| `src/modules/core/ModulePeriodicProcess.ts` | 41 | Timer-driven periodic replication |
| `src/modules/core/ModuleReplicatorMinIO.ts` | 18 | Factory for `LiveSyncJournalReplicator` (MinIO/object-storage journal sync) |
| `src/modules/coreObsidian/UILib/dialogs.ts` | 333 | Obsidian modal dialogs (input, select, message box with countdown) |
| `src/modules/coreObsidian/storageLib/utilObsidian.ts` | 124 | TFile/internal-file → `UXFileInfo`/`UXFileInfoStub` converters |
| `src/managers/ObsidianStorageEventManagerAdapter.ts` | 137 | Composite adapter: type-guard, persistence, watch, status, converter for Obsidian |
| `src/managers/StorageEventManagerObsidian.ts` | 44 | Obsidian subclass of `StorageEventManagerBase`; adds internal-file raw-event handling |
| **Total** | **1516** | |

## Key types / data structures

- **`ReplicateResultProcessorState`** (`ReplicateResultProcessor.ts:28`): `{ queued: [], processing: [] }`
  of `PouchDB.Core.ExistingDocument<EntryDoc>`. Persisted to `core.kvDB` under
  `KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT` for crash recovery.
- **`_queuedChanges` / `_processingChanges`** (arrays of existing docs): the in-flight
  work lists inside the processor; their combined length is published to
  `services.replication.replicationResultCount`.
- **`FileEventItem` / `FileEvent` / `FileEventItemSentinel`** (from `@lib/common/types`,
  `@lib/managers/StorageEventManager`): the shared storage-event queue element. Local
  events are converted into these by the adapter's converter.
- **`UXFileInfo` / `UXFileInfoStub` / `UXInternalFileInfoStub` / `UXFolderInfo`** (from
  `@lib/common/types`): the platform-neutral file abstractions produced by `utilObsidian.ts`
  from Obsidian `TFile`/`TFolder`. Stubs carry metadata only; `UXFileInfo` carries a `body: Blob`.
- **`EntryDoc` / `AnyEntry` / `LoadedEntry` / `MetaEntry` / `EntryLeaf`** (from
  `@lib/common/types`): the CouchDB document shapes. `EntryLeaf` = a content chunk;
  `MetaEntry`/`LoadedEntry` = note metadata (+ gathered content).
- **`RemoteType`** and constants `REMOTE_MINIO`, `REMOTE_P2P` (from `@lib/common/types`):
  drive replicator selection.
- The five **adapter interfaces** (`IStorageEventTypeGuardAdapter`,
  `IStorageEventPersistenceAdapter`, `IStorageEventWatchAdapter`, `IStorageEventStatusAdapter`,
  `IStorageEventConverterAdapter`, aggregated by `IStorageEventManagerAdapter`) — implemented
  per-concern in `ObsidianStorageEventManagerAdapter.ts`.

## Control & data flow (DEEP)

All these modules extend `AbstractModule` and register callbacks in `onBindFunction(core, services)`.
`services` is a set of `handlers<...>()` event buses (see `ReplicationService`). The plugin
core fires these buses; the modules react. So the wiring is **event/handler-driven**, not a
straight call chain.

### Local → remote (a vault change gets sent)

1. **Obsidian raw event.** `ObsidianWatchAdapter.beginWatch` registers
   `plugin.app.vault.on("create"|"modify"|"delete"|"rename"|"raw")` and
   `workspace.on("editor-change")` (`ObsidianStorageEventManagerAdapter.ts:106-114`). The
   base class's `watchVault*` handlers receive them.
2. **Convert + enqueue.** Each handler converts the `TFile` via
   `ObsidianConverterAdapter.toFileInfo` → `TFileToUXFileInfoStub` (`utilObsidian.ts:85`) and
   calls `StorageEventManagerBase.appendQueue`. `appendQueue` filters (ignored paths,
   dotfiles, folders, too-large, `isTargetFile`, `recentlyTouched`), then `enqueue`s a
   `FileEventItem`. A `DELETE` pushes a `SENTINEL_FLUSH` first so pending batch saves drain
   before the delete. Rename is decomposed into `DELETE(oldPath)+CREATE` with
   `skipBatchWait` (`StorageEventManager.ts:649`).
3. **Batch/debounce.** `runQueuedEvents` (serialized via `skipIfDuplicated`) drains
   `bufferedQueuedItems` under a `Semaphore(5)`; `processFileEvent` applies batch-save
   waiting (`_addWaiting`, bounded by `batchSaveMinimumDelay`/`batchSaveMaximumDelay`, only
   when `shouldBatchSave` = `batchSave && !liveSync`). A newer same-file/same-type event or a
   DELETE cancels the pending wait. A snapshot is persisted (`storage-event-manager-snapshot`
   via `ObsidianPersistenceAdapter`) at each step for crash recovery.
4. **Hand to file-processing.** `handleFileEvent` calls
   `fileProcessing.processFileEvent(queue)` (or `processOptionalFileEvent` for INTERNAL
   files). **This is the boundary out of this subsystem** — DB write / chunking lives in
   `FileProcessingService` (commonlib) and the storage-→DB modules, not here.
5. **Internal (config) files.** `StorageEventManagerObsidian._watchVaultRawEvents` (override)
   gates on `syncInternalFiles`/`usePluginSync`/`watchInternalFileChanges`, checks the path is
   under `API.getSystemConfigDir()`, and enqueues an `INTERNAL` event with `skipBatchWait: true`.
6. **Trigger replication.** Independently, when a file is saved the core fires
   `EVENT_FILE_SAVED`; `ModuleReplicator._everyOnloadAfterLoadSettings` (registered on
   `onSettingLoaded`) schedules `services.replication.replicateByEvent()` after 250 ms
   (`scheduleTask("perform-replicate-after-save", 250, ...)`) when `syncOnSave` is set and the
   app is not suspended. `replicateByEvent` (commonlib) rate-limits via
   `shareRunningResult`/`syncMinimumInterval`.

### Remote → local (a pulled doc becomes a vault file)

1. **Replicator emits results.** `LiveSyncCouchDBReplicator.replicationChangeDetected`
   (`LiveSyncReplicator.ts:239`) on a `pull` direction calls
   `services.replication.parseSynchroniseResult(e.change.docs)`. The journal and Trystero/P2P
   replicators do the same (`JournalSyncCore.ts:132/166`, `LiveSyncTrysteroReplicator.ts:105`).
   This is the **primary inbound entry point** into this subsystem.
2. **Module receives.** `ModuleReplicator._parseReplicationResult` (registered as the
   `parseSynchroniseResult` handler, `ModuleReplicator.ts:269`) calls
   `this.processor.enqueueAll(docs)` and returns immediately (fire-and-forget queueing).
3. **Classify + enqueue** (`ReplicateResultProcessor.enqueueAll` → `processIfNonDocumentChange`):
   - **Chunk** (`isChunk(id)`) → `localDatabase.onNewLeaf(change)` and done (chunks are stored,
     not applied to the vault).
   - **`versioninfo`** → if `change.version > VER`, call `core.replicator.closeReplication()`
     and warn the user to update the plugin (incompatible remote).
   - **`SYNCINFO_ID` / `_design*`** → skipped.
   - Otherwise → `enqueueChange`, which **de-dupes by `_id`**: an already-queued doc with the
     same `_rev` is dropped; a newer one of the same deleted-state replaces the old queued entry
     (latest-wins batching). Then `triggerTakeSnapshot` (throttled 50 ms) + `triggerProcessQueue`.
4. **Drain queue** (`runProcessQueue`): guarded against re-entrance (`_isRunningProcessQueue`)
   and suspension (`isSuspended` = local flag OR app not ready OR
   `suspendParseReplicationResult` OR app suspended). It loops shifting docs, acquiring a
   `Semaphore(10)` slot (acquired-then-immediately-released as a *pacing* gate — see
   Observations), pushing to `_processingChanges`, and firing `parseDocumentChange(doc)`
   **without awaiting** (`void`), so up to the queue's worth run concurrently.
5. **Parse** (`parseDocumentChange`, "Phase 1"): skips notes newer than
   `maxMTimeForReflectEvents`; lets `services.replication.processVirtualDocument` claim it
   first (customization-sync docs); for notes, checks `vault.isTargetFile` and
   `isFileSizeTooLarge` (using the *metadata* size), then calls `applyToDatabase`. Always
   removes itself from `_processingChanges` in `finally`.
6. **Apply to DB** (`applyToDatabase` → `_applyToDatabase`, "Phase 2"): wrapped in
   `withCounting(services.replication.databaseQueueCount)` and a real `Semaphore(10)`
   acquire, and **serialized per `_id`** (`serialized("replication-process:"+id)`) to avoid
   same-doc races. `checkIsChangeRequiredForDatabaseProcessing` reads the local doc with
   `conflicts`/`revs_info`: process if conflicts exist or rev is latest; skip if the rev was
   already inserted. If not deleted, it **gathers full content** via
   `localDatabase.getDBEntryFromMeta` (this is where missing chunks are fetched — the comment
   notes chunks may still be arriving). Then either
   `services.replication.processOptionalSynchroniseResult` claims it (hidden/plugin files) or,
   if the path is valid, `applyToStorage`.
7. **Apply to storage** (`applyToStorage`, "Phase 3"): `withCounting(storageApplyingCount)` →
   `services.replication.processSynchroniseResult(entry)`. **This is the boundary out** — the
   actual vault write happens in the commonlib handler chain (a storage-writing module), not
   in this file.

### Crash recovery & suspension

- The processor persists `{queued, processing}` to `kvDB` on every mutation
  (throttled). On DB init (`_everyOnDatabaseInitialized`) and before replicate
  (`_everyBeforeReplicate`) it calls `restoreFromSnapshotOnce`, which re-enqueues both lists
  (processing items are treated as un-applied and re-run — at-least-once semantics).
- `EVENT_SETTING_SAVED` suspends/resumes the processor based on
  `suspendParseReplicationResult`.

### Replication-failure handling

`ModuleReplicator.onReplicationFailed` (registered on `onReplicationFailed`) handles: tweak
mismatch (`askResolvingMismatched`), remote-locked-and-not-accepted (offers Fetch / Unlock /
Dismiss via `askSelectStringDialogue`, or the legacy `cleaned()` flow for the IndexedDB
adapter). `cleaned()` is marked `@deprecated v0.24.17`.

## Boundary to commonlib replication engine

Everything under `@lib/` (`src/lib/`) and `octagonal-wheels` is the commonlib. This subsystem
talks to it through **service handler buses** and a few concrete classes:

**Outbound calls this subsystem makes into commonlib:**

- `services.replication.parseSynchroniseResult` — *received* here (inbound), emitted by the
  replicators.
- `services.replication.processVirtualDocument(change)` — lets another module claim a doc.
- `services.replication.processOptionalSynchroniseResult(dbDoc)` — hidden/plugin-file claim.
- `services.replication.processSynchroniseResult(entry)` — **the actual vault write** (Phase 3).
- `services.replication.replicate()` / `replicateByEvent()` — trigger a sync cycle.
- `services.replication.isReplicationReady(showMessage)` — pre-flight gate.
- `services.replication.replicationResultCount` / `databaseQueueCount` / `storageApplyingCount`
  — reactive counters this subsystem writes for the status UI.
- `services.replicator.getActiveReplicator()` / `getNewReplicator` (factory bus) /
  `onReplicatorInitialised`.
- `core.replicator.openReplication(settings, continuous, showMessage, ...)` /
  `closeReplication()`.
- `services.appLifecycle` (isReady/isSuspended/onResumed/onUnload/onSuspending/scheduleRestart),
  `services.setting`, `services.vault` (isTargetFile/isFileSizeTooLarge/isValidPath),
  `services.API` (isOnline/isMobile/getSystemConfigDir), `services.tweakValue`, `core.rebuilder`.
- `localDatabase.getDBEntryFromMeta`, `getRaw`, `onNewLeaf`, `clearCaches`;
  `purgeUnreferencedChunks`, `balanceChunkPurgedDBs` (`@lib/pouchdb/chunks`).

**Concrete replicator classes instantiated here:**

- `LiveSyncCouchDBReplicator` (`ModuleReplicatorCouchDB._anyNewReplicator`).
- `LiveSyncJournalReplicator` (`ModuleReplicatorMinIO._anyNewReplicator`).
- Both are `LiveSyncAbstractReplicator` subclasses; the abstract type is the interface.

**Storage-event boundary:** `StorageEventManagerObsidian extends StorageEventManagerBase`
(commonlib). The base owns the queue/batch/snapshot logic; the Obsidian layer supplies only
the `ObsidianStorageEventManagerAdapter` (five concern-specific adapters) and the
internal-file raw-event override. Downstream, the base calls
`fileProcessing.processFileEvent` / `processOptionalFileEvent` — the DB-write side is
commonlib.

The net boundary: **this subsystem never reads/writes CouchDB documents or the vault
directly for replication payloads** — it queues, de-dups, gathers content via
`localDatabase`, and delegates the actual write to `processSynchroniseResult`. It owns
scheduling, adaptation, and result-queue orchestration only.

## Function/class inventory

### `ReplicateResultProcessor.ts`
- `class ReplicateResultProcessor` — the remote→local result pump owned by `ModuleReplicator`.
- `get localDatabase / services / core` — accessors delegating to `replicator.core`.
- `getPath(entry)` — `services.path.getPath`.
- `suspend() / resume()` — toggle `_suspended`; resume kicks `runProcessQueue`.
- `get isSuspended` — composite of local flag, app-ready, `suspendParseReplicationResult`,
  app-suspended.
- `_takeSnapshot() / _triggerTakeSnapshot() / triggerTakeSnapshot(throttle 50ms)` — persist
  `{queued, processing}` to kvDB and update status.
- `restoreFromSnapshot() / restoreFromSnapshotOnce()` — re-enqueue persisted work once.
- `withCounting(proc, countValue)` — increment/decrement a reactive counter around a proc.
- `reportStatus()` — publish queue length to `replicationResultCount`.
- `enqueueAll(changes)` — classify each; enqueue document changes.
- `processIfNonDocumentChange(change)` — handle chunk / versioninfo / syncinfo / design docs
  inline; returns whether consumed. **Non-trivial:** version-gate that closes replication on
  an incompatible remote.
- `enqueueChange(doc)` — de-dupe by `_id`/`_rev`/deleted-state, latest-wins replace, trigger
  snapshot + process.
- `triggerProcessQueue()` — fire `runProcessQueue`.
- `runProcessQueue()` — re-entrancy-guarded drain loop; per-doc pacing via `Semaphore(10)`;
  fires `parseDocumentChange` un-awaited. **Non-trivial** (see Observations re: the
  acquire-then-release pattern).
- `parseDocumentChange(change)` — Phase 1: mtime/virtual/target/size gates, then
  `applyToDatabase`; always de-lists from processing.
- `applyToDatabase(doc)` — Phase 2 wrapper: counter + semaphore + error trap.
- `_applyToDatabase(doc_)` — Phase 2.1: per-`_id` serialized; requiredness check; content
  gather; optional-processor claim vs `applyToStorage`. **Non-trivial** — the core apply
  decision.
- `applyToStorage(entry)` — Phase 3: `processSynchroniseResult` under `storageApplyingCount`.
- `checkIsChangeRequiredForDatabaseProcessing(dbDoc)` — rev/conflict analysis to skip
  already-applied revisions. **Non-trivial** — governs idempotency.

### `ModuleReplicator.ts`
- `isOnlineAndCanReplicate(errorManager, host, showMessage)` (module fn) — onBeforeReplicate
  guard (priority 10): network-online check.
- `canReplicateWithPBKDF2(errorManager, host, showMessage)` (module fn) — onBeforeReplicate
  guard (priority 20): ensures the PBKDF2 encryption salt via `replicator.ensurePBKDF2Salt`.
- `class ModuleReplicator extends AbstractModule` — owns `processor`, `_unresolvedErrorManager`.
- `clearErrors()` — clear unresolved-error manager.
- `_everyOnloadAfterLoadSettings()` — registers `EVENT_FILE_SAVED` (schedule replicate-on-save)
  and `EVENT_SETTING_SAVED` (suspend/resume processor).
- `_onReplicatorInitialised()` — `clearHandlers()` for sync-params.
- `_everyOnDatabaseInitialized(showNotice)` — restore processor snapshot once.
- `_everyBeforeReplicate(showMessage)` — restore snapshot + clear errors.
- `cleaned(showMessage)` — **@deprecated** legacy remote-cleanup flow (fetch/cleanup/dismiss).
- `onReplicationFailed(showMessage)` — tweak-mismatch / remote-locked dialog handling.
- `_parseReplicationResult(docs)` — enqueue pulled docs into the processor.
- `onBindFunction(core, services)` — registers all the above on the service buses (this is the
  wiring map).

### `ModuleReplicatorCouchDB.ts`
- `_anyNewReplicator(settingOverride)` — returns `new LiveSyncCouchDBReplicator(core)` unless
  remoteType is MinIO/P2P (safety valve — avoids using `REMOTE_COUCHDB` as a positive test).
- `_everyAfterResumeProcess()` — on resume, if LiveSync or `syncOnStart`, `openReplication`
  (continuous when LiveSync). **Non-trivial:** the main auto-start trigger.
- `onBindFunction` — registers on `getNewReplicator` + `onResumed`.

### `ModuleReplicatorMinIO.ts`
- `_anyNewReplicator(settingOverride)` — returns `new LiveSyncJournalReplicator(core)` for
  `REMOTE_MINIO`, else `false`.
- `onBindFunction` — registers on `getNewReplicator`.

### `ModulePeriodicProcess.ts`
- `periodicSyncProcessor = new PeriodicProcessor(core, () => services.replication.replicate())`.
- `disablePeriodic() / resumePeriodic()` — enable/disable with
  `periodicReplicationInterval*1000` when `periodicReplication` set.
- Lifecycle handlers `_allOnUnload / _everyBeforeRealizeSetting / _everyBeforeSuspendProcess /
  _everyAfterResumeProcess / _everyAfterRealizeSetting` — disable on unload/suspend/before-setting,
  re-enable on resume/after-setting.
- `onBindFunction` — registers on the lifecycle + setting buses.

### `StorageEventManagerObsidian.ts`
- `class StorageEventManagerObsidian extends StorageEventManagerBase<ObsidianStorageEventManagerAdapter>`
  — constructs the adapter, passes it + deps to base.
- `_watchVaultRawEvents(path)` (override) — internal/config-file raw-event handling; enqueues
  an `INTERNAL` event immediately.

### `ObsidianStorageEventManagerAdapter.ts`
- `ObsidianTypeGuardAdapter` — `isFile`/`isFolder` (handles both real `TFile`/`TFolder` and
  duck-typed stubs).
- `ObsidianPersistenceAdapter` — `saveSnapshot`/`loadSnapshot` via `core.kvDB`
  (`storage-event-manager-snapshot`).
- `ObsidianStatusAdapter` — `updateStatus` → publishes batched/processing/totalQueued to
  `FileProcessingService` reactive sources.
- `ObsidianConverterAdapter` — `toFileInfo` (→ `TFileToUXFileInfoStub`) / `toInternalFileInfo`.
- `ObsidianWatchAdapter.beginWatch(handlers)` — registers the actual `vault.on(...)` +
  `workspace.on("editor-change")` listeners. **Non-trivial:** the raw `"raw"` event uses
  `@ts-ignore` (undocumented internal Obsidian API).
- `ObsidianStorageEventManagerAdapter` — composite holding the five adapters.

### `utilObsidian.ts`
- `TFileToUXFileInfo(core, file, prefix?, deleted?)` — async; reads file content via
  `storageAccess.readFileAuto` into a `Blob` (empty for deleted); builds full `UXFileInfo`.
- `InternalFileToUXFileInfo(fullPath, vaultAccess, prefix=ICHeader)` — same for config-dir
  internal files via adapter reads.
- `TFileToUXFileInfoStub(file, deleted?)` — metadata-only stub (throws on non-`TFile`).
- `InternalFileToUXFileInfoStub(filename, deleted?)` — internal-file stub (`isInternal: true`).
- `TFolderToUXFileInfoStub(file)` — folder info with mapped children.

### `dialogs.ts`
- `AutoClosableModal extends Modal` — closes itself on `EVENT_PLUGIN_UNLOADED`.
- `InputStringDialog` — single-field (optionally password) input modal.
- `PopoverSelectString extends FuzzySuggestModal<string>` — fuzzy pick-one; default `y/n`.
- `MessageBox<T>` — markdown message box with multiple buttons and an optional countdown timer
  that auto-selects `defaultAction`; tap-to-cancel countdown. **Non-trivial:** the interval
  timer drives button-label updates and auto-close.
- `confirmWithMessage(...)` / `confirmWithMessageWithWideButton(...)` — promise wrappers over
  `MessageBox`.
- `askYesNo(app, message)` / `askSelectString(app, message, items)` /
  `askString(app, title, key, placeholder, isPassword?)` — promise-based popover/input helpers.

## Dependencies

**Internal (this repo, `@/` and `@lib/`):**
- `@/modules/AbstractModule` (base class); `@/LiveSyncBaseCore`, `@/main` (core + plugin types).
- `@lib/replication/couchdb/LiveSyncReplicator`, `@lib/replication/journal/LiveSyncJournalReplicator`,
  `@lib/replication/LiveSyncAbstractReplicator`, `@lib/replication/SyncParamsHandler`.
- `@lib/services/base/ReplicationService` (the bus interface), `@lib/services/base/UnresolvedErrorManager`,
  `@lib/interfaces/ServiceModule`, `@lib/services/base/FileProcessingService`.
- `@lib/managers/StorageEventManager` (base), `@lib/managers/adapters`.
- `@lib/common/types`, `@lib/common/typeUtils`, `@lib/common/utils`, `@lib/common/utils.doc`,
  `@lib/common/logger`, `@lib/common/i18n`, `@lib/common/coreEnvFunctions`,
  `@lib/string_and_binary/path`, `@lib/pouchdb/chunks`.
- `@/common/events` (`EVENT_FILE_SAVED`, `EVENT_SETTING_SAVED`, `EVENT_PLUGIN_UNLOADED`, `eventHub`),
  `@/common/PeriodicProcessor`, `@/common/types` (`ICHeader`), `@/deps` (Obsidian re-exports),
  `@/serviceModules/FileAccessObsidian`.

**External:**
- `octagonal-wheels` — `concurrency/semaphore_v2`, `concurrency/semaphore`, `concurrency/lock`
  (`serialized`, `skipIfDuplicated`, `shareRunningResult`), `concurrency/task` (`scheduleTask`),
  `dataobject/reactive_v2` / `reactive`, `promises`, `common/logger`.
- `pouchdb-core` (types).
- `obsidian` (via `@/deps`): `Modal`, `FuzzySuggestModal`, `Setting`, `ButtonComponent`,
  `MarkdownRenderer`, `Component`, `TFile`, `TFolder`, `App`, `Plugin`.

## Consumed by

- **`src/LiveSyncBaseCore.ts`** (lines 142-146) registers `ModuleReplicatorMinIO`,
  `ModuleReplicatorCouchDB`, `ModuleReplicator`, `ModulePeriodicProcess` as modules. Module
  registration order matters: MinIO/CouchDB factories register before `ModuleReplicator`.
- **`src/main.ts`** (line 66) constructs `StorageEventManagerObsidian`.
- The **replicator classes** call back in via `services.replication.parseSynchroniseResult`
  (`LiveSyncReplicator.ts:239`, `JournalSyncCore.ts`, `LiveSyncTrysteroReplicator.ts`).
- **`utilObsidian.ts`** converters are used by the adapter and by other Obsidian modules;
  **`dialogs.ts`** helpers are used by the Obsidian confirm/UI layer.
- The web-app / CLI entrypoints (`src/apps/webapp/main.ts`, `src/apps/cli/...`) register their
  own replicator modules and rely on the same `_everyAfterResumeProcess` auto-start behavior.

## Design observations (factual; for critique)

1. **Semaphore usage in `runProcessQueue` looks like a no-op gate.** Lines 303-304 acquire a
   `Semaphore(10)` slot and immediately release it (`releaser()`), then fire
   `parseDocumentChange` un-awaited. The *real* concurrency limit is re-acquired inside
   `applyToDatabase` (line 375). The pacing acquire in the loop therefore only throttles the
   *rate of dispatch* while slots are momentarily saturated, not the number in flight — the
   two-phase acquire is subtle and easy to misread. Worth confirming intent.
2. **Fire-and-forget concurrency with no back-pressure on the queue drain.** `runProcessQueue`
   shifts the whole `_queuedChanges` list dispatching `void parseDocumentChange(...)`; the loop
   can empty the queue faster than docs are applied, so `_processingChanges` can grow large.
   Bounded only by the inner `Semaphore(10)`.
3. **At-least-once re-processing on restart.** `restoreFromSnapshot` re-enqueues both `queued`
   and `processing`; an item mid-apply at crash time is re-applied. The rev/conflict guard in
   `checkIsChangeRequiredForDatabaseProcessing` is what makes that safe — correctness hinges on it.
4. **Size check uses metadata size, not content size** (explicit comment,
   `parseDocumentChange`). A doc whose metadata size disagrees with actual content could slip
   the too-large gate.
5. **`maxMTimeForReflectEvents` gates in two places with opposite framing.** In
   `StorageEventManager.appendQueue` any positive value causes an *early return* (no local
   events queued at all, line 155-157); in `parseDocumentChange` it only skips docs *newer*
   than the limit. The local-side blanket return is a broad kill-switch that may surprise.
6. **Deprecated code still reachable.** `ModuleReplicator.cleaned()` is `@deprecated v0.24.17`
   but is still called from `onReplicationFailed` for the IndexedDB adapter path.
7. **Undocumented Obsidian API dependency.** `ObsidianWatchAdapter` registers the `"raw"`
   vault event with `@ts-ignore : Internal API` — a fragility risk across Obsidian versions.
8. **Two independent snapshot mechanisms** (processor `kvDB` snapshot and StorageEventManager
   `kvDB` snapshot) with similar throttle/restore logic — duplicated pattern, separately
   maintained.
9. **Replicator selection is a handler chain of factories** (`getNewReplicator` with each
   module returning `false` when not applicable). Adding a remote type means editing the
   safety-valve conditions in *both* CouchDB and MinIO modules; the negative-test pattern
   (`!= MINIO && != P2P`) is comment-flagged as intentional but fragile.
10. **P2P/Trystero replicator is referenced by the boundary but not wired here** — the CLI
    entrypoint comment shows a `ModuleReplicatorP2P` exists elsewhere; this subsystem only
    covers CouchDB + MinIO factories, so remote-type coverage here is partial by design.

### Coverage gaps / unclear behavior

- The **actual vault-write** in `processSynchroniseResult` / `processFileEvent` is in
  commonlib (another agent's scope) — I traced *to* the boundary, not through it.
- `getDBEntryFromMeta`'s **chunk-fetch-if-missing** behavior (the "Read chunks online" path) is
  commonlib; the comment in `_applyToDatabase` acknowledges chunks may still be arriving but the
  wait mechanism itself is not in these files.
- Exact semantics of `processVirtualDocument` / `processOptionalSynchroniseResult` claims
  (customization/hidden-file sync) live in other modules and were not read here.

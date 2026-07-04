# Feature Commands (Config/Customization Sync, Hidden File Sync, DB Maintenance, Commands)

> AS-BUILT reverse-engineering, read-only. Symbol names and paths verified against source
> at HEAD (branch `main`). Where behavior is genuinely unclear it is flagged explicitly.
> Scope excludes P2P sync (`src/features/P2PSync/`), settings UI panes
> (`src/modules/features/SettingDialogue/`), and conflict/doc-history modules
> (`InteractiveConflictResolving/`, `DocumentHistory/`, `ModuleGlobalHistory`,
> `ModuleObsidianDocumentHistory`, `ModuleInteractiveConflictResolver`,
> `JsonResolveModal.ts`) — those are other agents' subsystems.

## Purpose & responsibilities

This subsystem contains the plugin's optional "add-on" features, each a subclass of
`LiveSyncCommands`, plus the `ModuleLog` status/log module and the `SetupManager`
onboarding module. The three add-ons are instantiated in `src/main.ts` (lines 163–168)
in a factory that returns `[new ConfigSync, new HiddenFileSync, new LocalDatabaseMaintenance]`:

- **`ConfigSync` (Customization Sync)** — controlled, user-mediated sync of Obsidian
  configuration artifacts (app config, themes, snippets, plugins) between devices, keyed
  by a per-device "term" (device+vault name), surfaced through a dedicated modal dialog.
- **`HiddenFileSync`** — fully automatic, bidirectional sync of *all* hidden/dotfiles
  (everything under paths starting with `.`, e.g. `.obsidian/`), governed by
  include/exclude regex patterns. Known to be unreliable in the field.
- **`LocalDatabaseMaintenance`** — chunk garbage collection, orphan/unused chunk removal,
  permanent deletion commit, chunk resurrection, database analysis, and remote compaction.
- **`LiveSyncCommands`** — the abstract base for the three add-ons: holds `plugin`/`core`
  references, per-instance logging helpers, and the `onBindFunction` service-wiring hook.
- **`ModuleLog`** — status bar / in-editor status line rendering, the reactive log pipe,
  the "Show log" view, and the "Generate full report" debug-dump command.
- **`SetupManager`** — the onboarding/setup-wizard state machine (Svelte dialog flow).

## Files & LOC (table)

| File | LOC | Role |
|------|-----|------|
| `src/features/LiveSyncCommands.ts` | 103 | Abstract base class for add-on command features |
| `src/features/ConfigSync/CmdConfigSync.ts` | 1832 | `ConfigSync` — customization sync engine (V1 + V2) |
| `src/features/ConfigSync/PluginDialogModal.ts` | 39 | Obsidian `Modal` hosting the `PluginPane.svelte` UI |
| `src/features/ConfigSync/PluginPane.svelte` | 655 | Customization-sync dialog UI (not deeply analyzed here) |
| `src/features/ConfigSync/PluginCombo.svelte` | 471 | Per-item device/action combo UI (not deeply analyzed here) |
| `src/features/HiddenFileSync/CmdHiddenFileSync.ts` | 2002 | `HiddenFileSync` — automatic hidden-file sync engine |
| `src/features/HiddenFileCommon/JsonResolveModal.ts` | 89 | JSON 3-way merge modal (OTHER AGENT — noted only) |
| `src/features/LocalDatabaseMainte/CmdLocalDatabaseMainte.ts` | 969 | `LocalDatabaseMaintenance` — chunk GC/analysis |
| `src/features/LocalDatabaseMainte/maintenancePrerequisites.ts` | 54 | Guard that enforces GC-safe settings before maintenance |
| `src/features/LocalDatabaseMainte/CmdLocalDatabaseMainte.unit.spec.ts` | 89 | Unit tests for the prerequisites guard |
| `src/modules/features/ModuleLog.ts` | 603 | Status bar / status line / log view / debug dump |
| `src/modules/features/SetupManager.ts` | 433 | Onboarding & setup-wizard flow |

Note: `HiddenFileCommon/JsonResolveModal.ts` exists (89 LOC) and is consumed by both
`ConfigSync.compareUsingDisplayData` and `HiddenFileSync.showJSONMergeDialogAndMerge`,
but its internals are owned by the conflict-resolution agent.

## Key types / data structures

**Config/Customization sync (`CmdConfigSync.ts`):**

- `PluginDataEx` — a logical customization item: `{ category, name, displayName?, term,
  files: PluginDataExFile[], version?, mtime, documentPath? }`. `term` = device+vault name.
- `PluginDataExFile` — one file inside an item: `{ filename, data: string[], mtime, size,
  version?, hash?, displayName? }`.
- `IPluginDataExDisplay` / `PluginDataExDisplay` — display projections; `files` hold hashes
  (not full data) for cheap comparison.
- `PluginDataExDisplayV2` (class) — the V2 representation. Computes `confKey`
  (`categoryToFolder(category, term) + name`), lazily resolves a plugin/theme `manifest.json`
  into `_displayName`/`_version`, and `mtime` is the (integer) average of its files' mtimes.
- Category enum (string): `"CONFIG" | "THEME" | "SNIPPET" | "PLUGIN_MAIN" | "PLUGIN_DATA" |
  "PLUGIN_ETC"`, mapped to folders by `categoryToFolder`.
- Module-level Svelte `writable` stores: `pluginList`, `pluginIsEnumerating`,
  `pluginV2Progress`, `pluginManifests` (a `Map`) + `pluginManifestStore`.
- Custom serialization format: `serialize`/`deserialize2` use zero-width `​` (`d`) and
  `\n` (`d2`) as field/line delimiters; `DUMMY_HEAD`/`DUMMY_END` (`‌`) frame V2 file
  payloads. `getTokenizer`/`splitWithDelimiters` implement a hand-rolled tokenizer.
- `OPTIONAL_SYNC_FEATURES` (global interface, augmented here): `DISABLE`, `CUSTOMIZE`,
  `DISABLE_CUSTOM`.

**Hidden File sync (`CmdHiddenFileSync.ts`):**

- `SyncDirection = "push" | "pull" | "safe" | "pullForce" | "pushForce"`.
- Three `MapLike` caches (persisted via `autosaveCache` into `kvDB`):
  `_fileInfoLastProcessed` (path → `"{mtime}-{size}"` key), `_fileInfoLastKnown`
  (path → last-known nonzero mtime), `_databaseInfoLastProcessed`
  (path → `"{mtime}-{size}-{rev}-{-0|-1}"` doc key).
- `statToKey` / `docToKey` produce the change-detection fingerprints.
- `getComparingMTime` — normalizes mtime across `MetaEntry`/`LoadedEntry`/`UXStat`,
  treating deleted/missing as `0`.
- `OPTIONAL_SYNC_FEATURES` augmented with: `FETCH`, `OVERWRITE`, `MERGE`, `DISABLE`,
  `DISABLE_HIDDEN`.
- `ICHeader` / `ICHeaderEnd` prefixes mark hidden-file docs in the DB (`addPrefix`/
  `stripAllPrefixes`).

**LocalDatabaseMaintenance (`CmdLocalDatabaseMainte.ts`):**

- KV keys: `DB_KEY_SEQ = "gc-seq"`, `DB_KEY_CHUNK_SET = "chunk-set"`,
  `DB_KEY_DOC_USAGE_MAP = "doc-usage-map"`.
- `ChunkUsageMap = Map<NoteDocumentID, Map<Rev, Set<ChunkID>>>` — the incremental
  chunk-usage index tracked by `trackChanges` from the PouchDB `_changes` feed.
- `MaintenancePrerequisiteSettings` (in `maintenancePrerequisites.ts`) —
  `Pick<..., "doNotUseFixedRevisionForChunks" | "readChunksOnline">`; the required state is
  `doNotUseFixedRevisionForChunks: true`, `readChunksOnline: false`.

## Per-feature behavior & data flow

### How add-on commands are registered

`LiveSyncCommands` (the base) is constructed with `(plugin, core)`; its constructor calls
`this.onBindFunction(core, core.services)` and builds a per-instance `_log` via
`createInstanceLogFunction(this.constructor.name, services.API)`. Subclasses override two
abstract lifecycle hooks — `onload()` / `onunload()` — and (optionally) `onBindFunction`.

Two distinct registration mechanisms are used:

1. **Obsidian command palette / ribbon commands** are added in each subclass's `onload()`
   via `this.services.API.addCommand({ id, name, callback })` (and
   `this.addRibbonIcon(...)` / `addIcon(...)`). `LocalDatabaseMaintenance` uses
   `this.plugin.addCommand(...)` directly instead.
2. **Service-hub event wiring** is done in `onBindFunction`, where each add-on
   `.addHandler(...)`s into typed service buses: `services.fileProcessing`,
   `services.conflict`, `services.replication`, `services.setting`,
   `services.appLifecycle`, `services.databaseEvents`, `services.vault`. This is how the
   otherwise-passive add-ons hook into the sync lifecycle (replication results, before-
   replicate, resume, setting realization, optional-feature suggestion/enable, etc.).

The three add-ons are created and returned by a factory in `main.ts`; retrievable later via
`core.getAddOn<T>(T.name)` (e.g. `PaneHatch.ts` fetches `HiddenFileSync` this way).

Commands registered by this subsystem:
- ConfigSync: `livesync-plugin-dialog-ex` ("Show customization sync dialog") + a ribbon
  icon; also listens for `EVENT_REQUEST_OPEN_PLUGIN_SYNC_DIALOG`.
- HiddenFileSync: `livesync-sync-internal` ("(re)initialise hidden files…"),
  `livesync-scaninternal-storage`, `livesync-scaninternal-database`,
  `livesync-internal-scan-offline-changes`; listens for `EVENT_SETTING_SAVED`.
- LocalDatabaseMaintenance: `analyse-database`, `gc-v3`; listens for
  `EVENT_ANALYSE_DB_USAGE`, `EVENT_REQUEST_PERFORM_GC_V3`.
- ModuleLog: `view-log` ("Show log") + ribbon, `dump-debug-info` ("Generate full report…"),
  registers `VIEW_TYPE_LOG`.

### Config / Customization sync

Two on-disk formats coexist: **V1** (one DB document per logical item, all its files
serialized together via the zero-width-delimited `serialize` format) and **V2**
(`usePluginSyncV2`, one DB document per *individual file*, path-encoded with a `%`
separator). V2 is preferred; the scan processors auto-migrate V1→V2 on encounter
(`pluginScanProcessor` calls `migrateV1ToV2` when `useV2`).

**Storage → DB (capture).** `watchVaultRawEventsAsync` (bound via
`services.fileProcessing.processOptionalFileEvent`) fires on raw vault events for config
paths. It filters out files already handled by Customization Sync's `Automatic`-mode
entries, de-dupes recent self-writes via `recentProcessedInternalFiles` (a 100-entry
`path-mtime` ring), then debounces a `storeCustomizationFiles(path)` call (100 ms via
`scheduleTask`). `storeCustomizationFiles` routes to `storeCustomisationFileV2` when
`useV2`, else builds a `PluginDataEx` from the category's file set (`makeEntryFromFile`),
serializes, and writes with content-equality short-circuits (mtime match, then per-file
`isDocContentSame`). `filenameToUnifiedKey`/`filenameWithUnifiedKey` compute the
`ICXHeader`-prefixed DB path incorporating the device `term`.

**Full scan.** `scanAllConfigFiles` (`shareRunningResult`-guarded) enumerates config files
via `scanInternalFiles` (`getFiles` at depth 2), diffs local vs. DB-stored under the
device's key prefix, stores new/changed, and deletes DB entries with no local counterpart.
Triggered on database init (`_everyOnDatabaseInitialized`), before replicate
(`_everyBeforeReplicate` if `autoSweepPlugins`), on resume, on setting realization, and
periodically via `periodicPluginSweepProcessor` (`PERIODIC_PLUGIN_SWEEP`, disabled when
`watchInternalFileChanges`).

**DB → display / apply.** Incoming replicated `ICXHeader` docs are routed through
`_anyModuleParsedReplicationResultItem` (bound to `services.replication.processVirtualDocument`),
which calls `updatePluginList` and (if `notifyPluginOrSettingUpdated`) shows a "press HERE"
Notice. `updatePluginList` feeds `pluginScanProcessor`/`pluginScanProcessorV2` (10-way
concurrent `QueueProcessor`s) that call `loadPluginData` and push into the `pluginList`
store. **Applying** a chosen item to disk is `applyData`/`applyDataV2`: writes files via
`core.storageAccess.writeHiddenFileAuto` (skipping unchanged via `isDocContentSame`), then
re-stores; for `PLUGIN_MAIN`/`PLUGIN_DATA` it unload/reloads the affected plugin, and for
`CONFIG` it calls `services.appLifecycle.askRestart()`. Comparison/merge between two
devices' versions is `compareUsingDisplayData`, which opens `JsonResolveModal` for `.json`
files or a `ConflictResolveModal` (diff_match_patch) otherwise.

**Enable/config.** `configureHiddenFileSync(mode)` (modes `CUSTOMIZE`/`DISABLE`/
`DISABLE_CUSTOM`) applies settings via `services.setting.applyPartial`; on `CUSTOMIZE` it
prompts for a device name (auto-derived from `Platform` if blank) and runs a full scan.

### Hidden File sync

Goal: keep every dotfile (`isHiddenFileSyncHandlingPath` = starts with `.`, excludes
`.trash`) synchronized both ways automatically, filtered by `isTargetFile`, which ANDs:
regex include/exclude patterns (`isTargetFileInPatterns`, from
`syncInternalFilesTargetPatterns`/`syncInternalFilesIgnorePatterns`), NOT ignored by
Customization Sync's selective files (`isNotIgnoredByCustomisationSync`), the hidden-path
predicate, and NOT ignored by the vault ignore-file (`services.vault.isIgnoredByIgnoreFile`).

**Change-detection mechanism (the crux).** There is *no* content hashing on the fast path;
change detection is entirely **mtime+size fingerprint** based, using three persistent
caches keyed off the storage stat and the DB doc:

- Storage → DB: `trackStorageFileModification` computes `statToKey(stat)` and compares to
  `_fileInfoLastProcessed[path]`; if equal, skip. Otherwise it classifies
  invalid/delete/modified and calls `storeInternalFileToDatabase` or
  `deleteInternalFileOnDatabase`. `storeInternalFileToDatabase` *does* do a content compare
  (`isDocContentSame(readAsBlob(baseData), fileInfo.body)`) before writing, unless
  `forceWrite`.
- DB → Storage: `trackDatabaseFileModification` → `extractInternalFileFromDatabase`, which
  respects `_databaseInfoLastProcessed` (via `docToKey`), refuses to overwrite while
  `_conflicts` exist, and on `onlyNew` compares mtimes (`compareMTime`) before writing.
  `__writeFile` re-reads storage and compares content before actually writing.
- Every successful operation updates the caches (`updateLastProcessed*`) *and* calls
  `services.path.markChangesAreSame`/`unmarkChanges` to feed the plugin-wide
  "same-changes" suppression used elsewhere.

**Scans & offline reconciliation.** `scanAllStorageChanges` unions known + existing files
and processes any whose stat-key drifted. `scanAllDatabaseChanges` does the DB side.
`applyOfflineChanges` (run at startup via `performStartupScan`) intersects *untracked*
local and DB files (`bothUntracked`) and reconciles each by mtime comparison
(`BASE_IS_NEW`→storage wins, `TARGET_IS_NEW`→DB wins, `EVEN`→mark), then runs both full
scans. `initialiseInternalFileSync(direction,…)` implements the FETCH/OVERWRITE/MERGE
initializers via `rebuildFromDatabase` / `rebuildFromStorage` / `rebuildMerging`, each
followed by "doubly sure" `adoptCurrent*FilesAsProcessed` + full scans.

**Conflict handling.** `_anyGetOptionalConflictCheckMethod` (bound to
`services.conflict.getOptionalConflictCheckMethod`) enqueues internal-metadata paths into
`conflictResolutionProcessor` (a `QueueProcessor` with a downstream `pipeTo` processor).
For `.json` files it attempts an automatic 3-way object merge
(`localDatabase.managers.conflictManager.mergeObject` off a common-base rev), then applies
`syncInternalFileOverwritePatterns` (newer-wins), then falls back to a `JsonResolveModal`
dialog (`showJSONMergeDialogAndMerge`). Non-JSON conflicts are always resolved by
`resolveByNewerEntry` (delete the older rev). A `pendingConflictChecks` set + queue/requeue
logic keeps at most one in-flight check per path so repeated sync events don't close an open
dialog.

**Reload notifications.** `queueNotification`/`notifyConfigChange` (unless
`suppressNotifyHiddenFilesChange`) prompt to reload a specific plugin or schedule an
Obsidian restart when files under the config dir change.

### LocalDatabaseMainte

All operations first call `ensureAvailable(name)` →
`ensureLocalDatabaseMaintenancePrerequisites`, which HARD-REQUIRES
`doNotUseFixedRevisionForChunks: true` and `readChunksOnline: false` (offers to apply them,
else aborts). Rationale: GC needs stable, locally-readable chunk identities.

- **`analyseDatabase`** — walks every doc revision (`findEntryNames` + per-rev `db.get`),
  builds chunk/doc maps, classifies unique vs. shared chunks and orphan chunks, and emits a
  TSV report to the clipboard (`services.UI.promptCopyToClipboard`). Wired to command
  `analyse-database` and `EVENT_ANALYSE_DB_USAGE`.
- **`gcv3`** — the currently-exposed GC (command `gc-v3`, `EVENT_REQUEST_PERFORM_GC_V3`). It
  runs a one-shot `sync`, checks connected-device node info (`getConnectedDeviceList`):
  warns on accepted-but-unknown nodes and on divergent per-device `progress` values
  (staleness → conflict risk), asks for confirmation, then scans all docs to build
  `usedChunks`, computes unused = `allChunks − usedChunks`, `bulkDocs` deletes them,
  push-replicates, and calls `compactDatabase`.
- **`trackChanges` / `scanUnusedChunks` / `performGC`** — an older incremental GC path:
  `trackChanges` consumes the PouchDB `_changes` feed to maintain the persisted
  `ChunkUsageMap` (+ old-revision scan `processDocRevisions`), `scanUnusedChunks` keeps the
  last `KEEP_MAX_REVS = 10` revisions' chunks, `performGC` deletes the rest in 100-doc
  batches. `performGC` is NOT wired to any live UI (only the `gcv3` path is).
- **`resurrectChunks`** — finds deleted-but-still-referenced chunks and restores data from
  prior available revisions (chunks are immutable); reports "completely lost" chunks that
  cannot be recovered.
- **`commitFileDeletion` / `commitChunkDeletion` / `markUnusedChunks` / `removeUnusedChunks`**
  — permanent-deletion and mark/sweep operations, all confirmation-gated.
- **`compactDatabase`** — connects to remote CouchDB and runs `db.compact` with a 2-minute
  poll loop.

**Wiring gap (verified):** of the maintenance methods, only `gcv3` and `analyseDatabase`
are reachable from the app. The invocation sites for `performGC`, `commitFileDeletion`,
`removeUnusedChunks`, and `resurrectChunks` in `PaneMaintenance.ts` are all **commented
out** (lines ~215–285); `resurrectChunks`, `commitChunkDeletion`, `markUnusedChunks` have
no caller in `src/` at all. A `compactDatabaseWithRevLimit` method is fully commented out
(documented as "Very dangerous").

## Function/class inventory

### `src/features/LiveSyncCommands.ts`
- `abstract class LiveSyncCommands` — base for add-on features.
  - `get app/settings/localDatabase/services` — accessors delegating to `plugin`/`core`.
  - `path2id(filename, prefix?)` — delegate to `services.path.path2id`.
  - `getPath(entry)` — delegate to `services.path.getPath`.
  - `constructor(plugin, core)` — wires bindings + instance logger.
  - `abstract onunload()/onload()` — lifecycle hooks.
  - `_isMainReady()/_isMainSuspended()/_isDatabaseReady()` — lifecycle predicates.
  - `_log` + `_verbose/_info/_notice/_debug/_progress(prefix,level)` — logging helpers;
    `_progress` returns `{ log, once, done }` keyed-Notice updaters.
  - `onBindFunction(core, services)` — no-op default; overridden by subclasses.

### `src/features/ConfigSync/CmdConfigSync.ts`
- `serialize(data: PluginDataEx): string` — zero-width-delimited custom serializer.
- `splitWithDelimiters(sources)` / `getTokenizer(source)` / `deserialize2(str)` — the
  matching tokenizer/parser for the custom format.
- `deserialize<T>(str, def)` — tries custom format, then JSON, then YAML, else `def`.
- `categoryToFolder(category, configDir?)` — category → config-dir subpath.
- `setManifest(key, manifest)` — updates the `pluginManifests` map/store if changed.
- `class PluginDataExDisplayV2` — V2 item projection; `setFile`/`deleteFile`/
  `applyLoadedManifest` + `displayName`/`version`/`mtime` getters.
- `class ConfigSync extends LiveSyncCommands`:
  - `constructor` — wires `pluginScanningCount` → `pluginIsEnumerating`.
  - getters `configDir`, `kvDB`, `useV2`, `useSyncPluginEtc`; `isThisModuleEnabled()`.
  - `showPluginSyncModal()/hidePluginSyncModal()` — open/close `PluginDialogModal`.
  - `onunload()/onload()` — teardown; register icon/command/ribbon + event.
  - `getFileCategory(path)` / `isTargetPath(path)` — classify config paths.
  - `_everyOnDatabaseInitialized/_everyBeforeReplicate/_everyOnResumeProcess/`
    `_everyAfterResumeProcess/_everyRealizeSettingSyncMode` — lifecycle handlers.
  - `reloadPluginList(showMessage)` — clear + rebuild list.
  - `loadPluginData(path)` — read a V1 doc into `PluginDataExDisplay` (backfills missing
    file hashes).
  - `pluginScanProcessor` / `pluginScanProcessorV2` — 10-way `QueueProcessor`s populating
    the list (V1 migrates to V2).
  - `filenameToUnifiedKey/filenameWithUnifiedKey/unifiedKeyPrefixOfTerminal/parseUnifiedPath`
    — DB-key ↔ path encoding (`ICXHeader`, device term, `%` separator).
  - `createPluginDataExFileV2/createPluginDataFromV2` — build V2 file/item objects; parse
    manifests.
  - `updatePluginListV2/updatePluginList` — refresh list from DB (V2 per-file / V1 doc).
  - `migrateV1ToV2(showMessage, entry)` — split a V1 doc into per-file V2 docs, delete V1.
  - `compareUsingDisplayData(a, b, compareEach?)` — open merge/diff dialog between two
    devices' versions.
  - `applyData/applyDataV2(data, content?)` — write item to disk, reload plugin / ask
    restart.
  - `deleteData(data)` — delete item (and V2 sub-files) from DB.
  - `_anyModuleParsedReplicationResultItem(docs)` — on replicated ICX doc: refresh + notify.
  - `makeEntryFromFile(path)` — read a file into a `PluginDataExFile` (+manifest version).
  - `storeCustomisationFileV2(path, term, force?)` / `storeCustomizationFiles(path, term?)`
    — capture file(s) to DB (V2 / V1), with skip-if-same logic.
  - `_anyProcessOptionalFileEvent(path)` → `watchVaultRawEventsAsync(path)` — raw event
    entry point.
  - `scanAllConfigFiles(showMessage)` — full local↔DB reconciliation.
  - `deleteConfigOnDatabase(prefixedFileName, forceWrite?)` — soft-delete DB entry.
  - `scanInternalFiles()` — list dotfiles under config dir (depth 2).
  - `_allAskUsingOptionalSyncFeature/__askHiddenFileConfiguration/_allSuspendExtraSync/`
    `_allConfigureOptionalSyncFeature` — optional-feature prompts/handlers.
  - `_anyGetOptionalConflictCheckMethod(path)` — returns `"newer"` for plugin/customization
    metadata.
  - `configureHiddenFileSync(mode)` — enable/disable customization sync (device-name
    prompt).
  - `getFiles(path, lastDepth)` — recursive adapter listing.
  - `onBindFunction(core, services)` — registers all the service handlers above.
- Module stores/exports: `pluginList`, `pluginIsEnumerating`, `pluginV2Progress`,
  `pluginManifests`, `pluginManifestStore`; types `PluginDataExFile`,
  `IPluginDataExDisplay`, `PluginDataExDisplay`, `PluginDataEx`.

### `src/features/ConfigSync/PluginDialogModal.ts`
- `class PluginDialogModal extends Modal` — mounts/unmounts `PluginPane.svelte`;
  `isOpened()`, `onOpen()`, `onClose()`.

### `src/features/HiddenFileSync/CmdHiddenFileSync.ts`
- `getComparingMTime(doc, includeDeleted?)` — normalized mtime extractor.
- `class HiddenFileSync extends LiveSyncCommands`:
  - `isThisModuleEnabled()` (`syncInternalFiles`); `periodicInternalFileScanProcessor`.
  - `get kvDB`; `getConflictedDoc(path, rev)`.
  - `onunload()/onload()` — teardown; register 4 commands + `EVENT_SETTING_SAVED`.
  - `_everyOnDatabaseInitialized/_everyBeforeReplicate/_everyOnloadAfterLoadSettings/`
    `_everyOnResumeProcess/_everyRealizeSettingSyncMode` — lifecycle handlers.
  - `updateSettingCache()`; `isReady()`; `performStartupScan(showNotice)`.
  - `_anyProcessOptionalFileEvent/_anyGetOptionalConflictCheckMethod/`
    `_anyProcessOptionalSyncFiles` — service entry points.
  - `loadFileWithInfo(path)` — build a `UXFileInfo` (deleted-stub if missing).
  - cache accessors/mutators: `statToKey`, `docToKey`, `fileToStatKey`,
    `updateLastProcessedFile`, `updateLastProcessedAsActualFile`, `resetLastProcessedFile`,
    `getLastProcessedFileMTime`, `getLastProcessedFileKey`, `getLastProcessedDatabaseKey`,
    `updateLastProcessedDatabase`, `updateLastProcessed`, `updateLastProcessedDeletion`,
    `updateLastProcessedAsActualDatabase`, `resetLastProcessedDatabase`,
    `adoptCurrentStorageFilesAsProcessed`, `adoptCurrentDatabaseFilesAsProcessed`.
  - `ensureDir/writeFile/__removeFile/triggerEvent` — storage helpers.
  - `serializedForEvent(file, fn)` — per-path serialized + semaphore-limited wrapper (feeds
    `hiddenFilesEventCount`/`hiddenFilesProcessingCount` stores).
  - `useStorageFiles/trackScannedStorageChanges/scanAllStorageChanges/`
    `trackStorageFileModification` — Storage→DB scan & per-file change processing.
  - conflict: `queueConflictCheck/finishConflictCheck/requeueConflictCheck/`
    `resolveConflictOnInternalFiles/resolveByNewerEntry/conflictResolutionProcessor/`
    `showJSONMergeDialogAndMerge`.
  - `getDocProps(doc)` / `processReplicationResult(doc)` — DB event source handlers.
  - filter/pattern: `parseRegExpSettings/isTargetFileInPatterns/`
    `getCustomisationSynchronizationIgnoredFiles/isNotIgnoredByCustomisationSync/`
    `isHiddenFileSyncHandlingPath/isTargetFile`.
  - `trackScannedDatabaseChange/applyOfflineChanges/scanAllDatabaseChanges/`
    `useDatabaseFiles/trackDatabaseFileModification` — DB→Storage scan & processing.
  - notifications: `queuedNotificationFiles`, `notifyConfigChange`, `queueNotification`.
  - init: `rebuildMerging/rebuildFromStorage/getAllDatabaseFiles/rebuildFromDatabase/`
    `initialiseInternalFileSync`.
  - Storage→DB: `__loadBaseSaveData/storeInternalFileToDatabase/`
    `deleteInternalFileOnDatabase`.
  - DB→Storage: `extractInternalFileFromDatabase/__checkIsNeedToWriteFile/__writeFile/`
    `__deleteFile`.
  - optional-feature: `_allAskUsingOptionalSyncFeature/__askHiddenFileConfiguration/`
    `_allSuspendExtraSync/_allConfigureOptionalSyncFeature/configureHiddenFileSync`.
  - storage listing: `scanInternalFileNames/scanInternalFiles/getFiles` (+ a large
    commented-out `getFiles_`).
  - `onBindFunction(core, services)` — registers all handlers.

### `src/features/LocalDatabaseMainte/CmdLocalDatabaseMainte.ts`
- `class LocalDatabaseMaintenance extends LiveSyncCommands`:
  - `onunload()` (no-op); `onload()` — register `analyse-database` + `gc-v3` commands and
    the two events.
  - `allChunks(includeDeleted?)`; `get database`; `clearHash()`.
  - `confirm(title, message, affirmative?, negative?)` — yes/no dialog helper.
  - `ensureAvailable(operationName)` — enforce maintenance prerequisites.
  - `resurrectChunks()` — restore deleted-but-referenced chunks from old revs.
  - `commitFileDeletion()` — permanently delete soft-deleted files.
  - `commitChunkDeletion()` — permanently delete marked-deleted chunks.
  - `markUnusedChunks()` — soft-delete unused chunks.
  - `removeUnusedChunks()` — hard-delete unused chunks (data emptied).
  - `scanUnusedChunks()` — compute unused set keeping last 10 revs.
  - `trackChanges(fromStart?, showNotice?)` — incremental chunk-usage tracker off `_changes`.
  - `performGC(showingNotice?)` — batched GC using tracked usage map.
  - `analyseDatabase()` — full chunk/doc analysis → TSV to clipboard.
  - `compactDatabase()` — remote CouchDB compaction with poll loop.
  - (`compactDatabaseWithRevLimit()` — commented out / disabled.)
  - `gcv3()` — device-aware full-scan GC + push + compact (the live GC path).

### `src/features/LocalDatabaseMainte/maintenancePrerequisites.ts`
- `ensureLocalDatabaseMaintenancePrerequisites(opts)` — checks/optionally applies
  `doNotUseFixedRevisionForChunks:true` + `readChunksOnline:false`; returns `boolean`.

### `src/features/LocalDatabaseMainte/CmdLocalDatabaseMainte.unit.spec.ts`
- Vitest suite for the prerequisites guard (already-satisfied, missing-then-apply, cancel).

### `src/modules/features/ModuleLog.ts`
- Module-level: `recentLogEntries` source, `globalLogFunction` (+ `setGlobalLogFunction`),
  `addLog`/`addDisplayLog` (bounded buffers), `updateLogMessage` (debounced),
  `redactLog`/`redactPatterns` (strips PBKDF2 salt), `MARK_DONE` export.
- `class ModuleLog extends AbstractObsidianModule`:
  - `observeForLogs()` — builds the reactive status-bar label (replication/queue/network/
    P2P indicators).
  - `_everyOnload()` — subscribe to leaf/layout/error events.
  - `adjustStatusDivPosition()`; `getActiveFileStatus()`/`setFileStatus()`;
    `updateMessageArea()`; `onActiveLeafChange()`.
  - `applyStatusBarText()` — rAF-throttled status render.
  - `_allStartOnUnload()`; `_everyOnloadStart()` — register `view-log` icon/ribbon/command,
    `dump-debug-info` command, `VIEW_TYPE_LOG` view.
  - `_everyOnloadAfterLoadSettings()` — wire log pipe, build status DOM.
  - `writeLogToTheFile(...)`; `__addLog(message, level?, key?)` — the core log sink
    (Notice de-dup, file write, console).
  - `onBindFunction(...)` — register log handler + lifecycle handlers.

### `src/modules/features/SetupManager.ts`
- `const enum UserMode { NewUser, ExistingUser, Unknown, Update }`.
- `class SetupManager extends AbstractModule` — onboarding/setup-wizard state machine:
  `startOnBoarding`, `onOnboard`, `onUseSetupURI`, `onCouchDBManualSetup`,
  `onBucketManualSetup`, `onP2PManualSetup`, `onlyE2EEConfiguration`, `onConfigureManually`,
  `onSelectServer`, `onConfirmApplySettingsFromWizard`, `onPromptQRCodeInstruction`,
  `decodeQR`, `applySetting`. Drives Svelte dialogs via `services.UI.dialogManager` and
  applies settings via `services.setting`; schedules rebuild/fetch via `core.rebuilder`.

## Dependencies / Consumed by

**Depends on (upstream):**
- `LiveSyncCore` / `ObsidianLiveSyncPlugin` (`src/main.ts`) and the injected service hub
  (`services.API/path/setting/vault/conflict/replication/fileProcessing/appLifecycle/`
  `databaseEvents/UI/storageAccess`), plus `core.localDatabase`, `core.kvDB`,
  `core.replicator`, `core.rebuilder`, `core.confirm`.
- `octagonal-wheels` concurrency (`serialized`, `skipIfDuplicated`, `shareRunningResult`,
  `QueueProcessor`, `Semaphore`, `PeriodicProcessor`), reactive stores, base64/binary,
  and `number.sizeToHumanReadable`.
- `@lib/*` common types/utils, `LiveSyncLocalDB` (`getNoFromRev`), CouchDB replicator
  (`LiveSyncCouchDBReplicator`), i18n `$msg`, `diff_match_patch`, Obsidian `deps.ts`.
- ConfigSync + HiddenFileSync both consume `JsonResolveModal`
  (`HiddenFileCommon/`); ConfigSync also consumes `ConflictResolveModal`
  (`InteractiveConflictResolving/`).

**Consumed by (downstream):**
- `src/main.ts` instantiates all three add-ons (add-on factory) and `ModuleLog`/
  `SetupManager` (module factory).
- `PaneHatch.ts` / `PaneCustomisationSync.ts` / `PaneMaintenance.ts` /
  `PaneSyncSettings.ts` (settings UI, other agent) retrieve `HiddenFileSync` via
  `core.getAddOn` and emit maintenance events.
- `PluginPane.svelte` / `PluginCombo.svelte` consume the `ConfigSync` stores and methods.
- `StorageEventManagerObsidian.ts` and the E2E test scripts reference these features.

## Design observations (factual; fragility/risks for critique)

1. **Hidden File sync relies on mtime+size fingerprints, not content hashes, on the fast
   path.** `statToKey = "{mtime}-{size}"` is the primary change key. Filesystems/OSes that
   don't preserve or faithfully report mtime (Android, network/cloud-synced folders,
   editors that rewrite without mtime change) can cause missed or spurious syncs. The
   deeper content checks (`isDocContentSame`) exist but only run *after* the fingerprint
   says "changed," so a stale-but-equal fingerprint suppresses detection entirely.

2. **Change-tracking state lives in `kvDB` caches** (`_fileInfoLastProcessed`,
   `_fileInfoLastKnown`, `_databaseInfoLastProcessed`). If these caches are lost, cleared,
   or desynchronized from reality, correctness depends on `applyOfflineChanges` /
   `scanAll*` catching up. The `bothUntracked` intersection in `applyOfflineChanges`
   deliberately only reconciles files untracked on BOTH sides, and skips DB-deleted files
   ("Applying deletion can be harmful if the local file is not tracked") — so a deletion on
   one device may not propagate on first offline reconcile.

3. **Two coexisting config-sync formats (V1 doc-per-item, V2 doc-per-file) with
   auto-migration.** The custom zero-width-delimiter serializer (`serialize`/`deserialize2`
   with `​`/`‌`) is bespoke and fragile to any content containing those code
   points; `deserialize` silently falls back JSON→YAML→default, so malformed data degrades
   quietly. Migration (`migrateV1ToV2`) deletes the V1 doc after writing V2 files, per-file,
   without an all-or-nothing transaction — a partial failure mid-loop could leave a mix.

4. **`isTargetFile` is an AND of four filters plus an async ignore-file check, recomputed
   frequently** and only partially cached (`cacheFileRegExps`, `cacheCustomisationSyncIgnoredFiles`).
   The interaction between Hidden File Sync and Customization Sync is explicitly
   overlapping: Customization "Automatic" items are handled by Hidden File Sync
   (`isNotIgnoredByCustomisationSync`), and both features warn the other "may override
   certain behaviors." This shared-ownership boundary is a likely source of the reported
   unreliability.

5. **Conflict resolution defaults to newer-wins for non-JSON hidden files** (`resolveByNewerEntry`
   deletes the older revision by mtime). For binary/plugin files this is a silent
   last-writer-wins with no user visibility, and mtime is exactly the signal item (1) says
   is unreliable.

6. **Most `LocalDatabaseMaintenance` operations are dead-ended in the UI.** Only `gcv3` and
   `analyseDatabase` are reachable; `performGC`, `commitFileDeletion`, `commitChunkDeletion`,
   `markUnusedChunks`, `removeUnusedChunks`, `resurrectChunks` have their call sites
   commented out or absent. `trackChanges`/`performGC` (the incremental path) appear
   superseded by `gcv3` (full-scan path) but remain in the file. This is significant dead/
   latent code around destructive DB operations.

7. **GC safety hinges on cross-device coordination that is only advisory.** `gcv3` warns on
   divergent device progress and unknown accepted nodes but lets the user "Ignore and
   Proceed." Deleting chunks still needed by an unsynchronized device causes missing chunks
   (the code itself points users to "Recreate missing chunks" as recovery). The
   prerequisites guard (`doNotUseFixedRevisionForChunks`/`readChunksOnline`) is a hard gate,
   but device-sync state is not.

8. **`analyseDatabase` and `gcv3` do full O(revisions) / O(docs) scans with per-doc
   `db.get`** (analyse fetches every available revision of every doc concurrently via an
   unbounded `Promise.all(ft)`), which on large vaults risks memory pressure / long stalls.
   `gcv3` loads all chunk `_rev`s into a `Map` in memory before bulk-deleting.

9. **`applyData` (ConfigSync V1) reload logic reaches into Obsidian internals**
   (`this.app.plugins.manifests/enabledPlugins/unloadPlugin/loadPlugin`, all `@ts-ignore`d)
   and, for `CONFIG` category, triggers a restart prompt. Reliance on undocumented internal
   APIs is a durability risk across Obsidian versions.

10. **The abstract base marks `plugin` as `@deprecated` ("Please use core")** yet all three
    subclasses still use `this.plugin` (e.g. `this.app.plugins…`, `this.plugin.addCommand`),
    indicating an incomplete core/plugin decoupling migration.

## Coverage gaps / unclear areas

- `PluginPane.svelte` (655) and `PluginCombo.svelte` (471) — the customization-sync UI — were
  not analyzed in depth (Svelte UI, adjacent to settings-UI agent's scope). The exact
  user-facing merge/apply/delete affordances live there.
- `JsonResolveModal.ts` internals are owned by the conflict-resolution agent (noted only).
- Whether the field-reported Hidden File Sync unreliability is dominated by mtime issues
  (obs. 1), cache desync (obs. 2), or the Customization/Hidden ownership overlap (obs. 4)
  cannot be determined from static reading alone — all three are plausible mechanisms.
- The `ModuleLog` reactive status pipeline depends on `services.replication`/`fileProcessing`
  counters defined outside this subsystem; their semantics were not traced.

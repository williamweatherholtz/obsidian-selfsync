# Settings / Configuration UI

> AS-BUILT reverse-engineering notes for the settings tab subsystem. Depth: LIGHT / INVENTORY
> (a UX overhaul is deferred, so prose is kept minimal but the inventory is complete). All symbol
> names and paths verified by reading the source under `src/modules/features/SettingDialogue/`.

## Purpose & responsibilities

Renders the plugin's Obsidian settings tab: a single `PluginSettingTab` subclass
(`ObsidianLiveSyncSettingTab`) that hosts ~12 "panes" (top-level tabs), each pane being a plain
function that builds `Setting` rows into a container element. It owns:

- A **buffered editing model** (`editingSettings` / `initialSettings`) layered over `core.settings`
  plus a handful of dialogue-only pseudo-settings (`OnDialogSettings`). Edits are dirty-tracked and
  committed via `saveSettings` / `saveAllDirtySettings`.
- An **auto-wiring layer** (`LiveSyncSetting.autoWire*`) that binds a UI control to a setting key by
  looking up display metadata (name/desc/level) from a central `SettingInformation` registry.
- **Visibility / enable gating** driven by config "level" (Advanced / Power-user / Edge-case) toggles
  and per-row `onUpdate` predicates (e.g. `onlyOnCouchDB`, `visibleOnly(...)`).
- **Rebuild orchestration**: detecting when a changed key requires a local/remote DB rebuild
  (`isNeedRebuildLocal`/`isNeedRebuildRemote`) and running `confirmRebuild` / `rebuildDB`.
- Remote connection management, maintenance/recovery actions, and the onboarding "wizard" flow
  (a filtered view of the same panes via `wizardHidden` / `wizardOnly` CSS classes).

## Files & LOC (table)

| File | LOC | Role |
|------|-----|------|
| `ObsidianLiveSyncSettingTab.ts` | 866 | The `PluginSettingTab` host: buffered settings model, save/dirty logic, pane registration/`display()`, rebuild flow |
| `PaneRemoteConfig.ts` | 755 | "Remote Configuration" pane — E2EE + multi-remote connection list (add/import/activate/rename/export/delete); 3 large `if(false)` dead panels |
| `PaneHatch.ts` | 455 | "Hatch" pane — troubleshooting, scram switches, recovery/repair (verify all files, convert obfuscated, etc.) |
| `PaneMaintenance.ts` | 394 | "Maintenance" pane — lock/unlock server, reset sync, journal resets, GC v3, rebuild-remote, delete local DB |
| `LiveSyncSetting.ts` | 351 | `LiveSyncSetting extends Setting`: the auto-wiring engine (toggle/text/number/dropdown/textarea/apply-button) + per-row update handlers |
| `PaneSyncSettings.ts` | 326 | "Sync Settings" pane — preset, sync mode, thinning/batch, deletion, conflict, settings-via-markdown, hidden-file sync |
| `utilFixCouchDBSetting.ts` | 277 | `checkConfig`: probes a CouchDB server config and offers one-click "Fix" buttons (CORS, valid_user, request/doc size). Not currently wired into any live pane |
| `PanePatches.ts` | 245 | "Patches" (Edge-case) pane — compatibility toggles, DB adapter migration, hash algorithm, E2EE algorithm, remediation |
| `PaneSetup.ts` | 210 | "Setup" (wizard) pane — setup URI/QR, rerun onboarding, enable, discard, extra-feature toggles, online tips markdown |
| `settingUtils.ts` | 150 | Summary builders (`getCouchDBConfigSummary` etc.) + PouchDB migration helpers (`migrateDatabases`) |
| `PaneSelector.ts` | 142 | Confusingly-named pane function; renders file-filter settings ("Normal Files" / "Hidden Files") using RegExp list controls |
| `SettingPane.ts` | 119 | Shared types/helpers: `PageFunctions`, `OnUpdateFunc`, `visibleOnly`/`enableOnly`, `setLevelClass`, `wrapMemo` |
| `MultipleRegExpControl.svelte` | 105 | Svelte editor for a list of regex patterns (validity check, inverted-pattern chip, apply/revert) |
| `PaneCustomisationSync.ts` | 77 | "Customization sync" pane — device name, plugin/config sync toggles |
| `PaneChangeLog.ts` | 62 | "ChangeLog" pane — renders `UPDATE_INFO` markdown + version-flash dismiss |
| `PaneGeneral.ts` | 60 | "General Settings" pane — language, status display, logging verbosity |
| `PanePowerUsers.ts` | 59 | "Power users" pane — CouchDB batch tuning, config-encryption passphrase, `enableDebugTools` |
| `SveltePanel.ts` | 54 | `SveltePanel<T>` wrapper to mount/unmount a Svelte component with a `writable` port |
| `PaneAdvanced.ts` | 48 | "Advanced" pane — memory cache, chunk splitter, transfer tweaks |
| `remoteConfigBuffer.ts` | 17 | `syncActivatedRemoteSettings`: realign dialogue buffer with core after switching active remote |
| `InfoPanel.svelte` | 15 | Renders a key→value `InfoTable` from a port (used for remote/E2EE summaries) |
| `settingConstants.ts` | 1 | Barrel re-export of `@lib/common/settingConstants.ts` |
| `remoteConfigBuffer.unit.spec.ts` | 83 | Unit test for the buffer helper |

The setting metadata registry that auto-wiring reads lives outside this directory:
`src/lib/src/common/settingConstants.ts` (`SettingInformation`, `getConfig`, `getConfName`) and
`src/lib/src/common/models/shared.definition.configNames.ts` (`configurationNames`,
`ConfigurationItem` type, `statusDisplay`, level constants).

## The settings framework (LiveSyncSetting / SettingPane / PaneSelector — how panes are declared & rendered)

**Host + editing model (`ObsidianLiveSyncSettingTab`).** Extends Obsidian's `PluginSettingTab`.
On `display()` it clears state, builds a left-hand menu (`menuEl`) of radio "tabs", and registers
each pane. All edits go to `editingSettings` (a shallow copy of `core.settings` merged with
dialogue-only `OnDialogSettings` such as `preset`, `syncMode`, `configPassphrase`,
`deviceAndVaultName`). `isDirty(key)` compares `editingSettings[key]` vs `initialSettings[key]`;
`saveSettings(keys)` writes dirty keys back into `core.settings`, persists via
`services.setting.saveSettingData()`, and fires `onSavedHandlers`. `requestUpdate()` debounces a
pass over every registered `settingComponents[]._onUpdate()`.

**Pane registration.** `display()` defines two closures passed to every pane via `PageFunctions`:
- `addPane(parentEl, title, icon, order, wizardHidden, level?)` — creates a pane `<div>`, a heading,
  and a radio label in the menu; registers the div under `screenElements[order]`. `changeDisplay(order)`
  toggles `setting-collapsed` to switch panes (all panes are always in the DOM; visibility is CSS).
- `addPanel(parentEl, title, callback?, func?, level?)` — creates a titled sub-section (`<h4>`) inside a pane.

Each pane is a standalone function `paneXxx(this: ObsidianLiveSyncSettingTab, paneEl, { addPanel, addPane })`,
bound via `bindPane(...)` and attached with `addPane(...).then(bindPane(paneXxx))`. Registration order
in `display()` (with numeric `order`): ChangeLog(100), Setup(110), General(20), RemoteConfig(0),
SyncSettings(30), Selector(33, Advanced), CustomisationSync(60, Advanced), Hatch(50), Advanced(46),
PowerUsers(47, Power-user), Patches(51, Edge-case), Maintenance(70). A comment reads
`// TODO: Refactor to new API style.`

**Auto-wiring (`LiveSyncSetting`).** Subclasses Obsidian's `Setting`; a static `env` back-reference
points to the tab. Key methods: `autoWireToggle(key, opt)`, `autoWireText`, `autoWireTextArea`,
`autoWireNumeric(key, {clampMin, clampMax, acceptZero})`, `autoWireDropDown(key, {options})`,
`addApplyButton(keys)`. Each `autoWire*`:
1. calls `autoWireSetting(key)` → `getConfig(key)` to pull `{name, desc, status, level, isHidden,
   obsolete}` metadata and set the row name (with `statusDisplay(status)` suffix, e.g. " (Beta)");
2. binds the control's value to `editingSettings[key]` through a memoized `setValue` (`wrapMemo`);
3. on change calls `commitValue`, which writes the buffer and (unless `holdValue`) saves immediately.
`opt.invert` flips a boolean toggle's displayed value vs stored value. `opt.holdValue` defers saving
until an explicit Apply button. `opt.onUpdate` attaches a predicate returning
`{visibility?, disabled?, isCta?, isWarning?}` re-evaluated each `requestUpdate`.

**Config levels & gating.** `ConfigurationItem.level` / the `level` arg to `addPane` map to CSS
classes `sls-setting-{poweruser,advanced,edgecase}` via `setLevelClass`. The container gets
`menu-setting-{poweruser,advanced,edgecase}-enabled/-disabled` based on the `usePowerUserMode` /
`useAdvancedMode` / `useEdgeCaseMode` toggles (set in the Setup pane), so CSS shows/hides whole
levels. Per-row `onUpdate` predicates (`onlyOnCouchDB`, `onlyOnMinIO`, `onlyOnOnlyP2P`,
`onlyOnP2POrCouchDB`, `onlyOnCouchDBOrMinIO`, `visibleOnly`, `enableOnly`, `enableOnlySyncDisabled`)
provide finer conditional visibility/enable.

**Wizard flow.** `wizardHidden` / `wizardOnly` CSS classes mark rows shown only in normal mode vs
only during onboarding. `enableMinimalSetup()` disables all sync flags, sets `isWizard`, and jumps to
the General pane; presets in `PaneSyncSettings` finish the wizard.

**Svelte bridge.** `SveltePanel<T>` mounts a Svelte component with a `writable` port; used for
`InfoPanel` (remote/E2EE summaries) and `MultipleRegExpControl` (regex-list editors in the Selector pane).

## Pane inventory (per pane: purpose + the setting keys it exposes)

**PaneChangeLog** (`paneChangeLog`, order 100, "💬"). No settings; shows `versionUpFlash` banner and
renders `UPDATE_INFO` markdown. Writes `versionUpFlash`, `lastReadUpdates`.

**PaneSetup** (`paneSetup`, order 110, "🧙‍♂️"). Onboarding/reset. Buttons: open/copy setup URI, show
QR, rerun onboarding wizard (`SetupManager.onOnboard`), enable (`isConfigured`), discard settings
(resets to `DEFAULT_SETTINGS` + `resetDatabase`), online troubleshooting markdown viewer.
Toggles: `useAdvancedMode`, `usePowerUserMode`, `useEdgeCaseMode` (each re-renders the tab).

**PaneGeneral** (`paneGeneral`, order 20, "⚙️"). Keys: `displayLanguage` (dropdown), `showStatusOnEditor`,
`showOnlyIconsOnEditor`, `showStatusOnStatusbar`, `hideFileWarningNotice`, `networkWarningStyle`
(BANNER/ICON/HIDDEN dropdown), `lessInformationInLog`, `showVerboseLog`.

**PaneRemoteConfig** (`paneRemoteConfig`, order 0, "🛰️"). Two live panels + one autowired key:
- "E2EE Configuration": summary `InfoPanel` + buttons launching `SetupManager` E2EE flows (no direct keys).
- "Remote Databases": CRUD over `remoteConfigurations` (a `Record<id, RemoteConfiguration>`) +
  `activeConfigurationId`; add/import(connection string)/configure/activate/rename/export/duplicate/
  fetch-remote-settings/delete. Uses `ConnectionStringParser`, `SetupRemote*` Svelte dialogs.
- "Notification": `notifyThresholdOfRemoteStorageSize`.
- **Dead code:** three `if (false) { ... }` blocks that would render standalone CouchDB / MinIO-S3-R2 /
  P2P "Configure Remote" panels (superseded by the connection-list UI).

**PaneSyncSettings** (`paneSyncSettings`, order 30, "🔄"). Panels/keys:
- Preset: `preset` (dialogue-only; applies bundles of sync flags) + Apply.
- Method: `syncMode` (dialogue-only ONEVENTS/PERIODIC/LIVESYNC → sets `liveSync`/`periodicReplication`),
  `periodicReplicationInterval`, `syncMinimumInterval`, `syncOnSave`, `syncOnEditorSave`, `syncOnFileOpen`,
  `syncOnStart`, `syncAfterMerge`, `keepReplicationActiveInBackground` (desktop only).
- Update Thinning: `batchSave`, `batchSaveMinimumDelay`, `batchSaveMaximumDelay`.
- Deletion (Advanced): `trashInsteadDelete`, `doNotDeleteFolder`.
- Conflict (Advanced): `resolveConflictsByNewerFile`, `checkConflictOnlyOnOpen`, `showMergeDialogOnlyOnActive`.
- Settings-via-Markdown (Advanced): `settingSyncFile`, `writeCredentialsForSettingSync`, `notifyAllSettingSyncFile`.
- Hidden Files (Advanced): `syncInternalFiles` (via Merge/Fetch/Overwrite enable buttons, not a plain toggle),
  `suppressNotifyHiddenFilesChange`, `syncInternalFilesBeforeReplication`, `syncInternalFilesInterval`.

**PaneSelector** (`paneSelector`, order 33, Advanced, "🚦"). Despite the name, this is the file-filter
pane. Keys: `syncOnlyRegEx`, `syncIgnoreRegEx` (regex-list editors), `syncMaxSizeInMB`, `useIgnoreFiles`,
`ignoreFiles`; and hidden-file patterns `syncInternalFilesTargetPatterns`, `syncInternalFilesIgnorePatterns`
(with Default / Cross-platform buttons), `syncInternalFileOverwritePatterns`.

**PaneCustomisationSync** (`paneCustomisationSync`, order 60, Advanced, "🔌"). Keys: `deviceAndVaultName`,
`usePluginSyncV2`, `usePluginSync`, `autoSweepPlugins`, `autoSweepPluginsPeriodic`,
`notifyPluginOrSettingUpdated`; plus an "Open" button (plugin-sync dialog event).

**PaneHatch** (`paneHatch`, order 50, wizardHidden, "🧰"). Mostly action buttons:
- Troubleshooting: Run Doctor, Scan Broken files, Copy Report, Analyse DB usage, reset remote-size
  notification threshold; toggle `writeLogToTheFile`.
- "Scram Switches": `suspendFileWatching`, `suspendParseReplicationResult` (both ask restart).
- Recovery & Repair: recreate all chunks, resolve conflicts by newer, verify & repair all files
  (storage↔DB compare), convert non-path-obfuscated files. No autowired keys here.
- Reset: "Back to non-configured" (`isConfigured=false`), delete customization-sync data.

**PaneAdvanced** (`paneAdvanced`, order 46, Advanced, "🔧"). Keys: `hashCacheMaxCount`
(`hashCacheMaxAmount` is commented out), `chunkSplitterVersion` (dropdown), `customChunkSize`,
`readChunksOnline`, `useOnlyLocalChunk`, `concurrencyOfReadChunksOnline`,
`minimumIntervalOfReadChunksOnline`, `autoAcceptCompatibleTweak`.

**PanePowerUsers** (`panePowerUsers`, order 47, Power-user, "💪"). Keys: `batch_size`, `batches_limit`,
`useTimeouts` (CouchDB only); `configPassphraseStore` (dropdown) + `configPassphrase` (password, hold+Apply);
`enableDebugTools`.

**PanePatches** (`panePatches`, order 51, Edge-case, "🩹"). Keys: `deleteMetadataOfDeletedFiles`,
`automaticallyDeleteMetadataOfDeletedFiles`, `disableMarkdownAutoMerge`, `writeDocumentsIfConflicted`,
DB-adapter migration buttons (IndexedDB↔IDB) + `handleFilenameCaseSensitive`, `watchInternalFileChanges`
(rendered inverted), `E2EEAlgorithm` (dropdown), `useDynamicIterationCount`, `additionalSuffixOfDatabaseName`
(hold+Apply), `hashAlg` (dropdown), `doNotSuspendOnFetching`, `doNotDeleteFolder`,
`processSizeMismatchedFiles`, `disableWorkerForGeneratingChunks`, `processSmallFilesInUIThread`,
`disableCheckingConfigMismatch`, `maxMTimeForReflectEvents` (datetime picker), `enableCompression`
(under "Remote Database Tweak (In sunset)"; the `useEden*` keys are commented out).

**PaneMaintenance** (`paneMaintenance`, order 70, wizardHidden, "🎛️"). All action buttons, no autowired
keys: lock/unlock server, mark device resolved, emergency restart, reset sync on this device
(FETCH_ALL flag), overwrite server (REBUILD_ALL flag), resend chunks, journal received/sent/counter
resets (MinIO), GC v3, perform cleanup (compact), overwrite remote, fresh-start wipe, delete local DB.
Large blocks of older GC panels are commented out.

## Notable confusing / inverted / jargon setting names (catalog for future UX critique)

Double negatives / inverted semantics:
- `doNotUseFixedRevisionForChunks` — double negative; a rebuild trigger key (`isNeedRebuildLocal/Remote`).
- `doNotDeleteFolder`, `doNotSuspendOnFetching` — "do not X" toggles invert the natural on=action reading.
- `watchInternalFileChanges` — rendered with `{ invert: true }` in PanePatches, so the toggle's on/off
  state is the opposite of the stored value (UI label "Compatibility (Internal API Usage)" gives no hint).
- `lessInformationInLog` — displayed as "Show only notifications"; name and label diverge.
- `suppressNotifyHiddenFilesChange`, `disableMarkdownAutoMerge`, `disableWorkerForGeneratingChunks`,
  `disableCheckingConfigMismatch` — "disable/suppress" phrasing (off = feature on).

Jargon / opaque units:
- `hashCacheMaxAmount` — display name "Memory cache size (by total characters)", desc literally "(Mega chars)".
  Unit "mega chars" is non-obvious. (Currently commented out in PaneAdvanced but live in metadata.)
- `useIndexedDBAdapter` — the migration UI labels the two states "IndexedDB" vs "IDB", where both are
  IndexedDB-backed PouchDB adapters (`indexeddb` vs `idb`); the distinction is invisible from the labels.
- `maxMTimeForReflectEvents` — "Maximum file modification time for reflected file events" (epoch seconds); dense.
- `processSmallFilesInUIThread`, `processSizeMismatchedFiles`, `disableWorkerForGeneratingChunks` — internal
  processing terms surfaced verbatim as user toggles.
- `E2EEAlgorithm` values `ForceV1` / `V1` / (default) — versioned crypto jargon.
- `hashAlg` dropdown labels: "xxhash32 (Fast but less collision resistance)", "xxhash64 (Fastest)",
  "mixed-purejs (PureJS fallback W/O WebAssembly)", "sha1 (Older fallback, Slow)" — implementation-level.
- `chunkSplitterVersion`, `customChunkSize`, `readChunksOnline`, `useOnlyLocalChunk`,
  `concurrencyOfReadChunksOnline`, `minimumIntervalOfReadChunksOnline` — "chunk" terminology throughout.
- `additionalSuffixOfDatabaseName`, `autoAcceptCompatibleTweak`, `tweakModified` — "tweak" is internal vocabulary.
- Panel/section titles as jargon: "Scram!", "Scram Switches", "Hatch", "Remote Database Tweak (In sunset)",
  "Edge case addressing (Processing/Behaviour/Database)", "Garbage Collection V3 (Beta)".

Structural / naming mismatches:
- The pane titled **"Selector"** (function `paneSelector`) actually configures file inclusion/exclusion
  filters ("Normal Files" / "Hidden Files"); neither the tab title nor icon (🚦) conveys "file filters".
- Dialogue-only pseudo-settings `preset` and `syncMode` are not persisted keys — they compute and write
  the real flags (`liveSync`, `periodicReplication`, `syncOn*`), so "current" state can look duplicated.
- `usePluginSync` vs `usePluginSyncV2` presented adjacently with no explanation of the version relationship.

## Dependencies / Consumed by

- **Obsidian API** (`@/deps.ts`): `PluginSettingTab`, `Setting`, `Menu`, `MarkdownRenderer`, component types.
- **Setting metadata**: `@lib/common/settingConstants.ts` (`SettingInformation`, `getConfig`, `getConfName`),
  `@lib/common/models/shared.definition.configNames.ts` (`configurationNames`, `ConfigurationItem`,
  `statusDisplay`, `LEVEL_*`). Types from `@lib/common/types.ts` (`ObsidianLiveSyncSettings`, `REMOTE_*`, flags).
- **Core services** (via `this.core` / `this.services`): `replicator`, `setting`, `database`,
  `appLifecycle`, `control`, `conflict`, `vault`, `path`, `tweakValue`, `UI`, `API`, `config`, `rebuilder`,
  `storageAccess`, `localDatabase`, `fileHandler`. Modules: `SetupManager`, `HiddenFileSync`,
  `JournalSyncCore` + `MinioStorageAdapter`.
- **Svelte**: `SveltePanel`, `InfoPanel.svelte`, `MultipleRegExpControl.svelte`, `SetupRemote*.svelte`,
  `@lib/UI/components/InfoTable.svelte`.
- **Events** (`@/common/events.ts`): emits setup-URI/QR, plugin-sync-dialog, doctor, fix-incomplete,
  analyse-DB, check-remote-size, GC-v3, show-history requests; subscribes to `EVENT_REQUEST_RELOAD_SETTING_TAB`.
- **Remote parsing**: `ConnectionStringParser`, `activateRemoteConfiguration`, `remoteConfigBuffer.ts`.
- **Consumed by**: registered as the plugin's settings tab (constructed with `App` + `ObsidianLiveSyncPlugin`).
  `utilFixCouchDBSetting.checkConfig` is presently unreferenced by any live pane (the "Check config" flow is
  commented out in PaneRemoteConfig).

## Design observations (factual; structural smells; no fixes)

- **Dead/disabled UI kept in source.** PaneRemoteConfig contains three full `if (false)` panels
  (CouchDB / MinIO / P2P configure) plus a large commented "Next" button; PaneMaintenance has ~150 lines
  of commented-out GC panels; PaneAdvanced and PanePatches comment out several settings (`hashCacheMaxAmount`,
  `sendChunksBulk*`, `useEden*`, `useRequestAPI`). `checkConfig` (277 LOC) is fully implemented but unwired.
- **Panes are free functions sharing mutable `this` state**, not classes; each is registered with a `TODO:
  Refactor to new API style` comment. All panes live in the DOM simultaneously; switching is CSS-class only.
- **Three overlapping visibility mechanisms**: config `level` + mode toggles (CSS), per-row `onUpdate`
  predicates (JS), and `wizardHidden`/`wizardOnly` classes. A row's actual visibility is the intersection.
- **Two settings namespaces are merged** (`ObsidianLiveSyncSettings` + `OnDialogSettings`); dialogue-only
  keys (`preset`, `syncMode`, `configPassphrase`, `deviceAndVaultName`) are special-cased in every
  save/apply/refresh path (`if (k in OnDialogSettingsDefault)`), and `saveLocalSetting` hand-routes two of them.
- **Display metadata is centralized but split** across `SettingInformation` (in `settingConstants.ts`) and
  `configurationNames` (in `shared.definition.configNames.ts`); `_getConfig` checks `configurationNames`
  first, then `SettingInformation`. A missing entry silently renders no row (autoWire returns early).
- **Rebuild-trigger key set is hard-coded** in `isNeedRebuildLocal`/`isNeedRebuildRemote`; adding a
  rebuild-sensitive key requires editing those arrays by hand (no metadata flag drives it).
- **Heavy reliance on `//@ts-ignore`** across the buffered-settings copy logic (`applySetting`,
  `saveSettings`, `refreshSetting`) because the key is a union over two setting shapes.
- **Emoji as primary affordance** for pane tabs and several remote-list actions (➕ 📥 🔧 ✅ … 🪪 📤 🧬 📡 🗑),
  carrying meaning with no text label in the compact buttons.

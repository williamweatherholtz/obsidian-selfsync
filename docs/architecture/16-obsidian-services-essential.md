# Obsidian Services, Essential & Extra Modules

*As-built reverse-engineering baseline. Scope: `src/modules/services/`, `src/modules/essential/`, `src/modules/essentialObsidian/`, `src/modules/extras/`, `src/serviceFeatures/`, `src/serviceModules/`. Read-only analysis; symbols/paths verified against source.*

## Purpose & responsibilities

This subsystem is the **Obsidian-platform adaptation layer** that binds the platform-agnostic sync core (`LiveSyncBaseCore` in `src/LiveSyncBaseCore.ts`, base implementations under `src/lib/src/`) to the concrete Obsidian host (`App`, `Vault`, `DataAdapter`, workspace, commands, protocol handlers). Nothing here contains sync algorithms; instead it:

- Instantiates the **service hub** — the DI container of Obsidian-specific service subclasses (`src/modules/services/`).
- Provides **service modules** — platform I/O primitives wrapping Obsidian's `Vault`/`DataAdapter` behind portable adapter interfaces (`src/serviceModules/`).
- Registers **service features** — functional lifecycle middleware for cross-cutting behaviors (red-flag files, P2P UI, setup protocol/URI, i18n) (`src/serviceFeatures/`).
- Provides **legacy-style modules** — `AbstractModule`/`AbstractObsidianModule` classes for menu commands, migration/doctor, workspace-event wiring, and dev tooling (`src/modules/essential/`, `essentialObsidian/`, `extras/`).

### The four wiring concepts (module vs service vs service-module vs service-feature)

All four are assembled in `src/main.ts`'s `ObsidianLiveSyncPlugin` constructor and passed to `LiveSyncBaseCore`. The naming maps to distinct registration mechanisms — this directly complements the DI system documented by the DI-focused agent:

| Concept | Registry key | Shape | How registered | Examples in this scope |
|---|---|---|---|---|
| **Service** | `core.services.*` | Class extending an `Injectable*Service`/base service, constructor-injected deps | `ObsidianServiceHub` constructor builds each with explicit deps, then `satisfies Required<ServiceInstances>` | `ObsidianAPIService`, `ObsidianVaultService`, `ObsidianDatabaseService`, `ObsidianSettingService` |
| **Service module** | `core.serviceModules.*` | Class implementing an I/O abstraction (file/storage/db access), built from adapters | `initialiseServiceModules()` in `main.ts` returns `{rebuilder, fileHandler, databaseFileAccess, storageAccess}` | `FileAccessObsidian`, `ServiceFileHandler`, `ServiceDatabaseFileAccess`, `Obsidian*Adapter` |
| **Service feature** | none (side-effecting) | Plain `use*()` function taking a `NecessaryServices<services, serviceModules>` host; registers handlers on lifecycle events | Called imperatively in `main.ts` feature initialiser (`useRedFlagFeatures(core)`, etc.) | `useRedFlagFeatures`, `useP2PReplicatorUI`, `useSetupProtocolFeature`, `enableI18nFeature` |
| **Module** (legacy) | held in `extraModules[]` | Class extending `AbstractModule`/`AbstractObsidianModule` with `onBindFunction(core, services)` | Instantiated in the `extraModules` factory in `main.ts` | `ModuleBasicMenu`, `ModuleMigration`, `ModuleObsidianEvents`, `ModuleObsidianMenu`, `ModuleDev` |

**Discernible distinction.** A *service* owns state + behavior and is resolved by dependency injection through the hub (portable across platforms via `ObsidianServiceContext`; the code comments note an ongoing migration from "Injectable" to "Plain" services). A *service module* is the platform's concrete I/O plumbing (Obsidian `Vault`/`DataAdapter` calls) hidden behind `IFileSystemAdapter`/`IStorageAdapter`/etc. so the same core runs on the CLI and webapp targets (`src/apps/cli`, `src/apps/webapp` carry parallel adapter sets). A *service feature* is stateless functional middleware — it wires event handlers rather than being resolved. A *module* is the older `AbstractModule` mechanism (`onBindFunction` binds handlers to `appLifecycle` event hooks like `onInitialise`/`onLayoutReady`/`onFirstInitialise`); several carry `// TODO … should be moved` comments indicating features are being migrated out of modules toward service-features.

## Files & LOC (table)

| File | LOC | Kind |
|---|---|---|
| `serviceFeatures/redFlag.unit.spec.ts` | 1621 | test |
| `serviceFeatures/redFlag.ts` | 490 | service feature |
| `modules/essential/ModuleMigration.ts` | 359 | module |
| `modules/essentialObsidian/ModuleObsidianEvents.ts` | 293 | module |
| `serviceFeatures/redFlag.simpleFetch.ts` | 250 | service feature |
| `modules/services/ObsidianAPIService.ts` | 215 | service |
| `serviceFeatures/useP2PReplicatorUI.ts` | 168 | service feature |
| `modules/essentialObsidian/ModuleObsidianEvents.unit.spec.ts` | 166 | test |
| `modules/essentialObsidian/APILib/ObsHttpHandler.ts` | 133 | infra |
| `serviceFeatures/setupObsidian/setupProtocol.unit.spec.ts` | 131 | test |
| `modules/services/ObsidianServiceHub.ts` | 126 | service (hub) |
| `modules/extras/ModuleDev.ts` | 116 | module |
| `modules/services/ObsidianConfirm.ts` | 111 | service (dialog) |
| `modules/extras/devUtil/tests.ts` | 90 | dev util |
| `serviceFeatures/setupObsidian/setupManagerHandlers.unit.spec.ts` | 87 | test |
| `modules/essential/ModuleBasicMenu.ts` | 86 | module |
| `serviceModules/FileSystemAdapters/ObsidianFileSystemAdapter.ts` | 64 | service module (adapter) |
| `serviceModules/FileSystemAdapters/ObsidianVaultAdapter.ts` | 61 | service module (adapter) |
| `serviceModules/FileSystemAdapters/ObsidianStorageAdapter.ts` | 57 | service module (adapter) |
| `serviceFeatures/onLayoutReady/enablei18n.ts` | 54 | service feature |
| `modules/extras/devUtil/TestPaneView.ts` | 53 | dev util (view) |
| `modules/essentialObsidian/ModuleObsidianMenu.ts` | 41 | module |
| `modules/services/ObsidianPathService.ts` | 41 | service |
| `modules/services/ObsidianSettingService.ts` | 39 | service |
| `serviceFeatures/setupObsidian/setupProtocol.ts` | 37 | service feature |
| `modules/services/SvelteDialogObsidian.ts` | 37 | service (dialog) |
| `modules/services/ObsidianUIService.ts` | 36 | service |
| `modules/services/ObsidianVaultService.ts` | 36 | service |
| `modules/services/ObsidianServices.ts` | 34 | service (barrel of subclasses) |
| `serviceFeatures/setupObsidian/setupManagerHandlers.ts` | 34 | service feature |
| `serviceModules/FileSystemAdapters/ObsidianConversionAdapter.ts` | 18 | service module (adapter) |
| `serviceModules/FileSystemAdapters/ObsidianPathAdapter.ts` | 16 | service module (adapter) |
| `serviceModules/FileSystemAdapters/ObsidianTypeGuardAdapter.ts` | 16 | service module (adapter) |
| `modules/services/ObsidianDatabaseService.ts` | 16 | service |
| `modules/services/ObsidianAppLifecycleService.ts` | 15 | service |
| `serviceModules/FileAccessObsidian.ts` | 14 | service module |
| `serviceModules/DatabaseFileAccess.ts` | 8 | service module |
| `serviceModules/FileHandler.ts` | 7 | service module |
| `serviceModules/ServiceFileAccessImpl.ts` | 5 | service module |
| `serviceFeatures/onLayoutReady.ts` | 3 | service feature (barrel) |
| `modules/extras/devUtil/TestPane.svelte` | (svelte) | dev util (UI) |

Non-test LOC in scope ≈ 3.3k. The `redFlag` and `ModuleObsidianEvents`/`ModuleMigration` files dominate.

## Key types / data structures

- **`ObsidianServiceContext`** (`@lib/services/implements/obsidian/ObsidianServiceContext`) — the DI context threaded into every service; wraps `app`, `plugin`, and `liveSyncPlugin`. Constructed once in `ObsidianServiceHub` as `new ObsidianServiceContext(plugin.app, plugin, plugin)`.
- **`ServiceInstances<ObsidianServiceContext>`** — the full service registry shape; `ObsidianServiceHub` asserts completeness with `satisfies Required<...>`.
- **`ServiceModules`** (`{rebuilder, fileHandler, databaseFileAccess, storageAccess}`) — return type of `initialiseServiceModules`.
- **`NecessaryServices<T extends keyof ServiceHub, U extends keyof ServiceModules>`** (`@lib/interfaces/ServiceModule`) — `{ services: RequiredServices<T>; serviceModules: RequiredServiceModules<U> }`. The host contract every service-feature declares; keys enumerate exactly the services/serviceModules a feature touches (e.g. red-flag needs services `API|appLifecycle|UI|setting|tweakValue|fileProcessing|vault|path|keyValueDB|database` + serviceModules `storageAccess|rebuilder|fileHandler`).
- **`ServiceFeatureFunction<T,U,TR>`** / **`createServiceFeature()`** — typing helper (identity function) for authoring features.
- **`FlagFileHandler`** (`redFlag.ts`) — `{ priority: number; check(): Promise<boolean>; handle(): Promise<boolean> }`; the strategy interface for red-flag files.
- **`IFileSystemAdapter<TAbstractFile,TFile,TFolder,Stat>`** and sub-adapters `IPathAdapter`/`ITypeGuardAdapter`/`IConversionAdapter`/`IStorageAdapter`/`IVaultAdapter` (`@lib/serviceModules/adapters`) — the portable file-system abstraction the Obsidian adapters implement.
- **`ErrorInfo`** (`ModuleMigration.ts`) — `{path, recordedSize, actualSize, storageSize, contentMatched, isConflicted?}`, used in the incomplete-docs size-mismatch scan.
- **`VIEW_TYPE_TEST`** = `"ols-pane-test"`, **`VIEW_TYPE_P2P`**, **`VIEW_TYPE_P2P_SERVER_STATUS`** — Obsidian leaf view types registered by extras/features.

Several files augment Obsidian's typings via `declare module "obsidian"` (e.g. `App.appId?/isMobile?` in `ObsidianAPIService`, `App.commands.executeCommandById` in `ObsidianAppLifecycleService`, `DataAdapter.insensitive?` in `ObsidianVaultService`, `Vault.getAbstractFileByPathInsensitive`/`DataAdapter.reconcileInternalFile?` in `ObsidianFileSystemAdapter`).

## Service/module inventory (grouped by dir; per file)

### `src/modules/services/` — the Obsidian service hub

**`ObsidianServiceHub.ts`** — `class ObsidianServiceHub extends InjectableServiceHub<ObsidianServiceContext>`. Constructor manually instantiates all ~18 services in dependency order, wiring each with an explicit deps object, then passes the `satisfies Required<ServiceInstances>` map to `super(context, …)`. This is the composition root for the service layer.

**`ObsidianServices.ts`** — barrel of thin Obsidian subclasses, mostly empty bodies (behavior inherited from `@lib` Injectable bases): `ObsidianDatabaseEventService`, `ObsidianReplicatorService`, `ObsidianFileProcessingService`, `ObsidianReplicationService`, `ObsidianRemoteService`, `ObsidianConflictService`, `ObsidianTweakValueService`, `ObsidianTestService`, `ObsidianConfigService` (extends `ConfigServiceBrowserCompat`), `ObsidianKeyValueDBService` (extends `KeyValueDBService`), `ObsidianControlService` (extends `ControlService`).

**`ObsidianAPIService.ts`** — `class ObsidianAPIService extends InjectableAPIService<ObsidianServiceContext>`. The platform-capabilities gateway.
- `getCustomFetchHandler(): ObsHttpHandler` — lazily creates the S3/Smithy fetch handler.
- `showWindow(viewType): Promise<void>` — open or reveal a leaf of a view type.
- `override showWindowOnRight(viewType)` — reveal existing / open in right sidebar leaf, falling back to `showWindow`.
- `private get app()` — `this.context.app`.
- `override getPlatform(): string` — maps `Platform.*` flags to a string (`android-app`/`ios`/`macos`/`mobile-app`/`mobile`/`safari`/`desktop`/`desktop-app`/`unknown-obsidian`).
- `override isMobile()` / `override getAppID()` / `override getSystemVaultName()` / `override getAppVersion()` (parses `obsidian/x.y.z` from userAgent) / `override getPluginVersion()`.
- `get confirm(): Confirm` — the `ObsidianConfirm` instance.
- `addCommand(command)` / `registerWindow(type, factory)` / `addRibbonIcon(icon,title,cb)` / `registerProtocolHandler(action,handler)` — thin delegations to `plugin.*`.
- `override nativeFetch(req, opts): Promise<Response>` — **CORS workaround**: rebuilds the request and routes through Obsidian's `requestUrl` (strips `host`/`content-length`, defaults content-type), returning a synthesized `Response`.
- `override addStatusBarItem()` / `override setInterval(handler,timeout)` (registers via `plugin.registerInterval`) / `override getSystemConfigDir()`.

**`ObsidianAppLifecycleService.ts`** — `class ObsidianAppLifecycleService<T> extends AppLifecycleServiceBase<T>`. `performRestart()` — executes Obsidian command `app:reload`.

**`ObsidianDatabaseService.ts`** — `class ObsidianDatabaseService<T> extends DatabaseService<T>`. Registers `__onOpenDatabase(vaultName)` handler which calls `initializeStores(vaultName)` (Svelte stores). Wires the handler in the constructor via `onOpenDatabase.addHandler`.

**`ObsidianSettingService.ts`** — `class ObsidianSettingService<T> extends SettingService<T>`. Bridges settings persistence: `setItem`/`getItem`/`deleteItem` use `compatGlobal.localStorage` (with `// TODO: Implement nativeLocalStorage`); `override saveData`/`loadData` delegate to `plugin.saveData/loadData`. Constructor re-emits `EVENT_SETTING_SAVED`/`EVENT_REQUEST_RELOAD_SETTING_TAB` on the global `eventHub` when settings save/load.

**`ObsidianPathService.ts`** — `class ObsidianPathService extends PathService<…>`. Overrides `markChangesAreSame`, `unmarkChanges`, `compareFileFreshness`, `isMarkedAsSameChanges` (delegating to `@/common/utils`, which use IndexedDB-backed "same-change" marks — see note in `serviceModules/FileHandler.ts`), and `normalizePath` (Obsidian's `normalizePath`).

**`ObsidianVaultService.ts`** — `class ObsidianVaultService extends InjectableVaultService<…>`. `vaultName()`, `getActiveFilePath(): FilePath|undefined` (from workspace active file), `isStorageInsensitive()` (reads `adapter.insensitive ?? true`), `override shouldCheckCaseInsensitively()` (skips the check when storage is insensitive), `override isValidPath()`.

**`ObsidianUIService.ts`** — `class ObsidianUIService extends UIService<…>`. Overrides `dialogToCopy` getter (`DialogToCopy.svelte`). Constructor composes an `ObsidianSvelteDialogManager` (deps: appLifecycle/config/replicator/confirm/control) and passes it plus `APIService` up to the base. Exposes `ObsidianUIServiceDependencies` type.

**`ObsidianConfirm.ts`** — `class ObsidianConfirm<T> implements Confirm`. The interactive-dialog facade; delegates to `@/modules/coreObsidian/UILib/dialogs`. Methods: `askYesNo`, `askString`, `askYesNoDialog` (wide-button, i18n labels), `askSelectString`, `askSelectStringDialogue`, `askInPopup` (schedules a `Notice` popup with a clickable anchor, auto-close after 20s via `scheduleTask`), `confirmWithMessage`. Uses the `memoObject`/`scheduleTask` memoization utilities.

**`SvelteDialogObsidian.ts`** — glue between Svelte dialogs and Obsidian's `Modal`. `SvelteDialogBase = SvelteDialogMixIn(Modal, DialogHost)`. `class SvelteDialogObsidian<T,U,C>` extends it. `class ObsidianSvelteDialogManager<T> extends SvelteDialogManagerBase<T>` with `override openSvelteDialog(component, initialData)` — instantiates the dialog, `open()`s it, and awaits `waitForClose()`.

### `src/modules/essential/` — platform-neutral essential modules

**`ModuleBasicMenu.ts`** — `class ModuleBasicMenu extends AbstractModule`. `_everyOnloadStart()` registers commands: `livesync-replicate`, `livesync-dump`, `livesync-toggle` (flips `settings.liveSync`, applies + saves), `livesync-suspendall`, `livesync-scan-files`, `livesync-runbatch` (`commitPendingFileEvents`), `livesync-abortsync` (`core.replicator.terminateSync`). `onBindFunction` binds start to `appLifecycle.onInitialise`. Header comment notes these "ought to be in each respective feature."

**`ModuleMigration.ts`** — `class ModuleMigration extends AbstractModule`. The **doctor / data-integrity** module (see Important services).
- `migrateUsingDoctor(skipRebuild, activateReason, forceRescan)` — runs `performDoctorConsultation`, persists modified settings, schedules rebuild/fetch + restart if required.
- `migrateDisableBulkSend()` — one-shot fix disabling corrupted bulk send.
- `initialMessage()` — delegates onboarding to `SetupManager.startOnBoarding()` (large legacy block commented out).
- `askAgainForSetupURI()` — dialog routing to wizard / P2P / manual setup via `eventHub` events.
- `hasIncompleteDocs(force)` — scans all normal docs, compares recorded/actual/storage sizes, categorizes recoverable vs unrecoverable, optionally repairs from storage; caches result in `kvDB` key `checkIncompleteDocs`.
- `hasCompromisedChunks()` — (encrypted vaults only) counts compromised chunks locally + remotely, offers rebuild/fetch/dismiss.
- `_everyOnFirstInitialize()` — the boot integrity gate (chained checks).
- `_everyOnLayoutReady()` — subscribes to `EVENT_REQUEST_RUN_DOCTOR`/`EVENT_REQUEST_RUN_FIX_INCOMPLETE`.
- `onBindFunction` binds to `onLayoutReady` + `onFirstInitialise`.

### `src/modules/essentialObsidian/` — Obsidian-specific essential modules

**`ModuleObsidianEvents.ts`** — `class ModuleObsidianEvents extends AbstractObsidianModule`. The **workspace/OS event integration** hub (see Important services). Members: `_everyOnloadStart` (registers `vault.on("rename")`→`EVENT_FILE_RENAMED`, `workspace.on("active-leaf-change")`→`EVENT_LEAF_ACTIVE_CHANGED`), `__performAppReload`, `swapSaveCommand` (monkey-patches `editor:save-file` + CodeMirror save), `registerWatchEvents` (file-open/visibilitychange/focus/blur/online/offline DOM events), `setHasFocus`, `watchWindowVisibility`, `watchOnline`, `watchOnlineAsync`, `watchWindowVisibilityAsync` (background-keep-alive logic), `watchWorkspaceOpen`/`watchWorkspaceOpenAsync`, `_everyOnLayoutReady`, `_askReload` (restart-now/after-stable/later dialog), `_scheduleAppReload` (reactive process-count watcher → auto restart when idle), `_isReloadingScheduled`. `onBindFunction` wires `onLayoutReady`/`onInitialise` handlers and sets `askRestart`/`scheduleRestart`/`isReloadingScheduled` handlers.

**`ModuleObsidianMenu.ts`** — `class ModuleObsidianMenu extends AbstractModule`. `_everyOnloadStart` registers the `replicate` SVG icon (`addIcon`), a ribbon icon (`livesync-ribbon-replicate`) triggering `replication.replicate(true)`, and the `livesync-checkdoc-conflicted` editor command (`conflict.queueCheckForIfOpen`). Binds to `onInitialise`.

**`APILib/ObsHttpHandler.ts`** — `class ObsHttpHandler extends FetchHttpHandler` (AWS Smithy). Adapted from remotely-save (Apache-2). `override handle(request, {abortSignal})` routes S3/AWS SDK HTTP through Obsidian `requestUrl` (with query-string building, header lowercasing, host/content-length stripping, body normalization to ArrayBuffer, and a `Promise.race` timeout + abort). Module-private `requestTimeout(ms)` helper.

### `src/modules/extras/` — dev/debug tooling

**`ModuleDev.ts`** — `class ModuleDev extends AbstractObsidianModule` (currently **commented out** in `main.ts`). `_everyOnloadStart` clears missing-translation handler; `onMissingTranslation(key)` appends missing i18n keys to `<configDir>/ls-debug/missing-translation-<date>.jsonl`; `_everyOnloadAfterLoadSettings` (gated on `settings.enableDebugTools`) registers `VIEW_TYPE_TEST` view + `view-test` command; `_everyOnLayoutReady` registers `test-create-conflict` command (fabricates a conflicting revision via `bulkDocsRaw`); `testResults` writable store; `_addTestResult`, `_everyModuleTest`. Binds test handlers on the `test` service.

**`devUtil/TestPaneView.ts`** — `class TestPaneView extends ItemView` hosting `TestPane.svelte`; `VIEW_TYPE_TEST = "ols-pane-test"`. Standard `getViewType`/`getDisplayText`/`onOpen`/`onClose`.

**`devUtil/tests.ts`** — micro-benchmark harness. `perf_trench(plugin)` measures `Trench.evacuate` over strings and 10kb/100kb/1mb test binaries; helpers `measure`, `measureEach`, `clearResult`, `formatNumber`, `formatPerfResults` (markdown table).

**`devUtil/TestPane.svelte`** — the debug pane UI (not read; Svelte component).

### `src/serviceModules/` — Obsidian platform I/O (service modules)

**`FileAccessObsidian.ts`** — `class FileAccessObsidian extends FileAccessBase<ObsidianFileSystemAdapter>`; constructs the `ObsidianFileSystemAdapter(app)` and passes it + deps to the base. The vault-access primitive.

**`ServiceFileAccessImpl.ts`** — `class ServiceFileAccessObsidian extends ServiceFileAccessBase<ObsidianFileSystemAdapter>` (re-export shell). Becomes `storageAccess` in `main.ts`.

**`FileHandler.ts`** — `class ServiceFileHandler extends ServiceFileHandlerBase` (empty body; comment records that `markChangesAreSame`/`compareFileFreshness` were moved to `PathService`).

**`DatabaseFileAccess.ts`** — `class ServiceDatabaseFileAccess extends ServiceDatabaseFileAccessBase implements DatabaseFileAccess` (empty; comment notes IndexedDB-backed same-change marks kept out of `/lib/serviceModules`).

**`FileSystemAdapters/`** — the six-part adapter split behind `IFileSystemAdapter`:
- `ObsidianFileSystemAdapter.ts` — composes the five sub-adapters; implements `getAbstractFileByPath`, `getAbstractFileByPathInsensitive`, `getFiles`, `statFromNative`, `reconcileInternalFile`.
- `ObsidianStorageAdapter.ts` — `IStorageAdapter<Stat>` over `app.vault.adapter`: `exists`, `trystat`, `stat`, `mkdir`, `remove`, `read`, `readBinary`, `write`, `writeBinary`, `append`, `list`.
- `ObsidianVaultAdapter.ts` — `IVaultAdapter<TFile,TFolder>` over `app.vault`: `read`, `cachedRead`, `readBinary`, `modify`, `modifyBinary`, `create`, `createBinary`, `delete`/`trash` (prefer `fileManager.trashFile` with fallback), `trigger`.
- `ObsidianPathAdapter.ts` — `getPath`, `normalisePath`.
- `ObsidianTypeGuardAdapter.ts` — `isFile`/`isFolder` (`instanceof TFile/TFolder`).
- `ObsidianConversionAdapter.ts` — `nativeFileToUXFileInfoStub`/`nativeFolderToUXFolder` (delegates to `utilObsidian`).

### `src/serviceFeatures/` — lifecycle middleware

**`onLayoutReady.ts`** — barrel: `export const onLayoutReadyFeatures = [enableI18nFeature]`.

**`onLayoutReady/enablei18n.ts`** — `enableI18nFeature = createServiceFeature(async ({services:{setting,API}}) => …)`. On layout-ready, if `displayLanguage` is empty, detects Obsidian's language (`tryGetLanguage()` guarding the 1.8.7+ API), applies it (or `"def"`), and offers a revert-to-default dialog. Persists via `setting.applyPartial`/`saveSettingData`.

**`useP2PReplicatorUI.ts`** — `useP2PReplicatorUI(host, core, replicator)`. Registers P2P views (`VIEW_TYPE_P2P`, `VIEW_TYPE_P2P_SERVER_STATUS`), a `P2PLogCollector`, a reactive status line, commands (`open-p2p-replicator`, `open-p2p-server-status`, `replicate-now-by-p2p-default-peer`, `replicate-now-by-p2p`, `p2p-sync-targets`), a ribbon icon, and subscribes to `EVENT_REQUEST_OPEN_P2P`. On layout-ready auto-opens the status pane. Returns `{replicator, p2pLogCollector, storeP2PStatusLine}`.

**`setupObsidian/setupManagerHandlers.ts`** — `openSetupURI(setupManager)`, `openP2PSettings(host, setupManager)`, and `useSetupManagerHandlersFeature(host, setupManager)` which on `onLoaded` registers command `livesync-opensetupuri` and subscribes to `EVENT_REQUEST_OPEN_SETUP_URI`/`EVENT_REQUEST_OPEN_P2P_SETTINGS`.

**`setupObsidian/setupProtocol.ts`** — `handleSetupProtocol(setupManager, conf)` (routes `conf.settings` vs `conf.settingsQR`), `registerSetupProtocolHandler(host, log, setupManager)` (registers the `setuplivesync` obsidian:// protocol handler, guarded), and `useSetupProtocolFeature(host, setupManager)` which registers on `onLoaded` with an instance log function.

**`redFlag.ts`** + **`redFlag.simpleFetch.ts`** — the red-flag file feature (see Important services).

## Important services explained

### I/O — the storage/vault stack (`serviceModules/`)
All disk and vault access funnels through the adapter split. `ObsidianStorageAdapter` and `ObsidianVaultAdapter` are the only places that touch `app.vault.adapter.*` and `app.vault.*` respectively; higher layers (`FileAccessBase`, `ServiceFileAccessBase`, `ServiceDatabaseFileAccessBase`, `ServiceRebuilder`) are platform-agnostic. This is the seam that lets the same core run under CLI (`src/apps/cli/adapters/Node*`) and webapp (`src/apps/webapp/adapters/FSAPI*`). Notable I/O detail: `ObsidianVaultAdapter.delete/trash` prefer `fileManager.trashFile` and fall back to deprecated `vault.delete`/`trash` for older Obsidian — a compatibility branch. `toArrayBuffer` normalization is applied on every binary write.

### Networking — CORS avoidance (`ObsidianAPIService.nativeFetch`, `ObsHttpHandler`)
Two independent fetch paths both route through Obsidian's `requestUrl` to bypass browser CORS: `ObsidianAPIService.nativeFetch` (general fetch, used by the sync/replication layer) and `ObsHttpHandler` (the AWS Smithy handler for S3/MinIO remotes). Both strip `host`/`content-length` headers manually because those trigger preflight failures. `ObsHttpHandler` additionally supports a `reverseProxyNoSignUrl` host rewrite and a `Promise.race`-based timeout/abort.

### Scheduling & event integration (`ModuleObsidianEvents`)
This is the busiest scheduler. It debounces work with `scheduleTask(key, ms, fn)` (from octagonal-wheels): `syncOnEditorSave` (250ms), `watch-window-visibility` (100ms), `watch-online` (500ms), `watch-workspace-open` (500ms), `configReload` (250ms). It monkey-patches the `editor:save-file` command to trigger `replicateByEvent()` on save (and rebinds CodeMirror's save), self-healing by restoring the original callback once `control.hasUnloaded()`. `_scheduleAppReload` builds a **reactive aggregate counter** summing DB queue / replication / storage-applying / chunk / plugin-scan / hidden-file / conflict counts, ticked every 1s, and auto-restarts Obsidian after 3 consecutive idle (zero) reads — a "restart when the system goes quiet" mechanism. The window-visibility handler contains the most subtle logic in the subsystem: an opt-in "keep replication active in background" path with a forced continuous-channel teardown on re-show (extensively commented, gated on `liveSync` and non-mobile).

### Migration / data integrity (`ModuleMigration`)
Runs at first-initialise and on demand. `hasIncompleteDocs` is a genuine repair routine: it walks every normal doc, cross-checks three sizes (DB-recorded, DB-stored/actual, storage-stored), classifies mismatches by a documented A/B/C rule set, and only auto-repairs the safe "recoverable" class (recordedSize==storageSize, not conflicted) by re-storing from storage via `fileHandler.storeFileToDB`. `hasCompromisedChunks` guards encrypted vaults. `migrateUsingDoctor` wraps `performDoctorConsultation` and may schedule a rebuild/fetch then restart. Results are memoized in `kvDB` to avoid rescanning.

### Red-flag files — recovery orchestration (`redFlag.ts` / `redFlag.simpleFetch.ts`)
`useRedFlagFeatures` registers three prioritized `FlagFileHandler`s on `onLayoutReady` (priority ordering: suspend=5, fetch-all=10, rebuild=20). Each checks for a sentinel flag file in the vault (both `FlagFilesOriginal` and `FlagFilesHumanReadable` names) and, if present, drives a guided recovery:
- **Fetch-all** — optional remote-config selection, an offered "fast setup" (`redFlag.simpleFetch.ts`: newer-wins / remote-wins / legacy flows with remembered choices in small-config), then `rebuilder.$fetchLocal` or the fast `$fetchLocalDBFast` + `synchroniseAllFilesBetweenDBandStorage`.
- **Rebuild** — `rebuilder.$rebuildEverything`.
- **Suspend (SCRAM)** — suspends all sync and enables file logging, deliberately keeping the vault suspended.
All wrap work in `processVaultInitialisation` (disables batchSave, suspends sync + file watching in a try/finally) and finish via `verifyAndUnlockSuspension` (asks to resume + restart). `flagHandlerToEventHandler` adapts a handler to the lifecycle-handler signature. Remote config reconciliation (`adjustSettingToRemote`/`adjustSettingToRemoteIfNeeded`) fetches server "tweak" values and reconciles divergent settings (skipped for P2P).

### Logging
No dedicated logging service lives in this scope; logging is via `Logger`/`_log` (octagonal-wheels + `@lib/common/logger`) and, for features, `createInstanceLogFunction("SF:RedFlag", API)` / `("SF:SetupProtocol", API)` which tag log lines per feature. `ModuleDev.onMissingTranslation` writes an i18n-gap log file to disk. `ObsidianSettingService` (SCRAM path) can enable `writeLogToTheFile`.

## Dependencies / Consumed by

- **Upstream (consumed by this subsystem):** `@lib/services/*` (Injectable base services, `ServiceHub`, `ObsidianServiceContext`), `@lib/serviceModules/*` (`FileAccessBase`, `ServiceFileAccessBase`, `ServiceDatabaseFileAccessBase`, `Rebuilder`, `adapters`), `@lib/interfaces/ServiceModule` (`NecessaryServices`, `createServiceFeature`), `@lib/serviceFeatures/*` (`offlineScanner`, `remoteConfig`), `@lib/common/*` (types, i18n, logger, events, `configForDoc`), octagonal-wheels (scheduling/reactive/promises), `@smithy/*` (in `ObsHttpHandler`), Obsidian API via `@/deps`, and `@/modules/features/SetupManager`, `@/modules/coreObsidian/UILib/dialogs`, `@/features/P2PSync/*`.
- **Downstream (consumers):** `src/main.ts` (`ObsidianLiveSyncPlugin`) is the sole composition root — it builds `ObsidianServiceHub`, `initialiseServiceModules()`, the `extraModules[]` list, and the feature initialiser that calls `useRedFlagFeatures`, `useP2PReplicatorUI`, `useSetupProtocolFeature`, `useSetupManagerHandlersFeature`, `enableI18nFeature`. Everything flows into `LiveSyncBaseCore` (`src/LiveSyncBaseCore.ts`). The services are consumed pervasively by core modules (`src/modules/core/*`, `src/features/*`) through `core.services.*` / `core.serviceModules.*`.

## Design observations (factual; smells/risks; no fixes)

1. **Three overlapping extension mechanisms coexist** (services, service-modules, service-features, plus legacy `AbstractModule`). Multiple in-source comments confirm an incomplete migration: `ObsidianAPIService` header "All Services will be migrated to be based on Plain Services, not Injectable Services. This is a migration step."; `ModuleBasicMenu` "it is odd that it has here at all; it really ought to be in each respective feature"; `ModuleObsidianMenu`/`ModuleBasicMenu` `// TODO Replicator … should be moved to features`. The boundary between a "module" and a "service feature" is historical, not principled.

2. **`ObsidianServiceHub` is a hand-wired composition root** — ~18 services instantiated in strict manual dependency order with explicit deps objects. Adding/reordering a dependency is error-prone; the `satisfies Required<ServiceInstances>` gives compile-time completeness but not ordering safety.

3. **Prototype/monkey-patching of Obsidian internals.** `ModuleObsidianEvents.swapSaveCommand` mutates `app.commands.commands["editor:save-file"].callback` and `CodeMirrorAdapter.commands.save` via `as any`/`@ts-ignore`. Restoration depends on `control.hasUnloaded()` being observed inside a scheduled task — if that path never runs, the patched callback persists. Also accesses undocumented `app.commands.executeCommandById` (declared ad-hoc).

4. **Type augmentation scattered across files.** `declare module "obsidian"` appears in ≥5 files adding optional/undocumented fields (`appId`, `isMobile`, `commands`, `adapter.insensitive`, `getAbstractFileByPathInsensitive`, `reconcileInternalFile`). These are unverified assumptions about Obsidian internals that can silently break across Obsidian versions.

5. **`localStorage` used for settings key/value with acknowledged debt.** `ObsidianSettingService.setItem/getItem/deleteItem` all carry `// TODO: Implement nativeLocalStorage`, relying on `compatGlobal.localStorage` rather than a vault-scoped store.

6. **Auto-restart heuristic is fragile.** `_scheduleAppReload` restarts Obsidian after 3 one-second idle reads of an aggregate counter that hard-codes `e = 0; proc = 0` (former `pendingFileEventCount`/`processingFileEventCount` disabled with comments). If any not-counted work is in flight, an "idle" reading could trigger a restart mid-operation.

7. **Dead/disabled code paths.** `ModuleDev` is instantiated-commented in `main.ts` (`// new ModuleDev(...)`) yet fully implemented; `ModuleMigration.initialMessage`/`askAgainForSetupURI` retain large commented legacy blocks; `watchOnlineAsync` carries `TODO:FIXME AT V0.17.31, this logic has been disabled`. `main.ts` still references `enableI18nFeature` directly (line 172) *and* `onLayoutReady.ts` exports an `onLayoutReadyFeatures` array that appears unused by `main.ts`.

8. **Empty subclass proliferation.** Many services (`ObsidianServices.ts`) and service-modules (`FileHandler.ts`, `DatabaseFileAccess.ts`, `ServiceFileAccessImpl.ts`) are zero-body subclasses existing only to bind a base implementation to `ObsidianServiceContext`/adapter type. Cheap, but adds indirection layers to trace behavior.

9. **`redFlag` feature carries heavy UX/business logic in a "feature" function** (490 + 250 LOC, plus a 1621-LOC spec). It mixes dialog orchestration, remote-config reconciliation, suspension management, and rebuilder invocation — a broad `NecessaryServices` surface (10 services + 3 service-modules) indicating high coupling for a single feature.

10. **Duplicated P2P command handlers.** In `useP2PReplicatorUI`, `replicate-now-by-p2p-default-peer` and `replicate-now-by-p2p` have identical `checkCallback` bodies (`openReplication(settings, false, true, false)`), suggesting a copy-paste that may not do what the distinct command names imply.

11. **`nativeFetch` and `ObsHttpHandler` duplicate CORS/header-stripping logic** independently, risking divergence in header handling between the two network paths.

### Coverage gaps / uncertainties
- `TestPane.svelte` was not read (Svelte UI, out of the function-inventory format).
- Behavior of the many empty base classes (`InjectableAPIService`, `SettingService`, `PathService`, `FileAccessBase`, `Rebuilder`, etc.) lives in `src/lib/src/` — out of this subsystem's scope; only the Obsidian overrides are inventoried here.
- The exact semantics of the background-keep-alive teardown in `watchWindowVisibilityAsync` are described from its (extensive) comments; the interaction with the continuous replicator's `AbortController`/`shareRunningResult` lock was not traced into the replicator itself.
- `.unit.spec.ts` files were counted but not analyzed for behavior.

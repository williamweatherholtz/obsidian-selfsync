# Bootstrap, Module System & Core Types

> AS-BUILT reverse-engineering notes for the `obsidian-livesync` plugin (vrtmrz).
> Subsystem: plugin bootstrap, the module / service-hub composition mechanism, and the
> shared core types/vocabulary used across the Obsidian-facing code. Read-only analysis;
> file paths and symbol names verified against the source at the analyzed commit.

## Purpose & responsibilities

This subsystem is the **composition root** of the plugin. It is responsible for:

- Being the Obsidian entry point (`ObsidianLiveSyncPlugin extends Plugin`) and translating
  Obsidian's `onload()`/`onunload()` into the plugin's own lifecycle.
- Constructing the **service hub** (`ObsidianServiceHub` / `InjectableServiceHub`) that holds
  all singleton services, and constructing the **service modules** (storage access, file
  handler, database file access, rebuilder).
- Owning `LiveSyncBaseCore` — the platform-agnostic core object that aggregates the service
  hub, the list of feature `Module`s, and the list of `addOns` (`LiveSyncCommands`), and that
  runs the wiring/binding sequence.
- Defining the two base classes every feature module extends (`AbstractModule`,
  `AbstractObsidianModule`) and the minimal add-on contract (`IMinimumLiveSyncCommands`).
- Providing the Obsidian-side re-export shim (`deps.ts`) that centralizes all imports from the
  `obsidian` package plus `diff-match-patch`.
- Housing shared cross-cutting utilities and types in `src/common/` (event names, id/path
  conversion, memoization, key-value DB wrappers, periodic processor, Svelte view base,
  persistent stores, and the diagnostic report generator).

Note: the large majority of concrete behavior lives in **services** (`src/lib/src/services/`)
and **feature modules** (`src/modules/`, `src/features/`), which are separate subsystems. This
document covers how they are *declared, composed, injected, ordered, and booted*.

## Files & LOC (table)

| File | LOC | Role |
|------|-----|------|
| `src/main.ts` | 211 | Obsidian entry point; builds service hub + service modules + module/addon/feature lists; maps Obsidian lifecycle to `services.control`. |
| `src/LiveSyncBaseCore.ts` | 289 | Platform-agnostic core; registers modules, binds module functions, exposes obsolete accessor shims, initializes service features. Declares `IMinimumLiveSyncCommands`. |
| `src/deps.ts` | 51 | Central re-export of `obsidian` API symbols + `diff-match-patch`; typed `normalizePath` wrapper. |
| `src/types.ts` | 27 | Defines the `ServiceModules` (4-field) and `LiveSyncHost` interfaces used by the composition root. |
| `src/modules/AbstractModule.ts` | 89 | Base class for all feature modules; service accessors, command/UI binder shims, `onBindFunction` hook, test helpers. |
| `src/modules/AbstractObsidianModule.ts` | 21 | Obsidian-specialized module base; adds `plugin`/`app` access and `isThisModuleEnabled()`. |
| `src/modules/main/ModuleLiveSyncMain.ts` | 215 | The keystone module; wires the top-level load/ready/unload lifecycle handlers into the appLifecycle service. |
| `src/common/events.ts` | 47 | Obsidian-specific event-name constants + `LSEvents` global augmentation; re-exports core `eventHub`. |
| `src/common/obsidianEvents.ts` | 12 | `EVENT_REQUEST_SHOW_HISTORY` constant + its `LSEvents` payload typing. |
| `src/common/utils.ts` | 401 | Grab-bag: id/path conversion, path validation, memo/static caches, CouchDB request helpers, mtime comparison, `autosaveCache`. |
| `src/common/types.ts` | 64 | Plugin/DB data types: `PluginDataEntry`, `PluginList`, `DevicePluginList`, `InternalFileInfo`, `FileInfo`, `queueItem` + header-const re-exports. |
| `src/common/KeyValueDB.ts` | 99 | Legacy IndexedDB key-value wrapper factory `_OpenKeyValueDatabase`; re-exports v2. |
| `src/common/KeyValueDBv2.ts` | 154 | `IDBKeyValueDatabase` class + `OpenKeyValueDatabase` (current IndexedDB KV store). |
| `src/common/PeriodicProcessor.ts` | 45 | `PeriodicProcessor` timer wrapper tied to plugin-unload event. |
| `src/common/SvelteItemView.ts` | 28 | `SvelteItemView` abstract Obsidian `ItemView` that mounts/unmounts a Svelte component. |
| `src/common/reportTool.ts` | 142 | `generateReport()` — builds a redacted diagnostic report of settings + remote config. |
| `src/common/stores.ts` | 7 | `sameChangePairs` persistent map + `initializeStores()`. |

(`src/common/types.ts` and `src/types.ts` are **distinct files** with the same basename; both
are covered. `src/types.ts` holds the composition-root `ServiceModules`/`LiveSyncHost`
interfaces; `src/common/types.ts` holds plugin/DB data types and re-exports much from
`@lib/common/types.ts`.)

## Key types / data structures

- **`ObsidianLiveSyncPlugin`** (`src/main.ts`) — `default export extends Plugin`. Holds one
  field `core: LiveSyncCore`. All real work is delegated to `core.services.*`.
- **`LiveSyncCore`** (`src/main.ts:46`) — `type LiveSyncCore = LiveSyncBaseCore<ObsidianServiceContext, LiveSyncCommands>`.
  The concrete instantiation of the generic core for the Obsidian platform.
- **`LiveSyncBaseCore<T extends ServiceContext, TCommands extends IMinimumLiveSyncCommands>`**
  (`src/LiveSyncBaseCore.ts:34`) — the core aggregate. Implements a stack of env interfaces:
  `LiveSyncLocalDBEnv`, `LiveSyncReplicatorEnv`, `LiveSyncJournalReplicatorEnv`,
  `LiveSyncCouchDBReplicatorEnv`, `HasSettings<ObsidianLiveSyncSettings>`. Fields: `addOns:
  TCommands[]`, private `modules: AbstractModule[]`, `_services: InjectableServiceHub<T>`,
  protected `_serviceModules: ServiceModules`.
- **`IMinimumLiveSyncCommands`** (`src/LiveSyncBaseCore.ts:285`) — minimal add-on contract:
  `onunload()`, `onload()`, and a `constructor: { name: string }` (used for name-based lookup).
- **`ServiceModules`** (defined in `src/types.ts:7`) — struct of four service-dependent objects:
  `storageAccess: StorageAccess`, `databaseFileAccess: DatabaseFileAccess`, `fileHandler:
  IFileHandler`, `rebuilder: Rebuilder`. `main.ts` imports this type from `./types.ts`, while
  `LiveSyncBaseCore.ts` imports a `ServiceModules` of the same 4-field shape from
  `@lib/interfaces/ServiceModule` — two import paths for the same structural contract.
- **`LiveSyncHost`** (`src/types.ts:24`) — `{ services: IServiceHub; serviceModules:
  ServiceModules }` — the minimal "host" shape.
- **`PluginDataEntry`** (`src/common/types.ts:5`) — a DB entry for a synced Obsidian plugin:
  `mainJs`, `manifestJson`, optional `styleCss`, encrypted `dataJson`, `manifest:
  PluginManifest`, `type: "plugin"`, `deviceVaultName`, `mtime`, `_conflicts?`.
- **`PluginList` / `DevicePluginList`** (`src/common/types.ts:18,22`) — maps of plugin-id → entries.
- **`InternalFileInfo` / `FileInfo`** (`src/common/types.ts:27,35`) — path/mtime/ctime/size(/deleted)
  file descriptors; `FileInfo` additionally carries the Obsidian `TFile`.
- **`queueItem`** (`src/common/types.ts:44`) — file-watch queue element (`entry: EntryBody`,
  `missingChildren`, `timeout?`, `done?`, `warned?`).
- **Event-name constants** (`src/common/events.ts`) — string literals such as
  `EVENT_PLUGIN_LOADED`, `EVENT_PLUGIN_UNLOADED`, `EVENT_LAYOUT_READY` (from core),
  `EVENT_SETTING_SAVED`, `EVENT_REQUEST_RELOAD_SETTING_TAB`, `EVENT_REQUEST_RUN_DOCTOR`, etc. The
  `LSEvents` interface is **globally augmented** to type each event's payload (mostly
  `undefined`; a few carry `string` or object payloads). `obsidianEvents.ts` adds
  `EVENT_REQUEST_SHOW_HISTORY`.
- **Handler primitives** (`@lib/services/lib/HandlerUtils.ts` — adjacent subsystem but
  load-bearing here): `Binder`, `LazyBinder`, `MultiBinder`, `Dispatch`/`DispatchParallel`,
  `AllHandler`, `ParallelAllHandler`, `AnySuccessHandler`, `FirstResultHandler`, and the
  `handlers<T>()` factory yielding `.all()` / `.bailFirstFailure()` / `.binder()` /
  `.dispatchParallel()` / `.anySuccess()` / `.firstResult()` extension points.

## The module / DI system (DEEP)

This project uses a **hand-rolled composition + handler-injection** system, not a formal DI
container. There are three distinct "plugin extension" concepts and one service layer:

### 1. Services (the injectable singletons)

`InjectableServiceHub<T>` (`src/lib/src/services/implements/injectable/InjectableServiceHub.ts`)
extends `ServiceHub<T>` and holds ~17 services as private readonly fields exposed via getters:
`API, path, database, databaseEvents, replicator, fileProcessing, replication, remote, conflict,
appLifecycle, setting, tweakValue, vault, test, UI, config, keyValueDB, control`. Its constructor
takes a `context: T` and a bag of pre-built service instances; **missing services are lazily
default-constructed** with their dependencies wired by hand (e.g. `_control ??= new
ControlService(context, { appLifecycleService, databaseService, ... })`). So the hub *is* the
manual dependency-injection wiring point — dependencies are passed as constructor bags, not
resolved from a registry. `ObsidianServiceHub` (`src/modules/services/ObsidianServiceHub.ts`,
adjacent subsystem) is the Obsidian-platform subclass that supplies the concrete
implementations.

### 2. The handler-based "injection" mechanism (the real DI substrate)

Each service exposes named **extension points** built from `handlers<IService>()` (see
`AppLifecycleService.ts`). Each extension point is one of several *combinator* handler objects
from `HandlerUtils.ts`:

- `.binder(name)` → single-assignment function (`Binder`): exactly one implementation via
  `setHandler(fn)`; throws if invoked unassigned or assigned twice (unless `override`).
- `.all(name)` → `AllHandler`: runs all registered handlers sequentially, **bails to `false` on
  the first `false`/throw** (used for `onUnload`, `onScanningStartupIssues`, `onBeforeUnload`).
- `.bailFirstFailure(name)` → also an `AllHandler` (used for `onLayoutReady`, `onReady`,
  `onLoad`, `onWireUpEvents`, `onInitialise`, `onSettingLoaded`, `onLoaded`, `onFirstInitialise`,
  `onSuspending/onResuming/onResumed`). Semantics: every phase is a fan-out of boolean handlers
  where any failure aborts the phase.
- `.dispatchParallel(name)` → `DispatchParallel`: fan-out, collect results/errors (used by
  `onAppUnload`, `getUnresolvedMessages`).
- `.anySuccess` / `.firstResult` combinators also exist.

Modules **inject behavior** by calling `service.<hook>.addHandler(this._method.bind(this))` (for
multi-handlers) or `service.<fn>.setHandler(...)` (for binders). This is the plugin's
inversion-of-control: the core drives the lifecycle phases, and modules subscribe pieces of
behavior into them, with priority + registration-order sorting (`MultiBinder._callbacks`).

### 3. Feature modules (`AbstractModule` / `AbstractObsidianModule`)

`AbstractModule<T extends LiveSyncBaseCore>` (`src/modules/AbstractModule.ts`) is the base for
every feature module. Notable:

- Constructor takes `public core: T`; logs `[Name] Loaded`.
- `get services()` proxies `core._services` (throws if accessed before services ready).
- **Instance-field shims** bound at construction: `addCommand`, `registerView`,
  `addRibbonIcon`, `registerObsidianProtocolHandler` (each `.bind`-ed to `services.API.*`),
  `saveSettings` (bound to `services.setting.saveSettingData`), and `_log` (a per-instance log
  fn tagged with the class name).
- `onBindFunction(core, services)` — **the injection hook**, empty by default; overridden by
  modules to register their handlers. This is where a module wires its methods into the service
  extension points.
- Convenience accessors: `settings` get/set, `localDatabase`, `getPath`/`getPathWithoutPrefix`,
  `isMainReady/isMainSuspended/isDatabaseReady`, plus test helpers
  (`addTestResult/testDone/testFail`).

`AbstractObsidianModule` (`src/modules/AbstractObsidianModule.ts`) extends it with `plugin`
(the `ObsidianLiveSyncPlugin`), `app` getter, and an overridable `isThisModuleEnabled()`.

### 4. Composition & ordering (who is registered, in what order)

Two module tiers:

- **Core modules** — hard-coded in `LiveSyncBaseCore.registerModules()`
  (`LiveSyncBaseCore.ts:139`), always registered first and in this exact order:
  `ModuleLiveSyncMain`, `ModuleConflictChecker`, `ModuleReplicatorMinIO`,
  `ModuleReplicatorCouchDB`, `ModuleReplicator`, `ModuleConflictResolver`,
  `ModulePeriodicProcess`, `ModuleResolvingMismatchedTweaks`, `ModuleBasicMenu`.
- **Extra (Obsidian) modules** — supplied by `main.ts` via the `extraModuleInitialiser`
  callback and appended after core modules: `ModuleObsidianEvents`,
  `ModuleObsidianSettingDialogue`, `ModuleObsidianMenu`, `ModuleObsidianSettingsAsMarkdown`,
  `ModuleLog`, `ModuleObsidianDocumentHistory`, `ModuleInteractiveConflictResolver`,
  `ModuleObsidianGlobalHistory`, `SetupManager`, `ModuleMigration`.

**Add-ons** (`LiveSyncCommands`, satisfying `IMinimumLiveSyncCommands`) are a *separate* list
supplied by the `addOnsInitialiser` callback in `main.ts`: `ConfigSync`, `HiddenFileSync`,
`LocalDatabaseMaintenance`. They are registered via `_registerAddOn` which pushes to `addOns`
and hooks `onUnload`. Lookup is name-based: `getAddOn(cls: string)` matches
`addon.constructor.name`. Modules are looked up by constructor identity via
`getModule(constructor)` (throws if absent) — e.g. `core.getModule(SetupManager)` in `main.ts`.

**Binding phase:** after all modules are registered, `bindModuleFunctions()`
(`LiveSyncBaseCore.ts:159`) iterates every module, calls `module.onBindFunction(this,
this.services)`, then runs `__$checkInstanceBinding(module)` — a **dev-time reflective check**
(`@lib/dev/checks.ts`) that compares the module's private `_`-prefixed methods against the
`this._x` references found by regex in the `onBindFunction` source string, logging warnings for
methods that exist but are never wired (or vice-versa). This is a convention-enforcement guard,
not a hard failure.

### 5. Service features (functional composition)

Alongside class modules, the codebase uses **`useXxx(core)` "feature" functions** (a
React-hook-style pattern) that register handlers imperatively. `LiveSyncBaseCore.initialiseServiceFeatures()`
calls `useTargetFilters`, `usePrepareDatabaseForUse`, `useRemoteConfigurationMigration`. The
`featuresInitialiser` callback in `main.ts` calls many more: `enableI18nFeature` (registered as
an `onLayoutReady` handler), `useP2PReplicatorFeature/Commands/UI`, `useRemoteConfiguration`,
`useSetupProtocolFeature`, `useSetupQRCodeFeature`, `useSetupURIFeature`,
`useSetupManagerHandlersFeature`, `useOfflineScanner`, `useRedFlagFeatures`,
`useCheckRemoteSize`. These functions typically pull services off `core` and call `addHandler`
/ `setHandler` — the same injection substrate as modules, minus the class ceremony.

## Boot & lifecycle flow (step-by-step)

**Construction (synchronous, in `ObsidianLiveSyncPlugin` constructor, `main.ts:133`):**
1. `super(app, manifest)` (Obsidian `Plugin`), then `setNoticeClass(Notice)` (interop shim).
2. `new ObsidianServiceHub(this)` — builds all concrete services.
3. `new LiveSyncBaseCore(serviceHub, serviceModuleInitialiser, extraModuleInitialiser,
   addOnsInitialiser, featuresInitialiser)`. Inside the core constructor (`LiveSyncBaseCore.ts:69`),
   **in order**:
   a. `_services = serviceHub`.
   b. `_serviceModules = serviceModuleInitialiser(this, serviceHub)` → `main.initialiseServiceModules`
      builds `StorageAccessManager`, `FileAccessObsidian`, `StorageEventManagerObsidian`,
      `ServiceFileAccessObsidian`, `ServiceDatabaseFileAccess`, `ServiceFileHandler`,
      `ServiceRebuilder` — a hand-wired dependency chain (each ctor gets a bag of service refs).
   c. `registerModules(extraModuleInitialiser(this))` → core modules first, then extras.
   d. `initialiseServiceFeatures()` → the three core `useXxx`.
   e. `featuresInitialiser(this)` → the P2P/setup/scanner/i18n feature functions.
   f. addons built + `_registerAddOn` each (hooks each addon's `onunload` into
      `appLifecycle.onUnload`).
   g. `bindModuleFunctions()` → every module's `onBindFunction` runs (handlers registered) +
      binding check.

At this point nothing async has happened; all extension points are populated.

**Load (`ObsidianLiveSyncPlugin.onload`, `main.ts:205`):** calls `void this._startUp()`:
1. `await core.services.control.onLoad()` → `ControlService.onLoad` invokes
   `appLifecycle.onLoad` (bailFirstFailure). `ModuleLiveSyncMain._onLiveSyncLoad` is the main
   registered handler: initializes the worker module, fires `onWireUpEvents`, emits
   `EVENT_PLUGIN_LOADED`, runs `onInitialise`, loads settings (`services.setting.loadSettings`),
   fires `onSettingLoaded`, handles version-upgrade side effects (may disable sync flags on a
   downgrade), opens the database (`services.database.openDatabase`), fires `onLoaded`, then
   `await Promise.all(core.addOns.map(e => e.onload()))`. If `onLoad` returns false, `_startUp`
   returns early.
2. Registers `core.services.control.onReady` (bound) as an `app.workspace.onLayoutReady`
   callback — so the "ready" phase runs only once Obsidian's layout is ready.

**Ready (Obsidian fires layout-ready → `ControlService.onReady` → `appLifecycle.onReady`):**
`ModuleLiveSyncMain._onLiveSyncReady` runs: awaits `appLifecycle.onLayoutReady()`, emits
`EVENT_LAYOUT_READY`; if `suspendFileWatching`/`suspendParseReplicationResult` are set it prompts
the user (keep vs resume+restart); calls `databaseEvents.initialiseDatabase`; runs
`onFirstInitialise`; `control.applySettings()`; and fires a background safety scan
(`onScanningStartupIssues`).

**Settings-saved reaction:** `ModuleLiveSyncMain._wireUpEvents` (registered on
`onWireUpEvents`) subscribes to `EVENT_SETTING_SAVED` on `eventHub` — reapplies language,
re-applies settings if DB ready, emits `EVENT_REQUEST_RELOAD_SETTING_TAB`.

**Unload (`ObsidianLiveSyncPlugin.onunload`, `main.ts:208`):** `core.services.control.onUnload()`
→ `ControlService._onLiveSyncUnload`: emits `EVENT_PLUGIN_UNLOADED`, runs `onBeforeUnload`,
`onAppUnload` (parallel), cancels all periodic tasks/tasks/processors, runs `onUnload`, marks
`_unloaded`, closes the active replicator + local database, emits `EVENT_PLATFORM_UNLOADED`, and
`eventHub.offAll()`. Add-on `onunload`s were separately hooked into `appLifecycle.onUnload` at
registration time.

**`applySettings()` sequence (ControlService):** `onSuspending` → `onBeforeRealiseSetting` →
`localDatabase.refreshSettings` → `commitPendingFileEvents` → `onRealiseSetting` → (if not
suspended) `onResuming` → `onResumed` → `onSettingRealised`.

## Function/class inventory (per significant file)

### `src/main.ts`
- `class ObsidianLiveSyncPlugin extends Plugin` — the entry point.
  - `private initialiseServiceModules(core, services): ServiceModules` — hand-wires the four
    service-module objects (storage/DB-file/file-handler/rebuilder) + `StorageAccessManager`,
    `FileAccessObsidian`, `StorageEventManagerObsidian`.
  - `async saveSettings()` — obsolete shim → `services.setting.saveSettingData()`.
  - `constructor(app, manifest)` — sets Notice class, builds `ObsidianServiceHub`, constructs
    `LiveSyncBaseCore` with the four initialiser callbacks (service-modules, extra-modules,
    add-ons, features).
  - `private async _startUp()` — `control.onLoad()`, then register `control.onReady` on layout
    ready.
  - `override onload()` / `override onunload()` — delegate to `_startUp` / `control.onUnload`.
- `type LiveSyncCore` — the concrete `LiveSyncBaseCore` alias.

### `src/LiveSyncBaseCore.ts`
- `class LiveSyncBaseCore<T, TCommands>` — the core aggregate.
  - `_registerAddOn(addOn)` / `getAddOn(cls)` — add-on registration + name lookup.
  - `constructor(...)` — the 5-step composition sequence (see boot flow).
  - `get services()` — guarded accessor to `_services`.
  - `get serviceModules()` — accessor to `_serviceModules`.
  - `getModule(constructor)` — constructor-identity module lookup (throws if missing).
  - `_registerModule(module)` / `registerModules(extraModules)` — core-module list + extras.
  - `bindModuleFunctions()` — runs each module's `onBindFunction` + `__$checkInstanceBinding`.
  - Obsolete getter shims: `confirm`, `settings` get/set, `getSettings`, `localDatabase`,
    `getDatabase`, `simpleStore`, `replicator`, `kvDB`, `storageAccess`, `databaseFileAccess`,
    `fileHandler`, `rebuilder` — all proxying `services.*` / `serviceModules.*` (marked
    `@obsolete`).
  - `initialiseServiceFeatures()` — registers `useTargetFilters`, `usePrepareDatabaseForUse`,
    `useRemoteConfigurationMigration`.
- `interface IMinimumLiveSyncCommands` — add-on contract.

### `src/modules/AbstractModule.ts` / `AbstractObsidianModule.ts`
- `abstract class AbstractModule<T>` — see DI section (accessors, binder shims,
  `onBindFunction`, test helpers, readiness checks).
- `abstract class AbstractObsidianModule extends AbstractModule` — adds `plugin`, `app`,
  `isThisModuleEnabled()`.

### `src/modules/main/ModuleLiveSyncMain.ts`
- `class ModuleLiveSyncMain extends AbstractModule`
  - `async _onLiveSyncReady()` — the ready-phase handler (layout-ready, scram prompt, DB init,
    first-init, applySettings, background safety scan).
  - `_wireUpEvents()` — subscribes to `EVENT_SETTING_SAVED` on the event hub.
  - `async _onLiveSyncLoad()` — the load-phase handler (worker init, settings load, DB open,
    version-upgrade handling, addon `onload`).
  - `override onBindFunction(core, services)` — registers the three handlers
    (`onReady`, `onWireUpEvents`, `onLoad`). (Many prior handlers are commented out — see
    observations.)

### `src/deps.ts`
- Barrel re-export of `obsidian` runtime symbols (`Notice`, `Plugin`, `Modal`, `Setting`,
  `TFile`, `Menu`, `ItemView`, components, etc.) + `obsidian` types; a typed `normalizePath`
  cast; `diff-match-patch` re-exports (`DIFF_*`, `diff_match_patch`).

### `src/common/events.ts` / `obsidianEvents.ts`
- Event-name string constants + `declare global { interface LSEvents {...} }` payload typing;
  re-exports `@lib/events/coreEvents.ts` and `eventHub`.

### `src/common/utils.ts`
- `path2id(filename, obfuscatePassphrase, caseInsensitive)` / `id2path(id, entry?)` — path↔id
  conversion wrapping the `@lib/string_and_binary/path` primitives with `normalizePath`.
- `getPathFromTFile(file)` — `.path` accessor.
- Memo helpers: `memoObject`, `memoIfNotExist`, `retrieveMemoObject`, `disposeMemoObject`;
  `useMemo`, `useStatic`, `disposeMemo`, `disposeAllMemo` (React-hook-style caches keyed by
  string).
- `isValidPath(filename)` — platform-aware filename validation (desktop `process.platform`,
  Android/iOS branches).
- `trimPrefix(target, prefix)`.
- CouchDB request helpers: `_requestToCouchDBFetch`, `_requestToCouchDB`, `requestToCouchDB`
  (`@deprecated`), `requestToCouchDBWithCredentials`.
- Change-freshness: `markChangesAreSame`, `unmarkChanges`, `isMarkedAsSameChanges`,
  `compareFileFreshness` (uses `sameChangePairs` store + `compareMTime`).
- `autosaveCache(db, mapKey)` — returns a `MapLike` view over a KV-backed `Map` that debounces
  writes via `scheduleTask`.
- `getLogLevel(showNotice)`, `onlyInNTimes(n, proc)`; several re-exports from `@lib`
  (`isInternalFile`, `isChunk`, header consts, `displayRev`, `scheduleTask`, etc.).

### `src/common/KeyValueDB.ts` / `KeyValueDBv2.ts`
- `_OpenKeyValueDatabase(dbKey)` — legacy factory returning a `KeyValueDatabase` closure object
  over an `idb` `IDBPDatabase`, with a module-level `databaseCache` and reopen-on-demand.
- `class IDBKeyValueDatabase implements KeyValueDatabase` — v2 class form: lazy `ensureDB`,
  `get/set/del/clear/keys/close/destroy`, destroy/blocking handling, `isDestroyed`/`ensuredDestroyed`.
- `OpenKeyValueDatabase(dbKey)` — serialized, cached factory returning cached live instance.

### `src/common/PeriodicProcessor.ts`
- `class PeriodicProcessor` — `enable(interval)` sets an API interval that runs `_process` and
  auto-`disable`s when `control.hasUnloaded()`; `disable()` clears it; auto-disables on
  `EVENT_PLUGIN_UNLOADED`. Host typed as `NecessaryServices<"API" | "control", never>`.

### `src/common/SvelteItemView.ts`
- `abstract class SvelteItemView extends ItemView` — abstract `instantiateComponent(target)`;
  `onOpen`/`onClose` mount/unmount a Svelte 5 component (`mount`/`unmount`).

### `src/common/reportTool.ts`
- `redactObject(obj, dotted, redactedValue)` — dotted-path in-place redaction helper.
- `async generateReport(settings, core)` — builds a diagnostic report: queries remote CouchDB
  config (redacting secrets/admins/uuid/jwt), strips non-default settings keys, redacts
  credentials/URIs/P2P/JWT fields, adds Obsidian navigator + FS case-sensitivity info.

### `src/common/stores.ts`
- `sameChangePairs: PersistentMap<number[]>` + `initializeStores(vaultName)`.

## Dependencies

**Internal subsystems consumed:**
- `src/lib/src/services/**` — the entire service layer (hub, base services, injectable
  implementations, `HandlerUtils`, `ServiceBase`, `ControlService`, `AppLifecycleService`). The
  core is meaningless without it.
- `src/modules/**` and `src/features/**` — the concrete modules and add-ons that `main.ts`
  instantiates.
- `src/managers/**` (`StorageEventManagerObsidian`), `src/serviceModules/**`
  (`FileAccessObsidian`, `FileHandler`, `DatabaseFileAccess`, `ServiceFileAccessImpl`),
  `src/serviceFeatures/**` (the `useXxx` feature functions).
- `@lib/hub/hub` (`eventHub`), `@lib/events/coreEvents`, `@lib/common/*` (types, i18n, logger,
  coreEnv vars/functions, models), `@lib/interfaces/*` (service/DB/handler interfaces),
  `@lib/replication/**`, `@lib/worker/bgWorker`, `@lib/mock_and_interop/wrapper`.

**External libraries:**
- `obsidian` (all UI/vault API, via `deps.ts`).
- `octagonal-wheels` — the author's utility library (logger, `promises`, `concurrency/task`,
  `concurrency/lock`, `concurrency/processor`, `dataobject/PersistentMap`, `databases/SimpleStoreBase`).
- `pouchdb-core` (types only in core), `idb` (IndexedDB wrappers), `svelte` (`mount`/`unmount`),
  `diff-match-patch`.

## Consumed by (who relies on this)

- **Obsidian** loads `ObsidianLiveSyncPlugin` as the plugin `default` export (build entry).
- **Every feature module** extends `AbstractModule`/`AbstractObsidianModule` and receives `core`
  — so the entire module tree depends on this subsystem's base classes and on `core.services`.
- **Add-ons** (`ConfigSync`, `HiddenFileSync`, `LocalDatabaseMaintenance`) depend on
  `IMinimumLiveSyncCommands` + `core`.
- **`useXxx` service-feature functions** consume `core` and its services.
- `src/common/utils.ts` id/path helpers and `events.ts` constants are imported widely across
  modules and features (e.g. `eventHub`, `path2id`/`id2path`, `compareFileFreshness`).
- `reportTool.generateReport` is consumed by diagnostics/menu features; `SvelteItemView` by
  view panes; `PeriodicProcessor` by `ModulePeriodicProcess`; the KV DB factories by the KV
  service.

## Design observations (factual — for later critique)

- **Composition root is a fat constructor with 5 callbacks.** `LiveSyncBaseCore`'s constructor
  runs the entire wiring pipeline synchronously and takes four/five initialiser closures from
  `main.ts`. Ordering is significant and implicit (service modules before extra modules before
  features before add-ons before binding); there is no declarative dependency graph — order is
  encoded in call sequence and in the hand-written `?? new XxxService(...)` fallbacks inside
  `InjectableServiceHub`.
- **Two parallel extension models coexist:** class-based modules (`AbstractModule` +
  `onBindFunction`) and functional `useXxx(core)` features. Both ultimately call
  `addHandler`/`setHandler` on the same service extension points, so the same wiring can be
  expressed two ways; there is no single registry of "who handles what."
- **Handler semantics are subtle and safety-relevant.** `AllHandler`/`bailFirstFailure` treat a
  thrown error the same as a returned `false` (logged at VERBOSE and swallowed into a phase
  abort). `AnySuccessHandler`/`FirstResultHandler` silently ignore errors. Phase success/failure
  therefore hinges on boolean return discipline across many independently-registered handlers,
  with failures easy to miss in logs.
- **`__$checkInstanceBinding` is a stringly-typed reflective guard.** It regex-scans the
  `onBindFunction.toString()` source for `this._x` references and diffs against `_`-prefixed
  prototype methods. It only logs warnings (never fails), depends on source text not being
  minified/transformed in a way that breaks the regex, and only checks `_`-prefixed names — a
  brittle convention check rather than a real contract.
- **Large obsolete-shim surface.** `LiveSyncBaseCore` carries ~12 `@obsolete` getters
  (`settings`, `localDatabase`, `replicator`, `storageAccess`, ...) that forward to
  `services.*`/`serviceModules.*`. `AbstractModule` similarly re-exposes `settings`,
  `saveSettings`, `localDatabase`. This is a mid-migration state (services replacing direct core
  access) — dual access paths to the same state increase coupling and the chance of stale usage.
- **Commented-out code marks an in-progress refactor.** `ModuleLiveSyncMain` has large
  commented blocks (`_onLiveSyncUnload`, `_realizeSettingSyncMode`, ready/suspended state
  handlers) whose logic now lives in `ControlService`/`AppLifecycleService`. `main.ts` and
  `LiveSyncBaseCore` contain `//TODO` markers and commented feature registrations
  (`ModuleDev`, P2P view). The subsystem is visibly mid-migration from a monolithic core to the
  service architecture.
- **Name-based add-on lookup vs identity-based module lookup.** `getAddOn(cls: string)` matches
  on `constructor.name` (fragile under minification/renaming), while `getModule(constructor)`
  uses constructor identity. Two lookup conventions for two similar registries.
- **Global namespace augmentation for events.** `LSEvents` is a `declare global` interface
  extended across `events.ts` and `obsidianEvents.ts`; event payload typing is decentralized and
  most payloads are `undefined`, so the event bus is effectively loosely typed at call sites.
- **Module-level mutable singletons.** `KeyValueDB`/`KeyValueDBv2` keep module-scoped
  `databaseCache`; `stores.ts` exports a mutable module-level `sameChangePairs` populated by
  `initializeStores`; `utils.ts` keeps module-level `memos`/`_cached`/`_staticObj` maps. These
  are process-global caches with lifetime tied to the JS module, not the plugin instance —
  relevant to reload/teardown correctness.
- **`deps.ts` is a hard coupling seam to Obsidian.** Centralizing all `obsidian` imports aids the
  stated goal of porting to other platforms (comment in `main.ts`), but the core still imports
  Obsidian types transitively (`ObsidianServiceContext`, `TFile` in `types.ts`), so the
  platform-agnostic boundary is partial.
- **`initialiseServiceModules` hand-wires a 7-object dependency chain** with each constructor
  receiving an explicit bag of service references. Adding a service module means editing this
  method and threading new refs by hand — no automatic resolution.
- **Duplicate `ServiceModules` definition paths.** `main.ts` imports `ServiceModules` from
  `./types.ts` (a local 4-field interface) while `LiveSyncBaseCore.ts` imports `ServiceModules`
  from `@lib/interfaces/ServiceModule`. Both are the same structural shape, so TypeScript treats
  them interchangeably, but there are two source-of-truth declarations for one contract.

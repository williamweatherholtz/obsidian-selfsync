# Alternate Apps (Web App & CLI)

## Purpose & responsibilities

`src/apps/` holds the entry points that run the LiveSync **sync core outside the
Obsidian plugin**. Each app supplies its own platform-specific storage/UI shims,
constructs a `ServiceHub`, and drives the same `LiveSyncBaseCore` (`src/LiveSyncBaseCore.ts`)
that the plugin uses. They exist to prove — and exercise — that the core is portable:
the plugin is not the only host.

Three apps live here:

- **`cli/`** — a Node.js command-line tool (`livesync-cli`) that syncs a local PouchDB
  (LevelDB) + filesystem vault against a remote CouchDB/S3 or P2P peers. Richest of the
  three; ~9.5k LOC (incl. tests).
- **`webapp/`** — a browser app that uses the **File System Access API** (and OPFS for
  headless tests) to sync a user-picked local folder against CouchDB, with P2P support.
- **`webpeer/`** — a small Svelte browser app focused specifically on **P2P (Trystero)
  replication**, built on `BrowserServiceHub` and `useP2PReplicator`. Secondary to the
  other two; noted for completeness.

The prose below concentrates on **how each app reuses the core** and wires platform
service modules, not on per-function detail.

## Files & LOC (table; tests grouped)

| Area | Key files | LOC (approx.) |
|------|-----------|---------------|
| CLI entry / arg parsing | `cli/entrypoint.ts` (21), `cli/main.ts` (572) | 593 |
| CLI command dispatch | `cli/commands/runCommand.ts` (866), `commands/types.ts` (93), `commands/p2p.ts` (131), `commands/utils.ts` (50) | ~1,140 |
| CLI service hub / services | `cli/services/NodeServiceHub.ts` (207), `NodeKeyValueDBService.ts` (285), `NodeLocalStorage.ts` (115), `NodeSettingService.ts` | ~710 |
| CLI service modules | `cli/serviceModules/CLIServiceModules.ts` (119), `FileAccessCLI.ts`, `DatabaseFileAccess.ts`, `ServiceFileAccessImpl.ts`, `IgnoreRules.ts` (129) | ~464 |
| CLI platform adapters | `cli/adapters/Node*Adapter.ts` (FileSystem/Storage/Vault/Path/Conversion/TypeGuard) | ~530 |
| CLI storage-event managers | `cli/managers/StorageEventManagerCLI.ts`, `CLIStorageEventManagerAdapter.ts` | ~385 |
| CLI Node compat / pouch | `cli/node-compat.ts` (11), `cli/lib/pouchdb-node.ts` (137) | ~148 |
| Web app entry / bootstrap | `webapp/main.ts` (265), `webapp/bootstrap.ts` (138), `webapp/vaultSelector.ts` (198), `webapp/test-entry.ts` (231) | ~832 |
| Web app service modules | `webapp/serviceModules/FSAPIServiceModules.ts` (105) + `FileAccessFSAPI.ts`, `DatabaseFileAccess.ts`, `ServiceFileAccessImpl.ts` | — |
| Web app FSAPI adapters/managers | `webapp/adapters/FSAPI*.ts`, `webapp/managers/FSAPIStorageEventManager*.ts` (296) | — |
| Web peer app | `webpeer/src/main.ts` (11), `P2PReplicatorShim.ts` (314), `CommandsShim.ts`, `*.svelte` | ~574 |
| Tests (grouped) | `cli/**/*.unit.spec.ts` (vitest), `cli/testdeno/**` (Deno integration/E2E/bench, ~4.1k LOC), `webapp/test/e2e.spec.ts` (Playwright, 294) | ~6,000 |

Totals (incl. tests): CLI ≈ 9,563 · web app ≈ 2,421 · web peer ≈ 574.

## Web app: bootstrap, service modules, capabilities

`webapp/bootstrap.ts` is the DOM entry. On `window.load` it renders a **vault picker**
(`vaultSelector.ts` — a `VaultHistoryStore` remembering `FileSystemDirectoryHandle`s), lets
the user pick or reopen a folder, then constructs `LiveSyncWebApp(handle)` (`webapp/main.ts`)
and calls `initialize()`.

`LiveSyncWebApp.initialize()` wiring:

- Creates a **`BrowserServiceHub<ServiceContext>`** (`src/lib/src/services/BrowserServices.ts`),
  the browser-flavored assembly of the injectable services (browser API/UI/database/KV services
  + shared `Injectable*` services).
- Overrides a few hub handlers directly rather than subclassing: `API.getSystemVaultName`
  returns the folder name; `setting.saveData`/`loadData` persist settings to
  `<vault>/.livesync/settings.json` via the FS Access API; `appLifecycle.scheduleRestart`
  reloads the page.
- Constructs `new LiveSyncBaseCore(serviceHub, moduleInit, modules, addOns, features)`, passing
  `initialiseServiceModulesFSAPI(rootHandle, core, serviceHub)` as the module initializer.
- Registers only `SetupManager` as a module (all Obsidian UI modules are commented out) and
  turns on a curated feature set via `use*` calls: `useOfflineScanner`, `useRedFlagFeatures`,
  `useCheckRemoteSize`, `useRemoteConfiguration`, `useP2PReplicatorFeature`/`Commands`,
  setup-URI + setup-manager handlers.
- Starts the core through the shared lifecycle: `control.onLoad()` → `control.onReady()`, then
  scans the picked directory to populate the file cache. `shutdown()` calls `control.onUnload()`.

`serviceModules/FSAPIServiceModules.ts` builds the platform layer: a `FileAccessFSAPI`
(vault access over `FileSystemDirectoryHandle`), a `StorageEventManagerFSAPI` (change
watching), `ServiceFileAccessFSAPI`, and the **platform-independent** `ServiceDatabaseFileAccessFSAPI`,
`ServiceFileHandler`, and `ServiceRebuilder` (the latter three imported from `@lib`/`@/serviceModules`
and reused verbatim by both apps). Underlying FS Access API adapters live in `webapp/adapters/FSAPI*.ts`.

**Capabilities:** interactive browser sync of a local folder to CouchDB, first-run config
gating (`isConfigured`), P2P sync, setup-URI import, offline scan, remote-size checks.
`webapp/test-entry.ts` exposes a headless `window.livesyncTest` API (init/put/delete/replicate/
getInfo over OPFS) for the Playwright suite.

## CLI: bootstrap, service hub, commands, capabilities

`cli/entrypoint.ts` is the `#!/usr/bin/env node` shebang entry. It polyfills a WebRTC
`RTCPeerConnection` global from `werift` (so Trystero/P2P works under Node) and calls `main()`.

`cli/main.ts` (`main()`):

1. **Arg parsing** (`parseArgs`) — positional `<database-path>`, flags (`--vault/-V`,
   `--settings/-s`, `--interval/-i`, `--verbose`, `--debug`, `--force`), and a command token
   validated against `VALID_COMMANDS` (`commands/types.ts`); default command is `daemon`.
   `init-settings` is handled early (writes a `DEFAULT_SETTINGS` file, forces
   `useIndexedDBAdapter:false`).
2. Configures Node-backed local storage (`configureNodeLocalStorage`, JSON file under
   `.livesync/runtime/`) and log routing.
3. Builds `NodeServiceContext(databasePath)` + **`NodeServiceHub`** and installs settings
   `saveData`/`loadData` handlers reading/writing `<db>/.livesync/settings.json`
   (always forcing `useIndexedDBAdapter:false`).
4. Constructs `LiveSyncBaseCore(serviceHub, () => initialiseServiceModulesCLI(vaultPath, …,
   ignoreRules, watchEnabled), [], [], features)`. Features register `useP2PReplicatorFeature`
   and prioritized `vault.isTargetFile` handlers that ignore dotfiles, the `*-livesync-v2`
   LevelDB dir, and user `IgnoreRules`.
5. Installs SIGINT/SIGTERM graceful shutdown (`control.onUnload()`) and an `exit` hook that
   **restores the settings file** from a pre-start backup (lifecycle hooks mutate sync flags
   in memory and can persist them).
6. Runs the shared lifecycle `control.onLoad()` → `suspendAllSync()` → `control.onReady()`,
   then dispatches to `runCommand(options, context)`. For `daemon` it stays resident; otherwise
   it unloads and `process.exit`s.

**`NodeServiceHub`** (`cli/services/NodeServiceHub.ts`) extends `InjectableServiceHub` and is
the CLI analog of `BrowserServiceHub`. It assembles the same injectable services but swaps in
Node-specific pieces: a **`HeadlessAPIService`** (no GUI), a `NodeSvelteDialogManager`/`NodeUIService`
whose dialog methods throw (headless — confirmations route through `HeadlessAPIService.confirm`),
a `NodeDatabaseService` that forces the PouchDB adapter to a LevelDB prefix under `databasePath`
(never IndexedDB), plus `NodeKeyValueDBService` and `NodeSettingService` backed by JSON files
under `.livesync/runtime/`.

**`initialiseServiceModulesCLI`** (`serviceModules/CLIServiceModules.ts`) mirrors the FSAPI
module init exactly: platform-specific `FileAccessCLI` (over `cli/adapters/Node*Adapter.ts`) +
`StorageEventManagerCLI` (chokidar watching, gated by `watchEnabled`), and the **same shared**
`ServiceDatabaseFileAccessCLI`, `ServiceFileHandler`, `ServiceRebuilder`. Node built-ins are
funneled through `cli/node-compat.ts` (re-exports `node:fs`/`fs/promises`/`path`/`readline`).

**Commands** — `runCommand.ts` is a large `if`-ladder over 28 commands:
- Sync: `daemon` (replicate → mirror-scan → resume live/polling sync), `sync` (one cycle),
  `mirror` (PouchDB→filesystem full scan via `performFullScan`).
- P2P: `p2p-peers`, `p2p-sync`, `p2p-host` (`commands/p2p.ts`, Trystero).
- File ops via core service modules: `push`, `pull`, `pull-rev`, `put` (stdin), `cat`,
  `cat-rev`, `ls`, `info`, `rm`, `resolve` (conflict resolution).
- Remote config CRUD: `remote-add/rm/ls/export/set/activate` (via `ConnectionStringParser` +
  `remoteConfig` feature), plus `setup` (setup-URI import).
- Remote DB admin: `mark-resolved`, `lock-remote`, `unlock-remote`, `remote-status`.

Read/query commands write results to **stdout** and divert logs to **stderr** (`avoidStdoutNoise`),
making the CLI pipeline-friendly.

**Capabilities:** headless continuous sync (daemon/polling), scriptable file get/put against
the DB, conflict resolution, multi-remote management, and P2P — a superset of what the plugin
exposes non-interactively.

## Platform abstraction implications (what this says about core portability)

The three apps are the strongest evidence that the sync engine is genuinely
platform-independent:

- **One core, three hosts.** All three construct the identical `LiveSyncBaseCore` with the same
  constructor shape `(serviceHub, moduleInit, modules, addOns, features)` and drive the identical
  lifecycle (`control.onLoad`/`onReady`/`onUnload`). The Obsidian plugin is just a fourth host.
- **A clean seam at two layers.** Portability is achieved through (1) the **`ServiceHub`**
  (`InjectableServiceHub` + per-platform subclasses `BrowserServiceHub`/`NodeServiceHub`, or the
  plugin's own) and (2) **service modules** (`initialiseServiceModules*` returning the same
  `ServiceModules` shape: `rebuilder`, `fileHandler`, `databaseFileAccess`, `storageAccess`).
  Only the storage/vault/event pieces are platform-specific; `ServiceFileHandler`,
  `ServiceRebuilder`, and `ServiceDatabaseFileAccess*` are **shared verbatim** across apps.
- **Injection over inheritance for host glue.** The apps override behavior by setting handlers on
  injectable services (`API.getSystemVaultName`, `setting.saveData`, `vault.isTargetFile`,
  `appLifecycle.scheduleRestart`) rather than forking the core — a handler/hook registration model.
- **Environment shims are localized.** `coreEnvFunctions` (`compatGlobal`, `_activeDocument`)
  abstracts `window`/`document`/`setTimeout`; `node-compat.ts` isolates Node built-ins; the CLI
  polyfills WebRTC; storage varies (FS Access API / OPFS / LevelDB) behind adapter interfaces.
- **Feature curation, not a monolith.** Each host picks a `use*` feature set and a module list;
  the web app deliberately comments out every Obsidian-UI module, showing those are optional
  presentation concerns, not core dependencies.
- **The database adapter is a settings-driven variable** (`useIndexedDBAdapter` forced off in
  Node; LevelDB prefix vs browser IndexedDB/OPFS), confirming PouchDB adapter choice is
  parameterized rather than hard-wired.

## Key file inventory (entry points & service hubs)

- CLI entry: `src/apps/cli/entrypoint.ts` → `src/apps/cli/main.ts`
- CLI command dispatch: `src/apps/cli/commands/runCommand.ts` (+ `commands/types.ts`, `commands/p2p.ts`)
- CLI service hub: `src/apps/cli/services/NodeServiceHub.ts` (extends `InjectableServiceHub`)
- CLI service-module init: `src/apps/cli/serviceModules/CLIServiceModules.ts`
- CLI Node compat: `src/apps/cli/node-compat.ts`, `src/apps/cli/lib/pouchdb-node.ts`
- Web app entry: `src/apps/webapp/bootstrap.ts` → `src/apps/webapp/main.ts` (`LiveSyncWebApp`)
- Web app service hub: `src/lib/src/services/BrowserServices.ts` (`BrowserServiceHub`, shared with webpeer)
- Web app service-module init: `src/apps/webapp/serviceModules/FSAPIServiceModules.ts`
- Web app test harness entry: `src/apps/webapp/test-entry.ts` (`window.livesyncTest`)
- Web peer entry / P2P shim: `src/apps/webpeer/src/main.ts`, `src/apps/webpeer/src/P2PReplicatorShim.ts`
- Shared core: `src/LiveSyncBaseCore.ts` (constructed identically by all apps)

## Dependencies / Design observations (factual; no fixes)

- Build tooling: each app has its own `vite.config.ts` (`cli`, `webapp`, `webpeer`) and the
  web apps have Playwright configs; the CLI ships as a Node bundle with a shebang entry.
- The web app reaches into `core` internals via `(this.core as any)._serviceModules?.storageAccess…`
  (own comments flag this as accessing private members) for directory scanning and shutdown
  cleanup — an intentional but explicitly-noted encapsulation break.
- The CLI must **back up and restore** the settings file around the core lifecycle because
  lifecycle hooks (`suspendAllSync`, `onSuspending`) mutate sync flags in memory and other paths
  persist them; this is a documented workaround, not an incidental detail.
- `runCommand.ts` is a single ~870-line function with a flat `if`/`throw` dispatch rather than a
  command table/registry (factual structure observation).
- Node vs browser divergence is concentrated in a few spots: WebRTC polyfill (`werift`), forced
  `useIndexedDBAdapter:false`, LevelDB path prefixing, and headless UI/dialog services that throw
  if a modal is requested.
- Tests are substantial and split by runtime: **vitest** unit specs (`*.unit.spec.ts`), a large
  **Deno** integration/E2E/benchmark suite (`cli/testdeno/**`, incl. Docker-orchestrated CouchDB
  and multi-node P2P conflict tests), and a **Playwright** browser E2E suite for the web app —
  themselves further evidence the core runs across Node, Deno, and browser runtimes.
- `webpeer` is the least-developed app and is P2P-only; it reuses `BrowserServiceHub` and the
  `useP2PReplicator*` core features through `P2PReplicatorShim`/`CommandsShim` rather than the
  full `LiveSyncWebApp` bootstrap. (Behavior beyond this wiring not examined in depth.)

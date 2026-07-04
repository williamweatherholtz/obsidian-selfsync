# Commonlib: Coordination & Platform Infrastructure

*As-built architecture of the small cross-cutting packages in `src/lib/src/`. Read-only reverse-engineering; verified against source. Where behavior could not be confirmed it is flagged explicitly.*

## Purpose & responsibilities

This document covers nine small, cross-cutting packages that provide the *plumbing* the rest of livesync-commonlib runs on: process-wide pub/sub, an inter-component request/reply "board", web-worker offloading of CPU-heavy work (chunk splitting + encryption), a few platform abstractions (screen wake lock, notice wrapper, reactive stores), a set of shared Svelte dialog primitives, and small mock/dev/CLI scaffolding. None of these owns sync logic; they are the coordination and platform substrate.

Two coordination primitives dominate and are worth stating up front, because their names are opaque:

- **`hub/`** wraps a global **`EventHub`** (broadcast pub/sub over a globally-augmented `LSEvents` map) — fire-and-forget signals like "layout ready", "setting saved", "platform unloaded".
- **`bureau/`** wraps a global **`SlipBoard`** (a keyed request/response *rendezvous* over a globally-augmented `Slips` map) — one party `submit`s a value under a `(topic, key)` slip and another party `awaitNext`s it. Used for point-to-point async handoff, notably conflict-resolution dialog results.

Both are thin re-exports of the external **`octagonal-wheels`** library; the local files exist only to bind the library's generic types to LiveSync's own augmentable global interfaces.

## Files & LOC (table, grouped by package)

| Package | File | LOC | Kind |
|---|---|---|---|
| bureau | `bureau/bureau.ts` | 8 | global SlipBoard binding |
| hub | `hub/hub.ts` | 10 | global EventHub binding |
| events | `events/coreEvents.ts` | 53 | event-name constants + `LSEvents` decls |
| system | `system/wakelock.ts` | 88 | screen wake-lock wrapper |
| worker | `worker/bgWorker.ts` | 215 | FG worker pool + dispatch |
| worker | `worker/bgWorker.splitting.ts` | 180 | FG split stream reassembly |
| worker | `worker/bgWorker.mock.ts` | 124 | in-thread mock (no Worker) |
| worker | `worker/universalTypes.ts` | 67 | shared message/argument types |
| worker | `worker/bgWorker.encryption.ts` | 55 | FG encrypt/decrypt offload |
| worker | `worker/bg.worker.splitting.ts` | 53 | BG (worker-side) splitter |
| worker | `worker/bg.worker.encryption.ts` | 37 | BG (worker-side) encryption |
| worker | `worker/bg.worker.ts` | 22 | BG worker entry / router |
| worker | `worker/bg.common.ts` | 7 | BG `postBack` helper |
| worker | `worker/bgWorker.unit.spec.ts` | 137 | test |
| worker | `worker/bg.worker.splitting.unit.spec.ts` | 64 | test |
| UI | `UI/DialogHost.svelte` | 162 | dialog mount host + global CSS |
| UI | `UI/dialogues/DialogueToCopy.svelte` | 59 | concrete "copy this" dialog |
| UI | `UI/svelteDialog.ts` | 14 | re-export of dialog service base |
| UI | `UI/components/InfoNote.svelte` | 87 | callout/note primitive |
| UI | `UI/components/Option.svelte` | 81 | radio option row |
| UI | `UI/components/InfoTable.svelte` | 74 | key/value grid |
| UI | `UI/components/Check.svelte` | 53 | checkbox row |
| UI | `UI/components/DialogHeader.svelte` | 41 | title binding (sets modal title) |
| UI | `UI/components/Question.svelte` | 27 | radio-group container (+ heading) |
| UI | `UI/components/Password.svelte` | 27 | password input + reveal toggle |
| UI | `UI/components/Decision.svelte` | 24 | action button |
| UI | `UI/components/Guidance.svelte` | 21 | guidance block |
| UI | `UI/components/ExtraItems.svelte` | 17 | plain container |
| UI | `UI/components/InputRow.svelte` | 15 | labeled row wrapper |
| UI | `UI/components/Options.svelte` | 14 | radio-group container (no heading) |
| UI | `UI/components/UserDecisions.svelte` | 12 | button-group container |
| UI | `UI/components/Instruction.svelte` | 10 | instruction container |
| mock_and_interop | `mock_and_interop/wrapper.ts` | 37 | `WrappedNotice` (Logger-backed) |
| mock_and_interop | `mock_and_interop/stores.ts` | 20 | reactive status stores |
| cli | `cli/APITest.sample.ts` | 36 | sample/manual script |
| cli | `cli/deno.jsonc` | 10 | Deno import map |
| dev | `dev/checks.ts` | 42 | dev-time binding self-check |

Package subtotals: bureau 8, hub 10, events 53, system 88, worker ~961 (incl. ~201 test), UI ~738, mock_and_interop 57, cli 46, dev 42.

## Per-package explanation

### `bureau/` — the SlipBoard binding (request/reply rendezvous)
`bureau.ts` re-exports `globalSlipBoard` from `octagonal-wheels/bureau/SlipBoard`, cast to `SlipBoard<Slips>`. It `declare global`-augments the library's `Slips` interface (`interface Slips extends LSSlips`). The "bureau" metaphor: a bureau of pigeon-holes where one party drops a *slip* under a key and another collects it. Confirmed consumer: `ConflictResolveModal.ts` — the modal `submit`s the merge result under `("conflict-resolved", filename)` and the caller `awaitNext`s the same slip (`globalSlipBoard.awaitNext("conflict-resolved", this.filename)`). This is the async handoff between a fire-and-forget UI modal and the code awaiting the user's decision. Only one topic (`conflict-resolved`) is used in-tree.

Note: `bureau.ts` references a base interface `LSSlips` but **no `interface LSSlips {}` declaration was found** anywhere in the source tree or in `octagonal-wheels` (both `bureau.ts` and `ConflictResolveModal.ts` write `extends LSSlips`, neither defines it). Behavior unclear — likely an ambient/vestigial base that resolves to empty, or a latent type issue; flagged, not asserted.

### `hub/` — the EventHub binding (broadcast pub/sub)
`hub.ts` instantiates `new EventHub<LSEvents>()` from `octagonal-wheels/events` and exports it as `eventHub`. The `LSEvents` map is globally augmented — `hub.ts` seeds two dummy entries (`hello`, `world`) and the real event vocabulary lives in `events/coreEvents.ts`. This is the process-wide broadcast bus; ~68 files reference `eventHub`/the hub. `bgWorker.ts` itself subscribes (`eventHub.on(EVENT_PLATFORM_UNLOADED, …)`) to tear down workers on unload.

### `events/` — the event vocabulary
`coreEvents.ts` declares the string constants for hub topics (e.g. `EVENT_LAYOUT_READY`, `EVENT_SETTING_SAVED`, `EVENT_FILE_CHANGED`, `EVENT_DATABASE_REBUILT`, `EVENT_PLATFORM_UNLOADED`, `EVENT_REQUEST_OPEN_P2P*`, `EVENT_ON_UNRESOLVED_ERROR`, `EVENT_REQUEST_CHECK_REMOTE_SIZE`) and `declare global`-augments `LSEvents` with the payload type for each (most are `undefined`; `EVENT_SETTING_SAVED` carries `ObsidianLiveSyncSettings`, `EVENT_FILE_CHANGED` carries `{ file, automated }`, `EVENT_FILE_RENAMED` carries `{ newPath, old }`). This is the typed contract layer for `hub/`. (Some constants — e.g. the setup-URI/QR request events, `EVENT_LOG_ADDED` — are declared but not added to the `LSEvents` payload block; see Observations.)

### `system/` — platform abstraction (wake lock)
`wakelock.ts` exports `withWakeLock<T>(callback)`. It resolves `navigator.wakeLock` via `compatGlobal` (cross-env global), and if absent simply runs the callback. Otherwise it acquires a `"screen"` wake lock, re-acquires on `visibilitychange` (screen returning to visible), and uses a single `AbortController` to tear down all listeners + release the lock in a `finally`. Robust against abort-during-await (releases immediately if aborted mid-request). Logs at `LOG_LEVEL_VERBOSE`.

### `worker/` — web-worker offloading (see deep section below)
Splits into a **foreground** half (`bgWorker.*`, runs on the main thread, manages a worker pool + reassembles results) and a **background** half (`bg.worker.*`, runs *inside* the Worker), a shared **types** module (`universalTypes.ts`), and an in-thread **mock** (`bgWorker.mock.ts`) selected for environments without `Worker` (CLI). Offloads two workloads: content chunk-splitting (3 algorithm versions) and encryption/decryption (standard + HKDF).

### `UI/` — shared Svelte dialog primitives
Svelte 5 (runes: `$props`, `$bindable`, `$derived`, `$state`, `$effect`) presentational components used to compose plugin dialogs. `DialogHost.svelte` is the generic host: it receives a `mountComponent` and dialog-control callbacks (`setTitle`/`closeDialog`/`setResult`/`getInitialData`), sets up the dialog context, mounts the guest component, and wraps `setResult` to also close. It carries a large block of `:global(...)` CSS defining the shared look for rows, notes, details, inputs. `svelteDialog.ts` is a pure re-export of the dialog service base in `services/implements/base/SvelteDialog.ts` (context keys, `setupDialogContext`/`getDialogContext`, `SvelteDialogManagerBase`, and the prop/result types). `dialogues/DialogueToCopy.svelte` is a concrete guest dialog ("your X is ready to be copied" + clipboard button). `components/` are leaf primitives: `Check` (checkbox row w/ conditional notes), `Option`/`Options`/`Question` (radio option + group container via svelte `context` key `"radioGroup"`), `Decision` (action button, fires `commit` via `fireAndForget`), `Password` (input + reveal toggle), `InfoNote` (callout with danger/warning/caution/notice/info variants + i18n signal word), `InfoTable` (key/value grid), `DialogHeader` (binds title into the modal chrome via dialog context + scrolls modal to top), `InputRow`/`Instruction`/`Guidance`/`ExtraItems`/`UserDecisions` (labeled/grouping wrappers). Nearly all run titles through `translateIfAvailable` (i18n).

### `mock_and_interop/` — interop shims & reactive status
`wrapper.ts` provides `WrappedNotice` — a stand-in for Obsidian's `Notice` that just routes the message text to `Logger(..., LOG_LEVEL_NOTICE)`; `setNoticeClass()` lets the host swap in the real implementation, and `NewNotice()` constructs whichever class is registered (indirection so commonlib stays platform-agnostic). `stores.ts` exports `reactiveSource` stores for cross-cutting status counters: `lockStats` (`{pending, running, count}`), `collectingChunks`, `pluginScanningCount`, `hiddenFilesProcessingCount`, `hiddenFilesEventCount`, `logMessages`, plus `LockStats`/`LogEntry` types. These are observable status signals the UI subscribes to.

### `cli/` — CLI scaffolding
`APITest.sample.ts` is a *manual sample* (not a test): constructs a `DirectFileManipulator` with a hardcoded local CouchDB config and exercises `init/get/put/close`. `deno.jsonc` is an import map aliasing `octagonal-wheels/*` for a Deno context. This package is documentation/scratch, not runtime library code.

### `dev/` — dev-time diagnostics
`checks.ts` exports `__$checkInstanceBinding(instance)` — a reflection helper that, for an object with an `onBindFunction`, compares the underscore-prefixed methods on the prototype against the `this._method` references parsed out of `onBindFunction.toString()`, logging any mismatch. A guard against forgetting to bind/list a handler; dev-only.

## Web worker offloading (deep-ish)

**What is offloaded.** Two CPU-heavy workloads that would otherwise block the main thread: (1) **content chunk splitting** — the core of LiveSync's dedup/sync (`splitPieces2` / `splitPieces2V2` / `splitPiecesRabinKarp`, i.e. algorithm versions 1/2/3, from `string_and_binary/chunks.ts`); (2) **encryption/decryption** — standard (`octagonal-wheels/encryption`) and HKDF (`.../encryption/hkdf`).

**Topology.** `bgWorker.ts` (foreground) owns a **pool** of `WorkerInstance`s. `initialiseWorkerModule()` creates `~~((navigator.hardwareConcurrency || 8) / 2)` workers, each an inline-bundled worker (`import WorkerX from "./bg.worker.ts?worker&inline"`), tracks `{ worker, processing, taskKeys }`, wires `onmessage`/`onerror`, and subscribes to `EVENT_PLATFORM_UNLOADED` for teardown. Called once from `modules/main/ModuleLiveSyncMain.ts`. Dispatch is **round-robin** (`nextWorker()` advances `roundRobinIdx`); there is no least-loaded balancing despite a `processing` counter being maintained.

**Message protocol.** Foreground `startWorker(data)` allocates a monotonic numeric `key`, records a `ProcessItem` in `tasks: Map<number, ProcessItem>` (and a reverse `taskWorkerMap` + the instance's `taskKeys`), then `worker.postMessage({ data: { ...args, key } })`. Inside the worker, `bg.worker.ts`'s `self.onmessage` routes by `data.type`: `"split"` → `processSplit`, `"encrypt"/"decrypt"/"encryptHKDF"/"decryptHKDF"` → `processEncryption`, else posts an error. Argument/result shapes live in `universalTypes.ts` (`EncryptArguments`, `EncryptHKDFArguments`, `SplitArguments`; `ResultPayload{WithResult|WithError}`, and the streaming `ResultPayloadWithSeq`).

- **Encryption path (request/response).** Worker computes and posts `{ key, result }` or `{ key, error }`. Foreground `handleTaskEncrypt` resolves/rejects the task's `PromiseWithResolvers` and `removeTask`s. Single message per task.
- **Splitting path (streaming, ordered).** Chunks stream back incrementally. Worker-side `getMainThreadPostBack(key)` assigns an incrementing **`seq`** per emitted chunk and calls `postBack(key, seq, data)` (`bg.common.ts` → `self.postMessage({key, seq, result})`); it sends `END_OF_DATA` (`null`) as the terminator (and emits an empty `""` first if the stream produced nothing). Foreground `bgWorker.splitting.ts` builds, per key, a `TransformStream` + writer + a `responseBuf: Map<seq, chunk|SYMBOL_USED|SYMBOL_END_OF_DATA>`. `handleTaskSplit` inserts by `seq` and **flushes in-order** (walking `0..max`, stopping at the first gap, marking written entries `SYMBOL_USED`), serializing all writes through a single `writerPromise` chain to preserve order. `END_OF_DATA` closes the stream and `removeTask`s. `_splitPieces2Worker` returns an **async generator** the caller iterates. This is a full ordered-reassembly-over-postMessage streaming layer.

**Crash handling.** `worker.onerror` terminates the instance, removes it from the pool, and for every `taskKey` it owned rejects encryption tasks with a "Background worker crashed" error and routes split tasks to `abortSplitTasks(keys, error)` (which aborts their writers so awaiting generators unblock). This is notably careful.

**Relation to `disableWorkerForGeneratingChunks`.** The worker/main-thread choice for splitting is **not** made in `worker/`; it is made upstream in `ContentSplitter/ContentSplitterBase.ts::getParamsFor()`: `useWorker` starts `true`, is forced `false` if `settings.disableWorkerForGeneratingChunks`, and is also set `false` for small blobs when `settings.processSmallFilesInUIThread` (blob ≤ `MAX_CHUNKS_SIZE_ON_UI`). Each `ContentSplitterV1/V2/RabinKarp.processSplit` then branches: `useWorker` → `splitPieces2Worker*` (from `bgWorker.ts`), else call `splitPieces2*` directly on the main thread. So the setting is a per-file bypass of the worker layer, honored by the *caller*.

**Mock / no-Worker environments.** `bgWorker.mock.ts` mirrors the public surface (`splitPieces2Worker*`, `encryptWorker`, `decryptWorker`, `encryptHKDF/decryptHKDF Worker`, `startWorker`, `initialiseWorkerModule` no-op, `terminateWorker` no-op) but runs everything **synchronously in-thread** by calling the underlying `octagonal-wheels`/`chunks.ts` functions directly. Selection is a **build-time alias**, not runtime: `apps/cli/vite.config.ts` maps `@lib/worker/bgWorker.ts` → `bgWorker.mock.ts`. Note the mock's `SplitArguments` still uses a legacy `useV2: boolean` field where the real `universalTypes.ts` uses `splitVersion: 1|2|3` — the two argument shapes have drifted.

## Event system (pub/sub model)

Two distinct models coexist, both from `octagonal-wheels`, both typed via *global declaration merging*:

1. **Broadcast (`EventHub`, via `hub/` + `events/`).** One-to-many, fire-and-forget. Publishers emit a named event (payload typed by `LSEvents[name]`); any number of subscribers registered via `eventHub.on(name, cb)` react. Used pervasively (~68 files) for lifecycle/UI/setting/P2P signals. Topic names + payload contracts are centralized in `events/coreEvents.ts`.
2. **Rendezvous (`SlipBoard`, via `bureau/`).** Point-to-point request/reply keyed by `(topic, key)`. `submit(topic, key, value)` deposits; `awaitNext(topic, key)` awaits the next deposit. Typed by `Slips[topic]`. Used for the conflict-resolution modal handoff.

The split is deliberate: `hub` for "something happened, whoever cares", `bureau` for "I need *this specific* answer back". Both keep commonlib decoupled from the host by making the type maps augmentable from anywhere.

## Function/class inventory

### bureau
- `globalSlipBoard: SlipBoard<Slips>` — re-exported global rendezvous board; augments global `Slips`.

### hub
- `eventHub: EventHub<LSEvents>` — global broadcast bus; augments global `LSEvents` (`hello`,`world` placeholders).

### events (`coreEvents.ts`)
- ~20 `EVENT_*` string constants (layout/plugin lifecycle, setting-saved, file changed/renamed/saved, database-rebuilt, log-added, setup-URI/QR requests, reload-setting-tab, plugin-sync-dialog, P2P open/close/settings, platform-unloaded, unresolved-error, check-remote-size). `declare global interface LSEvents` maps a subset to payload types.

### system (`wakelock.ts`)
- `withWakeLock<T>(callback: () => Promise<T>): Promise<T>` — run callback holding a screen wake lock; re-acquire on visibility; guaranteed release/cleanup via `AbortController`.

### worker — foreground (`bgWorker.ts`)
- `type WorkerInstance = { worker; processing; taskKeys }`.
- `splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename?, useSegmenter?)` — split via algorithm v1.
- `splitPieces2WorkerV2(...)` — split via v2.
- `splitPieces2WorkerRabinKarp(...)` — split via v3 (Rabin–Karp). (all three delegate to `_splitPieces2Worker` with a version tag.)
- `encryptWorker(input, passphrase, autoCalculateIterations): Promise<string>` / `decryptWorker(...)`.
- `encryptHKDFWorker(input, passphrase, pbkdf2Salt): Promise<string>` / `decryptHKDFWorker(...)`.
- `tasks: Map<number, ProcessItem>` — in-flight tasks.
- `removeTask(key)` — drop task from `tasks` + owning worker's `taskKeys`.
- `initialiseWorkerModule()` — build worker pool, wire `onmessage`/`onerror`, subscribe to `EVENT_PLATFORM_UNLOADED`.
- `startWorker(data)` (overloaded) — allocate key, register task, round-robin dispatch, `postMessage`.
- `terminateWorker()` — terminate all workers.
- (internal) `initialiseWorkers()`, `nextWorker()`.

### worker — foreground split reassembly (`bgWorker.splitting.ts`)
- `_splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, splitVersion, useSegmenter)` — start a split task, wire a `TransformStream`, return an async generator yielding ordered chunks.
- `abortSplitTasks(keys, error)` — abort writers for crashed-worker tasks.
- `handleTaskSplit(process, data)` — buffer by `seq`, flush in order, close on `END_OF_DATA`.

### worker — foreground encryption (`bgWorker.encryption.ts`)
- `encryptionOnWorker(data)` / `encryptionHKDFOnWorker(data)` — start task, await its promise, finalize.
- `handleTaskEncrypt(process, data)` — resolve/reject task from `{result}`/`{error}`, remove task.

### worker — background (in-Worker)
- `bg.worker.ts`: `self.onmessage` router (split vs encrypt vs HKDF vs error). Exports nothing (by design).
- `bg.worker.splitting.ts`: `processSplit(data)` — pick algorithm by `splitVersion`, iterate generator, `emit` each chunk + terminal `END_OF_DATA`; `getMainThreadPostBack(key)` (internal seq/emit closure, deliberately named `emit` to avoid a minify-collision recursion bug documented inline).
- `bg.worker.encryption.ts`: `processEncryption(data)` — encrypt/decrypt (± HKDF), post `{key,result}` or `{key,error}`.
- `bg.common.ts`: `postBack(key, seq, data)` — `self.postMessage` helper.

### worker — types (`universalTypes.ts`)
- Argument types `EncryptArguments`, `EncryptHKDFArguments`, `SplitArguments`; process-item types `EncryptProcessItem`, `EncryptHKDFProcessItem`, `SplitProcessItem`, union `ProcessItem`; result payloads `ResultPayload*` incl. seq'd streaming variants; `END_OF_DATA = null`.

### worker — mock (`bgWorker.mock.ts`)
- Same exported names as `bgWorker.ts` but in-thread; `startWorker` returns an immediately-resolved task; `initialiseWorkerModule`/`terminateWorker` are no-ops. Local `SplitArguments/EncryptArguments/EncryptHKDFArguments` (with legacy `useV2`).

### UI
- `svelteDialog.ts` — re-exports `CONTEXT_DIALOG_CONTROLS`, `setupDialogContext`, `getDialogContext`, `SvelteDialogManagerBase` + dialog prop/result types from the service base.
- `DialogHost.svelte` — props `{setTitle, closeDialog, setResult, mountComponent, getInitialData, onSetupContext}`; mounts guest, wraps `setResult`+`closeDialog`; global dialog CSS.
- `dialogues/DialogueToCopy.svelte` — guest dialog; reads `{title, dataToCopy}`, clipboard copy, returns `"ok"`.
- Components (props summarized): `Check{title,value,noteOnSelected?,noteOnUnselected?,children?}`; `Option{title,value,selectedValue,group?,notes,children?}`; `Options{children?}` / `Question{question?,children?}` (radio-group context providers); `Decision{title,commit,important?,destructive?,disabled?,additionalClasses?}`; `Password{value,name?,placeholder?,disabled?,required?}` (+ reveal); `InfoNote{title?,message?,warning?/caution?/error?/notice?/info?,signalWord?,visible?,cssClass?,children?}`; `InfoTable{info: Record<string,any>}`; `DialogHeader{title,subtitle?}` (sets modal title via context, scrolls to top); `InputRow{label,children?}`; `Instruction{title?,children?}`; `Guidance{title?,important?,children?}`; `ExtraItems{children?}`; `UserDecisions{children?}`.

### mock_and_interop
- `stores.ts` — `lockStats`, `collectingChunks`, `pluginScanningCount`, `hiddenFilesProcessingCount`, `hiddenFilesEventCount`, `logMessages` (reactive sources) + `LockStats`, `LogEntry` types.
- `wrapper.ts` — `class WrappedNotice` (`constructor`, `setMessage`, `hide`), `setNoticeClass(cls)`, `NewNotice(message, timeout?)`.

### cli
- `APITest.sample.ts` — top-level script exercising `DirectFileManipulator`. `deno.jsonc` — import map.

### dev
- `checks.ts` — `__$checkInstanceBinding<T>(instance)` binding-consistency diagnostic.

## Dependencies / Consumed by

**Depends on (external):** `octagonal-wheels` (SlipBoard, EventHub, encryption + hkdf, `reactiveSource`, `promiseWithResolvers`, `fireAndForget`, logger). **Depends on (internal):** `@lib/common/*` (`coreEnvFunctions`/`compatGlobal`, `logger`, `types`, `i18n`, `utils`), `@lib/string_and_binary/chunks` + `path` (worker split), `@lib/services/implements/base/SvelteDialog` (UI). Svelte 5 runtime for UI.

**Consumed by:**
- `hub`/`events`: ~68 modules across replication (trystero P2P, journal), pouchdb (`LiveSyncLocalDB`), services, setup features, and the Obsidian plugin layer (`src/modules`, `src/features`, `apps/webpeer`, `apps/cli`).
- `bureau`: `ConflictResolveModal.ts` (conflict-resolution result handoff).
- `worker`: `encryption/encryptHKDF.ts`, `pouchdb/encryption.ts`, and `ContentSplitter/ContentSplitterV1|V2|RabinKarp.ts`; `initialiseWorkerModule` invoked by `modules/main/ModuleLiveSyncMain.ts`. `disableWorkerForGeneratingChunks` (settings) gates use via `ContentSplitterBase`.
- `system/withWakeLock`: not confirmed here (grep beyond scope); a general-purpose helper.
- `UI`: dialog composition throughout the plugin/setting/P2P UIs.
- `mock_and_interop`: `WrappedNotice` is the default notice for headless/CLI; stores feed status UIs.
- `cli`/`dev`: not shipped as runtime library consumers (samples/diagnostics).

## Design observations (factual)

1. **`LSSlips` base interface appears undefined.** `bureau.ts` and `ConflictResolveModal.ts` both `extends LSSlips`, but no `interface LSSlips {}` declaration exists in-tree or in `octagonal-wheels`. Whether this compiles cleanly depends on an ambient declaration not located; potential latent type gap. (`LSEvents` by contrast is concretely augmented in `events/coreEvents.ts`.)
2. **Two coexisting `EVENT_FILE_CHANGED`-style definitions and unused constants.** `coreEvents.ts` declares several constants (e.g. `EVENT_LOG_ADDED`, `EVENT_REQUEST_OPEN_SETUP_URI`, `EVENT_REQUEST_COPY_SETUP_URI`, `EVENT_REQUEST_RELOAD_SETTING_TAB`, `EVENT_REQUEST_OPEN_PLUGIN_SYNC_DIALOG`) that are **not** added to the `LSEvents` payload map — so emitting/subscribing them is untyped. A commented-out duplicate `EVENT_FILE_CHANGED = "file-changed"` sits next to the live `"event-file-changed"`. Vocabulary and type-map have drifted apart.
3. **Mock vs real worker argument shapes have diverged.** Real `SplitArguments` uses `splitVersion: 1|2|3`; `bgWorker.mock.ts`'s local `SplitArguments` still uses `useV2: boolean`. The mock reimplements the public surface by hand rather than sharing types, so drift is silent (the alias swap is build-time).
4. **`hub.ts` ships placeholder events (`hello`,`world`)** in the global augmentation — harmless but leftover scaffolding in a core module.
5. **Round-robin dispatch ignores load.** `WorkerInstance.processing` is incremented/decremented but never consulted; `nextWorker()` is pure round-robin, so a long split can queue behind others on the same worker while an idle worker exists.
6. **`processing` decrement path is split-responsibility.** For encryption, `finalize()` (which decrements `processing`) is called by `encryptionOnWorker` after the promise; for splitting it is called in the generator's `finally`. If a split consumer never fully drains the generator, `finalize` may not run and `processing` can leak (cosmetic, since `processing` is unused — but it means the counter is unreliable).
7. **Documented minification hazard is load-bearing.** `bg.worker.splitting.ts` carries an explicit comment that renaming `postBack`→`emit` avoids an inline-bundling minify collision causing infinite recursion ("Maximum call stack size exceeded"). This is a real, fragile coupling to the esbuild `?worker&inline` bundling.
8. **UI radio grouping relies on a stringly-typed svelte context key `"radioGroup"`** shared across `Question`/`Options`/`Option` with a `Math.random()` group id; no type safety binds them, and two container components (`Question`, `Options`) duplicate the same setup.
9. **`cli/APITest.sample.ts` embeds hardcoded credentials/URL** and runs top-level `await` with side effects; clearly a manual scratch file, but it lives in the shipped source tree.
10. **`WrappedNotice` silently downgrades UI notices to log lines** and its `hide()`/`timeout` are no-ops — correct for headless, but any code depending on a notice actually disappearing gets nothing until `setNoticeClass` installs the real implementation.
11. **`dev/checks.ts` parses method bindings from `Function.prototype.toString()`** (regex over `this._method`), which is brittle under minification/transpilation — acceptable as a dev-only check but not a runtime guarantee.

## Coverage gaps

- Tests exist only for `worker/` (`bgWorker.unit.spec.ts`, `bg.worker.splitting.unit.spec.ts`); their assertions were not read in depth here.
- The `LSSlips` resolution (obs. 1) was investigated via grep across `src/` and `octagonal-wheels`; an ambient declaration in the toolchain/`node_modules` types could exist but was not located — stated as unclear rather than a defect.
- `withWakeLock` consumers were not enumerated (out of the assigned package scope).
- `services/implements/base/SvelteDialog.ts` (the real dialog engine behind `svelteDialog.ts`/`DialogHost`) is outside this subsystem and was treated as a dependency, not analyzed.

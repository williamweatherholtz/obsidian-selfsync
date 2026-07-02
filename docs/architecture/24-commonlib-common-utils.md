# Commonlib: Common Utilities

*As-built reverse-engineering baseline. Scope: `src/lib/src/common/` (all files). Read-only analysis; symbol names and paths verified against source.*

## Purpose & responsibilities

`src/lib/src/common/` is the **shared foundation layer** of livesync-commonlib. It is a catch-all "common" package that owns three broad responsibilities:

1. **The canonical data model** — the settings type (`ObsidianLiveSyncSettings`), the CouchDB/PouchDB document/entry types, database constants, and the enums/symbols the whole sync engine keys off. `types.ts` is a single re-export barrel that fans these out to the rest of the codebase.
2. **Cross-cutting utilities** — generic async/concurrency helpers, blob/document content helpers, object patch/merge/diff, regexp handling, error wrapping, environment abstraction.
3. **Internationalization (i18n)** — a message-key → translated-string system plus a large body of generated/authored translation data (this is where most of the LOC lives, but almost all of it is *data*, not logic).

By import count it is the single most depended-on directory in the library: **195 files import from `./common/types`** and **232 files** import from `common/*` overall. Changes here ripple everywhere.

> Note on the ~14.9K-LOC figure: the directory is dominated by generated i18n data. `messages/combinedMessages.prod.ts` alone is 9,328 LOC and the `messagesYAML/` + `messagesJson/` trees add ~20K more lines of translation tables. The *architecturally significant TypeScript logic* is a much smaller subset (~4–5K LOC across `utils.ts`, `types.ts`, `models/`, `settingConstants.ts`, `configForDoc.ts`, `ConnectionString.ts`, `utils.patch.ts`, and the i18n runtime).

## Files & LOC (full table)

### Top-level `common/` files

| File | LOC | Role |
|------|----:|------|
| `types.ts` | 414 | **Barrel** — re-exports the entire common data model (settings, db entries, consts, symbols) from `models/`. Central import hub. |
| `utils.ts` | 673 | Grab-bag utility module: blob/document content helpers, concurrency (`Parallels`, `allSettledWithConcurrencyLimit`), interval throttling, custom regexp engine, settings "pick" helpers, misc. Re-exports many `octagonal-wheels` primitives. |
| `settingConstants.ts` | 474 | UI-facing setting metadata (`SettingInformation` name/desc table), derived key-type helpers (`FilterStringKeys` etc.), `getConfig`/`getConfName`, `AllSettings`/`OnDialogSettings` types. |
| `configForDoc.ts` | 413 | Rule engine describing per-setting doctor/validation rules (rebuild-required, obsolete values, conditions) used by the "doctor"/config-check feature. |
| `ConnectionString.ts` | 209 | `ConnectionStringParser` — parse/serialize `sls+http(s)/s3/p2p://` remote-config URIs to/from settings objects. |
| `utils.patch.ts` | 214 | Object diff/patch/merge algorithm (`generatePatchObj`, `applyPatch`, `mergeObject`, `flattenObject`) with special marker sentinels; used for tweak/settings sync. |
| `LSError.ts` | 127 | `LiveSyncError` / `LiveSyncFatalError` classes with cause-chain status extraction and `isCausedBy`/`fromError` helpers. |
| `i18n.ts` | 118 | i18n runtime: `$t`, `$msg`, `$f`, `translateIfAvailable`, language resolution, missing-translation tracking, message cache. |
| `rosetta.ts` | 118 | i18n type/config core: `I18N_LANGS`, `SUPPORTED_I18N_LANGS`, `MESSAGE`, `expandKeywords` (recursive `%{key}` interpolation). |
| `coreEnvFunctions.ts` | 112 | Host-environment abstraction: injectable `getLanguage`, `compatGlobal`, `_fetch`, `_activeDocument`, HTMLElement/SVGElement `setCssStyles` polyfills. |
| `typeUtils.ts` | 52 | Path/ID classification helpers (`isInternalMetadata`, `isChunk`, `getDatabasePathFromUXFileInfo`, etc.). |
| `utils.doc.ts` | 45 | CouchDB error-code predicates (`isNotFoundError`, `isConflictError`, `isUnauthorizedError`), `tryGetFilePath`. |
| `utils.object.ts` | 12 | `asCopy` (JSON deep-clone), `ensureError`. |
| `coreEnvVars.ts` | 7 | `manifestVersion` / `packageVersion` from build-time defines. |
| `utils.type.ts` | 2 | `Constructor<T>` generic type alias. |
| `logger.ts` | 2 | Pure re-export of `octagonal-wheels/common/logger`. |

### Unit-test files (co-located)

| File | LOC | Role |
|------|----:|------|
| `ConnectionString.unit.spec.ts` | 260 | Tests for the URI parser. |
| `LSError.unit.spec.ts` | 135 | Tests for the error class. |
| `utils.doc.unit.spec.ts` | 35 | Tests for doc error predicates. |

### `models/` subdirectory (the data model, split out of the old `types.ts`)

| File | LOC | Role |
|------|----:|------|
| `setting.type.ts` | 1,087 | **The settings type definitions** — all the composed interfaces and the canonical `ObsidianLiveSyncSettings` type. |
| `shared.definition.configNames.ts` | 228 | `ConfigurationItem` type + `configurationNames` metadata table + `ConfigLevel` constants (`confName`/`confDesc`/`statusDisplay`). |
| `db.type.ts` | 171 | CouchDB entry types (`DatabaseEntry`, `NoteEntry`, `NewEntry`, `PlainEntry`, `LoadedEntry`, `SavingEntry`, `MetaEntry`, `EntryLeaf`, …) + tagged `FilePath`/`DocumentID`. |
| `setting.const.qr.ts` | 171 | `KeyIndexOfSettings` — fixed integer index per setting key, for compact QR-code setting export. |
| `setting.const.defaults.ts` | 187 | `DEFAULT_SETTINGS` and `P2P_DEFAULT_SETTINGS` values. |
| `tweak.definition.ts` | 95 | Tweak-sync templates (`TweakValues*`), `IncompatibleChanges`, compatibility classification of setting mismatches. |
| `db.definition.ts` | 79 | Higher-level doc types (`EntryDoc`, `EntryMilestoneInfo`, `EntryNodeInfo`, `NodeData`) + `isMetaEntry`. |
| `fileaccess.type.ts` | 79 | UX file-abstraction types (`UXFileInfo`, `UXFileInfoStub`, `UXStat`, `UXFolderInfo`, `FileEvent*`, `CacheData`). |
| `setting.const.ts` | 62 | Core setting enums: `RemoteTypes`, `E2EEAlgorithms`, `HashAlgorithms`, `ChunkAlgorithms`, sync `MODE_*`, `NetworkWarningStyles`, `CURRENT_SETTING_VERSION`. |
| `auth.type.ts` | 44 | Credential/JWT types (`CouchDBCredentials`, `BasicCredentials`, `JWTCredentials`, `JWTHeader/Payload/Params`, `JWTAlgorithm`). |
| `redflag.const.ts` | 36 | "Red flag" trigger-file names (suspend/rebuild/fetch flags) + log-file prefixes. |
| `shared.const.behabiour.ts` | 34 | Behavioural constants: `MAX_DOC_SIZE`, `VER` (=12), timeouts, salts, murmurhash seed, ID prefixes. *(filename typo: "behabiour")* |
| `shared.const.symbols.ts` | 13 | Magic result `Symbol`s (`CANCELLED`, `AUTO_MERGED`, `NOT_CONFLICTED`, `BASE_IS_NEW`, `TARGET_IS_NEW`, `EVEN`, …). |
| `shared.definition.ts` | 32 | `DatabaseConnectingStatuses` enum + type. |
| `setting.const.preferred.ts` | 32 | Preferred setting presets (`PREFERRED_BASE`, `PREFERRED_SETTING_CLOUDANT`, `PREFERRED_SETTING_SELF_HOSTED`, `PREFERRED_JOURNAL_SYNC`). |
| `sync.definition.ts` | 25 | `ProtocolVersions`, `SyncParameters`, sync-parameter doc IDs + defaults. |
| `diff.definition.ts` | 24 | Diff result types (`diff_result`, `diff_result_leaf`, `dmp_result`, `diff_check_result`). |
| `db.const.ts` | 24 | Doc IDs (`VERSIONING_DOCID`, `MILESTONE_DOCID`, `SYNCINFO_ID`), `EntryTypes`, `ChunkTypes`, `NoteTypes`. |
| `fileaccess.const.ts` | 14 | Path prefix headers (`CHeader`="h:", `ICHeader`, `PSCHeader`, `ICXHeader`). |
| `shared.const.symbols.ts` | (13) | *(see above)* |
| `shared.const.ts` | 10 | Setting keys, config URI bases, DB name suffixes. |
| `shared.type.util.ts` | 12 | `TaggedType`, `CustomRegExpSource`/`List`, `ParsedCustomRegExp`, `Prettify`. |

### `messages/`, `messagesJson/`, `messagesYAML/` (i18n data — largest by LOC)

| File(s) | LOC | Role |
|---------|----:|------|
| `messages/combinedMessages.prod.ts` | 9,328 | **Generated** production message table (all languages inlined). |
| `messages/combinedMessages.dev.ts` | 50 | Dev-mode message assembler — imports each `messages/<lang>.ts` and builds `allMessages` via `expandKeywords`. |
| `messages/def.ts, de.ts, es.ts, fr.ts, he.ts, ja.ts, ko.ts, ru.ts, zh.ts, zh-tw.ts` | 4 each | Per-language re-export stubs (`export { PartialMessages }`). |
| `messagesYAML/*.yaml` (en, de, es, fr, he, ja, ko, ru, zh, zh-tw) | ~412–1,939 each | **Authoring source** for translations (largest: `en.yaml` 1,939). |
| `messagesJson/*.json` (same langs) | ~295–1,117 each | Compiled JSON form of the YAML. |

## Logical clusters

The files group into these clusters:

- **A. Settings / configuration model** — `models/setting.type.ts`, `models/setting.const.ts`, `models/setting.const.defaults.ts`, `models/setting.const.preferred.ts`, `models/setting.const.qr.ts`, `models/tweak.definition.ts`, `models/shared.definition.configNames.ts`, `settingConstants.ts`, `configForDoc.ts`.
- **B. Database / document model** — `models/db.type.ts`, `models/db.const.ts`, `models/db.definition.ts`, `models/fileaccess.type.ts`, `models/fileaccess.const.ts`, `models/auth.type.ts`, `models/sync.definition.ts`, `models/diff.definition.ts`, `models/redflag.const.ts`.
- **C. Constants / enums / symbols** — `models/shared.const.ts`, `models/shared.const.behabiour.ts`, `models/shared.const.symbols.ts`, `models/shared.definition.ts`, `models/shared.type.util.ts`.
- **D. The re-export barrel** — `types.ts` (aggregates A–C for downstream consumers).
- **E. Generic utilities** — `utils.ts`, `utils.patch.ts`, `utils.object.ts`, `utils.doc.ts`, `typeUtils.ts`, `utils.type.ts`.
- **F. Errors** — `LSError.ts`.
- **G. Environment abstraction** — `coreEnvFunctions.ts`, `coreEnvVars.ts`.
- **H. Logging** — `logger.ts`.
- **I. i18n runtime + data** — `i18n.ts`, `rosetta.ts`, `messages/`, `messagesJson/`, `messagesYAML/`.
- **J. Remote-config URI codec** — `ConnectionString.ts`.

## Significant clusters explained (deep)

### Settings / types — the canonical `ObsidianLiveSyncSettings`

**The central settings type lives in `src/lib/src/common/models/setting.type.ts`**, and its defaults live in `src/lib/src/common/models/setting.const.defaults.ts`. `types.ts` merely re-exports them (`export type { ObsidianLiveSyncSettings }; export { DEFAULT_SETTINGS };`). Historically these were defined directly in `types.ts`; the top comment ("Now migrating everything here to models, only re-exporting from this file") confirms an in-progress extraction into `models/`.

`ObsidianLiveSyncSettings` is built by **composition of ~35 small single-concern interfaces**, then intersected:

```ts
type ObsidianLiveSyncSettings = ObsidianLiveSyncSettings_PluginSetting & RemoteDBSettings & LocalDBSettings;
```

- `ObsidianLiveSyncSettings_PluginSetting` `extends` (multiple-interface inheritance) the plugin-side concerns: `SyncMethodSettings`, `UISettings`, `FileHandlingSettings`, `MergeBehaviourSettings`, `EncryptedUserSettings`, `PeriodicReplicationSettings`, `InternalFileSettings`, `PluginSyncSettings`, `ModeSettings`, `ExtraTweakSettings`, `BetaTweakSettings`, `ObsoleteSettings`, `DebugModeSettings`, `SettingSyncSettings`, `SafetyValveSettings`, `DataOnSettings`, `RemoteConfigurations`.
- `RemoteDBSettings` is a large intersection of remote/DB concerns: `CouchDBConnection & BucketSyncSetting & RemoteTypeSettings & EncryptionSettings & ChunkSettings & EdenSettings & DataOnRemoteDBSettings & ObsoleteRemoteDBSettings & OnDemandChunkSettings & BetaRemoteDBSettings & ReplicationSetting & RemoteDBTweakSettings & FileHandlingSettings & ProcessingBehaviourSettings & OptionalAndNotExposedRemoteDBSettings & CrossPlatformInteroperabilitySettings & ConflictHandlingSettings & EdgeCaseHandlingSettings & DeletedFileMetadataSettings & P2PSyncSetting & RemoteConfigurations`.

Notable design points:
- Many settings are explicitly marked obsolete/deprecated but retained for migration (`ObsoleteSettings`, `ObsoleteRemoteDBSettings`, `useSegmenter`, `enableChunkSplitterV2`). Nothing is removed; settings are grandfathered.
- `HasSettings<T extends Partial<ObsidianLiveSyncSettings>>` is a mixin interface (`{ settings: T }`) used broadly to inject settings into classes.
- Encryption/hashing/chunking algorithm choices are const-object enums in `models/setting.const.ts` (`E2EEAlgorithms`, `HashAlgorithms`, `ChunkAlgorithms`, `RemoteTypes`); the settings type references them via `(typeof X)[keyof typeof X]`. `""` is a meaningful "legacy/default" value in several of these (e.g. `REMOTE_COUCHDB=""`, `E2EEAlgorithms.V1=""`).
- `CustomRegExpSourceList<D>` is a *branded* string type parameterized by its delimiter — note two different delimiters in use: `","` for internal-file patterns and the (self-described "I really regret this") `"|[]|"` for `syncOnlyRegEx`/`syncIgnoreRegEx`.
- Setting **versioning**: `CURRENT_SETTING_VERSION = SETTING_VERSION_SUPPORT_CASE_INSENSITIVE = 10` (in `setting.const.ts`), stamped into `DEFAULT_SETTINGS.settingVersion`.

Around the raw type sit several *metadata* tables, all keyed by setting name:
- `configurationNames` (`models/shared.definition.configNames.ts`) and `SettingInformation` (`settingConstants.ts`) hold human-readable `name`/`desc`/`placeHolder`/`isHidden`/`status` per key. `getConfig(key)` merges them (configurationNames first, then SettingInformation) and translates via `$t`.
- `KeyIndexOfSettings` (`setting.const.qr.ts`) assigns each key a stable integer for compact QR-code serialization.
- `configForDoc.ts` defines a **rule engine** (`RuleLevel` Must/Necessary/Recommended/Optional, `ConditionType` platform/remote case-sensitivity, per-rule `requireRebuild`/`recommendRebuild`/`detectionFunc`/`reasonFunc`) driving the "doctor" config-check feature.
- `settingConstants.ts` also derives compile-time key-sets from the settings type: `FilterStringKeys`/`FilterBooleanKeys`/`FilterNumberKeys` → `AllStringItemKey` etc., plus `OnDialogSettings` (UI-only ephemeral fields: `preset`, `syncMode`, `configPassphrase`).

### Logging

Effectively a **pass-through to the `octagonal-wheels` package**. `logger.ts` is two lines: `export * from "octagonal-wheels/common/logger"`. `types.ts` re-exports the log levels (`LOG_LEVEL_DEBUG/INFO/NOTICE/URGENT/VERBOSE`) and the `LOG_LEVEL` type from the same source. There is no bespoke logging implementation in this directory; consumers call `Logger(...)` / the level constants sourced through here. This is a deliberate thin seam so the whole codebase imports logging from one local path.

### Async / concurrency / lock primitives

There is **no bespoke lock/mutex class in this directory** — the real concurrency primitives (`Semaphore`, `Mutex`, signals) come from `octagonal-wheels` and are re-exported through `utils.ts`. What `common` adds:

- `globalConcurrencyController = Semaphore(50)` (`utils.ts`) — a **process-wide 50-permit semaphore** exported for shared use; a global coupling point.
- `Parallels(ps)` and `allSettledWithConcurrencyLimit(processes, limit)` (`utils.ts`) — a lightweight bounded-concurrency runner built on `Promise.race` over a live `Set` of in-flight promises (`.add`/`.wait(limit)`/`.all()`).
- `runWithInterval(key, interval, task)` / `runWithStartInterval(...)` (`utils.ts`) — keyed minimum-interval throttling backed by a **module-level mutable `lastProcessed` record** (explicitly documented as *not concurrency-safe*). `markInterval` has a subtle precedence bug-smell: `lastProcessed?.[key] ?? 0 < next` parses as `?? (0 < next)`.
- `isDirty(key, value)` — module-level `Map` tracking last-seen values per key.
- Re-exported from `octagonal-wheels` via `utils.ts`: `delay`, `fireAndForget`, `throttle`, `sendValue`/`sendSignal`/`waitForSignal`/`waitForValue` (signal message-passing), `LRUCache` (via `memorizeFuncWithLRUCache`/`...Multi`).
- `resolveWithIgnoreKnownError` / `wrapException` / `wrapByDefault` — error-swallowing async wrappers.

So the "primitives" here are thin **coordination helpers and module-global singletons** rather than a lock library.

### i18n

Two source files plus a large data tree:
- `rosetta.ts` — declares `I18N_LANGS` (def/de/es/fr/he/ja/ko/ru/zh/zh-tw plus `""` = auto), `SUPPORTED_I18N_LANGS`, `MESSAGE` (`{lang?: string}`), and `expandKeywords` which recursively resolves `%{key}` references between messages (recursion-limited to 10, logs on overrun). *(Bug-smell: the recursion uses `recurseLimit--`, a post-decrement passing the un-decremented value.)*
- `i18n.ts` — runtime. `$t(key, lang?)` resolves a message (with per-`currentLang` cache and missing-translation tracking via `__onMissingTranslation`); `$msg(key, params, lang?)` additionally interpolates `${placeholder}` params and returns a branded `TaggedType<string, key>`; `$f` is a tagged-template translator; `translateIfAvailable` no-ops on unknown keys. Language auto-resolution maps Obsidian locale codes (via injected `getLanguage`) to internal langs (`obsidianLangMap`).
- Data: `messages/combinedMessages.dev.ts` assembles `allMessages` from per-language `PartialMessages` stubs (which point at the YAML/JSON-derived tables); `messages/combinedMessages.prod.ts` is the flattened generated production table. `messagesYAML/*` is the human authoring source; `messagesJson/*` the compiled form.

### Remote-config URI codec (`ConnectionString.ts`)

`ConnectionStringParser` (static-method class) parses/serializes `sls+<subscheme>://…` URIs into typed settings via a discriminated union `RemoteConfigurationResult` (`couchdb` | `s3` | `p2p` | `webdav`(TODO/`never`)). Because `sls+xxx:` is a non-special URL scheme (host/user/pass unreadable per WHATWG), it swaps in a `https` proxy scheme for parsing and swaps the prefix back on serialize (`parseSlsUri`/`withSlsScheme`). P2P is parsed manually (regex) because room IDs contain characters special-scheme hosts can't represent. This is the codec behind the `obsidian://setuplivesync?settings=` config-share/QR feature.

## Function inventory for remaining clusters (compact)

### `utils.ts` (content/db helpers, not covered above)
- `getDocData(doc)` / `getDocDataAsArray(doc)` / `getDocDataAsArrayBuffer(doc)` — normalize `string | string[] | ArrayBuffer` doc data.
- `isTextBlob(blob)` / `createTextBlob(data)` / `createBinaryBlob(data)` / `createBlob(data)` — Blob constructors by content type.
- `isTextDocument(doc)` / `readAsBlob(doc)` / `readContent(doc)` — read a `LoadedEntry` as blob/string/binary.
- `isDocContentSame(a,b)` — content equality; uses `indexedDB.cmp` fast-path, else chunked base64 compare.
- `isObfuscatedEntry` / `isEncryptedChunkEntry` / `isSyncInfoEntry` — entry type guards by `_id` prefix.
- `isAnyNote` / `isLoadedEntry` / `isDeletedEntry` — entry guards by `type`/`data`/deleted flags.
- `createSavingEntryFromLoadedEntry(doc)` — LoadedEntry → SavingEntry (blob + datatype).
- `determineType(path,data)` / `determineTypeFromBlob(data)` — `"plain" | "newnote"` classification.
- `memorizeFuncWithLRUCache(fn)` / `...Multi(fn)` — LRU memoization wrappers.
- `onlyNot(exclusion)` — typed filter predicate factory.
- `escapeNewLineFromString` / `unescapeNewLineFromString` / `escapeMarkdownValue` — string escaping.
- `timeDeltaToHumanReadable(ms)` / `sizeToHumanReadable` (re-export) — formatting.
- `toRanges(sorted)` — numeric array → base-32 range string (chunk-id compaction).
- `tryParseJSON(str, fallback)` — safe JSON parse.
- `parseHeaderValues(strHeader)` — `"k: v\n…"` → record.
- `parseCustomRegExp` / `matchRegExp` / `isValidRegExp` / `isInvertedRegExp` / `constructCustomRegExpList` / `splitCustomRegExpList` / class `CustomRegExp` / `getFileRegExp(settings,key)` — the custom regexp engine (`!!`-prefix = negate).
- `copyTo(source,target)` — copy only keys present in target.
- `pickBucketSyncSettings` / `pickCouchDBSyncSettings` / `pickEncryptionSettings` / `pickP2PSyncSettings` — extract sub-setting objects from full settings.
- `compareMTime(a,b)` — mtime compare truncated to 2000ms resolution → `BASE_IS_NEW`/`TARGET_IS_NEW`/`EVEN`.
- `displayRev(rev)` — shorten a CouchDB `_rev`.
- `generateP2PRoomId()` / `extractP2PRoomSuffix(roomId)` — P2P room-ID gen/parse (`123-456-789-abc`).
- Re-exports from `octagonal-wheels`: `replaceAll`, `replaceAllPairs`, `concatUInt8Array`, `delay`, `fireAndForget`, `arrayToChunkedArray`, `unique`, `extractObject`, `isObjectDifferent`, `throttle`, signal fns, `SimpleStore` type.

### `utils.patch.ts`
- `generatePatchObj(from,to)` — deep diff producing a patch with sentinel markers (`__DELETED`/`__ARRAY`/`__SWAP`, prefixed by ``); arrays of `{id}` objects diffed order-independently.
- `applyPatch(from,patch)` — apply such a patch (mutates `from`).
- `mergeObject(a,b)` — deep merge with sorted keys; arrays union'd via `Set`.
- `flattenObject(obj)` — `[dotPath, value][]`.
- `isSensibleMargeApplicable(path)` (`.md`) / `isObjectMargeApplicable(path)` (`.canvas`/`.json`) — merge-eligibility by extension. *(note misspelling "Marge".)*

### `utils.doc.ts`
- `isErrorOf(ex, code)` / `isNotFoundError` (404) / `isConflictError` (409) / `isUnauthorizedError` (401) — PouchDB/CouchDB error predicates. `tryGetFilePath(entry)`.

### `utils.object.ts`
- `asCopy(obj)` — JSON deep clone. `ensureError(err)` — coerce unknown → `Error` (via `LiveSyncError.fromError`).

### `typeUtils.ts`
- `isInternalMetadata(id)`, `isInternalFile(file)`, `stripInternalMetadataPrefix(id)`, `id2InternalMetadataId(id)`, `isChunk(str)`, `isPluginMetadata(str)`, `isCustomisationSyncMetadata(str)`, `getPathFromUXFileInfo`, `getStoragePathFromUXFileInfo`, `getDatabasePathFromUXFileInfo` — path/prefix classification & conversion using headers from `fileaccess.const.ts`.

### `LSError.ts`
- `class LiveSyncError extends Error` — `.status` getter (walks `.cause` chain, default 500), `.overrideStatus`, static `isCausedBy(error, class)` (cycle-guarded), static `fromError(error)`. `class LiveSyncFatalError extends LiveSyncError`.

### `coreEnvFunctions.ts` / `coreEnvVars.ts`
- `setGetLanguage(fn)` / `getLanguage()` — injectable host-language accessor (defaults `"en"`; keeps `obsidian` out of core).
- `compatGlobal`, `_fetch`, `_activeDocument` — environment-portable globals (window vs globalThis). Polyfills `HTMLElement`/`SVGElement` `.setCssStyles`/`.setCssProps` for non-Obsidian runtimes.
- `manifestVersion` / `packageVersion` — from build-time `MANIFEST_VERSION`/`PACKAGE_VERSION` defines.

## Dependencies / Consumed by

**Depends on (external):** `octagonal-wheels` heavily (logger, LRUCache, Semaphore, promises, collection, object, signal, string, binary, number, function, SimpleStore, `TaggedType`); `obsidian` only as a *type* import in `coreEnvFunctions.ts` (deliberately no runtime dependency). Internal sibling deps: `@lib/string_and_binary/*` (path/convert), `@lib/pouchdb/utils_couchdb` (`isErrorOfMissingDoc`, `isCloudantURI`), `@lib/interfaces/Confirm`.

**Consumed by:** essentially the entire library and plugin. Verified counts: **195 files import `common/types`; 232 files import from `common/*`.** `types.ts` is the single most-imported module — nearly every module reaches the data model through this barrel. Changes to the settings type, entry types, or the re-export surface are maximally high-blast-radius.

## Design observations (factual)

- **God-barrel / hub coupling.** `types.ts` (414 lines, almost all re-exports) is a single funnel through which 195 files reach dozens of unrelated concerns (settings, db entries, symbols, credentials, diff, redflag). It couples consumers to the whole model regardless of what they use, and makes the model's true internal dependency graph invisible at the import site. The header comment shows an active migration to `models/` behind this barrel.
- **`utils.ts` is a genuine catch-all (673 lines).** It mixes blob/content handling, entry type guards, concurrency helpers, interval throttling, a regexp engine, settings "pick" helpers, base-32 range encoding, P2P room-ID generation, and pure re-exports of `octagonal-wheels`. Low cohesion; multiple unrelated reasons to change.
- **Module-global mutable state.** `globalConcurrencyController` (a shared `Semaphore(50)`), `lastProcessed` (interval tracking), `previousValues` (`isDirty`), and i18n's `currentLang`/`msgCache`/`missingTranslations` are process singletons. These are documented as not concurrency-safe and create hidden coupling/test-isolation hazards.
- **Settings type is a very wide intersection (~35 mixin interfaces).** `ObsidianLiveSyncSettings` is a single flat namespace where plugin-, remote-DB-, P2P-, and obsolete concerns all collide into one key space. Setting metadata is split across *three* parallel tables (`configurationNames`, `SettingInformation`, `KeyIndexOfSettings`) keyed by the same names, which must be kept in sync manually. Obsolete/deprecated fields are never removed (migration safety), so the type steadily accumulates dead keys.
- **`""` as a meaningful enum member** (remote type, E2EE algo, hash algo, display language, network warning style) blurs "unset" vs "legacy default"; correctness depends on readers knowing which.
- **i18n data dominates LOC but not complexity.** ~30K+ of the directory's lines are translation tables (`combinedMessages.prod.ts`, YAML/JSON). The logic footprint is small; the LOC figure overstates the code-review surface.
- **Minor code smells noted (not fixed):** operator-precedence smell in `markInterval` (`?? 0 < next`); post-decrement `recurseLimit--` in `expandKeywords`; recurring misspellings baked into public names/filenames (`shared.const.behabiour.ts`, `mergeObject`-family "Marge"); `webdav` branch of the connection-string union is `settings: never` (TODO placeholder).
- **Clean seams worth noting.** Logging and environment access are deliberately thin, injectable seams (`logger.ts` re-export, `coreEnvFunctions.setGetLanguage`, `compatGlobal`) that keep the host (`obsidian`) out of the core and enable CLI/web/test reuse — a genuinely good decoupling amid the coupling smells.

### Coverage gaps / uncertainties
- I did not read every per-language message file line-by-line (`messagesYAML/*`, `messagesJson/*`, `combinedMessages.prod.ts`) — treated as generated/authored data; roles inferred from `combinedMessages.dev.ts` and `rosetta.ts`.
- `configForDoc.ts` was read only through its rule-type declarations (first ~40 lines) plus the settingConstants integration; the full concrete rule list (~370 lines) was not enumerated.
- Several small `models/*.definition.ts` files (`db.definition.ts`, `tweak.definition.ts`, `sync.definition.ts`, `diff.definition.ts`) were confirmed by header/first lines, not exhaustively.

# Conflict Detection, Resolution & Document History

> As-built reverse-engineering baseline. All symbol names and paths verified by reading the
> source at repo HEAD. Where behavior could not be confirmed from the files in scope, it is
> flagged explicitly as **UNVERIFIED**.

## Purpose & responsibilities

This subsystem is responsible for the *last-mile* of Self-hosted LiveSync's replication model:
CouchDB/PouchDB replicates freely and never rejects a write, so two devices editing the same
note produce a document with **multiple leaf revisions** (a conflict). This subsystem:

1. **Detects** that a document is conflicted (has `_conflicts`).
2. **Attempts automatic resolution** — either a trivial "identical leaves" collapse, a
   line-level three-way *sensible merge* (Markdown), or a key-level *object merge* (JSON/Canvas).
3. Falls back to **interactive resolution** (a modal presenting a diff and letting the user
   pick a side, concatenate, or defer).
4. Offers bulk / policy resolution: **"resolve by newer file"** (per-file and vault-wide), and
   an automatic **"newer wins"** path for plugin/appearance metadata.
5. Provides **Document History** — a per-file revision browser with diff highlighting, search,
   image overlay diff, and "restore this revision".
6. Provides a specialized JSON/settings conflict pane (`JsonResolveModal` / `JsonResolvePane`)
   used by Config Sync and Hidden File Sync.

The heavy diff/merge algorithms live in the commonlib (`src/lib/src/managers/ConflictManager.ts`
and `src/lib/src/common/utils.patch.ts`); the `src/modules/*` layer orchestrates queueing, DB
mutation, storage write-back, and the Obsidian UI.

## Files & LOC (table)

| File | LOC | Role |
|---|---|---|
| `src/modules/coreFeatures/ModuleConflictResolver.ts` | 236 | Core resolution orchestrator: auto-merge decision, delete-losing-rev, resolve-by-newest, bulk-by-newer. Platform-agnostic. |
| `src/modules/coreFeatures/ModuleConflictChecker.ts` | 82 | Two-stage conflict-check queue (`conflictCheckQueue` → `conflictResolveQueue`); optional-method dispatch (`newer`). |
| `src/modules/features/ModuleInteractiveConflictResolver.ts` | 177 | Obsidian commands + interactive UI driver; opens `ConflictResolveModal`, applies selection. |
| `src/modules/features/InteractiveConflictResolving/ConflictResolveModal.ts` | 205 | The conflict diff modal (Use A / Use B / Concat / Not now); also reused in plugin "pick a version" mode. |
| `src/modules/features/DocumentHistory/DocumentHistoryModal.ts` | 659 | Revision browser: slider, highlight-diff, diff-only, search (last 100), image overlay diff, restore. |
| `src/features/HiddenFileCommon/JsonResolveModal.ts` | 89 | Obsidian `Modal` wrapper mounting the Svelte JSON merge pane. |
| `src/features/HiddenFileCommon/JsonResolvePane.svelte` | 229 | JSON/settings merge UI (A / B / A+B / B+A) for Config Sync & Hidden File Sync. |
| `src/lib/src/managers/ConflictManager.ts` | 410 | **commonlib** — `tryAutoMerge`, `mergeSensibly` (three-way line merge), `mergeObject` (three-way object merge), `getConflictedDoc`. |
| `src/lib/src/common/utils.patch.ts` | 214 | **commonlib** — `generatePatchObj`, `applyPatch`, `mergeObject`, `flattenObject`, `isSensibleMargeApplicable`, `isObjectMargeApplicable`. |
| `src/lib/src/common/models/diff.definition.ts` | 24 | Types: `diff_result_leaf`, `diff_result`, `dmp_result`, `DIFF_CHECK_RESULT_AUTO`, `diff_check_result`. |
| `src/lib/src/services/base/ConflictService.ts` | 73 | Abstract service surface (`resolve`, `resolveByDeletingRevision`, `resolveByNewest`, `queueCheckFor`, …). |

Total in scope: ~2,398 LOC.

## Key types / data structures (conflict/leaf/diff representations)

Defined in `src/lib/src/common/models/diff.definition.ts`:

```ts
type diff_result_leaf = {           // one CouchDB leaf revision, materialized for comparison
    rev: string;
    data: string;                   // decoded text content
    ctime: number;
    mtime: number;
    deleted?: boolean;
};
type dmp_result = Array<[number, string]>;   // diff-match-patch output: [op, text]
type diff_result = {                // payload handed to the interactive UI
    left: diff_result_leaf;         // "local"/current leaf (test._rev)
    right: diff_result_leaf;        // "remote"/conflicted leaf (conflicts[0])
    diff: dmp_result;
};
type DIFF_CHECK_RESULT_AUTO = CANCELLED | AUTO_MERGED | NOT_CONFLICTED | MISSING_OR_ERROR;  // symbols
type diff_check_result = DIFF_CHECK_RESULT_AUTO | diff_result;   // union: sentinel OR "needs UI"
```

The sentinels (`AUTO_MERGED`, `NOT_CONFLICTED`, `MISSING_OR_ERROR`, `CANCELLED`, `TARGET_IS_NEW`,
`BASE_IS_NEW`, `EVEN`, `LEAVE_TO_SUBSEQUENT`) are `Symbol`s from
`src/lib/src/common/models/shared.const.symbols.ts`, so the union is discriminated by identity.

`ConflictManager.tryAutoMerge` returns one of three shapes (`AutoMergeResult`,
defined in `ConflictManager.ts`):

```ts
{ ok: DIFF_CHECK_RESULT_AUTO }                          // terminal: nothing/auto-handled
{ result: string; conflictedRev: string }              // merged text ready to store
{ leftRev; rightRev; leftLeaf: leaf|false; rightLeaf: leaf|false }  // needs decision/UI
```

## Conflict detection flow (DEEP)

**Source of a conflict.** PouchDB stores every leaf; a conflicted doc has `_conflicts` (an array
of losing-leaf `_rev`s) when fetched with `{ conflicts: true }`. `_rev` is CouchDB's winning
(deterministic) leaf; `_conflicts` are the others. The subsystem always treats `_rev` as
`left` and `_conflicts[0]` as `right` — i.e. it resolves conflicts **one leaf at a time** and
re-queues.

**Entry points that enqueue a check:**

- Replication produces/updates docs → callers invoke `services.conflict.queueCheckFor(path)` or
  `queueCheckForIfOpen(path)`.
- `ModuleConflictChecker._queueConflictCheckIfOpen` honors `checkConflictOnlyOnOpen`: if the file
  isn't the active editor file, the check is postponed (logged, not queued).
- Startup scan: `ModuleInteractiveConflictResolver._allScanStat` (bound to
  `onScanningStartupIssues`) enumerates `findAllDocs({ conflicts: true })` and pops a persistent
  "conflicting-detected-on-safety" notice with a HERE link to resolve all.

**The two-stage queue** (`ModuleConflictChecker`):

1. `_queueConflictCheck(file)` first asks `services.conflict.getOptionalConflictCheckMethod(file)`:
   - returns `true` → already handled by another feature (Hidden File Sync re-queues internal
     metadata itself) → drop.
   - returns `"newer"` → route to `resolveByNewest(file)` (used for plugin/appearance metadata;
     see below) and skip the diff path.
   - otherwise → `conflictCheckQueue.enqueue(file)`.
2. `conflictCheckQueue` (concurrency 10, batch 1) is a pass-through that pipes each filename into
   `conflictResolveQueue`.
3. `conflictResolveQueue` (concurrency 10, batch 1) calls `services.conflict.resolve(filename)`.
   Its `replaceEnqueueProcessor` **cancels any in-flight resolution for the same file** by
   `sendValue("cancel-resolve-conflict:" + filename, true)` and de-duplicates the queue — so a
   newer replication event supersedes a stale pending resolution.

**`resolve` = `ModuleConflictResolver._resolveConflict`** (bound to `services.conflict.resolve`)
runs under `serialized("conflict-resolve:" + filename)` (per-file lock) and:

1. Calls `checkConflictAndPerformAutoMerge(filename)`.
2. On `MISSING_OR_ERROR | NOT_CONFLICTED | CANCELLED` → nothing to do.
3. On `AUTO_MERGED` → optionally replicate (`syncAfterMerge`), then **re-queue the same file**
   (a single auto-resolution collapses only one leaf; more may remain).
4. Otherwise a `diff_result` came back → if `showMergeDialogOnlyOnActive` and this isn't the
   active file, postpone; else emit `conflict-cancelled` and call
   `services.conflict.resolveByUserInteraction(filename, diff_result)`.

## Automatic merge: how it works & its limits (DEEP)

`ModuleConflictResolver.checkConflictAndPerformAutoMerge` → `localDatabase.tryAutoMerge(path,
!disableMarkdownAutoMerge)` → `ConflictManager.tryAutoMerge`.

### `ConflictManager.tryAutoMerge(path, enableMarkdownAutoMerge)`

1. Fetch the doc with `{ conflicts: true, revs_info: true }`. If missing → `{ ok: MISSING_OR_ERROR }`;
   if no `_conflicts` → `{ ok: NOT_CONFLICTED }`.
2. Sort `_conflicts` ascending by revision number; take `conflicts[0]`.
3. **Identical-leaf fast path:** load `leftLeaf`(=`_rev`) and `rightLeaf`(=`conflicts[0]`) via
   `getConflictedDoc`. If `leftLeaf.data == rightLeaf.data && leftLeaf.deleted == rightLeaf.deleted`,
   return `{ leftRev, rightRev, leftLeaf, rightLeaf }` (the resolver's "isSame" branch then just
   deletes one leaf — no new revision created).
4. If `(isSensibleMargeApplicable(path) || isObjectMargeApplicable(path)) && enableMarkdownAutoMerge`,
   attempt `tryAutoMergeSensibly`.
5. Else return `{ leftRev, rightRev, leftLeaf, rightLeaf }` (decision needed).

`isSensibleMargeApplicable` = path ends in `.md`. `isObjectMargeApplicable` = ends in `.canvas`
or `.json` (`utils.patch.ts`). **Note the `enableMarkdownAutoMerge` flag (from
`!settings.disableMarkdownAutoMerge`) gates BOTH sensible and object merge**, despite the name.

### `tryAutoMergeSensibly(path, test, conflicts)` — finding a base

The three-way merge needs a common ancestor. It reads `revs_info` and picks the
**highest-numbered available revision whose revision *number* is less than the conflicted leaf's
number** as `commonBase`:

```ts
const commonBase = revs_info.filter(e => e.status=="available"
                   && Number(e.rev.split("-")[0]) < conflictedRevNo)?.[0]?.rev ?? "";
```

If `commonBase` is empty (all history compacted, or the conflicted leaf's number is not greater),
**no auto-merge is attempted** and the file goes to the interactive path. This is a real
limitation on vaults with aggressive history/compaction. **UNVERIFIED nuance:** using revision
*number* comparison to select an ancestor is heuristic — it assumes lower rev-number = ancestor,
which is not guaranteed to be a true common ancestor of both leaves in all replication topologies.

### `mergeSensibly` (Markdown, line-level three-way)

For `.md`: diff base→left and base→right using diff-match-patch in **line mode**
(`diff_linesToChars_` / `diff_charsToLines_`), split each hunk into per-line `Diff` pieces
(`splitDiffPiece`), then walk both diff streams in lockstep merging line-by-line:

- both EQUAL & equal text → keep.
- both DELETE & equal → keep the delete (both sides removed the same line), *unless* the
  following lines are both INSERT-but-different → **bail** (`autoMerge=false`).
- both INSERT: identical → keep once; different → **keep both**, ordered by file mtime
  (older side's insert first).
- one-sided INSERT → emit it, rewind the other index.
- one side DELETE while other is EQUAL and the deleting side's *next* piece is INSERT
  (a replace) → keep the delete; otherwise **bail**.
- any structural mismatch → log `MERGING PANIC` / `Weird condition` and **bail**.

On success the merged `Diff[]` is returned; `tryAutoMergeSensibly` reconstructs text by dropping
`DIFF_DELETE` pieces and joining the rest. **"Simple conflict" ≈ non-overlapping edits**: two
sides that added/removed *different* lines around a shared base merge cleanly; two sides that
changed the *same* line differently bail to the UI.

**Hard limit:** `mergeSensibly` returns `false` immediately **if either leaf is `deleted`** — a
delete-vs-edit conflict is never auto-merged here (it drops to the mtime/"newer" branch in the
resolver, or to the UI).

### `mergeObject` (JSON/Canvas, key-level three-way)

For `.json`/`.canvas`: parse base/left/right, compute `generatePatchObj(base,left)` and
`generatePatchObj(base,right)` (a custom recursive diff supporting nested objects and
**id-keyed unordered arrays**, using sentinel markers `__DELETED/__ARRAY/__SWAP`). It
flattens both patch sets; if any key is changed by **both** sides to **different** values →
return `false` (conflict). Otherwise apply both patches to the base in **mtime order** and
return `JSON.stringify`. Also bails if either leaf is `deleted`.

### Applying an auto-merge (`ModuleConflictResolver.checkConflictAndPerformAutoMerge`)

- `{ ok }` → returned directly.
- `{ result, conflictedRev }` (merged text): `databaseFileAccess.storeContent(path, merged)`
  creates a **new merged revision**, then `resolveByDeletingRevision(path, conflictedRev,
  "Sensible")` deletes the losing leaf and writes back.
- `{ leftRev, rightRev, leftLeaf, rightLeaf }`:
  - `leftLeaf == false` → `MISSING_OR_ERROR`.
  - `rightLeaf == false` → delete `rightRev` ("MISSING OLD REV").
  - Compute `isSame` (data+deleted equal), `isBinary` (`!isPlainText(path)`),
    `alwaysNewer` (`settings.resolveConflictsByNewerFile`). **If any is true**, pick the loser by
    `compareMTime(leftLeaf.mtime, rightLeaf.mtime)`: if right is newer (`TARGET_IS_NEW`) delete
    left, otherwise delete right (so **ties/EVEN keep the local `_rev`/left**). `subTitle`
    records which trigger fired.
  - Otherwise build a semantic diff (`diff_main` + `diff_cleanupSemantic`) and return a
    `diff_result` → interactive UI.

**Notable:** `resolveConflictsByNewerFile` turns *every* text conflict into an mtime coin-flip
with no merge attempt — see safety caveats. `compareMTime` truncates both mtimes to a
`resolution` before comparing, so near-equal timestamps are treated `EVEN`.

### Delete-losing-revision + write-back (`_resolveConflictByDeletingRev`)

Bound to `services.conflict.resolveByDeletingRevision`:

1. `fileHandler.deleteRevisionFromDB(path, deleteRevision)` (→ `db.delete(info, rev)`) removes the
   losing leaf. On failure → `MISSING_OR_ERROR`.
2. Emit `conflict-cancelled` (closes any open modal for this file).
3. If `getConflictedRevs(path).length != 0` → **more conflicts remain** → return `AUTO_MERGED`
   (caller re-queues).
4. If plugin/customisation metadata → return `AUTO_MERGED` without touching storage.
5. Else `fileHandler.dbToStorage(path, stripAllPrefixes(path), true)` writes the surviving DB
   content to the vault file; on failure → `MISSING_OR_ERROR`.

## Interactive resolution UX & data flow (DEEP)

Driver: `ModuleInteractiveConflictResolver._anyResolveConflictByUI(filename, diff_result)`
(bound to `services.conflict.resolveByUserInteraction`), serialized under a **single global lock
`conflict-resolve-ui`** so only one merge dialog is active at a time.

1. Open `ConflictResolveModal(app, filename, diff_result)` and `await dialog.waitForResult()`.
2. `waitForResult` delays 100ms then awaits `globalSlipBoard.awaitNext("conflict-resolved",
   filename)` — the modal communicates its result through the `globalSlipBoard` (a
   message/"slip" board from `@lib/bureau`) keyed by filename, **not** a direct promise. On
   `onOpen` the modal first submits `CANCELLED` for the filename (clearing any stale slip), and
   registers an `eventHub` `conflict-cancelled` listener that force-cancels if the file changes
   underneath it.
3. The modal renders the diff (`result.diff`): `DIFF_DELETE`→`deleted` (local/left),
   `DIFF_INSERT`→`added` (remote/right), `DIFF_EQUAL`→`normal`. Diffs over **100 KiB** are
   truncated to "(Too large diff to display)". Prev/Next buttons navigate `.added/.deleted`
   fragments. Two version-info lines show each side's mtime and `(Deleted)` marker.
4. Buttons (default, non-plugin mode; `localName="Base"`, `remoteName="Conflicted"`):
   - **Use {localName}** → `sendResponse(result.right.rev)` — i.e. **delete the right leaf, keep
     left**.
   - **Use {remoteName}** → `sendResponse(result.left.rev)` — delete left, keep right.
   - **Concat both** → `sendResponse(LEAVE_TO_SUBSEQUENT)`.
   - **Not now / Cancel** → `sendResponse(CANCELLED)`.
   `sendResponse` stores `response` and closes; `onClose` submits `response` to the slip board.
5. Back in the driver, on `CANCELLED` → return false. Otherwise re-read the doc
   (`getDBEntry({conflicts:true})`); if no `_conflicts` remain → nothing to do.
   - `LEAVE_TO_SUBSEQUENT` (Concat): build `p = diff.map(e=>e[1]).join("")` (i.e. concatenate the
     full diff text — equal+deleted+inserted — producing a union document), `storeContent`, then
     `resolveByDeletingRevision(filename, testDoc._conflicts[0], "UI Concatenated")`.
   - a `string` rev → `resolveByDeletingRevision(filename, toDelete, "UI Selected")`.
6. If `syncAfterMerge` and not suspended → replicate. **Then `queueCheckFor(filename)` and return
   `false`** — always re-checks (a doc may have >2 leaves; one pass resolves one).

`allConflictCheck()` loops `pickFileForResolve()` (askSelectString over all conflicted docs,
sorted by mtime desc) until the user cancels; commands `livesync-conflictcheck` ("Pick a file to
resolve conflict") and `livesync-all-conflictcheck` ("Resolve all conflicted files") expose these.

**Plugin "pick a version" reuse:** `CmdConfigSync` constructs
`new ConflictResolveModal(app, path, diffResult, /*pluginPickMode*/ true, dataB.term)`. In this
mode the title becomes "Pick a version", labels are Local/Remote, "Concat both" is hidden, and
the result string `"A"`/`"B"` is interpreted by the caller rather than as a rev to delete.

## "Resolve by newer" and bulk modes (behavior + documented safety caveats)

Three distinct "newer wins" surfaces exist:

1. **Per-conflict `resolveConflictsByNewerFile` setting** — inside
   `checkConflictAndPerformAutoMerge`, sets `alwaysNewer`, forcing the mtime branch for *text*
   files too (no merge attempt). Loser leaf is deleted.

2. **`resolveByNewest(filename)` = `_anyResolveConflictByNewest`** (bound to
   `services.conflict.resolveByNewest`) — collects the current `_rev` plus every conflicted rev,
   builds `[mtime, rev]` pairs (a leaf that fails to load contributes `mtime = 0`), sorts by
   mtime desc with rev-string numeric tiebreak, keeps `[0]`, and **deletes every other revision**
   via `resolveByDeletingRevision(..., "NEWEST")`. Used by the `"newer"` optional-method path for
   plugin/customisation metadata (`CmdConfigSync._anyGetOptionalConflictCheckMethod` returns
   `"newer"` for `isPluginMetadata`/`isCustomisationSyncMetadata`).

3. **`resolveAllConflictedFilesByNewerOnes()`** — iterates **all storage file names**
   (`storageAccess.getFileNames()`) and calls `resolveByNewest` on each (progress logged every
   10th file). Vault-wide bulk operation.

**Documented / in-code safety caveats:**

- A leaf that **cannot be loaded** is assigned `mtime = 0` in `_anyResolveConflictByNewest`, so a
  transient read failure makes that leaf "oldest" and it will be **deleted** — content loss risk
  if the failure was transient.
- The "newer" strategies are **pure mtime comparisons with no merge and no content inspection** —
  concurrent edits on both devices lose the older side wholesale. `compareMTime` truncates to a
  resolution, so sub-resolution differences count as EVEN (per-conflict branch keeps local).
- mtimes come from device clocks; **clock skew between devices directly determines the winner.**
- **Delete-vs-edit:** in the mtime branch, if the *deleted* leaf has the newer mtime it wins and
  the edited content is discarded (deletion propagates); conversely a stale delete can be
  overridden by a newer edit. `mergeSensibly`/`mergeObject` deliberately refuse to auto-merge
  when either leaf is deleted, so these cases *only* resolve via mtime or the UI.

## Document history integration

`DocumentHistoryModal` (opened by `ModuleObsidianDocumentHistory`, and reachable with an
`initialRev`) is the auditing/recovery companion:

- `loadFile` reads `db.getRaw(id, { revs_info: true })`, filters to `status == "available"`
  leaves, and drives a range slider (index 0 = newest).
- `showExactRev(rev)` loads that revision (`getDBEntry(file, { rev })`); `readDocument` decodes
  text vs binary vs image. When **Highlight diff** is on, it diffs the selected rev against the
  **previous (older) available rev** with `diff_match_patch` + `diff_cleanupSemantic` and renders
  `history-added/history-deleted/history-normal` spans; **Diff only** collapses equal runs to
  `...`. Images get an overlay diff (`appendImageDiff`, `generateBlobURL`). Deleted revisions show
  "(At this revision, the file has been deleted)".
- **Search** (`performSearch`) scans the **last 100 revisions**, matching either full content or
  insert/delete diff hunks (`matchType: "Content" | "Diff"`), with prev/next navigation and a
  500ms debounce.
- **"Back to this revision"** writes the currently displayed revision's content back to the vault
  via `core.storageAccess.writeHiddenFileAuto(pathToWrite, readContent(currentDoc))` — a manual
  recovery path independent of the conflict pipeline. **Blob URLs are tracked and revoked** on
  close.

The connection to conflict resolution is *evidentiary rather than mechanical*: history lets a
user inspect leaves/revisions and manually restore content the automatic or "newer" resolver may
have discarded. It does not itself delete or merge leaves.

## Boundary to commonlib diff/merge (functions called)

The `src/modules` / `src/features` layer never runs the merge algorithms directly; it crosses
into commonlib at these points:

| Caller (module layer) | commonlib target | Purpose |
|---|---|---|
| `ModuleConflictResolver.checkConflictAndPerformAutoMerge` | `LiveSyncLocalDB.tryAutoMerge` → `ConflictManager.tryAutoMerge` | full auto-merge attempt |
| `ModuleConflictResolver` (diff for UI) | `diff-match-patch` `diff_main` + `diff_cleanupSemantic` | build `diff_result.diff` |
| `ConflictManager.tryAutoMergeSensibly` | `mergeSensibly` / `mergeObject`, `isSensibleMargeApplicable`, `isObjectMargeApplicable` | pick + run merge |
| `ConflictManager.mergeSensibly` | dmp `diff_linesToChars_`, `diff_main`, `diff_charsToLines_` | line-level three-way |
| `ConflictManager.mergeObject` | `generatePatchObj`, `flattenObject`, `applyPatch`, `tryParseJSON` (`utils.patch.ts`) | object three-way |
| `JsonResolvePane.svelte` | `mergeObject`, `isObjectDifferent`, `getDocData` + dmp | interactive JSON A/B/A+B/B+A merge preview |
| `DocumentHistoryModal` | `diff_match_patch`, `decodeBinary`/`readString` | history diff rendering |

`ConflictManager` is instantiated once in `LiveSyncManagers.ts` (`new ConflictManager({
entryManager, pathService, database })`) and exposed via `LiveSyncLocalDB.tryAutoMerge`. Note
`mergeObject` exists in **two** forms: the *three-way* `ConflictManager.mergeObject` (base/left/
right, conflict-detecting) and the *two-way* `utils.patch.mergeObject` (deep union, used by the
Svelte pane and for A+B/B+A previews) — they are different algorithms with the same name.

## Function/class inventory (per file: signature + purpose)

### `src/modules/coreFeatures/ModuleConflictResolver.ts` — `class ModuleConflictResolver`
- `_resolveConflictByDeletingRev(path, deleteRevision, subTitle="") : MISSING_OR_ERROR|AUTO_MERGED` — deletes a losing leaf, re-checks for remaining conflicts, writes surviving content back to storage (skips plugin metadata). Bound to `resolveByDeletingRevision`.
- `checkConflictAndPerformAutoMerge(path) : diff_check_result` — the auto-merge decision engine (identical / merged-text / isSame|binary|newer / diff-for-UI). *Non-trivial*: see Automatic-merge section.
- `_resolveConflict(filename) : void` — per-file-serialized loop: auto-merge → re-queue / postpone / hand to UI. Bound to `resolve`.
- `_anyResolveConflictByNewest(filename) : boolean` — keep newest-mtime leaf, delete all others. Bound to `resolveByNewest`. *Non-trivial*: unloadable leaf → mtime 0.
- `_resolveAllConflictedFilesByNewerOnes()` — vault-wide `resolveByNewest`. Bound to `resolveAllConflictedFilesByNewerOnes`.
- `onBindFunction` — wires the four handlers onto `services.conflict`.

### `src/modules/coreFeatures/ModuleConflictChecker.ts` — `class ModuleConflictChecker`
- `_queueConflictCheckIfOpen(file)` — postpone if `checkConflictOnlyOnOpen` and not active file. Bound to `queueCheckForIfOpen`.
- `_queueConflictCheck(file)` — dispatch on `getOptionalConflictCheckMethod` (`true`/`"newer"`/enqueue). Bound to `queueCheckFor`.
- `_waitForAllConflictProcessed()` — awaits `conflictResolveQueue`. Bound to `ensureAllProcessed`.
- `conflictResolveQueue` / `conflictCheckQueue` — the `QueueProcessor` pair; `replaceEnqueueProcessor` cancels stale in-flight resolutions and de-dupes.

### `src/modules/features/ModuleInteractiveConflictResolver.ts` — `class ModuleInteractiveConflictResolver`
- `_everyOnloadStart()` — registers the two conflict commands.
- `_anyResolveConflictByUI(filename, diff_result) : boolean` — global-serialized modal flow; applies Concat / Select / Cancel. Bound to `resolveByUserInteraction`. *Non-trivial*: slip-board result, always re-queues.
- `allConflictCheck()` / `pickFileForResolve()` — interactive picker over conflicted docs.
- `_allScanStat()` — startup scan + persistent notice. Bound to `onScanningStartupIssues`.

### `src/modules/features/InteractiveConflictResolving/ConflictResolveModal.ts` — `class ConflictResolveModal extends Modal`
- `constructor(app, filename, diff, pluginPickMode?, remoteName?)` — dual-purpose (conflict vs plugin-pick).
- `appendDiffFragment` / `appendVersionInfo` / `navigateDiff` / `resetDiffNavigation` — render helpers.
- `onOpen` — builds diff view (100 KiB cap), version rows, action buttons; registers `conflict-cancelled` handler; submits stale `CANCELLED` slip.
- `sendResponse(result)` / `onClose` — set `response`, close, submit result to `globalSlipBoard`.
- `waitForResult() : MergeDialogResult` — awaits the slip. *Non-trivial*: 100ms delay before await.

### `src/modules/features/DocumentHistory/DocumentHistoryModal.ts` — `class DocumentHistoryModal extends Modal`
- module fns `isImage`, `isComparableText`, `isComparableTextDecode`, `readDocument` — content-type decoding.
- `loadFile` / `loadRevs` / `showExactRev(rev)` — revision loading + rendering (diff vs previous rev, image overlay, deleted notice).
- `appendTextDiff` / `appendSearchHighlightedText` / `appendImageDiff` / `appendDeletedNotice` — renderers.
- `navigateDiff` / `resetDiffNavigation` / `updateDiffNavVisibility` — diff nav.
- `performSearch(keyword)` / `updateSearchUI` / `navigateSearch` — last-100-rev search (content + diff).
- `generateBlobURL` / `revokeURL` — image blob lifecycle.
- `onOpen` — builds full UI (slider, search row, diff options, buttons: Copy, Back-to-this-revision). `onClose` revokes blob URLs.

### `src/features/HiddenFileCommon/JsonResolveModal.ts` — `class JsonResolveModal extends Modal`
- `constructor(app, filename, docs, callback, nameA?, nameB?, defaultSelect?, keepOrder?, hideLocal?, title?)` — mounts the Svelte pane; auto-closes on `cancel-internal-conflict:<filename>` signal.
- `UICallback` / `onOpen` / `onClose` — mount/unmount `JsonResolvePane`; `onClose` invokes callback with `undefined` if not yet consumed.

### `src/features/HiddenFileCommon/JsonResolvePane.svelte`
- Svelte 5 runes component. Chooses A/B by `keepOrder` or mtime; computes `objAB = mergeObject(A,B)`, `objBA = mergeObject(B,A)` (two-way deep union, `utils.patch.mergeObject`); `objBA` shown only if different. `apply()` returns either a `keepRev` (same `_id`) or a merged string; `getJsonDiff` previews the selection vs A.

### `src/lib/src/managers/ConflictManager.ts` — `class ConflictManager`
- `getConflictedDoc(path, rev) : false|diff_result_leaf` — materialize one leaf (decode by datatype).
- `mergeSensibly(path, base, current, conflicted) : Diff[]|false` — line-level three-way; `false` if any leaf missing/deleted or unmergeable. *Non-trivial* (see above).
- `mergeObject(path, base, current, conflicted) : string|false` — object three-way; `false` on same-key divergent change or deleted leaf.
- `tryAutoMergeSensibly(path, test, conflicts)` — select common base by rev-number, dispatch sensible/object merge.
- `tryAutoMerge(path, enableMarkdownAutoMerge) : AutoMergeResult` — top-level entry (identical fast-path, gate, dispatch).

### `src/lib/src/common/utils.patch.ts`
- `generatePatchObj(from,to)` — recursive object diff with `__DELETED/__ARRAY/__SWAP` markers and id-keyed unordered-array handling.
- `applyPatch(from,patch)` — apply such a patch.
- `mergeObject(objA,objB)` — two-way deep union (arrays deduped via `Set`, keys sorted).
- `flattenObject(obj)` — dotted-key flatten (for conflict detection).
- `isSensibleMargeApplicable(path)` (`.md`) / `isObjectMargeApplicable(path)` (`.canvas`/`.json`).

### `src/lib/src/services/base/ConflictService.ts` — `abstract class ConflictService`
- Declares the service surface: `getOptionalConflictCheckMethod` (firstResult), `queueCheckForIfOpen`, `queueCheckFor`, `ensureAllProcessed`, `resolveByUserInteraction`, `resolveByDeletingRevision`, `resolve`, `resolveByNewest`, `resolveAllConflictedFilesByNewerOnes`, and `conflictProcessQueueCount` (reactive).

## Dependencies / Consumed by

**Depends on:**
- commonlib: `ConflictManager`, `utils.patch.ts`, `diff.definition.ts`, `diff-match-patch`,
  `octagonal-wheels` (locks `serialized`/`scheduleOnceIfDuplicated`, `QueueProcessor`,
  `reactiveSource`, `sendValue`/`waitForSignal`, binary decode).
- Services: `databaseFileAccess` (`storeContent`, `getConflictedRevs`, `fetchEntryMeta`),
  `fileHandler` (`deleteRevisionFromDB`, `dbToStorage`), `replication` (`replicateByEvent`),
  `vault`/`appLifecycle`/`confirm`, `path` (`id2path`/`path2id`).
- `eventHub` (`conflict-cancelled`), `globalSlipBoard` (`conflict-resolved`), Obsidian `Modal`,
  Svelte (`mount`/`unmount`).

**Consumed by:**
- Replication / storage-to-DB pipelines that enqueue `queueCheckFor` after applying incoming docs.
- `CmdConfigSync` and `CmdHiddenFileSync` — use `JsonResolveModal`, the `pluginPickMode`
  `ConflictResolveModal`, and register `getOptionalConflictCheckMethod` returning `"newer"`.
- `ModuleObsidianDocumentHistory` — opens `DocumentHistoryModal`.
- CLI: `src/apps/cli/commands/runCommand.ts` uses `getConflictedRevs`.

## Design observations (factual; correctness/safety risks for critique; no fixes)

1. **Delete-file resurrection surface.** `mergeSensibly`/`mergeObject` refuse when a leaf is
   `deleted`, so delete-vs-edit falls through to the mtime branch or UI. In the mtime branch and
   in `_anyResolveConflictByNewest`, the surviving leaf may be a *deletion*; whether
   `dbToStorage` then actually removes the vault file (vs leaving stale content, i.e.
   resurrection) is decided in `ServiceFileHandlerBase.dbToStorage`'s delete branch, **not read
   in this scope — UNVERIFIED**. This is the classic risk area and warrants direct verification.

2. **Unloadable leaf treated as oldest (`mtime = 0`).** In `_anyResolveConflictByNewest`, a leaf
   whose `fetchEntryMeta` fails is scored `mtime = 0` and therefore deleted. A transient DB read
   error can silently destroy a valid revision.

3. **"Newer wins" is clock-dependent and content-blind.** `resolveConflictsByNewerFile`,
   `resolveByNewest`, and `resolveAllConflictedFilesByNewerOnes` discard the losing side with no
   merge and no content check; correctness depends on cross-device clock accuracy and
   `compareMTime`'s truncation resolution. Bulk mode applies this to the *entire* vault.

4. **Common-base selection is heuristic.** `tryAutoMergeSensibly` picks the highest available
   rev *number* below the conflicted leaf's number as the ancestor. This is not guaranteed to be
   a true common ancestor; after history compaction `commonBase` may be empty (no auto-merge) or
   a poor base (potentially producing a merge that isn't a genuine three-way result).

5. **`enableMarkdownAutoMerge` gates object merge too.** The flag derived from
   `disableMarkdownAutoMerge` also disables `.json`/`.canvas` object merge — a naming/scope
   mismatch that may surprise users who disable only "markdown" auto-merge.

6. **Concat ("Leave to subsequent") builds a union document.** `p = diff.map(e=>e[1]).join("")`
   concatenates equal+deleted+inserted text, so the result contains both sides' text (including
   text that one side deleted). It's a lossless-but-noisy union, not a semantic merge.

7. **Loose left/right ↔ Local/Base labeling.** The interactive modal defaults its two sides to
   `localName = "Base"` / `remoteName = "Conflicted"` while buttons read "Use Base"/"Use
   Conflicted"; the mapping to which `_rev` is deleted is correct but the "Base" wording for the
   local current leaf is potentially confusing for users reasoning about which content survives.

8. **Two different `mergeObject` implementations** (three-way conflict-detecting in
   `ConflictManager`; two-way deep-union in `utils.patch`) share a name — a maintenance/analysis
   hazard, and the Svelte pane's A+B/B+A previews use the *union* semantics, which can differ
   from what the automatic object merge would produce.

9. **Comment-level uncertainty in the codebase itself.** `ServiceFileHandlerBase.deleteFromDB`
   carries an all-caps developer comment ("I BELIEVED SO. BUT I NOTICED THAT I AM NOT SURE …")
   about which rev is deleted when conflicted — an author-acknowledged unverified invariant on
   the deletion path this subsystem relies on.

10. **Diff display cap (100 KiB) is UI-only.** Large conflicts show "(Too large diff to
    display)" but the underlying resolution (pick a side / concat) still runs on full content, so
    users may act on a conflict they cannot see.

## Verified addendum — deletion / resurrection path (2026-07-02)

Traced end-to-end to settle the deleted-file-resurrection question (previously flagged unverified in
the storage/overview sections). Findings, from `ModuleConflictResolver.checkConflictAndPerformAutoMerge`
(`src/modules/coreFeatures/ModuleConflictResolver.ts:66-127`) and `ServiceFileHandlerBase.dbToStorage`
(`src/lib/src/serviceModules/ServiceFileHandlerBase.ts:270-398`):

- **`dbToStorage` is correct and not the culprit.** It treats `docEntry._deleted || docEntry.deleted`
  as "not on DB" (line 308) and deletes the vault file when the DB side is deleted (lines 314-327), and
  it **defers** (`queueCheckForIfOpen` + early return) whenever unresolved conflicts exist and
  `writeDocumentsIfConflicted` is off (lines 285-297). It faithfully applies whichever leaf the
  resolver selects.
- **Default settings, plain-text, delete-vs-edit → manual merge dialog.** `tryAutoMerge` refuses when
  either leaf is `deleted` (the v0.25.74 / #911 fix). Control reaches the diff branch (lines 117-126):
  `isSame` is false (data differs and `deleted` flags differ), `isBinary` false, `alwaysNewer` false →
  returns a `diff_result` → user resolves. **Contained** (no silent resurrection).
- **Binary files → always mtime.** `isBinary` forces the mtime path (lines 99-116) with no dialog;
  a delete-vs-edit binary conflict is a clock-based coin-flip → **silent resurrection possible**.
- **`resolveConflictsByNewerFile` (BETA "testing only") and bulk `resolveByNewest` /
  `resolveAllConflictedFilesByNewerOnes` → mtime, content-blind** (lines 100-116, 168-226) → **silent
  resurrection possible**; these are the documented "can overwrite modified files. Be Warned" modes.
- **Opposite-direction data loss:** an unloadable conflicted leaf (`rightLeaf == false`) is deleted
  outright as `"MISSING OLD REV"` (lines 93-96); a leaf that fails to load scores `mtime=0` and loses.
- The mtime comparison uses a 2-second resolution (`compareMTime`), so near-simultaneous edits tiebreak
  by rev-id string ordering, not true recency.

**Net:** the headline "deleted files reappear" class is *contained for default text edits* (routed to
manual resolution) but *remains real* for binary files and the opt-in newer-wins modes. Observation #9
above (the "I AM NOT SURE" comment) concerns `deleteFromDB` rev-selection, which is upstream of this and
was not separately re-verified.

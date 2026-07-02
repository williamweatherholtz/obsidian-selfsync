# Obsidian LiveSync — As-Built System Architecture (Overview)

> **Status:** Reverse-engineered from source at submodule commit `87dc724` (livesync-commonlib) on 2026-07-02, plugin `main`. This is a *descriptive* as-built model produced to serve as the **baseline for critique** — it records what the code *is*, not what it should be. Design observations are factual; they name risks and smells but propose no fixes (that is the next phase).
>
> **Scope:** ~81,500 LOC across two codebases — the Obsidian plugin (`src/`, ~37.2K LOC, 219 files) and the `livesync-commonlib` submodule (`src/lib/src/`, ~44.3K LOC, 248 files). Coverage is complete at the subsystem/module level with function-level depth on the load-bearing paths.
>
> **⚠️ Path note (2026-07-02):** the analyzed fork has since been **archived under `obsolete/`** for the fresh rebuild. All `src/…` and `src/lib/…` references in this document set are now under **`obsolete/src/…`** and **`obsolete/src/lib/…`**. The analysis itself is unchanged.

## How to read this document set

Start here for the big picture, then drill into any subsystem file. Depth is weighted toward the load-bearing paths.

| # | Subsystem | Codebase | File |
|---|-----------|----------|------|
| — | **Overview (this file)** | both | `00-overview.md` |
| 10 | Bootstrap, module/DI system & core types | plugin | `10-bootstrap-di-types.md` |
| 11 | Obsidian sync core & managers (glue) | plugin | `11-sync-core-obsidian.md` |
| 12 | Conflict detection, resolution & doc history | plugin+lib | `12-conflict-resolution.md` |
| 13 | Feature commands (Config/Hidden-file sync, DB maint) | plugin | `13-feature-commands.md` |
| 14 | Peer-to-peer (WebRTC) sync | plugin+lib | `14-p2p-sync.md` |
| 15 | Settings / configuration UI | plugin | `15-settings-ui.md` |
| 16 | Obsidian services, essential & extra modules | plugin | `16-obsidian-services-essential.md` |
| 17 | Alternate apps (CLI, web app, web peer) | plugin | `17-alternate-apps.md` |
| 20 | Replication engine (CouchDB / Journal / P2P) | lib | `20-commonlib-replication.md` |
| 21 | RPC / transport (P2P) | lib | `21-commonlib-rpc-transport.md` |
| 22 | Content pipeline (chunking, binary, encryption) | lib | `22-commonlib-content-pipeline.md` |
| 23 | Storage / database layer & public API | lib | `23-commonlib-storage-pouchdb.md` |
| 24 | Common utilities (types, settings, i18n) | lib | `24-commonlib-common-utils.md` |
| 25 | Services & managers | lib | `25-commonlib-services-managers.md` |
| 26 | Coordination & platform infra (events, worker) | lib | `26-commonlib-coordination-infra.md` |

## 1. What LiveSync is

Obsidian LiveSync keeps a Markdown vault replicated across devices. Its design center is **a local PouchDB database on every device that replicates to a remote** — CouchDB (the reference/recommended backend), object storage (S3/MinIO/R2 via an append-only "journal"), or **directly between peers over WebRTC** (P2P, experimental, no server). Notes are stored **chunked and content-addressed** so unchanged content is deduplicated and only changed chunks move; content is optionally **end-to-end encrypted** before it leaves the device.

The same core runs in four hosts (see §17), which is the strongest evidence of a real portability seam:
- the **Obsidian plugin** (primary),
- a **Node CLI** (28 commands: daemon/sync/mirror, conflict resolve, remote-config CRUD, P2P),
- a **browser web app** (File System Access API / OPFS), and
- a **web peer** (P2P-only Svelte app).

## 2. Architectural style

- **No DI container.** The system is assembled by a hand-wired **composition root** in `src/main.ts`: it builds a `ServiceHub` (service locator), then constructs `LiveSyncBaseCore(serviceHub, moduleInit, modules, addOns, features)` with five ordered initialiser callbacks (build service-modules → register core+extra modules → run `useXxx(core)` feature functions → register add-ons → `bindModuleFunctions()`). (§10)
- **Dual — actually four — extension idioms coexist**, reflecting an in-progress *monolith → services* migration that in-source comments confirm:
  1. legacy class **modules** (`AbstractModule.onBindFunction`),
  2. **services** (DI-resolved via `ServiceHub`),
  3. **service modules** (per-platform I/O primitives), and
  4. **service features** (`useXxx(host)` middleware).
  Behaviour is attached through **late-bound named handlers** (`handlers<T>().binder/all/anySuccess/firstResult`), a middleware/event-bus layered over the locator. (§10, §16, §25)
- **Event-driven glue.** A global **EventHub** (pub/sub, ~68 consumers) carries `EVENT_*` topics; a **SlipBoard** provides keyed request/reply rendezvous (used for the conflict-resolution modal handoff). (§26)
- **Platform variance is confined to two seams**: the `ServiceHub` subclass and the `initialiseServiceModules*` set (`Storage/Vault/Path/TypeGuard/Conversion` adapters). Core logic is shared verbatim across hosts. (§16, §17)
- **Concurrency** leans on the external `octagonal-wheels` library plus a process-global `Semaphore(50)` (`globalConcurrencyController`) that paces replication. (§24, §20)

## 3. Core data model (§23)

- Documents are an `EntryDoc` union. A note's metadata doc (`newnote`/`plain`) holds an **ordered `children: string[]` of content-addressed chunk IDs** (`h:`+hash); each chunk is a separate `leaf` doc. Small/hot content may be inlined in an **`eden`** map on the metadata doc. Legacy `notes` store data inline.
- Revisions use PouchDB's rev tree: `deterministic_revs:true`, `revs_limit:100`, `auto_compaction:false`.
- **Deletes are soft by default**: `newnote`/`plain` deletions set `deleted:true` + bump `mtime` while the doc and its chunk refs stay live (only legacy notes, explicit rev-deletes, or `deleteMetadataOfDeletedFiles` create hard PouchDB `_deleted` tombstones). **This is the direct deleted-file-resurrection surface** — see §6.
- Bookkeeping docs: milestone, versioninfo, syncinfo, nodeinfo.

## 4. Content pipeline (§22)

- **Chunking** is a façade (`ContentSplitter`) selecting a strategy by `chunkSplitterVersion` (default **V3 = Rabin-Karp content-defined chunking**: a 48-byte rolling hash declares a boundary when `hash % avgChunkSize === 1` past `minChunkSize`, forced at `maxChunkSize`; UTF-8-safe cuts). V1/V2 do line/delimiter/fixed splitting; V2.5 uses `Intl.Segmenter`. Text ≥4 MB is demoted to binary.
- Pieces are hashed (`prepareChunk` → `h:`+hash), so **identical plaintext collapses to one chunk** — dedup is content-addressed. Chunk hashing is **non-cryptographic xxHash** with the passphrase folded in.
- **Encryption** (optional E2EE) is a `transform-pouch` incoming/outgoing pair: default **V2 = AES-256-GCM + HKDF** encrypting the whole metadata JSON (path/mtime/ctime/size/children) and zeroing visible fields; legacy V1 = PBKDF2 and only obfuscates the filename. Document-ID paths are one-way SHA-256 obfuscated.
- **Chunk splitting + encryption/HKDF are offloaded to a web-worker pool** (round-robin; seq-numbered streaming reassembly), gated by `disableWorkerForGeneratingChunks` / `processSmallFilesInUIThread`. In the CLI, a build-time mock runs it in-thread. (§26)

## 5. Cross-cutting flows

### 5a. Local edit → remote (§11, §22, §23, §25, §20)
1. Obsidian `vault.on(...)` fires → `ObsidianStorageEventManagerAdapter` converts `TFile`→`UXFileInfo`.
2. `StorageEventManagerBase` (689 LOC; the batching/debounce heart) queues and coalesces events into a **crash-recoverable** sync queue.
3. `fileProcessing.processFileEvent` reads content → content pipeline **splits → hashes → (encrypts)** → new/changed `leaf` chunks + updated metadata doc written to local PouchDB via `EntryManager`/`LayeredChunkManager` (Cache→DB write pipeline).
4. `EVENT_FILE_SAVED` schedules `replicateByEvent()`; the active `LiveSyncAbstractReplicator` backend pushes changed docs/chunks to the remote (paced by the global semaphore).

### 5b. Remote → local apply (§20, §11, §12)
1. Replicator streams remote changes; `parseSynchroniseResult(docs)` is the apply boundary. Content chunks may be **excluded from the stream and fetched on demand** (`readChunksOnline` → `fetchRemoteChunks`) or bulk pre-sent (`sendChunks` + `_local/max_seq_on_chunk` checkpoint).
2. `ModuleReplicator._parseReplicationResult` → `ReplicateResultProcessor` queues/de-dupes by `_id`/`_rev`, gathers chunk content, and applies to the vault via `processSynchroniseResult` in a **3-phase, per-id-serialized, semaphore-bounded** pipeline with kvDB crash-recovery snapshots. Re-apply on restart is **at-least-once** (safety hinges on the rev/conflict guard).

### 5c. Conflict detection & resolution (§12, §23)
1. PouchDB never rejects writes, so concurrent edits leave a doc with **multiple leaves** (`_conflicts`).
2. A two-stage `QueueProcessor` (check→resolve, stale-cancelling) calls `ConflictManager.tryAutoMerge`: identical leaves collapse for free; otherwise a **three-way merge** against a rev-number-selected common base — line-level `mergeSensibly` for `.md`, key-level `mergeObject` for `.json`/`.canvas`.
3. Success stores a merged rev and deletes the loser. Failure → interactive modal (Use A / Use B / Concat / Not now), handed off via the SlipBoard.
4. **Auto-merge is deliberately conservative**: it bails on any same-line/same-key divergence, and **refuses entirely if either leaf is deleted** — delete-vs-edit falls through to an mtime-based "newer wins."

### 5d. Backend abstraction (§20)
One abstract `LiveSyncAbstractReplicator` contract, selected at runtime by `settings.remoteType`:
- **CouchDB** (reference): drives PouchDB `sync` (one-shot pull/push or `{live,retry,heartbeat}`); a `processSync` state machine adapts PouchDB events, returning DONE / NEED_RETRY (**halve batch sizes**) / NEED_RESURRECT (restore) / FAILED / CANCELLED.
- **Journal** (S3/MinIO/R2): append-only compressed doc-pack journals with a `CheckPointInfo` (epoch/wipe detection) behind a swappable `IJournalStorage`.
- **P2P** (Trystero/Nostr/WebRTC): proxies a remote PouchDB over the RPC layer (§21) and runs shim replication; most remote-management methods are stubs (`isChunkSendingSupported=false`).

## 6. Consolidated design observations & risk index (critique seed)

Factual, cross-referenced. Grouped by theme. Items marked *(unverified)* were flagged by a section agent as not fully traced.

### Performance
- **Chunk-store invalidation on parameter change**: changing splitter version, hash, or passphrase invalidates the entire chunk store → **full resync**. Content-defined chunking (V3) exists to reduce the day-to-day "chunk recycling" cost. (§22)
- **All-or-nothing chunk-fetch batches** and a **contiguous-prefix chunk checkpoint that pins resume on gaps**, plus unbounded `seqStatusMap` growth — bears directly on the field reports of slow/stalled large-file sync and restart-on-interruption. (§20)
- **Whole-file `arrayBuffer()` buffering** on binary / Rabin-Karp paths. (§22)
- **Unbounded fire-and-forget queue drain** in the Obsidian apply path; subtle acquire-then-release semaphore pacing. (§11)

### Correctness / data safety
- **Deleted-file resurrection — partially contained (verified 2026-07-02).** Soft-delete tombstones are ordinary editable revisions, so *conflict resolution* decides whether a delete survives. `ServiceFileHandlerBase.dbToStorage` itself is correct — it honors `deleted`/`_deleted` (deletes the vault file, line 314–327) and **defers whenever unresolved conflicts exist** (`queueCheckForIfOpen`, line 285–297) — so it faithfully applies whatever leaf conflict-resolution selects; it is **not** the culprit. The determinant is `ModuleConflictResolver.checkConflictAndPerformAutoMerge`: **(a)** default settings + plain-text delete-vs-edit → routed to the **manual merge dialog** (the v0.25.74 #911 fix: `tryAutoMerge` now *refuses* when either leaf is deleted, instead of silently reappearing) — **contained**; **(b)** **binary files** → *always* resolved by **mtime** with no dialog → silent resurrection possible — **real**; **(c)** **`resolveConflictsByNewerFile`** or the **bulk "resolve all by newer"** modes → mtime, content-blind → silent resurrection possible — **real (opt-in)**; **(d)** the mtime tiebreak is clock-dependent (2-second resolution). Net: real for binaries and the opt-in newer-wins modes; contained (manual) for default text edits. Related opposite-direction risk: an **unloadable conflicted leaf is deleted outright** (`"MISSING OLD REV"`, line 93–96) — transient-error data loss. (§12, §23)
- **Chunk GC hazard**: the `_design/chunks` view counts only winning-revision `children`, risking over-aggressive purge of chunks referenced by unresolved conflicts (partly compensated by a conservative `allChunks`). (§23)
- **Transient-error data loss**: an unloadable leaf is scored `mtime=0` and can be deleted. (§12)
- **Hidden File sync fragility**: change detection is mtime+size fingerprint based (unreliable on Android / cloud folders / some editors); offline reconcile skips DB deletions; non-JSON conflicts resolve silent newer-wins. Matches the field reports of unreliable hidden-file sync. (§13)
- `ConflictManager` branch marked `//TODO: SHOULD BE PANIC`; half-built chunk machinery (`HotPackLayer` pass-through, empty `__stabilise`). (§25)

### Security (defer to a dedicated security review)
- **No real key stretching**: `hashString`'s stretch loop re-hashes the original buffer, not the prior digest. (§22)
- **Non-cryptographic chunk IDs** (32-bit xxHash legacy → collision risk) with passphrase folded in by concat/XOR. (§22)
- **V1 encryption leaks metadata** (mtime/size/children); only filename is obfuscated. (§22)
- **P2P**: passphrase → base-36 password with a **zeroed PBKDF2 salt**; **name-based peer acceptance**; third-party Nostr relay dependency. (§14, §20)
- CouchDB JWT hardcodes `_admin`. (§20)

### Architectural complexity / maintainability
- **Four coexisting extension mechanisms** + hand-wired, order-sensitive composition root (`// TODO reorder` across 3 hubs); behaviour is indirect (locator + handler bus). (§10, §16, §25)
- **God-barrel `types.ts`** funnels 195 importers to the whole model; `ObsidianLiveSyncSettings` composed from ~35 mixin interfaces; **triple parallel setting-metadata tables kept in manual sync**. (§24, §15)
- Module-global mutable singletons/caches in several packages. (§24, §25, §26)
- Complexity concentrates in `StorageEventManagerBase` (689 LOC) and `ConflictManager`. (§25, §12)

### Dead / half-migrated code (legibility)
- Most DB-maintenance ops (performGC, commit*, mark/removeUnused, resurrect) are call-site-commented-out; only `gcv3`/`analyseDatabase` are live. (§13)
- Settings UI: three `if(false)` remote panels, ~150 commented GC lines, an unwired 277-LOC `checkConfig`, `TODO: Refactor to new API style`, heavy `@ts-ignore`. (§15)
- `redFlag` spec is large but the live-vs-dead status of parts of the CouchDB `checkConfig` flow is *(unverified)*. (§15, §16)

### Configuration UX (feeds the deferred goal #1)
- Confusing/inverted/jargon setting names confirmed in code: `doNotUseFixedRevisionForChunks`, `disableWorkerForGeneratingChunks`, `hashCacheMaxAmount` ("Mega chars"), `watchInternalFileChanges` (UI rendered *inverted* from stored value), `useIndexedDBAdapter` (both states are IndexedDB), a pane titled "Selector" that configures file filters. ~120+ keys across 12 panes. (§15)

## 7. Known coverage gaps
- Concrete per-platform service bodies (Browser/Headless/Injectable) and large `SettingService`/`HandlerUtils` internals inventoried by signature, not line-by-line. (§25)
- AES/HKDF/PBKDF2 internals live in the un-vendored `octagonal-wheels` dependency — documented from the call surface only. (§22, §24)
- Deep internals of the two largest P2P files and `ReplicatorShim.ts` referenced, not line-verified. (§20, §14)
- Test suites catalogued but not analysed.

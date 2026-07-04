# Commonlib: Content Pipeline (Chunking, Binary, Encryption)

> AS-BUILT reverse-engineering of `livesync-commonlib` (the core of Obsidian Self-hosted
> LiveSync). Scope: `src/lib/src/ContentSplitter/`, `src/lib/src/string_and_binary/`,
> `src/lib/src/encryption/`. Read-only analysis; symbol names and paths verified against source.
> Where behaviour depends on the external `octagonal-wheels` package (the actual crypto/binary
> primitives), that is called out explicitly — that source is **not vendored in this repo**, so
> those internals are documented from call-sites and cannot be confirmed line-by-line here.

---

## Purpose & responsibilities

This subsystem turns a document (a `Blob` or string) into the on-disk/on-wire representation that
LiveSync replicates, and reverses that on read. Three concerns:

1. **Chunking / content splitting** (`ContentSplitter/`, `string_and_binary/chunks.ts`) — split a
   document into variable-size *pieces* so that (a) each piece fits within CouchDB/HTTP request
   limits and (b) unchanged regions produce identical pieces across edits, enabling
   content-addressed **deduplication** and minimal replication traffic.
2. **String & binary encoding** (`string_and_binary/convert.ts`, `hash.ts`, `path.ts`) — convert
   between `Uint8Array`/`ArrayBuffer`, UTF strings, base64 and hex; compute the content hashes that
   become chunk IDs; and map file paths to document IDs (including obfuscation).
3. **Encryption** (`encryption/`, and the consuming transform layer `pouchdb/encryption.ts`) —
   end-to-end encrypt chunk data, sync metadata, the "Eden" inline cache, and file paths using a
   passphrase.

The three splitter/hash/encrypt stages are decoupled: **the splitter emits plaintext pieces →
the hash manager derives a content-addressed chunk ID from the plaintext → encryption is applied
last** (as a PouchDB transform on write). This ordering is what preserves dedup under encryption:
the ID is computed on plaintext, so the same plaintext always maps to the same chunk ID regardless
of ciphertext variation.

---

## Files & LOC (table)

| File | LOC | Role |
|------|----:|------|
| `ContentSplitter/ContentSplitter.ts` | 31 | `SplitOptions`/`ContentSplitterOptions` types; `MAX_CHUNKS_SIZE_ON_UI` constant |
| `ContentSplitter/ContentSplitterBase.ts` | 111 | Abstract `ContentSplitterCore`/`ContentSplitterBase`; `getParamsFor` (settings → `SplitOptions`) |
| `ContentSplitter/ContentSplitters.ts` | 36 | `ContentSplitter` façade; selects active splitter by settings |
| `ContentSplitter/ContentSplitterV1.ts` | 44 | Legacy V1 splitter (delegates to `splitPieces2`) |
| `ContentSplitter/ContentSplitterV2.ts` | 43 | V2 / V2-segmenter splitter (delegates to `splitPieces2V2`) |
| `ContentSplitter/ContentSplitterRabinKarp.ts` | 37 | V3 content-defined splitter (delegates to `splitPiecesRabinKarp`) |
| `string_and_binary/chunks.ts` | 785 | **All actual splitting algorithms**: V1/V2/segmenter/Rabin-Karp; base64 helpers |
| `string_and_binary/convert.ts` | 43 | Re-exports `octagonal-wheels/binary` (base64/hex/UTF); `arrayBufferToBase64Single` Node fallback; `versionNumberString2Number` |
| `string_and_binary/hash.ts` | 2 | Re-export of `octagonal-wheels/hash/xxhash.js` |
| `string_and_binary/path.ts` | 266 | Path↔DocumentID mapping, **path obfuscation** (`path2id_base`), filename validation, `.gitignore` matching, `shouldSplitAsPlainText` |
| `encryption/encryptHKDF.ts` | 4 | Thin re-export of `encryptHKDFWorker`/`decryptHKDFWorker` |
| `encryption/stringEncryption.ts` | 82 | `encryptString`/`decryptString`/`tryDecryptString` wrappers over `octagonal-wheels/encryption` with format detection |

Closely-related out-of-scope files referenced for the end-to-end picture:
`pouchdb/encryption.ts` (the E2EE transform pipeline), `pouchdb/chunks.ts` (chunk GC / recycling),
`managers/EntryManager/EntryManagerImpls.ts` (`prepareChunk` — hash→ID), `managers/HashManager/*`,
`worker/bgWorker.ts` + `worker/bg.worker.encryption.ts` (worker offload).

---

## Key types / data structures (chunk, hash, encrypted envelope)

**`SplitOptions`** (`ContentSplitter.ts`): the normalized input to a splitter —
`{ blob: Blob; path: FilePathWithPrefix; pieceSize: number; plainSplit: boolean;
minimumChunkSize: number; useWorker: boolean; useSegmenter: boolean }`.

**Chunk piece**: splitters yield `string` values via a (possibly async) generator. Text pieces are
raw UTF strings; **binary pieces are base64 strings** (`arrayBufferToBase64Single`). There is no
richer per-piece object at the splitter boundary — a piece is just a string.

**Chunk document (`EntryLeaf`)**: a piece becomes a stored chunk with
`_id = "h:" + hash` (the `IDPrefixes.Chunk` prefix `h:`), `data = piece`, and an `e_: true` flag
once encrypted. The `_id` **is** the dedup key. Built in `prepareChunk`
(`EntryManagerImpls.ts:265`): a per-session cache is consulted first
(`chunkManager.getChunkIDFromCache`), else `hashManager.computeHash(piece)` produces the hash.

**Hash config** (`common/models/setting.const.ts`): `HashAlgorithms = { XXHASH32:"xxhash32",
XXHASH64:"xxhash64", MIXED_PUREJS:"mixed-purejs", SHA1:"sha1", LEGACY:"" }`. When encryption is on,
hashes get a `"+"` prefix (`HashEncryptedPrefix`, `HashManagerCore.ts`) and mix in a hashed
passphrase (see below).

**Chunk-algorithm enum** (`ChunkAlgorithms`): `V1:"v1"`, `V2:"v2"`, `V2Segmenter:"v2-segmenter"`,
`RabinKarp:"v3-rabin-karp"`. Display names in `ChunkAlgorithmNames` ("V1: Legacy", "V2: Simple
(Default)", "V2.5: Lexical chunks", "V3: Fine deduplication"). **`chunkSplitterVersion`** (a.k.a.
`ChunkSplitterVersion`) is the setting field selecting the algorithm; default is
`ChunkAlgorithms.RabinKarp` (`setting.const.defaults.ts:179`).

**E2EE enum** (`E2EEAlgorithms`): `V1:""`, `V2:"v2"`, `ForceV1:"forceV1"`; names:
`""→"V1: Legacy"`, `"v2"→"V2: AES-256-GCM With HKDF"`, `"forceV1"→"Force-V1 (Not recommended)"`.
Default `E2EEAlgorithm` is `V2` (`setting.const.defaults.ts:180`).

**Encrypted envelope** (in-band, prefix-tagged strings; from `stringEncryption.ts` and
`pouchdb/encryption.ts`):
- `ENCRYPT_V1_PREFIX_PROBABLY`, `ENCRYPT_V2_PREFIX`, `ENCRYPT_V3_PREFIX` — legacy PBKDF2 formats.
- `HKDF_SALTED_ENCRYPTED_PREFIX` — the V2 HKDF format.
- Chunk-level header bytes in `pouchdb/encryption.ts`: `Encrypt_HKDF_Header = "%="`,
  `Encrypt_OLD_Header = "%"`; an internal `EncryptionVersions` map
  (`UNENCRYPTED:0, ENCRYPTED:1, HKDF:2, UNKNOWN:99`) classifies a stored `EntryLeaf.data` by prefix.
- Obfuscated/encrypted metadata prefix `ENCRYPTED_META_PREFIX = "/\\:"`; obfuscated path prefix
  `PREFIX_OBFUSCATED` (from `common/types`).

---

## Chunking / content splitting (DEEP)

### Selection & parameters

`ContentSplitter` (the façade, `ContentSplitters.ts`) holds an ordered list
`[ContentSplitterV1, ContentSplitterV2, ContentSplitterRabinKarp]` and, on `initialise`, picks the
**first** whose static `isAvailableFor(settings)` matches `chunkSplitterVersion`:
- `ContentSplitterV1.isAvailableFor` → `v1` **or** empty/undefined (so an unset setting falls back
  to V1's `splitPieces2`).
- `ContentSplitterV2.isAvailableFor` → `v2` or `v2-segmenter`.
- `ContentSplitterRabinKarp.isAvailableFor` → `v3-rabin-karp`.

`ContentSplitterBase.getParamsFor(entry)` (`ContentSplitterBase.ts:65`) derives `SplitOptions`:
- `pieceSize = floor(MAX_DOC_SIZE_BIN * (customChunkSize + 1))` — the hard cap on a single chunk,
  scaled by the user's `customChunkSize` tweak.
- `minimumChunkSize = settings.minimumChunkSize`.
- `plainSplit = shouldSplitAsPlainText(path)` — true only for `.md`, `.txt`, `.canvas`
  (`path.ts:191`). Everything else (including other "plain text" types like `.html`, `.css`, `.js`)
  is treated as binary for splitting purposes.
- `useWorker` — true unless `disableWorkerForGeneratingChunks`; additionally forced false for blobs
  `≤ MAX_CHUNKS_SIZE_ON_UI` (1024 bytes) when `processSmallFilesInUIThread` is set.
- `useSegmenter = (chunkSplitterVersion === V2Segmenter)`.

Each concrete splitter's `processSplit` calls either the in-process generator
(`splitPieces2`/`splitPieces2V2`/`splitPiecesRabinKarp` from `chunks.ts`) or the worker variant
(`splitPieces2Worker`/`…V2`/`…RabinKarp` in `bgWorker.ts`, which route to `_splitPieces2Worker`
with a numeric algorithm tag 1/2/3). The worker path exists to keep large-file splitting off the UI
thread.

### V1 — `splitPieces2` (`chunks.ts:434`)

Two modes decided by blob MIME (`isTextBlob` = `type === "text/plain"`):

- **Text** → `splitPiecesText` → `splitPiecesTextV1` (`chunks.ts:216`). Splits on `\n` into lines,
  then `pickPiece` (`chunks.ts:11`) assembles pieces: it accumulates lines until
  `buffer.length ≥ minimumChunkSize` (or a heading `#` or EOF), and has **special code-block
  handling** — a fenced block (`` ``` `` with up to 3 leading spaces) is gathered whole, and if it
  is not base64-looking and `< 2048` chars it is further split on a `/(.*?[;,:<])/g` delimiter
  regex. Each yielded piece is then hard-capped to `pieceSize` characters, with a `codePointAt` vs
  `charCodeAt` check to **avoid cutting a UTF-16 surrogate pair** (grow the cut by one).
- **Binary** → fixed-size scan: slices `pieceSize` bytes at a time, then looks for a *delimiter*
  after `minimumChunkSize` to trim the cut earlier (delimiter is `\0` by default, `/` for `.pdf`,
  `,` for `.json`). `minimumChunkSize` is **recomputed** from the file size via a
  `while (w > 10) { w /= 12.5; step++ }` loop → `minimumChunkSize = 10^(step-1)` (i.e. larger files
  get larger minimum chunks). Binary pieces are base64-encoded.

### V2 — `splitPieces2V2` (`chunks.ts:340`)

- **Text, plainSplit** → `splitByDelimiterWithMinLength(text, "\n", xMinimumChunkSize)` then
  `chunkStringGeneratorFromGenerator(…, pieceSize)`. `xMinimumChunkSize` is scaled up so that
  `textLen / xMinimumChunkSize ≤ MAX_ITEMS` (100) — capping the chunk *count* for a document.
  `splitByDelimiterWithMinLength` walks the delimiter (`\n`) and only yields once the buffer exceeds
  the min length, so lines coalesce into ≥min chunks.
- **Text, not plainSplit** → simple `chunkStringGenerator(text, pieceSize)` (fixed size, surrogate-
  safe).
- **Binary** → same byte-scan-with-delimiter approach as V1's binary path, but it reads the **whole
  file** into one `Uint8Array` up front (`await dataSrc.arrayBuffer()`), then advances by finding a
  delimiter/newline after `minimumChunkSize` and capping at `pieceSize`. Same size-derived
  `minimumChunkSize` recomputation.

### V2.5 — segmenter (`splitPiecesTextV2`, `chunks.ts:143`)

Enabled when `useSegmenter` and `Intl.Segmenter` is available. Splits text into fenced-code regions
(``` ``` ``` / ` ```` `) vs prose; prose is segmented with
`new Intl.Segmenter(navigator.language, { granularity: "sentence" })` (`splitTextInSegment`), then
each accumulated buffer is length-capped to `pieceSize`. Code blocks bypass segmentation and are cut
by length only. Intent: chunk on **lexical/sentence boundaries** so small edits shift fewer chunks.

### V3 — Rabin-Karp content-defined chunking (`splitPiecesRabinKarp`, `chunks.ts:493`)

This is the **default** and the most sophisticated. It is *content-defined chunking (CDC)*: chunk
boundaries are chosen by a rolling hash of the content, not by fixed offsets, so inserting/deleting
bytes only reshuffles the chunks near the edit rather than every chunk after it.

Parameters:
- `plainSplit = doPlainSplit || isTextBlob`; **but text files ≥ 4 MB are demoted to binary
  splitting** (`isDataSizeTooLargeForPlainSplit`) to bound chunk count.
- Text unit `chunkUnitPlain` starts at 64 bytes and grows by 32 until the estimated chunk count
  (`dataSize / (chunkUnitPlain*4)`) ≤ `MAX_CHUNK_COUNT` (500). Binary unit `chunkUnitBinary` = 256 KB.
- Target sizes: `avg = unit*4`, `max = unit*16`, `min = unit*2` (text) / `unit` (binary) — i.e.
  ~256 B avg / 1 KB max for text; ~1 MB avg / 4 MB max for binary.
- `absoluteMaxPieceSize` (the caller's `pieceSize`) is floored at `rkAbsoluteMaxPieceSizeFloor =
  30 KB`, then `maxChunkSize = min(fixedMaxChunkSize, effectiveMax)`, `minChunkSize` /
  `avgChunkSize` clamped into `[min, max]`.

Algorithm (`chunks.ts:592`): a **48-byte rolling window** (`windowSize = 48`) polynomial hash with
`PRIME = 31`, updated byte-by-byte using `Math.imul` and precomputed `P_pow_w = 31^47`. A byte
position is a **boundary candidate** when `currentChunkSize ≥ minChunkSize` **and**
`(hash >>> 0) % hashModulus === boundaryPattern` where `hashModulus = avgChunkSize` and
`boundaryPattern = 1` (so ~1-in-avg probability of a boundary per byte). A boundary is **forced**
once `currentChunkSize ≥ maxChunkSize`. For text, a candidate boundary is rejected if the next byte
is a UTF-8 continuation byte (`(buffer[pos+1] & 0xc0) === 0x80`) — **multi-byte-char-safe cutting**.
On a boundary it yields `readString(...)` (text) or `arrayBufferToBase64Single(...)` (binary) of
`[start, pos+1)`, then resets `start`. The trailing remainder is yielded at EOF.

`splitPiecesRabinKarpOld` (`chunks.ts:653`) is a retired earlier variant (5%/12-piece heuristic
sizing) kept in-tree but not wired into any splitter.

### Deduplication via hashing

The splitter itself does **not** deduplicate — it just yields pieces. Dedup happens downstream in
`prepareChunk`: the piece string is hashed and the chunk stored under `_id = "h:" + hash`. Because
CouchDB/PouchDB keys are unique, two identical pieces (same plaintext) collapse to the same document
— replication then only transfers chunk IDs that the peer is missing. A document references its
chunks by listing their `h:` IDs in its `children[]` (see `pouchdb/chunks.ts` design-doc `map`,
which emits `[child] → 1` for references and `[h:id] → 0` for the chunk itself). CDC (Rabin-Karp)
maximizes cross-version dedup because unchanged regions reproduce byte-identical pieces.

### Hash computation (dedup key derivation)

`HashManagerCore.computeHash` (`HashManagerCore.ts:122`): when `settings.encrypt`, returns
`"+" + computeHashWithEncryption(piece)`, else `computeHashWithoutEncryption(piece)`. Concrete
managers (`XXHashHashManager.ts`, plus `PureJSHashManager`):
- `XXHash64HashManager`: `h64(`${piece}-${hashedPassphrase}-${piece.length}`)` (encrypted) /
  `h64(`${piece}-${piece.length}`)` (plain), base-36.
- `XXHash32RawHashManager` (legacy `""`): `h32Raw(piece) ^ hashedPassphrase32 ^ piece.length`, base-36.
- `FallbackWasmHashManager`: always-available `h32(...)` fallback.

`applyOptions` derives the passphrase mix-ins: `passphraseForHash = SALT_OF_ID +
passphrase.substring(0, ~~(len/4*3))`, `hashedPassphrase = fallbackMixedHashEach(...)`,
`hashedPassphrase32 = mixedHash(..., SEED_MURMURHASH)[0]`. This folds the passphrase and length into
the chunk ID so that (a) chunk IDs differ between vaults with different passphrases and (b) length is
a cheap collision-reducer. These are **non-cryptographic** hashes (xxHash/murmur) — see observations.

---

## String & binary encoding (DEEP)

`convert.ts` is a thin façade over **`octagonal-wheels/binary`** (external), re-exporting:
- `arrayBufferToBase64` / `base64ToArrayBuffer` / `base64ToArrayBufferInternalBrowser` /
  `tryConvertBase64ToArrayBuffer` — base64 codec (binary chunks are stored/transported as base64).
- `readString` / `writeString` — UTF-8(?) string ↔ `Uint8Array` (used by the splitters and by the
  path hasher). `readString` is used to materialize text chunks from byte ranges without base64.
- `uint8ArrayToHexString` / `hexStringToUint8Array` (from `octagonal-wheels/binary/hex`).
- `encodeBinaryEach` / `decodeToArrayBuffer` (from `…/binary/encodedUTF16`) and
  `decodeBinary` / `encodeBinary` — alternate encodings used elsewhere in the DB layer for storing
  binary as UTF-16-safe strings.

`arrayBufferToBase64Single` (`convert.ts:20`) wraps the octagonal-wheels single-buffer base64
encoder and adds a **Node/CLI fallback**: if `FileReader` is unavailable it uses `Buffer.from(...)
.toString("base64")`. This is the function the binary splitters call per piece.

`versionNumberString2Number` (`convert.ts:37`) turns `"1.23.45"` into a sortable integer
(`45 + 23*1000 + 1*1000^2`).

`hash.ts` (2 lines) simply re-exports `octagonal-wheels/hash/xxhash.js` (exposing `xxhashNew` etc.
used by the hash managers).

**Encoding-related size note:** binary chunk data is base64 → ~33% size inflation over raw bytes,
and this base64 is what then gets encrypted and replicated.

---

## Encryption (DEEP)

### Algorithms

Two families, selected by `E2EEAlgorithm`:
- **V2 (default, `"v2"`)** — "AES-256-GCM with HKDF". Implemented in
  `octagonal-wheels/encryption/hkdf` (`encrypt`/`decrypt`, exported through the worker as
  `encryptHKDFWorker`/`decryptHKDFWorker`). Ciphertext strings carry `HKDF_SALTED_ENCRYPTED_PREFIX`;
  stored chunk data starts with `"%="` (`Encrypt_HKDF_Header`). Takes a **`pbkdf2Salt`
  (`Uint8Array`)** argument in addition to the passphrase.
- **V1 / legacy (`""`), and `ForceV1` (`"forceV1"`)** — PBKDF2-based
  (`octagonal-wheels/encryption/encryption`, `encrypt`/`decrypt` via `encryptWorker`/`decryptWorker`,
  with an `autoCalculateIterations` / `useDynamicIterationCount` flag). Prefixes
  `ENCRYPT_V1_PREFIX_PROBABLY` / `ENCRYPT_V2_PREFIX` / `ENCRYPT_V3_PREFIX`; stored chunk data starts
  with `"%"` (`Encrypt_OLD_Header`).

> The AES-GCM/HKDF/PBKDF2 primitives themselves live in `octagonal-wheels` (external, not in this
> repo), so exact IV handling, HKDF `info`/salt usage, iteration counts, and tag length are **not
> verifiable from this codebase** — only the call surface (passphrase + `pbkdf2Salt`, prefix
> tagging, worker offload) is.

### Key derivation

Not implemented in-scope; performed inside `octagonal-wheels`. Observable inputs: the raw
`passphrase` string and, for V2, a repo-scoped **`pbkdf2Salt`** obtained lazily via
`getPBKDF2Salt()` (supplied by the DB/replicator managers, e.g.
`DirectFileManipulatorV2.ts:213`, `LiveSyncReplicator.ts:196`). V1 uses PBKDF2 with a
per-string dynamic iteration count. The **content-hash** passphrase mixing (in the hash managers,
above) is a *separate* keying used only for chunk IDs, not for confidentiality.

### What is encrypted (the transform pipeline)

The real E2EE wiring is `pouchdb/encryption.ts`, installed as a **transform-pouch** `incoming`
(write) / `outgoing` (read) pair by `enableEncryption` /
`getConfiguredFunctionsForEncryption`. Routing: `incoming` uses `incomingEncryptHKDF` when algorithm
is `V2`, else `incomingEncryptV1`; `outgoing` uses `outgoingDecryptHKDF` unless `ForceV1` (so V2/HKDF
decrypt stays the forward-compatible default). Encrypted surfaces:

1. **Chunk data** (`isEncryptedChunkEntry`) and **sync-info** (`isSyncInfoEntry`): `EntryLeaf.data`
   is encrypted and `e_ = true` set. On read, classified by `getEncryptionVersion` (via `%=` / `%`
   prefix) and decrypted; `incomingEncryptHKDF` also **upgrades** a V1-encrypted chunk to HKDF on
   write (decrypt-then-re-encrypt).
2. **Path / metadata obfuscation**: for obfuscated entries, V1 uses `obfuscatePath(...)` (from
   octagonal-wheels) on the `path`; **V2 (HKDF) encrypts the whole metadata object** —
   `encryptMetaWithHKDF` serializes `{ path, mtime, ctime, size, children }` to JSON, encrypts it,
   and stores it as `path = "/\\:" + ciphertext` (`ENCRYPTED_META_PREFIX`), then **zeroes `mtime`,
   `ctime`, `size` and empties `children`** on the visible document. So under V2, timestamps, size,
   and child-chunk lists are hidden, not just the filename.
3. **Eden** (an inline recent-chunk cache on entries): encrypted under keys `h:++encrypted`
   (V1, `EDEN_ENCRYPTED_KEY`) / `h:++encrypted-hkdf` (V2, `EDEN_ENCRYPTED_KEY_HKDF`).

### Path obfuscation — the two mechanisms

- **DocumentID hashing** (`path.ts`, `path2id_base`): independent of the transform layer. When
  `obfuscatePassphrase` is set, a path maps to `prefix + PREFIX_OBFUSCATED + hashString(
  hashString(obfuscatePassphrase) + ":" + filename)`. `hashString` (`path.ts:82`) is
  SHA-256-based (WebCrypto `subtle.digest`) with an LRU memo cache and a stretch loop of
  `key.length` iterations. This yields a **deterministic, non-reversible** ID (the file's real name
  cannot be recovered from the ID — `id2path_base` throws on obfuscated IDs). `caseInsensitive`
  lowercases first.
- **Reversible path encryption** (transform layer, above): `obfuscatePath` (V1) or
  `encryptMetaWithHKDF` (V2) store an **encrypted, recoverable** path so the real name is restored
  on read via the passphrase.

### stringEncryption.ts (generic string helper)

`encryptString` (`stringEncryption.ts:24`) is idempotent: returns input unchanged if it already
starts with `ENCRYPT_V2_PREFIX` or `HKDF_SALTED_ENCRYPTED_PREFIX`, else calls
`encryptWithEphemeralSalt(source, passphrase)` (V2 HKDF with a fresh per-call salt).
`decryptString` dispatches by prefix (HKDF → `decryptWithEphemeralSalt`; V1/V2/V3 →
`decrypt(...)` tried with then without dynamic iterations); `tryDecryptString` swallows failures and
returns `false`. This helper is used for ad-hoc field encryption (e.g. settings), distinct from the
chunk transform pipeline.

---

## How this ties to replication & storage (chunk recycling, dedup)

- **Content addressing → dedup → minimal sync.** A document stores a `children[]` of `h:`-prefixed
  chunk IDs; chunks are separate `EntryLeaf` docs keyed by content hash. Replication (PouchDB
  `_bulk_docs`/`_changes`) transfers only chunk docs the peer lacks. `transferChunks`
  (`pouchdb/chunks.ts:83`) explicitly narrows to chunks "not in the local" via `allDocs` before
  copying — pure content-addressed dedup.
- **Chunk recycling / GC.** `pouchdb/chunks.ts` computes reference counts through a CouchDB design
  doc view (`_design/chunks` `collectDangling`: `reduce:_sum`, grouping chunk-self `0` against
  reference `1`). `collectUnreferencedChunks` (value `== 0`) feeds `purgeUnreferencedChunks`, which
  backs chunks up to `_local/...` before `purgeMulti` (local) or CouchDB `_purge` (remote).
  `balanceChunkPurgedDBs` / `fetchAllUsedChunks` re-sync chunk sets between separately-GC'd DBs.
- **The recycling performance concern (chunking's whole point).** Chunk IDs are derived from
  *plaintext content* (+ passphrase + length). Therefore any change that alters the piece boundaries
  or the ID recipe **invalidates the entire chunk store and forces a full re-upload**:
  - changing `chunkSplitterVersion` (V1↔V2↔RabinKarp) → different piece boundaries → all-new IDs;
  - changing `hashAlg` (`HashAlgorithms`) → different IDs for identical content;
  - changing the passphrase / `encrypt` flag → different `hashedPassphrase`/`+` prefix → all-new IDs.
  Rabin-Karp (V3, "Fine deduplication") exists precisely to *raise* cross-edit chunk reuse and to
  *bound* chunk count (the `MAX_CHUNK_COUNT`=500 and 30 KB/4 MB floors), because too-many-small-chunks
  is a documented replication/sync performance problem (see the in-code comment at
  `chunks.ts:507-508`). Fixed-size splitters (V1/V2 binary) suffer boundary-shift: an insert near the
  file start changes every subsequent fixed-offset chunk, defeating dedup.

---

## Function/class inventory (per file)

### `ContentSplitter/ContentSplitter.ts`
- `type SplitOptions`, `type ContentSplitterOptions`; `const MAX_CHUNKS_SIZE_ON_UI = 1024` — the
  foreground-processing size threshold.

### `ContentSplitter/ContentSplitterBase.ts`
- `abstract class ContentSplitterCore` — holds `options`, `initialised` promise; abstract
  `initialise` / `splitContent`.
- `abstract class ContentSplitterBase extends ContentSplitterCore` — default `initialise` (resolves
  true); static `isAvailableFor` (default false); abstract `processSplit(options)`;
  **`getParamsFor(entry)`** (settings→`SplitOptions`, non-trivial — computes `pieceSize`,
  `plainSplit`, worker/segmenter flags); `splitContent(entry)` (awaits init, builds params, calls
  `processSplit`).

### `ContentSplitter/ContentSplitters.ts`
- `class ContentSplitter extends ContentSplitterCore` — the façade. `initialise` iterates
  `[V1, V2, RabinKarp]`, instantiates the first matching `isAvailableFor`, throws if none;
  `splitContent` delegates to `_activeSplitter`.

### `ContentSplitter/ContentSplitterV1.ts` / `V2.ts` / `RabinKarp.ts`
- Each: static `isAvailableFor` (maps `chunkSplitterVersion` values) + `processSplit` that dispatches
  to the worker (`useWorker`) or in-process `chunks.ts` generator. V1→`splitPieces2` /
  `splitPieces2Worker`; V2→`splitPieces2V2` / `splitPieces2WorkerV2` (passes `useSegmenter`);
  RabinKarp→`splitPiecesRabinKarp` / `splitPieces2WorkerRabinKarp`.

### `string_and_binary/chunks.ts` (core algorithms)
- `isTextBlob(blob)` — MIME `"text/plain"` test.
- `pickPiece(leftData, minimumChunkSize)*` — V1 line/code-block aggregator (non-trivial; fenced-block
  and `;,:<`-delimiter logic).
- `splitStringWithinLength(text, pieceSize)*`, `splitTextInSegment(...)*`, `splitInNewLine(...)*` —
  segmenter helpers.
- `splitPiecesTextV2(...)`, `binaryTextSplit(...)`, `splitPiecesText(...)`, `splitPiecesTextV1(...)`
  — text splitting entry points; `splitPiecesText` chooses segmenter vs V1 vs binary.
- `splitByDelimiterWithMinLength(...)*`, `chunkStringGenerator(...)*`,
  `chunkStringGeneratorFromGenerator(...)*`, `stringGenerator(...)*` — V2 delimiter/size generators
  (surrogate-safe).
- `collectGenAll(gen)` / `concatGeneratedAll(gen)` — drain a (async)generator to array/string.
- `splitPieces2V2(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename?, useSegmenter?)` — V2
  splitter (text via delimiter+cap, binary via whole-buffer delimiter scan). Non-trivial size math.
- `splitPieces2(...)` — V1 splitter (text via `splitPiecesText`; binary via per-slice delimiter scan).
- `splitPiecesRabinKarp(dataSrc, absoluteMaxPieceSize, doPlainSplit, minimumChunkSize, …)` — V3 CDC
  (rolling-hash boundaries; the primary/default algorithm). Non-trivial (see deep section).
- `splitPiecesRabinKarpOld(...)` — retired variant, **not referenced** by any splitter.

### `string_and_binary/convert.ts`
- Re-exports base64/hex/UTF codecs from `octagonal-wheels/binary`.
- `arrayBufferToBase64Single(buffer)` — base64 with Node `Buffer` fallback (non-trivial: env branch).
- `versionNumberString2Number(version)` — dotted-version → sortable int.

### `string_and_binary/hash.ts`
- Re-export of `octagonal-wheels/hash/xxhash.js` (types + `xxhashNew`).

### `string_and_binary/path.ts`
- `isValidFilenameIn{Widows,Darwin,Linux,Android}` — per-OS filename validators (note the misspelled
  `Widows`).
- `isFilePath`, `stripAllPrefixes`, `addPrefix`, `expandFilePathPrefix`, `expandDocumentIDPrefix`,
  `stripPrefix` — prefix parsing on `prefix:body` IDs/paths.
- `hashString(key)` (memoized `_hashString`) — SHA-256 with a `key.length`-iteration stretch loop
  (see observation). Non-trivial.
- `path2id_base(filenameSrc, obfuscatePassphrase, caseInsensitive)` — path → `DocumentID`, applying
  obfuscation hashing when a passphrase is given. Non-trivial.
- `id2path_base(id, entry?)` — reverse; **throws** on obfuscated IDs (one-way).
- `getPath`, `getPathWithoutPrefix`.
- `shouldBeIgnored(filename)` — red-flag / logfile filters.
- `isPlainText(filename)` (broad list) vs `shouldSplitAsPlainText(filename)` (only `.md`/`.txt`/
  `.canvas`) — **note the divergence** between what's "plain text" and what's *split* as plain text.
- `isAccepted(path, ignore)` / `isAcceptedAll(...)` — `.gitignore`-style minimatch evaluation.

### `encryption/encryptHKDF.ts`
- `export const encryptHKDF = encryptHKDFWorker; export const decryptHKDF = decryptHKDFWorker;` —
  worker re-export only.

### `encryption/stringEncryption.ts`
- `encryptString(source, passphrase)` — idempotent V2/HKDF ephemeral-salt encrypt.
- `tryDecryption(trials)*` — try list of decrypt closures, first success wins.
- `decryptString(encrypted, passphrase)` — prefix dispatch (HKDF vs V1/V2/V3), throws on unknown.
- `tryDecryptString(encrypted, passphrase|false)` — non-throwing wrapper → `string | false`.

---

## Dependencies / Consumed by

**Depends on (external):** `octagonal-wheels` (`^0.1.47`) — binary codecs, xxHash/mixed hashes, and
**all crypto primitives** (`/encryption`, `/encryption/hkdf`, `obfuscatePath`,
`isPathProbablyObfuscated`); `minimatch` (gitignore matching); WebCrypto (`getWebCrypto` for
SHA-256 path hashing).

**Depends on (in-repo):** `common/types` (enums, `MAX_DOC_SIZE_BIN`, prefixes),
`common/models/setting.const*`, `services/base/IService` (`ISettingService`),
`worker/bgWorker.ts` (worker offload for both splitting and encryption), `common/logger`,
`common/utils` (`createTextBlob`, entry-type guards).

**Consumed by:** `managers/EntryManager/EntryManagerImpls.ts` (`prepareChunk`, `splitContent`
orchestration — the chunk write path), `managers/HashManager/*` (compute chunk IDs),
`pouchdb/encryption.ts` (the E2EE transform layer that wraps chunk data/paths/eden),
`pouchdb/chunks.ts` (chunk GC/recycling), `pouchdb/LiveSyncLocalDB.ts`, `replication/*`
(couchdb + trystero P2P replicators), `API/DirectFileManipulatorV2.ts`, `cli/*`.

---

## Design observations (factual; for critique — no fixes prescribed)

**Performance**
1. **Whole-file buffering.** `splitPieces2V2` (binary), `splitPiecesRabinKarp`, and
   `splitPiecesRabinKarpOld` call `await dataSrc.arrayBuffer()` and hold the entire file in one
   `Uint8Array` before/while yielding. Memory scales with file size (up to the 100 MB clamp / 4 GB
   comment) — the generator is not truly streaming for these paths.
2. **Rabin-Karp is byte-at-a-time in JS.** The rolling hash loops every byte with `Math.imul`
   arithmetic and per-byte modulus; on large binaries this is CPU-heavy (hence the worker offload and
   the ≥4 MB text→binary demotion). `hashModulus`/`avgChunkSize` also caps effective granularity.
3. **Re-chunking cliff / chunk-store invalidation.** Because chunk IDs bind content **plus**
   splitter boundaries, hash algorithm, passphrase, and encrypt flag, changing any of those forces a
   full re-chunk and re-upload with zero reuse — the known "chunk recycling" cost. There is no
   migration that re-keys existing chunks; the switch is effectively a full resync.
4. **Chunk-count bounding is heuristic.** `MAX_ITEMS=100` (V2 text), `MAX_CHUNK_COUNT=500` (RK),
   `10^(step-1)` size scaling, and the 30 KB/256 KB/4 MB floors are magic constants; a document just
   under a threshold vs just over can chunk very differently, changing dedup behaviour non-linearly.
5. **base64 for binary chunks** inflates stored/replicated size ~33% before encryption.

**Security**
6. **`hashString` stretch loop re-hashes the *original* buffer, not the previous digest**
   (`path.ts:87-90`: the loop assigns `digest = subtle.digest("SHA-256", buff)` each iteration, using
   `buff` — the input — every time, never `digest`). The `key.length` iterations therefore compute
   the *same* SHA-256 repeatedly: it is **not iterative key stretching** (no strengthening), yet it
   costs O(key.length) hashes and its cost is proportional to path length (a potential timing signal).
   This is path *obfuscation* keying, not chunk confidentiality, but the construction does not do what
   its "// Stretching" comment implies.
7. **Chunk IDs use non-cryptographic hashes** (xxHash32/64, murmur-based `mixedHash`). xxHash32
   (legacy `""` and the wasm fallback) is 32-bit → birthday collisions are plausible for large vaults;
   a chunk-ID collision means one chunk's content is silently served for another. `piece.length` is
   mixed in as a weak mitigation. The passphrase is folded into the hash by simple string
   concatenation / XOR (`XXHash32RawHashManager`), which is obfuscation, not authenticated keying.
8. **Passphrase truncation for hash keying.** `passphraseForHash` uses only
   `passphrase.substring(0, ~~(len/4*3))` (roughly the first 75%) of the passphrase — again only for
   the ID mix-in, but it means chunk-ID keying ignores the passphrase tail.
9. **Metadata leakage under V1 obfuscation.** Only V2/HKDF (`encryptMetaWithHKDF`) hides `mtime`,
   `ctime`, `size`, and `children`. Under V1 path obfuscation the filename is encrypted but
   timestamps, size, and the child-chunk list remain visible on the server. Even under V2, chunk
   *count/size distribution* per document remains observable at the storage layer, and chunk IDs are
   deterministic across a vault (enabling equal-content correlation).
10. **Crypto primitives are external and unaudited here.** AES-GCM IV uniqueness, HKDF `info`/salt
    binding, PBKDF2 iteration counts, and the "ephemeral salt" scheme all live in `octagonal-wheels`
    and cannot be verified from this repo; the in-repo code trusts prefix tags (`%`/`%=`) to select
    the decrypt path, and V1→HKDF *upgrade-on-write* decrypts-then-re-encrypts (a transient plaintext
    window in the worker).
11. **Silent decrypt fallbacks.** `decryptString`/`tryDecryptV1AsFallback`/`outgoingDecryptV1` try
    multiple parameterizations (with/without dynamic iteration count) and log at VERBOSE; a wrong
    passphrase surfaces as generic failure or `false`, and `tryDecryptString` returns `false` rather
    than distinguishing "wrong key" from "corrupt data".

**Coverage gaps / unknowns**
- The **actual AES/HKDF/PBKDF2 implementation, IV/nonce handling, and iteration counts** are in
  `octagonal-wheels` (not vendored) — documented here only from the call surface.
- `_splitPieces2Worker` internals (chunking inside the Web Worker) live in
  `worker/bgWorker.splitting.ts` (out of scope); this doc covers the in-process algorithms, which the
  worker mirrors by algorithm tag (1=V1, 2=V2, 3=RabinKarp).
- The `chunkManager.getChunkIDFromCache` cache semantics (eviction, cross-session persistence) are in
  the ChunkManager (out of scope) and affect dedup effectiveness.

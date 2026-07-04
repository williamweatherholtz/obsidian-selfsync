# Critique of the LiveSync Architecture — and a Target Direction

> **Purpose:** Judge the as-built architecture (`00-overview.md` + §10–§26) against the project's goals, using the sync-architecture research (2026-07-02, 25/25 claims verified; full findings in the research report). Produced as the input to a design/decision phase — it says *keep / change / drop*, not *how to implement*.
>
> **Evaluation frame.** Target: sync an Obsidian vault to a **self-hosted** backend for a **single user across multiple devices** (desktop + mobile). Four goals: **① dead simple · ② super secure · ③ performant · ④ mobile-capable.** Conflicts are occasional (offline edits on two devices), *not* real-time co-authoring.
>
> **Dropped by decision (2026-07-02):** **Peer-to-peer / WebRTC** (§14, §21, and the P2P backend in §20) is out of scope. This removes a whole risk surface — zeroed PBKDF2 salt, name-based peer trust, third-party Nostr-relay dependency, and duplicated P2P UI/command code — and simplifies the replicator contract to two backends.
>
> **Direction decided (2026-07-02):** target = **§5 option 1 — a single self-hostable binary distributed as a Docker image** (dumb authenticated blob/oplog store; all sync logic client-side). **Benchmark/aspiration:** match or beat **Obsidian's official Sync** for flawless **desktop↔mobile** sync (the primary use case). Two pre-design spikes are underway — an official-Sync teardown and an Obsidian-mobile/Capacitor reality check — resolving open questions §6.1 and §6.2 before design.

## 1. Verdict scorecard

| Goal | As-built state | Gap severity | Research-backed target |
|------|----------------|:---:|------------------------|
| ① Dead simple (self-host) | CouchDB is the recommended/primary backend → DB administration; object-storage "journal" backend exists but is experimental; config sprawl (~120+ keys, 12 panes) | **High** | Single self-hostable binary as a *dumb authenticated blob/oplog store*, or an object-store broker — **no DB admin** |
| ② Super secure | E2EE exists (V2 AES-256-GCM + HKDF); but **no real key stretching** (`hashString` bug), non-crypto chunk IDs, V1 metadata leak; P2P crypto weak | **Medium–High** | Cryptomator-style: scrypt/argon2 KEK → AES-KeyWrap per-vault master keys, separate enc+MAC keys, **encrypt names/paths** |
| ③ Performant | Rabin-Karp CDC (right *pattern*) but chunk-store full-invalidation on param change, all-or-nothing chunk-fetch, contiguous-prefix checkpoint pins resume, whole-file `arrayBuffer()` buffering | **High** | **FastCDC** (~10× faster, +10–20% dedup) + resumable, chunk-bounded, gap-tolerant transfer |
| ④ Mobile-capable | Live-sync model + heavy PouchDB/IndexedDB + at-least-once re-apply + large in-memory buffering | **High** | Minimal, **resumable, chunk-bounded, foreground-triggered** sync respecting ~30s iOS / 15-min Android background limits |
| Conflict model (cross-goal) | **Three-way merge** (`mergeSensibly`) — *the right primitive per research* | **Keep** | Strengthen three-way merge (block/heading-aware); do **not** adopt CRDT for this use case |

**Headline:** the *conflict engine is architecturally sound* and validated by the research (three-way merge is exactly what git/MRDTs use for occasional offline conflicts — CRDTs are unjustified overhead here). The real problems are **operational simplicity (CouchDB)**, **large-vault performance**, **mobile fit**, and **crypto hardening** — plus pervasive **internal complexity**. This argues for *evolving* the client's proven core (chunking + three-way merge + PouchDB-on-device) while *replacing the server story* and *hardening crypto/perf*, rather than a greenfield rewrite.

## 2. Goal-by-goal critique

### ① Dead simple to self-host — **High gap**
- **Root cause:** CouchDB is the primary backend (§20); it needs real DB administration (fly.io credential/CORS pain, 256 MB OOM on initial sync — from the user-complaints research). The object-storage *journal* backend (§20) is the simpler path but is labeled experimental and had a memory-footprint overhaul only in v0.25.78.
- **Good bones:** the replicator is already abstracted behind one `LiveSyncAbstractReplicator` contract with pluggable backends (§20). Simplicity is reachable by **maturing the object-store/single-binary path and demoting CouchDB**, not by rebuilding replication.
- **Research direction:** a passive object-store broker is proven (remotely-save), and a single Go/Rust binary as an authenticated blob/oplog store removes DB admin entirely while keeping the server "dumb" (all logic client-side).
- **Also simple-hostile:** config sprawl (§15 — ~120+ keys, inverted/jargon names, triple hand-synced metadata tables in §24) and four coexisting extension mechanisms (§10, §16, §25). *(Config UX is the deferred goal #1; noted here as a simplicity tax.)*

### ② Super secure — **Medium–High gap**
- **Exists:** optional client-side E2EE, default **V2 = AES-256-GCM + HKDF** encrypting whole metadata + one-way SHA-256 path obfuscation (§22). That's a reasonable core and already yields a broadly zero-knowledge server.
- **Concrete weaknesses (from §22):**
  - **No real key stretching** — `hashString`'s stretch loop re-hashes the *original* buffer, not the prior digest. This undermines passphrase→key hardening.
  - **Non-cryptographic chunk IDs** (32-bit xxHash legacy) with passphrase folded in by concat/XOR — collision + analysis risk.
  - **V1 leaks metadata** (mtime/size/children); only filename obfuscated.
- **Research target (Cryptomator):** passphrase → **scrypt** (or argon2id) KEK → **AES Key Wrap** per-vault master keys → **separate 256-bit encryption + MAC** keys; **encrypt names/paths** to close the metadata gap. This is a well-audited blueprint that fixes all three weaknesses.
- **Dropping P2P** removes the weakest crypto (zeroed salt, name-based trust).
- → Route the specifics to a **dedicated security review** before design sign-off.

### ③ Performant on large vaults/files — **High gap**
- **Right pattern, upgradable engine:** LiveSync already does **content-defined chunking** (V3 Rabin-Karp, §22) with content-addressed dedup — architecturally correct. Research says **FastCDC** is ~10× faster at near-identical dedup and fixes boundary-shift; a direct, low-risk swap behind the existing splitter façade (`chunkSplitterVersion`).
- **Structural stalls (from §20, §22):**
  - **Full chunk-store invalidation** when splitter/hash/passphrase change → whole-vault resync. (Design must make chunking/enc parameters migratable, not catastrophic.)
  - **All-or-nothing chunk-fetch batches** + a **contiguous-prefix checkpoint that pins resume on any gap** + unbounded `seqStatusMap` → the field-reported stalls and restart-on-interruption.
  - **Whole-file `arrayBuffer()` buffering** on binary/RK paths → memory spikes on large files.
  - **Unbounded fire-and-forget queue drain** in the Obsidian apply path (§11).
- **Target:** resumable, gap-tolerant, chunk-bounded transfer with bounded memory and per-chunk checkpoints — which also directly serves mobile (④).

### ④ Mobile-capable — **High gap**
- **Hardest constraint (research):** Capacitor background execution is isolated from the WebView and capped (~30s/iOS invocation, 10 min hard / 30 s recommended / 15-min interval Android). Sync must be **minimal, resumable, chunk-bounded, and foreground-triggered**, and cannot depend on live plugin state.
- **Where the current design fights this:**
  - **Live/continuous sync** model (§20 `{live,retry,heartbeat}`) and heavy **PouchDB/IndexedDB** local store are costly on mobile battery/CPU (matches user-complaint research: fans, latency, iOS hour-long initial syncs).
  - **At-least-once re-apply on restart** (§11) + **large in-memory buffering** (§22) are exactly what a 30-second background budget punishes.
  - Worker-offloaded chunking (§26) helps CPU but the main-thread fallbacks (`processSmallFilesInUIThread`, `disableWorkerForGeneratingChunks`) exist because the model is heavy.
- **Target:** treat mobile as **foreground, incremental, resumable** first; make an initial sync restartable in ≤30s slices; keep the on-device store lean.

## 3. Cross-cutting architectural critique (maintainability & correctness)

- **Internal complexity is a first-class risk** (§10, §16, §25): **no DI container**, **four coexisting extension idioms** mid-migration, hand-wired order-sensitive composition root (`// TODO reorder`), a **god-barrel `types.ts`** (195 importers), **triple parallel setting tables** kept in manual sync. Any redesign should collapse to **one** extension model and one settings source of truth.
- **Correctness residue** even after the deletion-path verification (§12 addendum, §23): deleted-file resurrection remains real for **binary files** and the **opt-in newer-wins/bulk modes** (mtime, content-blind); chunk-GC counts only winning-revision children (purge hazard under unresolved conflicts); an unloadable conflicted leaf is deleted outright.
- **Dead / half-migrated code** (§13, §15) hurts legibility and audit: most DB-maintenance ops are call-site-commented-out; `if(false)` panels; an unwired 277-LOC `checkConfig`.
- **Hidden File sync fragility** (§13): mtime+size fingerprints are unreliable on mobile/cloud/editors — relevant since mobile is a goal.

## 4. Keep / Change / Drop

**Keep (proven, research-validated):**
- **Three-way merge conflict model** (`mergeSensibly`, §12) — the correct primitive; do not replace with CRDT.
- **Content-defined chunking + content-addressed dedup** (§22) — right idea.
- **On-device local DB + a backend-abstracted replicator** (§20, §23) — sound layering; the `LiveSyncAbstractReplicator` seam is an asset.
- **Client-side E2EE with a zero-knowledge server** (§22) — right posture.
- **Platform seam (`ServiceHub` + service modules)** enabling desktop/mobile/CLI reuse (§16, §17).

**Change (evolve):**
- Chunking engine → **FastCDC**; make chunk/enc parameters **migratable** (no full-vault resync).
- Transfer path → **resumable, gap-tolerant, chunk-bounded, bounded-memory**; fix the contiguous-prefix checkpoint and all-or-nothing batches.
- Crypto → **Cryptomator-style KDF + key hierarchy**; fix `hashString` stretching; **encrypt names/paths**; retire non-crypto chunk-ID hashing for security-relevant use.
- Server story → **single self-hostable binary (dumb blob/oplog store) or object-store broker**; demote CouchDB from the default path.
- Mobile → **foreground/incremental/resumable-first**; lean on-device store; kill the at-least-once re-apply hazard.
- Delete semantics → make **binary delete-vs-edit** safe (don't silently mtime-resurrect); make the mtime tiebreak causality-aware.
- Internals → collapse to **one extension model**; single settings source of truth; remove dead code.

**Drop:**
- **P2P / WebRTC** (§14, §21, P2P backend in §20) — per decision.
- **Opt-in "resolve by newer / bulk newer" as a silent default-ish path** — keep only as an explicit, clearly-guarded action.

## 5. Target direction (ranked, from research — a starting point for design, not a committed design)

1. **Preferred — single self-hostable Go/Rust binary as a dumb, authenticated blob/oplog store** (over an embedded store or object storage), **client owns all logic**: FastCDC chunking + dedup, three-way merge, Cryptomator-style E2EE with encrypted paths. Beats CouchDB LiveSync on setup, remotely-save on conflicts (free markdown merge), obsidian-git on mobile.
2. **Fallback — object-store broker only** (S3/MinIO/WebDAV, remotely-save-like) with a strong free three-way merge and full-path encryption — if running *any* server is undesirable. LiveSync's existing journal backend is the seed.
3. **CRDT (Yjs / diamond-types-when-mature)** — only if the use case shifts toward **real-time multi-author collaboration**. Not now.

## 6. Open questions to resolve before committing to a design

1. **Obsidian official Sync internals** — its oplog/delta + E2EE + conflict model is the benchmark to beat; no verified data yet. Worth targeted primary research.
2. **Obsidian Capacitor sandbox reality** — actual WebCrypto / OPFS / IndexedDB / filesystem behavior *inside the Obsidian mobile plugin* (vs generic Capacitor); can FastCDC + encryption fit the ~30s iOS budget on a large vault? Needs an on-device spike.
3. **Three-way merge quality on large Markdown** — does it need **block/heading-aware** merging to avoid spurious conflicts, or is line-level enough? (Determines whether we ever need CRDT-like structure.)
4. **Migration path** — how to move existing users off CouchDB and re-chunk with FastCDC **without** a catastrophic full resync (ties to the "make parameters migratable" change).
5. **Single-binary vs broker** — is a tiny always-on server acceptable to you, or is a passive object store (no server process) the real "dead simple" bar?

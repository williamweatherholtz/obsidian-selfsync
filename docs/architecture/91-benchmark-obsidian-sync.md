# Benchmark: How Obsidian's Official Sync Works (and where we can beat it)

> The bar for this project is **flawless desktop↔mobile sync**, and official Sync is the reference. This is the verified teardown (deep-research 2026-07-02; 24/25 claims confirmed, 1 refuted). Sources: Obsidian's own docs/blog/security page, the independent reverse-engineering repo `zyrouge/rev-obsidian-sync`, and DeepWiki mirrors of the official help repo. Protocol details reflect a community server reimplementation, not Obsidian's actual server code — exact wire framing would need an on-device capture.

## Architecture (verified)

- **Transport:** WebSocket Secure — `wss://sync-xx.obsidian.md` (xx = 1–100, regional, on DigitalOcean). **Push-based, near-real-time — NOT polling** (the polling hypothesis was explicitly refuted 0-3).
- **Model: server-authoritative with a monotonic per-vault integer version counter.** Each device holds a **full local copy**. On connect the client sends its version; if the server's is higher it pushes changed-file metadata; the client filters by hash and pulls what it lacks. Every client push **bumps the version and is broadcast** to all connected clients. This persistent-push relay is the core reason it "feels instant" on desktop↔mobile.
- **Transfer granularity:** appears to be **full-file / full-revision** — no evidence of rsync-style delta or block transfer at the wire level (⚠️ *not confirmed*; an open item). No content-defined chunking or dedup.
- **Offline-first:** edits happen locally without a connection and reconcile on reconnect.

## Conflict & version model (verified)

- **Per-file-type resolution, client-side:**
  - **Markdown → Google `diff-match-patch` merge** (the same library LiveSync already uses in `mergeSensibly`).
  - **Settings/JSON → apply local keys over remote.**
  - **Binary / canvas → last-modified-wins.**
- Since **v1.9.7**, configurable per device: **Automatically merge** (default; can create duplicate text) vs **Create conflict file** (`… (Conflicted copy <device> YYYYMMDDHHMM).md`).
- **Version history:** per-file, retained **1 month (Standard) / 12 months (Plus)**; attachments only ~2 weeks. Snapshot + deleted-file restore. (This lives server-side — the server is *not* a dumb blob store.)

## Encryption (verified)

- **AES-256-GCM.** Wire format: 12-byte IV + ciphertext + 16-byte GCM auth tag.
- **Key derivation:** `scrypt(N=32768, r=8, p=1, 32 bytes)` from a **vault password + per-vault salt**, then **HKDF-SHA256** with info string `"ObsidianAesGcm"` (encryption v3).
- **Zero-knowledge for content:** the vault password is separate from account creds, **never sent/stored**; the server authorizes via a **SHA-256 keyhash** of the derived key. Lost password = unrecoverable. Obsidian publishes a step-by-step method to independently verify E2EE.
- **Metadata is NOT E2E encrypted:** uploader device, timestamps, and the **mapping between encrypted path and encrypted content** are server-readable, and there is **no cryptographic binding between path and content** (Obsidian's own security page flags a compromised server could tamper with that mapping; content stays encrypted).

## Strategic read — where we MATCH vs BEAT

**Match (adopt these — they're why it feels perfect):**
- **wss push + per-vault monotonic version counter** → real-time desktop↔mobile. Our single-binary store should do exactly this (oplog + version counter + WebSocket broadcast).
- **Server-side version history** → nearly free for us: a content-addressed chunk store already retains old chunks.
- **Crypto choice validates our research direction independently:** official Sync uses **scrypt + AES-256-GCM + HKDF** — the same family the Cryptomator-pattern research recommended. Strong confirmation.
- **Markdown conflict merge via diff-match-patch** — LiveSync already does this; keep it.

**Beat (our differentiators):**
1. **Transfer efficiency** — official Sync appears to move **whole files**; our **FastCDC content-defined chunking + dedup** transfers only changed blocks → faster large-file/large-vault sync, less bandwidth/battery. This is a concrete edge, not just parity.
2. **Metadata privacy** — official Sync leaves **path↔content unbound and paths' mapping server-readable**. We can **encrypt names/paths and cryptographically bind path↔content** (per the E2EE research), beating it on the threat model.
3. **Self-hosted & free** — no subscription, data on your own box; official Sync is a paid hosted service.
4. **Configurable conflict safety** — offer safe defaults (incl. for binaries, which official Sync resolves by blind last-modified-wins).

**Documented weaknesses of official Sync to avoid repeating:** auto-merge can inject **duplicate text**; there are forum reports of **data-loss incidents**; the **path/content tamper** gap above.

## Mobile feasibility (Area B) — mostly UNRESOLVED by desk research

- **Verified constraint:** the Obsidian mobile plugin sandbox has **no Node.js / Electron APIs** (calling them can crash the plugin) — a mobile engine must use only browser/Capacitor web APIs (guard with `Platform.isIosApp/isAndroidApp`, `isDesktopOnly`).
- **Existence proof:** Self-hosted LiveSync already ships a **client-side E2EE (AES-256-GCM/HKDF, off-main-thread worker) sync engine on iOS/Android** over commodity servers — so the approach is feasible in the sandbox.
- **⚠️ Still open — on-device-test questions (not answerable from docs):** WebCrypto/SubtleCrypto throughput for AES-GCM/HKDF on mid-range phones; whether scrypt/argon2 must run in JS/WASM (SubtleCrypto lacks them); IndexedDB quota/eviction, OPFS availability, localStorage limits; Web Worker reliability on mobile; iOS ~30s background-task budget vs Android WorkManager ~15-min floor / foreground-service options — i.e. **can meaningful sync run backgrounded at all**; memory/large-file limits (Android OOM reports); `requestUrl`/CORS and streaming constraints; and whether **FastCDC + AES-GCM can complete an initial sync of a GB-scale vault within the mobile budget**.
- **Design implication:** treat mobile as **foreground-first, incremental, resumable, chunk-bounded**; don't assume background sync; validate the throughput/quota unknowns with a small **on-device spike** before locking the design.

## Open items carried into design
1. Confirm official Sync's transfer granularity (full-file vs any delta) via network capture — *optional; we beat it either way with chunking.*
2. The Area B on-device performance/quota/background spike (above) — **the real remaining risk.**

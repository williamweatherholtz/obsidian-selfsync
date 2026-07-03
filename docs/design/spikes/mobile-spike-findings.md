# Mobile Feasibility Spike — Findings

> Resolves the mobile unknowns from `../design-spec.md` §9.2. Method: (1) **existence-proof** from the archived LiveSync code (it ships on iOS/Android), (2) **targeted research** on the Obsidian-mobile/Capacitor WebView (2025–2026, primary sources), and (3) a **runnable on-device benchmark** (this environment can't drive a physical phone, so the numeric unknowns are handed to you as an instrument to run). Verdict up top: **feasible** — the sandbox supports every primitive our (lighter-than-LiveSync) client needs — but the research surfaced **four design-changing constraints** that the spec now reflects.

## Run the benchmark on your phone

**→ https://claude.ai/code/artifact/c520b5ec-5d85-4edb-99d6-2fee8707bd6e**

Open it on your iPhone/Android (ideally also inside Obsidian's in-app browser if possible), tap **Run benchmark**, then **Copy results** and paste them back. It measures, on-device: content-defined chunking (gear-hash CDC), SHA-256, AES-256-GCM, IndexedDB read/write, OPFS availability, and reports device/quota info. Source is versioned at `mobile-benchmark.html`. (It's a dependency-free proxy — real blake3/FastCDC WASM will differ, but this bounds the compute envelope.)

## Existence-proof (from the archived code)

The archived LiveSync (`obsolete/`) already ships on iOS/Android doing **heavier** work than our design needs, using: **Web Workers** (`bgWorker.splitting.ts`, `bgWorker.encryption.ts`), **WebCrypto** (`crypto.subtle`), **IndexedDB/PouchDB** (`KeyValueDB`, idb adapter), **`requestUrl`** (CORS-bypassing fetch), guarded by **`Platform.isIosApp/isAndroidApp`**. So workers, WebCrypto, and IndexedDB demonstrably work in the sandbox — our client (no content E2EE, simpler store) is strictly lighter. (OPFS appears only in the *web-app* variant, confirming it's optional, not required.)

## Resolved facts (research, with confidence)

| Area | Finding | Confidence |
|------|---------|:---:|
| **OPFS** | Available in iOS WKWebView (WebKit 15.2+) & Android WebView; **use `createSyncAccessHandle()` in a Worker** (Safari's `createWritable` is flaky). Good fast local-cache path. | High (exists) / Med (at scale) |
| **IndexedDB quota** | ~**15% of disk per origin** for WKWebView-embedded apps (gigabytes on modern phones); old 500 MB iOS cap is gone. `localStorage` ~10 MiB → unusable for bulk. | High |
| **iOS 7-day eviction** | The ITP 7-day script-storage wipe **does NOT apply inside a WKWebView app** (own day-counter, resets each launch). Eviction only under genuine storage pressure. Our local cache is safe. | High |
| **WebCrypto** | AES-256-GCM is hardware-accelerated (hundreds of MB/s–~1 GB/s); PBKDF2/HKDF available; **scrypt/argon2 absent → WASM**. (Moot for us: no content E2EE; auth password hashing is server-side argon2 in Rust.) | High (API) / Low (mobile MB/s) |
| **blake3 / FastCDC** | Maintained WASM packages exist (`hash-wasm` for blake3; `@dstanesc/wasm-chunking-fastcdc`). Desktop blake3 ~435 MB/s→2.2× with SIMD; **no mobile figure** → benchmark. | High (exists) / Low (mobile perf) |
| **Web Workers on mobile** | Not documented by Obsidian, but LiveSync ships worker-based chunking/encryption on mobile → **works in practice**. | High (empirical) |

## ⚠️ Design-changing constraints (folded into the spec)

1. **Background sync is impossible as plugin JS.** iOS WKWebView **halts all JavaScript when the app is backgrounded** (timers stop); Android throttles/suspends similarly; Obsidian exposes **no background-task bridge** to plugins. → Sync runs **only while Obsidian is foregrounded** (on open, on foreground-return, and on file changes while open). This is a hard limit, not a preference — matches, and is stricter than, official Sync's practical mobile behavior.
2. **No partial/streaming file reads; `readBinary` loads the whole file into memory and can OOM-crash on large files.** There is no byte-range/streaming vault API. → We cannot chunk a huge attachment without loading it whole; **cap/guard large-attachment handling** (size threshold + warning) rather than assume streaming.
3. **`requestUrl` can't stream and struggles with large transfers (~20–50 MB+); it buffers whole responses.** → Keep transfers **chunk-sized** (our design already sends ~small chunks, so this fits). **Prefer `fetch` + permissive CORS on our own server** (we control it) to get streaming and avoid `requestUrl` limits — *verify on-device that Obsidian mobile allows `fetch`/WebSocket to our origin with CORS; fall back to `requestUrl` with small chunked requests if not.*
4. **Local store: OPFS (sync-handle-in-worker) preferred; IndexedDB is a safe fallback** (ITP-exempt in WKWebView). `localStorage` is out (10 MiB).

## Must be measured on-device (the benchmark + a later test plugin)

The benchmark URL above answers 3, 5, and storage/quota. These still need a real device (and, for the Obsidian-specific ones, a tiny test plugin — a follow-up):
1. OPFS sustained large-file write reliability inside the Obsidian build.
2. Real eviction behavior for a multi-GB vault under low disk.
3. AES-256-GCM / blake3 / FastCDC **MB/s in the Obsidian WebView** (+ is WASM **SIMD** enabled?).
4. `readBinary` memory ceiling before OOM (largest safe attachment).
5. Whether `fetch`/WebSocket to our server works from Obsidian mobile (CORS), or we must use `requestUrl`.
6. iOS foreground-suspension grace window mid-sync (assume ~0).

## Net verdict

**Feasible.** No blocker: every required primitive is supported (proven by LiveSync shipping). The design must be **foreground-only, chunk-bounded, resumable, and careful with large-file memory** — which the spec already leaned toward and now states as hard constraints. The remaining risk is purely **quantitative** (throughput/quota), retired by running the benchmark on your device(s).

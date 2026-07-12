# SelfSync — performance: scale & propagation latency (headless harness)

**Harness:** `client/perf/` (`npm run test:perf`). Spawns the **real** server binary + headless clients
driving the real chunk + reconcile engine. This is the repeatable synthetic pass; a real-device pass
(desktop + phone, BRAT) follows for fidelity — see `93-real-device-perf-protocol.md`.

**Environment for the numbers below:** one Windows dev machine, **loopback** (127.0.0.1 — no network
RTT, no TLS), server built in **`--debug`** (a `--release` build is materially faster). So treat these
as *relative* shape + a pessimistic floor, not production absolutes.

## Scale — initial sync + reconcile cost by vault size

| vault | files | MB | push (s) | pull (s) | no-op rescan (ms) | notes/s | MB/s |
|---|--:|--:|--:|--:|--:|--:|--:|
| 200 notes | 200 | 0.3 | 2.74 | 0.45 | 41 | 73 | 0.1 |
| 1000 notes | 1000 | 1.4 | 8.01 | 1.36 | 185 | 125 | 0.2 |
| 3000 notes + 20×256KB | 3020 | 9.3 | 27.20 | 3.71 | 373 | 111 | 0.3 |

**Reading it:**
- **Initial push is the dominant cost** and scales ~linearly with file count (~110 notes/s here). It's
  **per-file-round-trip bound, not bandwidth bound** — each file is a `chunks/missing` + `put` + `commit`
  round trip, so many small notes cost more than the MB/s suggests (the 5 MB of attachments rode along
  inside the 27 s). On a release build over a real (non-loopback) link the constant changes, but the
  shape — cost ∝ number of files — holds.
- **Pull is ~6–7× faster than push** (0.45 / 1.36 / 3.71 s): downloading + writing is cheaper than
  chunking + committing.
- **No-op rescan stays sub-second even at 3000 files** (41 → 373 ms): the scan-skip cache (size+mtime)
  is doing its job — a steady-state full pass does **not** re-hash the vault.

## Propagation latency — one edit, A → B round-trip

Measured as the **transfer** round-trip: A pushes the edited file via the event path (`reconcilePath`,
single file), B polls (`changes`) and applies via the delta path (`reconcileDelta`). End-to-end user
latency = this **plus the notify delay** (≈instant on the realtime WebSocket; ≤ the poll interval —
4 s active / 60 s idle — when falling back).

| baseline vault | p50 (ms) | p95 (ms) | max (ms) | (n=20) |
|---|--:|--:|--:|--:|
| 50 notes | 20 | 29 | 29 | |
| 3000 notes | 29 | 43 | 43 | |

**Reading it:** propagation is **essentially flat across vault size** (20 → 29 ms p50 from 50 to 3000
notes) — the event + delta paths are **O(change), not O(vault)**, so a big vault doesn't slow down how
fast a single edit moves between devices. (This is the path the `reconcileDelta` presence-guard fix
hardened; the transfer cost is unaffected.)

## Takeaways

- Steady-state sync (the common case — an edit here and there) is **fast and flat regardless of vault
  size**: ~tens of ms transfer + the notify delay.
- The one cost that grows with the vault is the **one-time initial sync** (and it's per-file-bound).
  For very large vaults the first sync is measured in tens of seconds; everything after is incremental.
- No steady-state re-hashing (scan-skip), and pull is cheap.

## Caveats / not yet measured (this pass = scale + latency only)

- Loopback + debug build + single machine → real network RTT/TLS and a release build will shift the
  absolutes (RTT adds to every per-file round trip on push; release speeds the server).
- Not covered here (future passes): multi-device concurrency/conflict convergence, server load/soak with
  many users, and mobile battery/CPU/background — those need the real-device protocol and/or a load rig.

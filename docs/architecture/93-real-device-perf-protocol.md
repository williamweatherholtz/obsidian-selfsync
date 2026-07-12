# SelfSync — real-device performance protocol (scale & propagation)

The headless harness (`92-perf-scale-latency.md`) gives repeatable numbers over loopback with a debug
build. This is the **fidelity pass**: real Obsidian on real devices, over a real network, against a
real deployed server — to confirm the shape holds and catch anything only the real app/OS/network shows
(TLS + RTT on every round trip, mobile CPU/battery/background, the realtime-WS notify path). Focused on
the two chosen dimensions: **scale** and **propagation latency**.

## Setup (once)

1. Deploy the SelfSync server behind your TLS reverse proxy (the production posture). Note the https URL.
2. Install **1.0.15** via BRAT (`williamweatherholtz/obsidian-selfsync`) on **desktop** and **phone**.
3. Create a test account; set up both devices to sync the same vault (desktop = A, phone = B).
4. Record the context: server host (CPU/RAM), proxy, both devices' OS + model, and the network for each
   test (home wifi / cellular).

## Test 1 — Scale (initial sync of a large vault)

1. On **desktop A**, prepare a large real vault (a few thousand notes + some attachments — a real vault
   or a copy). Record file count + total MB (`92`'s harness used 3000 notes + 5 MB attachments as the
   top size — match or exceed).
2. Fresh-install the plugin on A (or clear its state) and point it at an **empty** server vault. Start a
   stopwatch, trigger the first sync, stop when the status light reads "Fully synced". → **initial push**.
3. On **phone B** (fresh), set it to sync that vault. Time from start to "Fully synced". → **initial pull**.
4. After both are synced, reopen A and note the time to a steady "Fully synced" (no work) → **no-op**
   (should be ~instant; validates scan-skip on the real FS).
5. Watch for: memory/CPU spikes (desktop task manager / phone), any errors in the sync log, battery draw
   on the phone during the initial pull.

## Test 2 — Propagation latency (edit A → visible on B)

Do this run **twice**: once with the phone on **wifi**, once on **cellular**.

1. Both devices synced + idle, both showing green. Put them side by side.
2. On **desktop A**, edit a note (type a distinctive word) and save.
3. Start a stopwatch; stop when the change appears on **phone B**. Record. Repeat ~10 times; note the
   median and the worst.
4. Repeat in the reverse direction (edit on B → appears on A).
5. Note whether B's light showed the realtime state (instant) or fell back to polling (up to the poll
   interval) — i.e. was the WebSocket up. The harness measured **transfer only (~20–40 ms)**; real
   end-to-end = transfer + network RTT + the notify delay.

## Bonus — mobile fidelity (if time)

- Background behavior: edit on A while B (phone) is backgrounded, then foreground B — how long to catch
  up? (Mobile has no `raw` file watcher; the config/full scan cadence is the backstop.)
- Battery: rough %/hour during active two-way editing vs idle-synced.

## Results template (fill in, then compare to `92`)

| metric | harness (loopback/debug) | desktop A | phone B (wifi) | phone B (cellular) |
|---|---|---|---|---|
| initial push, N-note vault (s) | 27 s @ 3020 files | | | |
| initial pull (s) | 3.7 s @ 3020 files | | | |
| no-op resync | 0.4 s | | | |
| propagation A→B, median (ms) | 29 (transfer only) | | | |
| propagation A→B, worst (ms) | 43 (transfer only) | | | |
| notify path observed (WS / poll) | n/a | | | |

**Pass criteria (proposed):** steady-state propagation feels instant on wifi with the WS up (sub-second);
initial sync of a few-thousand-note vault completes without error or runaway memory; no-op resync is
effectively free. File anything that misses as an `Issue` and route it (fix or accepted-risk).

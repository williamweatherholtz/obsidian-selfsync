# SelfSync — durability journal + true streaming (design, for review)

**Date:** 2026-07-05 · **Status:** DESIGN — not implemented; needs review + sign-off.
**Why design-first:** this touches the data-integrity path; a subtle bug here loses data,
which "test later" won't reliably catch — review before implementing.

## Two independent problems

### 1. Index durability — append-only journal

**Today:** each commit/delete rewrites the whole `.sync-index.json` atomically (tmp + rename).
Correct and crash-safe, but **O(index size) per write** — a large vault pays to rewrite the
entire manifest on every single-file change.

**Proposed:** an append-only **journal** (`.sync-index.log`): each commit/delete appends one
record (`fsync`'d). The in-memory index is the source of truth at runtime; the journal is the
durable record. On startup, replay the journal to rebuild the index. **Compact** periodically
(when the journal exceeds N× the live index): write a fresh snapshot + truncate the log
(the existing atomic snapshot write becomes the compaction step).

- Crash safety: a half-written trailing record is detected (length/checksum per record) and
  discarded on replay — the last complete record wins.
- Keeps the current snapshot format as the compaction target (backward compatible; the
  reindex path is unchanged).
- Control totals on replay (record count vs live entries) guard against silent loss.

### 2. Transfer streaming — no whole-file in RAM

**Today:** `fetchFileBytes` fetches all chunks then `concat`s them into one `Uint8Array`
before `io.write` — so a large file is held **entirely in memory** during reassembly (a
mobile OOM risk; the whole reason for the 200 MiB size gate).

**Proposed:** stream reassembly — write each chunk to the file at its byte offset as it
arrives (or append in order), so peak memory is ~one chunk, not the whole file. On the server,
stream chunk-store reads/writes rather than buffering. This lets the client's size gate rise
substantially.

- Client: needs an `io.writeAt(path, offset, bytes)` (or append) capability; Obsidian's
  adapter supports positioned writes on desktop; **verify on mobile** (may fall back to the
  current buffered path under a threshold).
- Interacts with B11 (parallel transfer): parallel fetch + streamed positioned writes compose
  (each worker writes its chunk's offset); order no longer needs a concat.
- The server already stores per-chunk; streaming its reads is a `Body` stream instead of a
  buffered `Vec<u8>`.

## Phasing (independently shippable)

1. **Journal** first (server-only, no protocol change) — biggest durability + large-vault
   write-cost win. Migration: on first start, seed the journal from the current snapshot.
2. **Streaming reassembly** (client, then server) — raises the size gate; verify on mobile.

## Open questions for you

1. Journal compaction threshold + whether to `fsync` every record (durability) vs batch
   (throughput) — a durability/latency trade-off.
2. Raise/remove the 200 MiB client size gate once streaming lands, and to what?
3. Is the large-vault write cost actually biting yet, or is this premature? (Deferred as
   "don't rush the data-integrity path" — confirm it's worth doing now.)

Nothing here is built — review before implementation.

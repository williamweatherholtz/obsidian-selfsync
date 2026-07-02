# Commonlib: RPC / Transport

> AS-BUILT architecture of the `rpc` module inside `livesync-commonlib`
> (`src/lib/src/rpc/`). Reverse-engineered read-only from source at repo HEAD.
> Symbol names and paths verified against the files listed below. Where behaviour
> could not be confirmed from source it is flagged explicitly.

## Purpose & responsibilities

The `rpc` module is a **transport-agnostic, type-safe request/response RPC layer** that
lets one JavaScript context call named `async` methods on a remote peer as if they were
local functions. It is self-described in `src/lib/src/rpc/README.md` as a "Generic
Peer-to-Peer RPC Library" and in `SPEC.md` as a candidate for extraction into a
standalone package.

Its responsibilities, all handled internally so callers only see `call()`/`register()`:

- **Request/response correlation** — every call gets a unique `requestId`, tracked in a
  pending-invocation map until a response arrives or a timeout fires.
- **Method registration & dispatch** — namespaced method handlers (`register`), optional
  per-method serialisation (`serial: true`).
- **Serialisation** — JSON only (`JSON.stringify`/`JSON.parse` of an `RpcEnvelope`).
- **Chunking & reassembly** — payloads over `maxWirePayloadBytes` (default 32 KiB) are
  split into `chunk` wire messages and reassembled, with a timer-based NACK
  retransmission scheme (`chunk-ack`).
- **Error propagation** — remote handler exceptions are converted to a serialisable
  `RpcErrorShape` and re-thrown as `RpcError` on the caller side.
- **Version handshake** — a `handshake` envelope on peer join carries `versionMajor`/
  `versionMinor` (currently `1.0`) for compatibility checks.
- **PouchDB-over-RPC** (`pouchdb/` sub-module) — exposes a local PouchDB database as RPC
  methods (`exposeDB`) and provides a PouchDB-shaped client proxy (`RpcPouchDBProxy`) so
  native `PouchDB.replicate()`/`.sync()` work across the transport.
- **A Trystero (WebRTC/Nostr) transport binding** (`transports/`) plus WebRTC connection
  diagnostics.

The RPC core itself contains **no transport**; a caller supplies any bidirectional
channel implementing the `TransportAdapter` interface.

## Files & LOC (table)

| File | LOC | Role |
|------|----:|------|
| `rpc/index.ts` | 16 | Public barrel export (`RpcRoom`, `RpcSession`, `RpcError`, `exposeDB`, `RpcPouchDBProxy`, types) |
| `rpc/types.ts` | 96 | All wire/envelope/adapter type definitions + version constants |
| `rpc/errors.ts` | 27 | `RpcError` class + `asRpcErrorShape()` |
| `rpc/chunking.ts` | 61 | `estimateBytes`, `splitIntoChunks`, `IncomingChunkBuffer` |
| `rpc/RpcRoom.ts` | 355 | Core hub: dispatch, pending calls, chunking, handshake, serial queue |
| `rpc/RpcSession.ts` | 37 | Per-peer call helper + namespace `Proxy` factory |
| `rpc/pouchdb/RpcPouchDBServer.ts` | 83 | `exposeDB()` — registers PouchDB ops as RPC methods; `runDB` error wrapper |
| `rpc/pouchdb/RpcPouchDBProxy.ts` | 176 | `RpcPouchDBProxy` — PouchDB-compatible client (EventEmitter + thenable changes feed) |
| `rpc/transports/TrysteroTransport.ts` | 406 | Trystero (WebRTC/Nostr) `TransportAdapter`, advertisement discovery, high-level DB server/client helpers |
| `rpc/transports/trysteroUtils.ts` | 42 | `generateJoinRoomOptions()` — builds Trystero room config from settings |
| `rpc/transports/DiagRTCPeerConnections.ts` | 263 | Diagnostic `RTCPeerConnection` subclass + status/failure subscriptions |
| `rpc/transports/DiagRTCPeerConnections.types.ts` | 68 | Diagnostic type definitions |
| `rpc/transports/DiagRTCPeerConnections.utils.ts` | 340 | RTC failure diagnosis + stats helpers |
| `rpc/README.md` | 584 | Design/usage documentation |
| `rpc/SPEC.md` | 260 | RFC-2119 normative spec |
| `rpc/RpcHelpers.unit.spec.ts` | 25 | Tests |
| `rpc/RpcRoom.unit.spec.ts` | 252 | Tests |
| `rpc/pouchdb/RpcPouchDBSync.unit.spec.ts` | 535 | Tests |
| `rpc/transports/TrysteroTransport.unit.spec.ts` | 711 | Tests |

Non-test, non-doc production TS: ~1,970 LOC (matches the stated ~2K scope).

## Key types / data structures (messages, envelopes)

Defined in `rpc/types.ts`.

**Two-layer message model.** An application-level `RpcEnvelope` is JSON-serialised, then
wrapped in a transport-level `RpcWireMessage` that carries chunking metadata. The
transport only ever moves `RpcWireMessage` objects.

`RpcEnvelope` (discriminated on `kind`):

| `kind` | Shape |
|--------|-------|
| `"request"` | `{ requestId, method, args: JsonLike[] }` |
| `"response"` (ok) | `{ requestId, ok: true, data: JsonLike }` |
| `"response"` (err) | `{ requestId, ok: false, error: RpcErrorShape }` |
| `"cancel"` | `{ requestId }` |
| `"handshake"` | `{ versionMajor, versionMinor }` |

`RpcWireMessage` (discriminated on `wire`):

| `wire` | Shape | Purpose |
|--------|-------|---------|
| `"raw"` | `{ payload: string }` | Complete JSON envelope within size limit |
| `"chunk"` | `{ streamId, index, total, payload }` | One segment of a split envelope |
| `"chunk-ack"` | `{ streamId, missing: number[] }` | NACK (non-empty `missing`) or completion signal (empty) |

Supporting types:

- `JsonLike` — recursive JSON value type; the only serialisable payload type.
- `RpcErrorShape` — `{ code: RpcErrorCode, message, details?: JsonLike }`.
- `RpcErrorCode` — `"TIMEOUT" | "NOT_CONNECTED" | "REMOTE_ERROR" | "CANCELLED" | "PROTOCOL_ERROR"`.
- `TransportAdapter` — `send(message, peerId)`, `onMessage(handler) → unsubscribe`,
  optional `onPeerJoin`/`onPeerLeave`.
- `RpcRoomOptions` — `{ transport, maxWirePayloadBytes?, chunkMissingRetryMs?, canAcceptRequest?, onProtocolWarning? }`.
- `RpcMethodHandler<T,U>` — `(peerId, ...args: T) => U | Promise<U>`.
- Version constants: `RPC_VERSION_MAJOR = 1`, `RPC_VERSION_MINOR = 0`.

`RpcError` (`rpc/errors.ts`) extends `Error`, carries `code` and optional `details`, and
has `toShape()`. `asRpcErrorShape(ex)` normalises any thrown value into an `RpcErrorShape`
(non-`RpcError` errors become `code: "REMOTE_ERROR"`).

## Protocol / message flow (DEEP)

All logic lives in `RpcRoom` (`rpc/RpcRoom.ts`). A single `RpcRoom` is symmetric — it is
simultaneously a client (issues calls) and a server (registers handlers) for every peer.

### Connection / handshake

On construction the room subscribes to `transport.onMessage`. If the transport supports
`onPeerJoin`, the room sends a `handshake` envelope to each joining peer. Incoming
handshakes are stored in a per-peer `peerVersion` map. `onPeerLeave` drops the peer's
session and version entry. Peer versions are used later during inbound dispatch (see
error handling).

### Outbound call (`invoke` → `sendEnvelope`)

1. `invoke(peerId, method, args, timeoutMs = 30000)` validates the method is namespaced
   (contains `.` or `/`), else throws `RpcError("PROTOCOL_ERROR")`.
2. Generates `requestId = "req-<base36 time>-<random>"` (`newId`).
3. Creates a pending Promise; if `timeoutMs > 0`, arms a `setTimeout` that deletes the
   pending entry and rejects with `RpcError("TIMEOUT")`.
4. Registers the pending entry **then** sends the `request` envelope.
5. `sendEnvelope` JSON-serialises the envelope. If `estimateBytes ≤ maxWirePayloadBytes`,
   it sends a single `{ wire:"raw" }`. Otherwise it allocates a `streamId`, splits via
   `splitIntoChunks`, stores the outgoing chunks in `outgoingChunkMap`, and sends N
   `{ wire:"chunk" }` messages.

### Inbound dispatch (`onWireMessage` → `onEnvelopePayload`)

`onWireMessage` demultiplexes by `wire`:

- **`raw`** → decode payload directly.
- **`chunk`** → buffer into an `IncomingChunkBuffer` keyed by `streamId`, (re)schedule the
  missing-chunk timer. When complete: clear the timer, send a `chunk-ack` with empty
  `missing` (completion signal), reassemble via `toPayload()`, then decode.
- **`chunk-ack`** → look up the outgoing stream. Empty `missing` ⇒ delete the stream
  (done). Non-empty ⇒ retransmit exactly the listed chunk indices.

`onEnvelopePayload` `JSON.parse`s the payload (parse failure → `onProtocolWarning`, drop),
then dispatches by envelope `kind`:

- **handshake** → record version; if `versionMajor` differs, emit `onProtocolWarning`.
- **cancel** → set `cancelled = true` on the matching `InboundCallContext` (if present).
- **response** → look up pending by `requestId`; if found, delete it, clear its timeout,
  and resolve with `data` or reject with a reconstructed `RpcError`.
- **request** → the handler path (below).

### Request handling (server side)

1. `canAcceptRequest?(peerId, method)` gate: if it returns `false`, the request is
   **silently dropped** — no response is sent. The caller only learns via timeout (a
   deliberate design choice per the inline comment "Intentional timeout semantics for
   unauthorized caller").
2. Version check: if the stored peer `versionMajor` differs, reply with a `REMOTE_ERROR`
   response (a minor mismatch only warns).
3. Method lookup: unknown method → `REMOTE_ERROR` response `"Method not found: <m>"`.
   (Note: an unregistered method returns `REMOTE_ERROR`, *not* `PROTOCOL_ERROR` — the
   latter is thrown only locally on `register`/`invoke` for non-namespaced names.)
4. Create an `InboundCallContext { cancelled }`, keyed by `requestId` in `inboundCalls`.
5. `runner()`: checks `cancelled` before and after awaiting the handler; on success sends
   an `ok:true` response; on throw converts via `asRpcErrorShape` and sends `ok:false`;
   `finally` deletes the inbound context. **If cancelled it still sends a `CANCELLED`
   error response** (the handler throws `RpcError("CANCELLED")`) — this appears to
   contradict SPEC `[P-10]` ("MUST NOT send a response after receiving a cancel"); flagged
   as an observation, not verified against tests.
6. Serial methods (`serial: true`) chain onto `method.queue` so invocations run one at a
   time; non-serial run immediately.

### Cancellation

`cancel(peerId, requestId)` sends a `cancel` envelope. Per SPEC and the code, sending a
cancel does **not** settle the caller's pending invocation — it still resolves on the
response or rejects on timeout.

### Serialisation & chunking details

- Only JSON is supported; binary must be Base64-encoded by callers (SPEC §8).
- `splitIntoChunks` (`chunking.ts`) is UTF-8-byte-aware: it slices by character index but
  shrinks each slice until its `TextEncoder` byte length fits `maxBytes` (min chunk 16
  chars of the working window; degrades to 1-char steps for wide multibyte runs).
- `IncomingChunkBuffer` stores parts in a `Map<index, string>`, computes `missingIndices`,
  and reassembles in index order (`toPayload` throws if a part is missing).
- Ordering/duplication tolerant (SPEC [T-3]): chunks keyed by `streamId`+`index`.
- `raw` single-frame messages are **not** retransmitted — only multi-chunk streams have
  the NACK safety net (SPEC [T-4]). On an unreliable transport a lost `raw` message
  simply times out.

### Error handling summary

Local validation errors → thrown `RpcError("PROTOCOL_ERROR")`. Remote handler throws →
serialised into the response `error` and rethrown caller-side as `RpcError`. No response
within deadline → `RpcError("TIMEOUT")`. Room closed → all pending rejected with
`RpcError("NOT_CONNECTED", "Room closed")`. `RpcSession.call` throws
`RpcError("NOT_CONNECTED")` if `peerId` is empty.

## What it underlies (be explicit)

**This RPC layer underlies Obsidian LiveSync's peer-to-peer (P2P) replication over
WebRTC — it is NOT used for workers, and it does not underlie the app↔core boundary or
CouchDB/remote-server replication.** Evidence:

- The only production consumer outside `rpc/` is `src/lib/src/replication/trystero/`:
  - `TrysteroReplicatorP2PServer.ts` imports `RpcRoom`, `TransportAdapter`,
    `RpcWireMessage` from `@lib/rpc` and `TRYSTERO_RPC_DEFAULTS`,
    `generateJoinRoomOptions`, and the DiagRTC status subscriptions from
    `@lib/rpc/transports/*`. In `onAfterJoinRoom()` it builds a `TransportAdapter` around
    a Trystero `room.makeAction<RpcWireMessage>("rpc2")` channel and constructs an
    `RpcRoom` with a `canAcceptRequest` auth gate and `onProtocolWarning` logging.
  - `TrysteroReplicatorP2PClient.ts` reaches the server's `rpcRoom` to issue calls.
- The transport of record is **Trystero over Nostr** (`@trystero-p2p/nostr`), i.e. WebRTC
  data channels signalled via Nostr relays, keyed to the LiveSync `sls+p2p://` connection
  string / `P2PConnectionInfo` settings.
- The `pouchdb/` sub-module makes a local PouchDB database directly replicable to a remote
  peer via native `PouchDB.replicate()`/`replicateShim` across the RPC transport — the
  concrete purpose is **P2P database replication between LiveSync devices**.

Notably, the production P2P server (`TrysteroReplicatorP2PServer`) **re-implements the
transport-adapter wrapping inline** rather than calling `wrapTrysteroRoom()` from
`TrysteroTransport.ts` (both create an `"rpc2"` action, so they are compatible but
duplicated). The high-level helpers `serveTrysteroDB`/`connectTrysteroDBClient` and
`wrapTrysteroRoom` in `TrysteroTransport.ts` appear to be a library/CLI-facing convenience
surface (and are heavily unit-tested) that the main replicator does not itself call.

The README explicitly frames the transport as pluggable (WebRTC, WebSocket,
`BroadcastChannel`, Electron `ipcRenderer`, in-process queues) — so it *could* underlie
worker/iframe or app↔core comms — but **no such transport binding exists in this codebase**;
only the Trystero/WebRTC binding is present. State this as designed-for, not as-built.

## Function/class inventory (per file)

### `rpc/index.ts`
Re-exports `RpcRoom`, `RpcSession`, `RpcError`, `exposeDB`, `RpcPouchDBProxy`, and the
public types.

### `rpc/types.ts`
Type-only + constants (`RPC_VERSION_MAJOR/MINOR`). No runtime functions.

### `rpc/errors.ts`
- `class RpcError extends Error` — `constructor(code, message, details?)`; `toShape(): RpcErrorShape`.
- `asRpcErrorShape(ex: unknown): RpcErrorShape` — normalises any thrown value.

### `rpc/chunking.ts`
- `estimateBytes(text: string): number` — UTF-8 byte length via a shared `TextEncoder`.
- `splitIntoChunks(payload: string, maxBytes: number): string[]` — byte-bounded splitter.
- `class IncomingChunkBuffer` — `add(index, payload)`, `missingIndices()`, `isComplete()`,
  `toPayload()`.

### `rpc/RpcRoom.ts`
- `class RpcRoom` — constructor `(options: RpcRoomOptions)`; wires transport listeners &
  handshake.
  - `close()` — dispose transport sub, reject all pending, clear all state/timers.
  - `session(peerId): RpcSession` — memoised per-peer session.
  - `register(method, handler, options?)` — validate namespace; store handler + serial flag + queue.
  - `invoke(peerId, method, args, timeoutMs=30000): Promise<JsonLike>` — issue a call.
  - `cancel(peerId, requestId)` — send a `cancel` envelope.
  - `private sendEnvelope(peerId, envelope)` — serialise; raw-or-chunk send.
  - `private scheduleMissingAck(streamId, peerId)` — arm NACK timer.
  - `private onWireMessage(message, peerId)` — wire demux (raw/chunk/chunk-ack).
  - `private onEnvelopePayload(payload, peerId)` — envelope dispatch + request handling.
  - Module helpers: `newId(prefix)`, `validNamespacedMethod(method)`.

### `rpc/RpcSession.ts`
- `class RpcSession` — `constructor(room, peerId)`; `readonly peerId`.
  - `call<T>(method, args=[], timeoutMs?): Promise<T>` — thin wrapper over `room.invoke`.
  - `createProxy<T>(namespace): T` — returns a `Proxy` where each property access becomes
    an async method calling `"<namespace>.<prop>"`.

### `rpc/pouchdb/RpcPouchDBServer.ts`
- `runDB<T>(fn): Promise<T>` (module-private) — wraps PouchDB errors carrying
  `status`/`name` into `RpcError("REMOTE_ERROR", …, { status, name?, reason? })`;
  re-throws generic errors unchanged.
- `exposeDB(room, db, ns="pdb"): void` — registers `<ns>.info`, `.id`, `.changes` (forced
  `live:false`, resolves on the changes feed `complete` event), `.get`, `.put`,
  `.bulkGet`, `.bulkDocs`, `.revsDiff`, `.allDocs`.

### `rpc/pouchdb/RpcPouchDBProxy.ts`
- `class RpcPouchDBProxy extends EventEmitter` — PouchDB-shaped client.
  - `constructor(session, name, ns="pdb")`; `readonly name`, `readonly activeTasks`
    (no-op stub).
  - `private callDB<T>(method, args=[])` — calls remote; reconstructs PouchDB error shape
    (`err.status`/`name`/`reason`) from `RpcError("REMOTE_ERROR").details`.
  - `info()`, `id()`, `get()`, `put()`, `bulkGet()`, `bulkDocs()`, `revsDiff()`,
    `allDocs()` — forward to `<ns>.<op>`.
  - `changes(opts)` — returns an object that is **both** an EventEmitter
    (`change`/`complete`/`error`, `cancel()`) **and** a thenable (`then`/`catch`); always
    one-shot (`live:false`); iterates `info.results` emitting `change`, then `complete`,
    aborting if cancelled.
- `noopActiveTasks` (module const) — `add/get/update/remove/list` no-ops for
  `pouchdb-replication`.

### `rpc/transports/TrysteroTransport.ts`
- `attachAdvertisement(room, localPeerId, name, platform="unknown"): AdvertisementHandle`
  — presence discovery over an `"ad"` action; rejects spoofed ads (`data.peerId !== sender`).
- `wrapTrysteroRoom(room): TransportAdapter` — wraps a Trystero room's `"rpc2"` action as
  a `TransportAdapter` (unsubscribe stubs are no-ops).
- `joinTrysteroRoom(settings): TrysteroRoomHandle` — join via `generateJoinRoomOptions`;
  returns `{ transport, peerId, leave, advertise, getPeers, room }`.
- `joinTrysteroRoomFromUrl(url): TrysteroRoomHandle` — parse `sls+p2p://` via
  `ConnectionStringParser`, then `joinTrysteroRoom`.
- `serveTrysteroDB(settings, db, ns="pdb", options?): TrysteroDBServerHandle` — join +
  `new RpcRoom(TRYSTERO_RPC_DEFAULTS)` + `exposeDB`.
- `connectTrysteroDBClient(settings, serverPeerId, dbName, ns="pdb", options?)` — join +
  `RpcRoom` + `RpcPouchDBProxy`.
- `collectTrysteroAdvertisements(settings, name, timeoutMs, platform?)` — one-shot peer
  discovery.
- Constants/types: `RPC_ACTION_NAME="rpc2"`, `AD_ACTION_NAME="ad"`,
  `TRYSTERO_RPC_DEFAULTS` (`maxWirePayloadBytes: 15 KiB`, `chunkMissingRetryMs: 150`),
  `TrysteroAdvertisement`, `AdvertisementHandle`, `TrysteroRoomHandle`,
  `TrysteroDBServerHandle`, `TrysteroDBClientHandle`, `TrysteroRoomOptions`.

### `rpc/transports/trysteroUtils.ts`
- `generateJoinRoomOptions(settings: P2PConnectionInfo): BaseRoomConfig` — hashes the
  passphrase with `mixedHash`, parses relay/TURN lists, and selects the RTC polyfill
  (diagnostic wrapper if `P2P_useDiagRTC`, else global `RTCPeerConnection`).

### `rpc/transports/DiagRTCPeerConnections.ts`
- `subscribeConnectionStatus(cb): () => void`, `subscribeFailureDiagnosis(cb): () => void`.
- `createDiagRTCPeerConnectionConstructor(): DiagRTCPeerConnectionConstructor` — returns a
  subclass of the global `RTCPeerConnection` that records connection/ICE/gathering/
  signalling state history, counts new/failed/successful/closed connections, logs
  progress, and dispatches failure diagnoses. Module-level counters + subscriber arrays.

### `rpc/transports/DiagRTCPeerConnections.utils.ts`
- `diagnoseRtcFailure(...)`, `describeRTCProgress(...)`, `getPeerConnectionStats(...)`
  (async), `auditRtcConnectionFailures(...)` (async) — RTC stats extraction and
  human-readable failure diagnosis. (Signatures confirmed present by grep; bodies not read
  in full — declared purpose only.)

### `rpc/transports/DiagRTCPeerConnections.types.ts`
Type/const definitions (`DiagRTCConnectionStatus`, `DiagRTCStats`,
`DiagRTCFailureDiagnosis`, `DiagRTCFailureReasonCodes`, `DiagRTCPeerConnectionMetrics`, …).

## Dependencies / Consumed by

**Depends on (internal):**
- `@lib/common/coreEnvFunctions` (`compatGlobal` — cross-env `setTimeout`/`clearTimeout`/
  `RTCPeerConnection`).
- `@lib/common/LSError` (`LiveSyncError`) — in `RpcPouchDBServer`.
- `@lib/common/logger`, `@lib/common/types` — in DiagRTC.
- `@lib/common/models/setting.type` (`P2PConnectionInfo`) and
  `@lib/common/ConnectionString` (`ConnectionStringParser`) — in the Trystero transport
  (flagged with a `TODO` to be moved out for library extraction).

**Depends on (external):**
- `events` (Node `EventEmitter`) — `RpcPouchDBProxy`. Comment notes this module is
  "for Node.js environment" and eslint-disables the Node import; a potential concern for
  browser/Obsidian bundling.
- `pouchdb-core` types (`PouchDB.*`).
- `@trystero-p2p/nostr` (`joinRoom`, `selfId`, `Room`, config types).
- `octagonal-wheels/hash/purejs` (`mixedHash`).

**Consumed by:**
- `src/lib/src/replication/trystero/TrysteroReplicatorP2PServer.ts` and
  `TrysteroReplicatorP2PClient.ts` (and `types.ts`, `rpcCompat.ts`) — the P2P
  replication subsystem. This is the sole production consumer in the repo.
- The high-level `serveTrysteroDB`/`connectTrysteroDBClient` helpers are exercised by the
  unit-test suites and appear aimed at CLI/standalone use.

The `rpc` core (`RpcRoom`/`RpcSession`/`errors`/`chunking`/`types`) has **no dependency on
PouchDB, Trystero, or LiveSync app code** — those are confined to `pouchdb/` and
`transports/`, keeping the core genuinely transport- and domain-agnostic.

## Design observations (factual)

1. **Symmetric, single-file core.** Client and server responsibilities are fused in one
   `RpcRoom` (355 LOC). It is cohesive but dense; the request-handling path
   (`onEnvelopePayload`) mixes handshake, cancel, response, auth gate, version check, and
   dispatch in one method.

2. **Cancellation vs SPEC contradiction.** SPEC `[P-10]` says the callee MUST NOT respond
   after a cancel, but `runner()` throws `RpcError("CANCELLED")` on the cancelled path,
   which is caught and **sent as an error response**. Behaviour vs spec should be
   reconciled (not verified against tests here).

3. **Silent-drop auth semantics.** A `canAcceptRequest === false` sends no response, so
   the caller waits out the full `timeoutMs` (30 s default). The comment calls this
   intentional, but it couples authorisation failure to timeout latency and gives the
   caller no distinguishable `NOT_CONNECTED`/`PROTOCOL_ERROR` signal.

4. **Outgoing chunk streams may leak.** `outgoingChunkMap` entries are deleted only on
   receipt of a `chunk-ack` (empty `missing`) or overwritten. If a peer never acks (e.g.
   disconnects mid-stream), the entry persists — `close()` clears the map, but a
   long-lived room accumulates orphaned streams. `incomingChunkMap`/timers have the same
   shape but are cleared on completion.

5. **Timer-based NACK is tuned for reliable transports.** The README/`SPEC` and
   `TRYSTERO_RPC_DEFAULTS` acknowledge that WebRTC SCTP already guarantees
   delivery/order, so retransmission "virtually never triggers." On a genuinely lossy
   transport the single-timer NACK (no exponential backoff, no per-chunk sequencing beyond
   index) is a weak ARQ — documented as intentional.

6. **`raw` messages are unprotected.** Only multi-chunk streams get retransmission; a lost
   single-frame `raw` request just times out. Fine over SCTP, fragile over a UDP-style
   transport that the `TransportAdapter` contract explicitly permits.

7. **Node `EventEmitter` dependency in a browser-targeted plugin.** `RpcPouchDBProxy`
   imports Node's `events` and its own header comment admits it is "a sample and for
   Node.js environment" pending refactor — a coupling/portability smell for the Obsidian
   (browser) build.

8. **Duplicated transport wrapping.** `TrysteroReplicatorP2PServer.onAfterJoinRoom`
   hand-rolls a `TransportAdapter` around `makeAction("rpc2")` instead of reusing
   `wrapTrysteroRoom()`. Two code paths must stay in sync on the action name and framing.

9. **Live changes feed unsupported.** `exposeDB` forces `live:false`; live replication
   requires repeated one-shot polls. Documented, but means continuous P2P sync is built on
   polling, not push.

10. **No message-size back-pressure or in-flight cap.** SPEC §8 states max in-flight
    requests is "unbounded (limited only by memory)"; the `pending` map has no ceiling.

11. **Version negotiation is advisory on the caller side.** A `versionMajor` mismatch is
    only enforced on the *inbound request* path (server rejects with `REMOTE_ERROR`) and
    otherwise just warns; the handshake is stored but the caller does not proactively
    refuse to call an incompatible peer.

12. **Strong documentation-to-code fidelity.** `README.md` and `SPEC.md` are unusually
    complete and match the implementation closely (envelope shapes, error codes, chunking
    steps all verified) — the main gap is the cancel-response contradiction (obs. 2).

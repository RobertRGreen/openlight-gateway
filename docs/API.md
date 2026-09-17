# OpenLight API v1

This is the proposed public contract, subject to independent review and implementation conformance. All HTTP paths below begin `/api/v1`. JSON uses UTF-8. This gateway is an API service, not a GUI. Adapter-specific settings are administered locally; secrets never pass through normalized device state. Unknown request properties are rejected. Response consumers must tolerate new optional fields, capability types, and event types within v1. Breaking semantics require a new URL version.

## Resources and routes

| Method | Path | Purpose / success |
|---|---|---|
| GET | /health | Authenticated readiness and gateway identity, 200 or 503 |
| GET | /devices | Device collection, 200 |
| GET | /devices/{id} | Device detail and ETag, 200 |
| PATCH | /devices/{id} | Change name, room, groups only, 200 |
| GET | /devices/{id}/state | Observed state snapshot with freshness, 200 |
| POST | /devices/{id}/commands | Submit normalized state command, 202 |
| GET, POST | /rooms | List rooms, 200; create room, 201 |
| GET, PATCH, DELETE | /rooms/{id} | Read, amend name, delete; 200/200/204 |
| GET | /rooms/{id}/state | Aggregate observed device snapshots, 200 |
| GET, POST | /groups | List groups, 200; create name/deviceIds, 201 |
| GET, PATCH, DELETE | /groups/{id} | Read, amend name/deviceIds, delete; 200/200/204 |
| GET | /groups/{id}/state | Aggregate observed device snapshots, 200 |
| POST | /groups/{id}/commands | Submit state command to frozen membership, 202 |
| GET, POST | /scenes | List scenes, 200; create scene, 201 |
| GET, PATCH, DELETE | /scenes/{id} | Read, amend name/entries, delete; 200/200/204 |
| POST | /scenes/{id}/activate | Execute frozen scene and target membership, 202 |
| GET | /effects | List available normalized effects, 200 |
| GET | /effects/{id} | Effect definition and required capabilities, 200 |
| POST | /effects/{id}/start | Start effect for target, 202 |
| GET | /effect-runs | List active and retained stopped effect runs, 200 |
| GET | /effect-runs/{id} | Effect execution status, 200 |
| POST | /effect-runs/{id}/stop | Stop run idempotently, 202 |
| POST | /discovery/start | Start selected configured adapters, 202 |
| GET | /operations/{id} | Poll command/discovery/start/stop operation, 200 |
| GET | /events | Upgrade to authenticated WebSocket, 101 |

Collection responses are `{items:[...]}`. V1 returns the complete local installation collection; no undocumented pagination. Each persisted resource collection is limited to 10,000 entries; creation or discovery beyond that limit fails with 422 `resource_limit` (discovery reports the adapter failure on its operation). Effect runs and operations retain at most 10,000 records each: records still inside mandatory retention are not evicted, and admission returns 429 when capacity is exhausted. Expired records are purged before admitting new work. A room contains devices by their single `room` assignment; a group explicitly lists devices and may span rooms. Device `groups` and Group `deviceIds` are transactional inverse views. Creating or modifying a group verifies all references before committing. Scene entries refer to devices or groups; duplicates after expansion are rejected as `422 overlapping_targets`. Deleting a room clears device room assignments. Deleting a group referenced by a scene returns `409 resource_in_use`; delete or edit those scene references first. Deleting a scene does not cancel an already frozen operation. Effects are catalog resources, while effect runs are their executions: stop addresses a run, not an effect definition. Discovery selects configured adapters, never arbitrary network addresses or supplied cloud credentials. There is no public arbitrary adapter-registration endpoint in v1; manual pairing is adapter configuration followed by discovery.

## State mutation decision

Use **POST dedicated commands**, not PUT or PATCH `/state`. PUT means replace a complete representation; clients rarely know every measured field and could erase state. PATCH is attractive for partial desired state, but a bulb command has transport side effects, capability checks, asynchronous acknowledgements, and partial target failures. A command resource makes those outcomes explicit. This deliberately adjusts the proposed PUT state routes; clients migrate by wrapping desired fields in `state`, posting to `/commands`, and polling the returned operation. The disadvantage is an extra request/poll rather than a synchronous state update. PATCH remains appropriate for persisted resource metadata and replaces only supplied top-level fields (arrays are replaced whole); this is a documented partial-update body, not JSON Patch or JSON Merge Patch. `room:null` unassigns a room; other nullable semantics are schema-defined.

Commands are `{ "state": {"power":true,"brightness":65}, "transitionMs":500 }`. Brightness is 0–100; RGB and RGBW channel values are integers 0–255; RGBWW uses `warmWhite` and `coolWhite`. Color temperature is integer kelvin. `rgb`, `rgbw`, `rgbww`, and `colorTemperature` are mutually exclusive in one command. `effect` cannot coexist with those color fields or segments; scene entries cannot select effects. Commands may include segments only if no top-level color/effect field is present, and each segment state has the same color exclusivity. Device-specific ranges and quantization are enforced beyond the generic schema. Unsupported transitions are mismatches, not silently dropped. Omitted fields remain untouched. Zero brightness does not implicitly change power. Null `effect` explicitly stops a native device effect when effects capability is present. General scheduling uses effect-run endpoints.

Every admitted command returns `202`, `Location: /api/v1/operations/{id}`, and an Operation. Admission is not proof that a device changed. Operations progress `queued` → `running` → `succeeded|partial|failed`; terminal results are immutable. Each result records `deviceId`, `status` (`succeeded|degraded|failed`), confirmation (`observed|acknowledged|unconfirmed`), observed state if available, degradation warnings, and error if failed. Every result exposes actual `transport`, nullable `fallback:{from,to,reason}` provenance, and `fieldResults:[{path,status,reason?}]` with status `applied|failed|unconfirmed|omitted`. Applied means acknowledged, not necessarily observed; these fields expose non-atomic setter outcomes. Results rejected before dispatch use `transport:null`, `fallback:null`, and `fieldResults:[]`. Acknowledgement confirms acceptance at the reported transport, not observed hardware state. Timeouts can be unconfirmed and must not fabricate success. `succeeded` means every target succeeded without degradation; `partial` means mixed success/failure or any explicitly degraded success; `failed` means no target succeeded. Operations snapshot targets in `targetDeviceIds` and record original requested state in `request`. Discovery uses an empty targetDeviceIds array and records `adapterResults:[{adapterId,status,discoveredDeviceIds,error?}]` for every selected adapter. All adapters successful means succeeded, mixed means partial, and all failed means failed; `discoveredDeviceIds` is the deduplicated aggregate result. Group commands have no distributed transaction or rollback; per-device multi-field calls can themselves fail after some fields were applied. Results then carry the latest known state and a failure, rather than claiming atomicity. A running effect's creation operation finishes when scheduling starts; its ongoing lifecycle lives in EffectRun. `deviceExecutions` reports per-device status, effectiveIntervalMs, droppedFrames, throttled, and optional error. The top-level effectiveIntervalMs is only the slowest participating cadence summary, never a shared scheduling requirement. Fast local and slow cloud targets retain independent budgets. Failed effect startup preserves a failed run and per-device outcomes. A native effect may already have started on hardware despite a startup timeout, and an uncertain stop may leave it running physically. The gateway reports unconfirmed outcomes and reconciles rather than claiming that hardware stopped. Stopping an already stopped run succeeds without restarting it.

The core serializes commands per device, preserving admission order. Starting an effect on any device with an active run returns `409 effect_conflict`; a conflicting manual/scene command also returns 409 until the run is stopped. Effect startup reserves its frozen targets atomically before admission. Rate limits constrain queues; the gateway returns 429 rather than growing them without bound. A failed adapter does not block unrelated adapters. Restart marks nonterminal persisted operations `failed` with `gateway_restarted` and unconfirmed target outcomes; physical state is reconciled before accepting new work for affected devices, never blindly replayed. Operations and idempotency records survive restart.

## Preconditions, errors, partial results

All GET routes require Bearer authentication. POST/PATCH/DELETE also require authentication. All POST requests require an `Idempotency-Key` UUID. It is scoped by authenticated principal, method and path and retained at least 24 hours from admission. Repeating the same key and canonical JSON body returns the original response and Location without re-execution; a different body returns `409 idempotency_conflict`. Expired keys are new requests. Clients must not automatically retry a possibly executed command after the retention window. Operations are retained at least 24 hours after terminal status; unknown/expired IDs return 404. PATCH/DELETE require the last resource `ETag` in `If-Match`; missing precondition is 428, stale is 412. This guards concurrent configuration edits, not the device's physical state. Device metadata ETags change only for metadata/membership changes; observed-state revision changes separately.

| Status | Meaning |
|---|---|
| 400 | Malformed JSON, missing/invalid idempotency key, invalid syntax |
| 401 / 403 | Missing/invalid credentials / authenticated request forbidden (including Origin policy) |
| 404 | Unknown resource |
| 409 | Offline singleton, conflicting active effect, identity/payload conflict, referenced resource |
| 412 / 428 | Failed / missing configuration precondition |
| 413 / 415 | Body too large / unsupported content type |
| 422 | Structurally valid JSON violates schema, capability, range, membership or semantic constraints |
| 429 | Request, operation queue or adapter budget exceeded; Retry-After supplied |
| 500 / 503 | Unexpected redacted internal failure / gateway not ready or selected adapters unavailable |

Error responses use `{error:{code,message,requestId,details:[{path,code,message,deviceId?,capability?}]}}`; paths are JSON Pointers into the request. Error messages never include credentials or raw adapter responses. Example RGB command on a white-only device:

```json
{"error":{"code":"capability_mismatch","message":"Device does not support rgb","requestId":"req-28","details":[{"path":"/state/rgb","code":"unsupported_capability","message":"Required capability rgb is absent","deviceId":"1c2bd3ee-7334-400e-8bc1-96c02bf16b45","capability":"rgb"}]}}
```

Example validation failure (422):

```json
{"error":{"code":"validation_error","message":"Invalid request","requestId":"req-29","details":[{"path":"/state/brightness","code":"out_of_range","message":"Expected a number between 0 and 100"}]}}
```

Known offline single-device commands return `409 device_offline` without queueing. Unknown availability is probed within an execution deadline and may fail; GET still returns cached state with `stale:true`. The health route is the exception to the Error body convention: readiness failure returns 503 with the same Health schema as 200 (`status:not_ready`); infrastructure/authentication errors still use Error. For groups, offline or incompatible targets are recorded as failures. If no target can execute, return 422 `no_eligible_targets` with all reasons and dispatch nothing; empty target sets are 422. Otherwise admit eligible targets and expose all targets in the operation. A disconnect after admission is an operation result, not a retroactive HTTP error. Scene activation defaults to `allowDegraded:false`; explicit `true` permits only documented lossy transformations (for example omission of an unsupported transition). Unsupported RGB is never converted to fake RGB capability; dropping requested color is a failed target. Every transformation must appear as a warning with requested/applied descriptions. Direct commands never silently degrade.

Example terminal partial group operation (GET returns 200, never falsely reports all-device success and does not use HTTP 207):

```json
{"id":"b780bb96-58aa-42e5-a9c9-59833d5689bc","kind":"group.command","status":"partial","createdAt":"2026-09-17T18:00:00Z","completedAt":"2026-09-17T18:00:01Z","request":{"state":{"power":true}},"targetDeviceIds":["1c2bd3ee-7334-400e-8bc1-96c02bf16b45","d3b92289-adbd-464c-98fa-267b543f1c77"],"results":[{"deviceId":"1c2bd3ee-7334-400e-8bc1-96c02bf16b45","status":"succeeded","confirmation":"observed","state":{"power":true},"warnings":[],"transport":"mock","fallback":null,"fieldResults":[{"path":"/power","status":"applied"}]},{"deviceId":"d3b92289-adbd-464c-98fa-267b543f1c77","status":"failed","confirmation":"unconfirmed","warnings":[],"transport":null,"fallback":null,"fieldResults":[],"error":{"code":"device_offline","message":"Device is offline","requestId":"req-30","details":[]}}]}
```

## Models and reconciliation

Device has opaque persistent UUID `id`, `name`, `manufacturer`, nullable `model`, adapter identifier `adapter`, sanitized nullable `address`, nullable room UUID `room`, `groups` UUID array, Capability array `capabilities`, sparse observed `state`, `stateObservedAt`, `stateStale`, monotonic observed `revision`, `availability` (`online|offline|unknown`), and `metadata.extensions`. Extension keys use reverse-DNS namespaces; extension values never alter standardized capability meaning. Clients must not use addresses as identity. Capabilities are discriminated by `type`; one entry per type. Numeric capabilities advertise minimum/maximum/step, effects advertise effect IDs, transitions advertise maximum milliseconds, and segments advertise stable IDs. A missing state field means unknown, not zero or false. Capabilities describe actual supported controls, not states the gateway can approximate.

State GET is a cached observed snapshot `{state,observedAt,stale,revision}`; it does not synchronously poll hardware. Adapter subscriptions and transport-budgeted polling reconcile manufacturer-app, switch, automation, and power-cycle changes. Desired state stays in operation requests. Room/group state returns `{deviceStates:[{deviceId,availability,state,observedAt,stale,revision}],mixed:boolean}`; mixed is true if known comparable state fields differ, not a fabricated average. Missing/stale entries remain explicit, so mixed:false does not imply all devices are known or equal. The OpenAPI schemas define exact resource bodies.

## WebSocket events: `/api/v1/events`

Native clients authenticate the upgrade with `Authorization: Bearer …`. Browsers open the socket with an allowed Origin and send `{ "type":"authenticate", "token":"…" }` as their first frame within five seconds. The server sends no event or sensitive frame before successful authentication; an authenticated connection receives `{ "type":"authenticated", "gatewayId":"<uuid>", "bootId":"<uuid>" }`. Native header authentication receives the same control frame. Tokens never appear in URLs/subprotocols. Invalid/expired/revoked tokens close with code 1008; reauthenticate by reconnecting. Oversized frames close 1009; slow clients close 1013. Event sockets are receive-only after authentication (protocol ping/pong remains available); malformed/unsupported client messages close 1008.

Envelope fields are a long-term contract: `schemaVersion` is `"1.0"`; `id` is an event UUID; `sequence` increases monotonically within `bootId`; persistent `gatewayId` identifies the installation; `bootId` changes on process start; `occurredAt` is RFC3339 UTC; `type` names the event; `subject` identifies its resource; nullable `correlationId` refers to an initiating Operation, absent causation represented by null; `data` is type-specific. Sequence gaps and a new boot ID require reconciliation. V1 provides no replay, durable delivery, acknowledgements, or exactly-once guarantee. Connect first, buffer events while fetching snapshots, then apply only newer observed device-state revisions. Aggregate, capability, and configuration resources have no event revision ordering guarantee: refetch affected resources after the initial buffer drains rather than overwriting a fresh snapshot with a buffered event. Refetch resources after gaps; if a device-state gap cannot be resolved by revision comparison, refetch its snapshot too. New optional data fields and new event types are additive; ignore unknown types. IDs, timestamps and sequence are never reused to imply global ordering across boots.

```json
{"schemaVersion":"1.0","id":"a78adb8a-547e-45b1-b710-203f6ed139b4","sequence":42,"gatewayId":"f8603ea7-9f63-49f7-a915-1eaa6514e184","bootId":"5026cf62-5587-4e23-b9cf-f529ffb909c7","type":"device.state_changed","occurredAt":"2026-09-17T18:00:01Z","subject":{"type":"device","id":"1c2bd3ee-7334-400e-8bc1-96c02bf16b45"},"correlationId":"b780bb96-58aa-42e5-a9c9-59833d5689bc","data":{"state":{"power":true,"brightness":65},"observedAt":"2026-09-17T18:00:01Z","stale":false,"revision":8}}
```

| Event type | Subject | `data` |
|---|---|---|
| gateway.started / gateway.stopping | gateway | `{reason:string}`; started is emitted at boot, not replayed to later sockets |
| device.discovered | device | `{device:Device}` |
| device.connected / device.disconnected | device | `{availability:online\|offline\|unknown,reason:string}` |
| device.state_changed | device | Full StateSnapshot (not a delta) |
| device.capabilities_changed | device | `{capabilities:Capability[]}` full replacement |
| room.state_changed / group.state_changed | room / group | Full AggregateState |
| scene.started / scene.completed / scene.failed | scene | `{operationId:UUID,status:OperationStatus}`; completed includes partial outcomes, fetch operation |
| effect.started / effect.updated / effect.stopped | effect-run | `{run:EffectRun}`; stopped includes failures in run reason |
| adapter.connected / adapter.disconnected / adapter.error | adapter | `{adapterId:string,reason:string,error?:ErrorDetail}` sanitized |
| operation.completed | operation | `{operation:Operation}` terminal result including partial/degraded |

OpenAPI describes HTTP upgrade and the event schema with `x-websocket`; it does not imply ordinary HTTP streaming. Gateway stopping delivery is best effort. Room/group events indicate aggregate observations, not proof of successful commands. Periodic reconciliation remains necessary even when a socket stays connected.

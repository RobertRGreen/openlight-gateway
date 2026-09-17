# OpenLight Gateway architecture

This document specifies the target v1 design, not a claim that every route or adapter is implemented. OpenLight Gateway is a standalone, local-first smart-lighting service with a REST and WebSocket API. It provides no GUI. A PC RGB controller, automation service, or other client uses the same normalized contract regardless of manufacturer.

```text
Clients
  -> OpenLight API: authentication, validation, REST /api/v1, WebSocket events
    -> Lighting Core: registry, capabilities, operations, rooms/groups, scenes/effects
      -> Adapters: mock, then Govee / Feit / Hubspace, later other integrations
        -> Devices through LAN, local standards, bridges, or cloud
```

## Ownership and boundaries

The API accepts normalized requests and serializes normalized results. The core owns stable identity, configuration, capability validation, scheduling, desired-state intent, observed-state reconciliation, operation history, and events. An adapter owns protocol discovery, session management, native identifiers, translation, transport, and manufacturer errors. Core behavior must not branch on manufacturer or import manufacturer implementations; the composition root registers adapters through the common contract in [ADAPTERS.md](ADAPTERS.md).

Manufacturer-specific data is never a new core-model field. The explicit escape hatch is `metadata.extensions`, keyed by reverse-DNS namespaces such as `org.example.wled`; these values are optional, bounded, JSON-safe, credential-free, and not required to interpret ordinary core commands. Core clients may ignore extensions. Normalized errors never expose raw manufacturer responses or secrets.

## Normalized device and capability model

| Field | Meaning |
| --- | --- |
| `id` | Opaque gateway-assigned UUID, persisted across restarts. |
| `name` | User-facing display name; not identity. |
| `manufacturer`, `model` | Descriptive values (`model` may be null); not dispatch keys. |
| `adapter` | Registered adapter instance identifier used for internal routing. |
| `address` | Sanitized transport locator, nullable; not a stable identifier and never a credential. |
| `room` | Nullable room ID; at most one physical room. |
| `groups` | Group IDs; a device may belong to several. |
| `capabilities` | Discriminated capability descriptors with real per-device constraints. |
| `state` | Sparse observed normalized state; `stateObservedAt`, `stateStale`, and `revision` carry freshness beside it. |
| `availability` | Connectivity status distinct from power and state freshness. |
| `metadata` | Safe descriptive metadata plus explicit namespaced extensions. |

Persist a unique mapping of `(adapter instance, native device identity)` to the UUID. IP addresses, cloud session tokens, and display names cannot identify devices reliably. Rediscovery at a new address preserves the UUID when the adapter proves identity. Cross-adapter discovery does not automatically merge two records on name or IP; explicit, verified identity migration is required. Deleting a device and intentionally recreating it creates a new identity unless a supported restore preserves the mapping. A database restore must retain gateway and device identities.

Capabilities are an array of descriptors discriminated by `type`: `power`, `brightness`, `rgb`, `rgbw`, `rgbww`, `colorTemperature`, `effects`, `transitions`, and `segments`. Numeric descriptors advertise usable min/max/step constraints, effect descriptors identify supported effects, and segments expose supported addressing limits. Normalized brightness is 0–100, RGB components are integer bytes, and color temperature uses kelvin. RGBW and RGBWW are explicit channel modes; possessing RGB does not imply a controllable white emitter. A capability means the adapter can perform that operation for that device through its currently selected transport. Hardware marketing claims alone are insufficient.

Unknown or unobserved state fields are absent rather than fabricated as zero, off, or a default color. Capability changes trigger revalidation of queued work and a `device.capabilities_changed` event. Public JSON shapes and required properties are normative in [API.md](API.md) and [openapi.yaml](../openapi/openapi.yaml); adapter-specific method types are described separately in [ADAPTERS.md](ADAPTERS.md).

## Local-first transport selection

The priority is **direct LAN protocol → Matter/local standard → local bridge → manufacturer cloud API**. Direct control keeps latency low and limits dependencies. A local standard provides interoperable control when direct integration is unavailable; a local bridge adds a dependency but can still function without Internet access. Cloud control adds account, Internet, privacy, quota, and service-lifetime dependencies and is used only when necessary.

Preference is evaluated per device and operation against actual support, not by a global brand preference. A LAN device lacking a particular feature does not acquire that capability merely because another model supports it. A configured cloud fallback is eligible only if authorized credentials exist and that route can satisfy the command. Report selected transport and any fallback in operation results; never present cloud execution as local. Unsupported commands fail explicitly. A timeout after an uncertain write does not authorize blind replay through another transport: reconcile first to avoid duplicate effects or conflicting changes. Losing a preferred route is observable, with bounded reconnect backoff and no rapid transport oscillation.

Manufacturer protocol details, model exceptions, and dated supporting sources belong in [DEVICE-RESEARCH.md](DEVICE-RESEARCH.md), maintained by a separate research pass. That file may be pending. This architecture makes no blanket claim that Govee, Feit Electric, or Hubspace/Afero supports LAN control across its product line.

## Command execution and aggregate behavior

Device and group state reads are `GET`; state mutation uses dedicated `POST .../commands` resources, rather than pretending that an imperative network operation replaces an authoritative state document. See [API.md](API.md) for the precise route set, idempotency rules, and the PUT/PATCH alternatives. Accepted work returns `202` with a persistent operation ID and polling location. Acceptance is not proof of execution.

The core validates syntax, resolves target membership once, snapshots the resolved IDs, validates actual capabilities, and queues work within adapter budgets. Each device outcome is retained, including unsupported fields, offline status, transport failure, uncertain delivery, and explicit degradation. A failed member never turns into full group success. Successful members are not automatically rolled back; physical side effects across devices are not a transaction. Retries target failed members only, with the documented command/idempotency rules. A new external change must not be overwritten by an obsolete retry.

A room denotes physical location; a group is an explicit set of device IDs that may span rooms. They are separate persisted abstractions. Aggregate room/group state is derived from observed members, with mixed values, freshness, and each member's `availability` surfaced in aggregate snapshots; it is not a fictional extra bulb. Membership changes can change an aggregate even when no lamp changes. Emit aggregate state events when the normalized aggregate changes, and coalesce high-frequency updates.

Scenes store brand-independent normalized target definitions. Strict capability handling is the default. Degradation is allowed only by an explicit scene activation policy, and every skipped or approximated field and reason appears in per-device results. V1 permits explicitly reported omission of an unsupported transition under that policy, but dropping a requested color is a failed target. There is no universal RGB-to-white conversion that can truthfully reproduce an arbitrary color. Effects produce normalized time-varying intent; they do not override adapter budgets or invent device capabilities.

## Reconciliation: observed state, desired state, and freshness

Manufacturer apps, switches, other controllers, power cycles, and autonomous device effects all change devices outside OpenLight. The registry is the gateway's latest knowledge, not authoritative physical truth. Keep observed state separate from pending desired intent. A successful transport acknowledgment may mean only “accepted”; it must not be published as a verified observation unless the adapter can establish that meaning.

1. On startup, restore configuration and identity. Historical observations are stale and availability starts unknown until checked. Do not replay the previous desired state automatically.
2. Prefer adapter subscriptions or pushed observations. Accept ordered observations, discard known obsolete sequence numbers, and timestamp receipt with the gateway clock; device clocks alone are not trusted ordering sources.
3. Reconcile through periodic jittered polling where needed. Poll schedules, refresh-on-read requests, command verification, and discovery share the same adapter rate budget. Reads return freshness honestly and may schedule one coalesced refresh; many readers must not create a poll storm.
4. After a write, preserve desired intent in its operation while checking observed state within a bounded verification window. A mismatch or timeout remains visible in the result. Field updates merge into the observation only for fields actually observed; an omitted field does not reset another value.
5. Serialize writes per device and attach internal observation/write revisions. Discard a poll response known to precede a newer observation or completed write. Protocols with no ordering information cannot eliminate every race; expose the uncertainty and refresh rather than claiming perfect ordering.
6. Treat later external changes as new observations. The default is not continuous enforcement of the last command. An active effect is an explicit temporary controller: another effect or a manual/scene command targeting any of its reserved devices receives `409 effect_conflict` until the run is stopped. Stopping it stops new frames.

Availability describes reachability, not power. A switched-off lamp that still responds is online; a lamp disconnected at the wall may be offline with a stale last-known power value. Adapter-wide outages invalidate confidence in affected devices without erasing the last-known state. Capability refresh is part of reconnect because firmware, transport, and model support can change.

## Isolation, scheduling, and resource bounds

Every core-to-adapter call has an operation context, timeout, cancellation signal, and typed error boundary. Catch synchronous throws and rejected promises, bound queues and concurrency, apply backoff and circuit breakers per adapter, and contain adapter event-handler failures. A broken adapter is marked unavailable and emits `adapter.error`/`adapter.disconnected`; other adapters and health/API handling continue. Disconnect stops timers, subscriptions, and pending work. Do not allow a late result from a canceled generation to mutate a newer operation.

An async boundary is **not** a sandbox. A blocking loop, native crash, memory exhaustion, or unhandled process-level failure can still kill a single Node process. Phase 1 trusts the bundled mock implementation and tests ordinary failure isolation. Untrusted, crash-prone, or blocking integrations require worker or process isolation; native-crash containment needs a separate process. Cancellation is cooperative unless that execution boundary can be terminated. Do not claim that `Promise.race` stops an underlying network write.

The effect scheduler respects adapter-wide, account-wide, transport, and per-device limits, burst quotas, latency, and `Retry-After`. Interactive commands receive capacity alongside fair effect scheduling. Pending replaceable frames coalesce to the newest frame; stale frames are dropped rather than queued indefinitely. Cloud integrations may support only slow changes or native device effects; they must never emulate 60 fps through cloud requests. Effective cadence, throttling, dropped frames, and failures are observable. A local path may run faster only within its measured capacity and configured limits.

## Persistence, events, discovery, and security

Persist identity mappings, rooms, groups, scenes, effect definitions, adapter configuration references, token hashes, and bounded operation/idempotency history in SQLite. Use Node's built-in `node:sqlite` `DatabaseSync`, not `better-sqlite3`: no additional native-binding compilation step is needed. Keep transactions short, apply migrations transactionally, and bound retention. Synchronous database calls block the event loop, so large migrations/imports need an appropriate worker or maintenance strategy. This is an intentional choice over an unspecified SQLite library. `node:sqlite` was introduced in Node 22.5; that introduction does not mean all releases from 22.5 onward have identical stability/API status. The coordinator verified `DatabaseSync(':memory:')` on this machine's Node v26.8.2 with SQLite 3.53.4; validate and document the supported runtime matrix before release.

WebSocket `/api/v1/events` uses the versioned envelope in [API.md](API.md), including gateway/boot identity, boot-scoped sequence, event ID, subject, correlation, and operation linkage. A process restart creates a new boot ID. Events aid responsiveness; bounded retention and disconnections mean clients must resynchronize from REST when continuity is lost. The core, not arbitrary adapter payloads, constructs public events.

Device discovery runs as an operation through supported adapters. Provisioning/manual configuration is necessary where a protocol cannot discover; it must not be confused with gateway service advertisement. Optional mDNS advertisement describes the gateway only, never account credentials. Authentication, LAN binding, browser origins, rate limits, and credential storage are governed by [SECURITY.md](SECURITY.md). Local-first does not make the LAN trusted. Delivery phases are in [ROADMAP.md](ROADMAP.md), and rationale is recorded in [adr/](adr/).

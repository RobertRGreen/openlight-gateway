# Adapter contract and integration guide

This is the target v1 adapter contract. The documentation describes required behavior; it does not assert that the concurrent TypeScript implementation already exposes every type below. Public wire schemas are normative in [API.md](API.md) and [openapi.yaml](../openapi/openapi.yaml). Adapter SDK types must be generated from or checked against those schemas, rather than evolving as a competing public model.

Adapters translate protocols, not application policy. They discover devices, establish sessions, report supported capabilities and observations, and execute normalized operations. The lighting core owns IDs, rooms/groups, scenes, orchestration, authorization, scheduling, operation outcomes, and public events. It must never need `if (manufacturer === ...)`.

## Typed boundary

The following TypeScript illustrates the required signatures. `Capability`, `DeviceState`, and `SegmentState` refer to the canonical schema types; the latter is the same set of scalar state fields without recursive segments. All methods are asynchronous at the boundary, including implementations that currently finish immediately.

```ts
import type { Capability, DeviceState, SegmentState } from './schema-types';

type NativeDeviceId = string; // Adapter-scoped, not a public device UUID.
type Transport = 'lan' | 'matter' | 'bridge' | 'cloud' | 'mock';
type RGB = { r: number; g: number; b: number }; // Validated integer bytes.
type Color =
  | { mode: 'rgb'; value: RGB }
  | { mode: 'rgbw'; value: RGB & { w: number } }
  | { mode: 'rgbww'; value: RGB & { warmWhite: number; coolWhite: number } };

type CallContext = {
  operationId: string;
  correlationId: string | null;
  signal: AbortSignal;
  deadlineAt: number; // Epoch milliseconds; scheduler also uses monotonic time.
};
type AdapterDevice = {
  nativeId: NativeDeviceId;
  name: string;
  manufacturer: string;
  model: string | null;
  address: { transport: Transport; endpoint: string | null } | null;
  extensions: Record<string, Record<string, unknown>>;
};
type Observation = {
  state: DeviceState;
  observedAt: string; // Gateway-normalized RFC 3339 timestamp.
  complete: boolean; // Otherwise merge only fields actually observed.
  nativeSequence?: string; // Optional ordering information, opaque to clients.
};
type WriteReceipt = {
  transport: Transport;
  acknowledgment: 'accepted' | 'applied';
  observation?: Observation;
};
type RateBudget = {
  scope: 'adapter' | 'account' | 'device';
  key: string; // Sanitized opaque quota bucket, never an account credential.
  maxRequests: number;
  windowMs: number;
  burst: number;
  maxConcurrent: number;
};
type SchedulingProfile = {
  budgets: readonly RateBudget[];
  minUpdateIntervalMs: number;
  estimatedLatencyMs: number;
  recommendedPollIntervalMs: number;
};
type AdapterEvent =
  | { type: 'observation'; nativeId: NativeDeviceId; observation: Observation }
  | { type: 'availability'; nativeId: NativeDeviceId;
      status: 'online' | 'offline' | 'unknown' }
  | { type: 'capabilities'; nativeId: NativeDeviceId; capabilities: Capability[] }
  | { type: 'connection'; connected: boolean }
  | { type: 'error'; error: AdapterError };

type AdapterErrorCode =
  | 'OFFLINE' | 'UNSUPPORTED_CAPABILITY' | 'OUT_OF_RANGE' | 'AUTH_FAILED'
  | 'RATE_LIMITED' | 'TIMEOUT' | 'CANCELED' | 'TRANSPORT_ERROR';
class AdapterError extends Error {
  declare code: AdapterErrorCode;
  declare retryable: boolean;
  declare delivery: 'not_sent' | 'unknown' | 'acknowledged';
  declare retryAfterMs?: number;
}

interface LightingAdapter {
  readonly id: string; // Registered instance ID, e.g. two accounts are distinct.
  readonly scheduling: SchedulingProfile;
  onEvent(listener: (event: AdapterEvent) => void): () => void;
  discover(context: CallContext): AsyncIterable<AdapterDevice>;
  connect(context: CallContext): Promise<void>;
  disconnect(context: CallContext): Promise<void>;
  getDevices(context: CallContext): Promise<readonly AdapterDevice[]>;
  getCapabilities(id: NativeDeviceId, context: CallContext): Promise<Capability[]>;
  getState(id: NativeDeviceId, context: CallContext): Promise<Observation>;
  setPower(id: NativeDeviceId, on: boolean, context: CallContext): Promise<WriteReceipt>;
  setBrightness(id: NativeDeviceId, percent: number, context: CallContext): Promise<WriteReceipt>;
  setColor(id: NativeDeviceId, color: Color, context: CallContext): Promise<WriteReceipt>;
  setTemperature(id: NativeDeviceId, kelvin: number, context: CallContext): Promise<WriteReceipt>;
  effects?: {
    start(id: NativeDeviceId, effectId: string, context: CallContext): Promise<WriteReceipt>;
    stop(id: NativeDeviceId, context: CallContext): Promise<WriteReceipt>;
  };
  transitions?: {
    apply(id: NativeDeviceId, state: DeviceState,
          durationMs: number, context: CallContext): Promise<WriteReceipt>;
  };
  segments?: {
    apply(id: NativeDeviceId, values: readonly { id: string; state: SegmentState }[],
          context: CallContext): Promise<WriteReceipt>;
  };
}
```

RGB white-channel intensities use the same byte range as RGB. Brightness uses percent and temperature uses kelvin; conversion to hardware units happens only inside the adapter. Runtime validation is mandatory because TypeScript `number` cannot guarantee integer/range constraints. The base setter methods are a stable interface, not a promise that every device implements each feature: a capability check gates invocation, and unsupported direct calls still produce a typed error. Optional interfaces must be implemented if the adapter advertises their corresponding capabilities; having a method alone does not advertise support on every device.

`discover` may report already-known devices, and the core deduplicates on adapter/native identity. `getDevices` lists this adapter's known inventory; it is not inherently a network scan. `connect` establishes the adapter/account/transport session; individual device availability is separate. Connect/disconnect must tolerate repeated calls, release resources on shutdown, and stop discovery iterators when canceled. For protocols without discovery, return a documented empty inventory and consume explicitly provisioned configuration rather than guessing network credentials.

## Capability advertisement and truthful state

Return per-device discriminated descriptors using `type` values `power`, `brightness`, `rgb`, `rgbw`, `rgbww`, `colorTemperature`, `effects`, `transitions`, and `segments`. Brightness and temperature constraints use `minimum`, `maximum`, and `step`; effect support lists `effectIds`, transition support sets `maxDurationMs`, and segment support lists `segmentIds`. A device can support several descriptors, but that does not imply every simultaneous combination is valid. Core validation rejects contradictory color modes and values outside supported ranges before sending anything.

Detect capabilities from actual protocol/model information or a maintained, tested model mapping. If detection is incomplete, expose only confirmed support. Do not advertise emulated white channels, invent a color-temperature range, or silently clamp an unsupported value. Changes caused by firmware, authentication, or transport fallback trigger new descriptors and revalidation. Scene degradation is a core policy requiring explicit caller opt-in, and its exact lost/approximated fields must be recorded. V1 may omit an unsupported transition under that policy; dropping requested RGB color is a failed target, not degraded success.

`getState` reports only observable fields. If a protocol acknowledges writes without reading state, return an accepted receipt and preserve uncertainty; do not echo a request as proof that a lamp changed. The core stores the desired state in the operation separately, attaches freshness/revision metadata to observations, and produces normalized public state events. Adapter events are internal signals, not preformatted WebSocket envelopes.

## Translation and execution

For `POST /api/v1/devices/{id}/commands` with `{"state":{"power":true,"brightness":40}}`, the core:

1. Resolves the UUID to its adapter instance and native identity, validates authorization and syntax, and persists operation/idempotency metadata before scheduling.
2. Reads current capability descriptors and availability. Unsupported input produces the documented capability-mismatch error; known offline input follows the API's explicit offline policy.
3. Validates the entire command before dispatch. It serializes work per device, acquires all applicable account/adapter/device quota budgets, and passes a bounded cancellation context.
4. Translates fields to `setPower`, `setBrightness`, `setColor`, or `setTemperature`. A requested transition uses the optional transition interface only when supported. Segment/effect requests similarly require their optional interfaces and advertised capability.
5. Records each attempted field and receipt. A multi-field command is not necessarily atomic: if power succeeds and brightness fails, retain the applied field and the failure. Never rewrite the whole command as a full success or assume a rollback worked.
6. Reconciles observations and records the terminal per-device result, selected transport, errors, and explicit degradation. Polling the operation is the durable source of execution results; WebSocket events provide timely notifications.

The core preserves per-device admission order. Active effect ownership conflicts return `409 effect_conflict` until the run is stopped. The core defines deterministic sequencing where multiple setter calls are required; the adapter must document protocol coupling such as a brightness write that implicitly powers on. That side effect must appear in observations/results. If the protocol cannot achieve a requested combination, reject it or report the explicit failure rather than silently changing semantics. A transition interface may provide an atomic native operation; base setters do not imply atomicity.

Groups resolve membership once and repeat this pipeline with bounded concurrency. Some devices may succeed while others fail. The operation retains all member outcomes, with no fictional transaction across manufacturers. Retry only safe, selected work: a `delivery: 'unknown'` timeout requires reconciliation before automatic replay, especially for effects or non-idempotent protocol calls.

## Quotas, effects, and isolation

A scheduling profile is operational metadata, separate from capabilities: a lamp may support RGB but only tolerate one cloud update every several seconds. Each request consumes the relevant budgets, including discovery, reads, writes, verification, retries, and effect frames. Honor runtime quota feedback and `retryAfterMs`; an account quota may span several adapter instances and therefore needs a shared core budget key. Report profile changes to the scheduler through the integration's control interface before increasing traffic.

Prefer native effects when the advertised effect is appropriate. Generated effects use bounded queues, coalesced latest frames, fair capacity for interactive work, and a cadence limited by quota and measured latency. Do not retry obsolete frames or simulate 60 fps through a cloud API. A stop cancels future frames and pending replaceable work; it cannot retract a packet already delivered. Report delayed or uncertain stops.

Catch and normalize errors at the adapter boundary. Redact native bodies, credential values, URLs containing tokens, and device keys. Bound retries, use circuit breakers and reconnect backoff, and clean up every timer/socket/listener. Timeouts and `AbortSignal` prevent waiting forever only if implementations cooperate. In-process async error handling does not contain an infinite loop, native crash, or memory exhaustion. Use a process boundary when those risks must be contained; see [ARCHITECTURE.md](ARCHITECTURE.md).

## Adding an adapter, for example WLED or Matter

1. **Research and scope.** Record the exact models/protocol versions, supported discovery and transports, authentication requirements, commands, readback behavior, and quotas in the manufacturer research document. Verify primary protocol documentation. Do not infer local support from the brand name.
2. **Implement the boundary.** In the later implementation task, add an adapter package/module implementing the typed contract. Keep manufacturer SDK imports and native field names there. Register its factory at the composition root through configuration, without adding brand branches in core services.
3. **Establish identity.** Choose a stable native identifier and test that address changes, reconnects, duplicate discovery, and restart preserve the gateway UUID mapping. Never embed a secret in an identifier or extension. Provision explicitly when discovery cannot obtain identity safely.
4. **Implement lifecycle and discovery.** Add cancellable discovery, session connect/disconnect, known inventory, bounded retries, event subscription cleanup, and safe credential references. Respect localhost/LAN security and explicitly authorized cloud fallback.
5. **Map capabilities and observations.** Translate each supported model into canonical descriptors and state fields. Test ranges, RGB/RGBW/RGBWW distinctions, transition constraints, segment addressing, absent observations, physical-switch changes, and capability changes on reconnect.
6. **Translate writes.** Implement unit conversion and error mapping for every advertised feature. Prove required side effects and acknowledgment semantics. Add optional effects/transitions/segments only when supported; otherwise leave them unadvertised. Preserve quota feedback and uncertain delivery.
7. **Declare scheduling limits.** Supply conservative quotas and latency estimates, then measure. Exercise shared account quotas, slow requests, overload, frame coalescing, interactive fairness, cancellation, and safe shutdown. A LAN integration still needs rate limits.
8. **Run the conformance suite.** Reuse mock/fake-transport tests for identity, malformed native responses, offline devices, stale observations, external changes, partial multi-field writes, partial group failures, idempotency, secret redaction, resource cleanup, and adapter exceptions. Hardware smoke tests confirm real protocol behavior; CI must not require private credentials or physical devices.
9. **Document and stage release.** Publish supported models, capability matrix, limitations, secure setup, and opt-in configuration. Keep real integration delivery in its roadmap phase. Review any change to the public model with an ADR and API compatibility checks; a new brand should normally require neither a new core field nor a new REST route.

Adding an adapter is implementation work outside this documentation task. The gateway architecture and API remain stable whether the next integration is Matter, WLED, Hue, Nanoleaf, Tuya, Home Assistant, or a manufacturer-specific transport.

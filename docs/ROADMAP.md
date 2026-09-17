# Roadmap

This roadmap separates the proposed public contract from shipped functionality. Acceptance requires tests and independent review; a documented route or adapter is not evidence of an implemented feature.

## Phase 1: useful gateway with simulated devices

Deliver a standalone TypeScript service with a mock adapter, normalized device and capability contracts, versioned REST commands and operation tracking, and WebSocket lifecycle/state events. Persist device identity, rooms, groups, scenes, configuration, and token verifiers in SQLite through Node's built-in `node:sqlite` `DatabaseSync`. Implement reconciliation, explicit capability errors, offline outcomes, degraded scene results, and partial group outcomes using deterministic mock devices.

Include local token bootstrap/rotation, loopback default, deliberate LAN configuration, event authentication, input validation, and redacted logging. Exercise the mock adapter's discovery, physical-change simulation, reconnect, failure, latency, and capability changes. Test persistence across restart, operation/idempotency behavior, group partial failures, rate-bounded effect scheduling, schema compatibility, and adapter failures. Keep OpenAPI and examples synchronized with the implementation.

Exit gate: documented v1 behavior passes contract/integration tests, installation works without compiling SQLite native bindings, and Claude independently reviews the API and architecture. No real manufacturer integration is required for this gate. A GUI is outside scope.

## Phase 2: real manufacturer adapters

Add Govee, Feit Electric, and Hubspace/Afero integrations only after device-level protocol research and hardware verification. Prefer direct LAN, then a local standard, then a local bridge, and use cloud only where necessary. Record supported model/firmware combinations, account requirements, regional limitations, transport selection, quotas, and unsupported capabilities in the separate device research/support matrix. Never infer universal local control from a brand name or advertise a capability based on marketing alone.

Each adapter must pass the shared contract suite and demonstrate discovery or a documented configuration path, external state changes, credential handling, reconnect, rate limiting, and observable partial failures. Ship integrations independently rather than make one unavailable protocol block all others.

## Phase 3: local standards and additional ecosystems

Add Matter with explicit commissioning and fabric-credential lifecycle design. Evaluate Philips Hue, Nanoleaf, Tuya, WLED, and Home Assistant bridges according to actual local support and ecosystem needs. Preserve the normalized API and use namespaced extensions for optional manufacturer data. Reassess process isolation when integrations introduce native code, blocking libraries, or a larger trust boundary.

## Phase 4: PC RGB coordination and richer effects

Integrate the existing PC RGB controller as an API consumer. Define clock/timing expectations, cancellation and priority behavior, and latency-aware coordination across fast local devices and slower transports. Grow a brand-independent effects library and native-effect mappings; do not emulate high frame rates through cloud APIs. Expose device-level degradation and achieved scheduling rates.

Later improvements may include scoped tokens, durable event replay, expanded diagnostics, and richer orchestration. These require explicit versioning and security decisions; they are not implied by v1. Phase ordering can evolve with hardware access, but capability honesty, local-first transport selection, and explicit partial outcomes remain acceptance requirements.

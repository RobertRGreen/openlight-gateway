# ADR-0007: Typed adapter boundary and isolation

Status: Proposed; pending Claude’s independent review.

## Decision

Use a strongly typed manufacturer-neutral interface with discover, connect, disconnect, getDevices, getCapabilities, getState, setPower, setBrightness, setColor, and setTemperature. Optional effect/transition/segment operations require matching declared support. The core validates normalized commands, decomposes them into supported calls, and records field/device outcomes. See ADAPTERS.md for signatures.

## Alternatives considered

A universal opaque setState payload hides semantics and lets vendor fields leak into the core. Brand branches in the core duplicate behavior. Requiring every optional operation encourages fake support. Separate processes isolate faults better but add IPC and lifecycle costs for Phase 1.

## Reason

Explicit operations make capability validation and error handling inspectable while keeping protocol details inside adapters.

## Advantages

Adapters can be tested with a shared contract suite; optional capabilities remain honest; normalized failure and scheduler boundaries are reusable.

## Disadvantages

Multiple primitive calls are not hardware-atomic and may partially apply. Async exception handling cannot isolate event-loop blocking, process exits, native crashes, or malicious code.

## Migration and consequences

Wrap all calls and callbacks with error conversion, deadlines, cancellation where supported, bounded concurrency and retry/circuit policy. Quarantine failed adapters while serving others. Add a worker/process transport behind the same contract if hard isolation is needed; do not describe in-process boundaries as a sandbox.

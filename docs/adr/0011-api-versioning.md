# ADR-0011: Versioned normalized API and extensions

Status: Proposed; pending Claude’s independent review.

## Decision

Publish REST and WebSocket routes under /api/v1/. Treat normalized schemas, errors, operation behavior and event semantics as a compatibility contract. Keep manufacturer-specific properties out of core top-level fields; metadata.extensions is an explicit object keyed by reverse-DNS namespaces such as org.example.adapter, containing JSON values under adapter-owned schemas.

## Alternatives considered

Unversioned routes make breaking evolution ambiguous. Vendor fields in Device or DeviceState couple every client to manufacturer internals. A separate endpoint per brand abandons the gateway’s core abstraction. Versioning every additive change fragments clients without benefit.

## Reason

Consumers including PC RGB software need one stable brand-independent interface, while adapters need a bounded channel for optional nonportable metadata.

## Advantages

Predictable major migrations; brand-neutral core; optional extensions do not become required for normalized control.

## Disadvantages

Extension schemas still need documentation and security review; they must not smuggle credentials or replace required capabilities. Maintaining multiple major versions has cost.

## Migration and consequences

Add optional fields and event types compatibly, and require clients to ignore unknown optional content. Removing fields, changing units/meaning, tightening accepted inputs incompatibly, or altering command success semantics requires /api/v2/ with an explicit migration/deprecation policy. Event schemaVersion is not permission to change v1 semantics silently.

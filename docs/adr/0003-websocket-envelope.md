# ADR-0003: WebSocket event envelope

Status: Proposed; pending Claude’s independent review.

## Decision

Use /api/v1/events with envelope fields schemaVersion ("1.0"), id (UUID), sequence, gatewayId, bootId, type, occurredAt, subject ({type,id}), correlationId (operation UUID or null), and data. A gateway-wide sequence is ordered only within a boot; event IDs are not device IDs. The API document defines payloads and an example.

## Alternatives considered

Bare event-specific JSON saves bytes but makes tracing and compatibility inconsistent. Timestamps alone cannot reliably order simultaneous updates. A durable replay log offers stronger continuity but adds storage, retention, and subscriber cursor complexity.

## Reason

A common envelope supports ordering, restart detection, and operation correlation without promising durable delivery that Phase 1 does not provide.

## Advantages

Additive payload evolution; stable routing fields; explicit gateway restart boundary.

## Disadvantages

V1 has no replay. Network loss or slow-consumer disconnection can cause gaps; clients must reconcile REST snapshots and cannot infer that every gap means lost device data.

## Migration and consequences

Clients ignore unknown additive fields and unknown event types, and reconcile after reconnect or bootId change. Breaking envelope or payload semantics require a major API version; adding durable replay later must not reinterpret boot-scoped sequence numbers.

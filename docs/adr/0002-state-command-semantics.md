# ADR-0002: State mutation uses commands

Status: Proposed; pending Claude’s independent review.

## Decision

Use POST /api/v1/devices/{id}/commands and POST /api/v1/groups/{id}/commands for desired-state commands, returning 202 with an operation identifier and Location. GET state reports observed state. PATCH configuration with application/json changes only supplied fields; require ETag/If-Match for PATCH and DELETE. Do not expose PUT or PATCH on observed-state resources.

## Alternatives considered

PUT state suggests a complete resource replacement and creates ambiguity for omitted unsupported fields. PATCH state describes document mutation but cannot by itself express dispatch, partial hardware execution, or queued work. A synchronous command endpoint is simpler but couples request timeouts to device latency.

## Reason

Hardware execution is asynchronous and may fail per device. Separating commands from observations makes acceptance versus completion explicit and preserves an honest cache.

## Advantages

One operation model covers device/group commands, scene activation, effects and discovery; no false claim that an accepted command is already observed.

## Disadvantages

Clients must poll operations or consume events. POST requires explicit retry handling: all POST requests require an Idempotency-Key UUID scoped to token principal, method, and path; retain records for at least 24 hours from admission and reject a changed payload under the same key with 409.

## Migration and consequences

This deliberately adjusts the proposed PUT-state routes. Pre-release clients move to POST commands and operation polling; any already released contract would require a new major API version rather than silently changing PUT meaning. Repeated matching keys return the original response; operation records survive restart, and unfinished work fails with gateway_restarted rather than being automatically replayed. Retain operations for at least 24 hours after terminal status; repeated matching keys return the original admission response, while clients fetch the operation for its current status.

# ADR-0006: Observed state and desired intent are separate

Status: Proposed; pending Claude’s independent review.

## Decision

Keep observed state with observation time, freshness, and availability separate from command intent. Prefer adapter push observations, then bounded rate-aware reconciliation polls and stale-read background refresh. GET never makes indefinite promises of freshness or waits indefinitely on a cloud account. Startup state is unknown/stale until verified.

## Alternatives considered

An indefinitely authoritative cache is cheap but misses manufacturer apps, switches, other controllers, and power cycles. Polling on every read overloads slow integrations. Treating an adapter acknowledgement as physical observation hides eventual consistency and silent failures.

## Reason

The gateway shares control with independent actors. The newest command is an intention, not proof that the light now matches it.

## Advantages

External changes become visible; stale data is explicit; refresh scheduling respects shared adapter budgets.

## Disadvantages

Clients must understand unknown, unavailable, and stale states. Devices without push or readback provide weaker confirmation, which must remain visible.

## Migration and consequences

Introduce reconciliation without overwriting fresh observations with late stale replies: track request generation and monotonic ordering locally, coalesce refreshes, and reject obsolete responses. Distinguish dispatch acknowledgement from observed confirmation in operation results; do not repeatedly force a remembered desired value after an external change.

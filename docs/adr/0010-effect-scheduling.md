# ADR-0010: Rate- and latency-aware effect scheduling

Status: Proposed; pending Claude’s independent review.

## Decision

Route effect frames, commands, discovery-related calls, and reconciliation through shared adapter/account budgets with per-device constraints, bounded concurrency and queues. Prefer native effects where supported. Coalesce obsolete unsent frames; respect provider Retry-After and measured latency; never generate cloud requests at display frame rates.

## Alternatives considered

A universal 60 Hz timer is simple but exceeds cloud quotas and queues stale frames. Independent effect and polling limiters can collectively exceed the same account quota. Native-only effects avoid traffic but cannot support normalized effects on capable local devices.

## Reason

Effect quality depends on actual transport throughput. Explicit degraded cadence is more honest than claiming visual synchronization while commands lag by seconds.

## Advantages

Protects providers and devices; preserves responsiveness through bounded queues; lets fast local devices run faster independently.

## Disadvantages

Mixed transports cannot promise identical timing. Dropped/coalesced frames reduce fidelity and must be surfaced through effect updates and device outcomes. Scheduling and cancellation need deterministic tests.

## Migration and consequences

Expose effective timing and degradation without changing an adapter’s hardware capabilities. Cancel unsent frames on stop and report in-flight limitations. Recalibrate budgets as latency or quotas change; introduce priorities fairly so effects cannot starve reconciliation indefinitely.

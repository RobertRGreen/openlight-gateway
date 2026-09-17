# ADR-0004: Persistent device identifiers

Status: Proposed; pending Claude’s independent review.

## Decision

Assign each device an opaque gateway-generated UUID and persist its mapping to adapter identity plus the adapter’s stable native device identifier. Preserve the public UUID across restart and address changes. Rooms, groups, scenes, and operations have independent identifiers. Names and network addresses are not identity.

## Alternatives considered

Using IP/MAC addresses or names makes public identity sensitive, mutable, or ambiguous. Exposing native vendor IDs leaks protocol assumptions. Deterministic hashes avoid a mapping table but still require trustworthy identity input and complicate account or adapter migration.

## Reason

The public API needs stable references even when a device changes IP, display name, transport, or credentials.

## Advantages

Brand-neutral references; no native identifiers in URLs; simple relational links and backup restoration.

## Disadvantages

The mapping database must be backed up. A factory reset or ambiguous native identity cannot be merged safely without evidence. UUIDs are stable within the gateway’s persisted identity, not guaranteed globally shared identities for the same physical bulb.

## Migration and consequences

Only migrate mappings with verified identity continuity; otherwise create a new device and expose the replacement explicitly. Adapter replacement can preserve UUID through a deliberate mapping migration. Never merge devices merely because their names match.

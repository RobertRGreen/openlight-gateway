# ADR-0005: Capabilities are discriminated descriptors

Status: Proposed; pending Claude’s independent review.

## Decision

Represent capabilities as a discriminated array with one descriptor per supported capability and typed constraints. Kinds include power, brightness, rgb, rgbw, rgbww, colorTemperature, effects, transitions, and segments. Descriptors carry applicable ranges, units, effect identifiers, or segment constraints. Absence means unsupported; an unknown capability set does not justify optimistic execution.

## Alternatives considered

A fixed collection of booleans cannot describe kelvin ranges, native effect sets, or segment limits. A string list is compact but equally loses constraints. Vendor-specific capability blobs force client protocol knowledge.

## Reason

Validation must match each actual device and firmware, and effect scheduling needs more than marketing-level feature labels.

## Advantages

Honest capability reporting; precise validation errors; additive extension through versioned normalized descriptors.

## Disadvantages

Descriptor schemas and adapters need validation. New normalized kinds require client handling rules. Heterogeneous group capability unions cannot be treated as support on every member.

## Migration and consequences

Emit device.capabilities_changed after verified changes and revalidate queued commands before execution. Unknown kinds are ignored by older clients, never assumed supported. Manufacturer extras go through metadata.extensions rather than new core fields.

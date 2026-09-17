# ADR-0001: HTTP framework

Status: Proposed; pending Claude’s independent review.

## Decision

Use Fastify for the REST boundary and a WebSocket integration sharing the server lifecycle. Keep validation and HTTP translation at the API layer; the lighting core must not depend on Fastify request objects.

## Alternatives considered

Express offers broad familiarity but requires more assembly for schema validation and response contracts. Node HTTP minimizes dependencies but makes routing, validation, and lifecycle plumbing project responsibilities. A larger application framework adds conventions beyond this service’s needs.

## Reason

A small schema-oriented server boundary suits a typed gateway and can enforce consistent errors before adapter calls.

## Advantages

Central validation and lifecycle hooks; clear testable boundary; no GUI framework dependency.

## Disadvantages

Plugin compatibility and schema configuration require maintenance. Framework selection alone does not guarantee correct validation or authorization.

## Migration and consequences

Wrap framework-specific handlers at the boundary. A future framework replacement should preserve the published REST and event contracts and pass the same contract tests.

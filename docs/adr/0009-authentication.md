# ADR-0009: Token authentication on loopback and LAN

Status: Proposed; pending Claude’s independent review.

## Decision

Require bearer tokens on every REST route, including health, with loopback binding by default and explicit LAN opt-in. Store token verifiers rather than plaintext tokens. Native WebSocket clients may authenticate in upgrade headers; browser clients send {"type":"authenticate","token":"..."} as their first frame within five seconds. Deliver no events before authentication, validate browser Origin, and never accept token query parameters.

## Alternatives considered

Unauthenticated loopback trusts every local process and exposes browser-origin attack paths. LAN allowlisting alone does not identify callers. Cookie authentication requires a separate browser session/CSRF model. URL tokens leak through logs and history. Per-request user OAuth adds administration inappropriate for the initial local service.

## Reason

A consistent token model protects configuration and control across native and browser clients while supporting a simple local bootstrap flow.

## Advantages

Easy native integration; independent token revocation; predictable REST/WS authorization boundary.

## Disadvantages

Bearer-token theft grants gateway-wide v1 authority. LAN deployment needs TLS and careful token delivery. Browser first-frame authentication requires bounded unauthenticated sockets and a strict deadline.

## Migration and consequences

Rotate through a local administrative path with bounded old/new overlap, then revoke the old token and associated WebSockets. Future scoped tokens must preserve clear default permissions. See SECURITY.md for credential encryption, Origin/CORS, throttling and redaction.

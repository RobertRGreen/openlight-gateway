# Security design

Status: proposed v1 contract, pending Claude's independent review. These are implementation requirements, not a claim that the concurrent implementation already enforces every control.

## Trust boundaries and threats

A LAN is not automatically trusted. A compromised workstation, guest Wi-Fi client, malicious web page, stolen API token, untrusted device response, or compromised adapter can attempt unauthorized lighting changes, account theft, network reconnaissance, or denial of service. Protect commands, topology, device identifiers, cloud credentials, and service availability. Physical access to a light and manufacturer-account access remain independent control paths; the gateway cannot prevent those changes.

Adapters parse untrusted network data. Bound payload sizes, discovery duration, retry counts, event queues, and command concurrency. Validate addresses against configured adapter network policy; never turn arbitrary client URLs into unrestricted outbound requests. Adapter exceptions and timeouts must become structured failures. In-process adapters share the gateway's privileges: asynchronous error boundaries do not sandbox malicious code or contain an infinite CPU loop. Only vetted adapters run in process; move untrusted or unstable integrations into restricted worker processes before enabling them.

## Loopback and LAN modes

Default binding is loopback only, with token authentication still required. This limits remote reachability but does not trust other local processes or browser origins. Reject unexpected Host headers to reduce DNS-rebinding exposure. Installation/bootstrap creates a high-entropy token through a local administrative path; there is no unauthenticated network bootstrap endpoint.

LAN binding and mDNS advertisement each require explicit configuration. Advertise only gateway identity and service location, never secrets. LAN mode requires encrypted transport, either gateway TLS or a deliberately configured TLS proxy. Trust forwarded headers only from configured proxies. Firewall the service to intended networks; do not automatically expose it through router port forwarding. Native API clients should verify TLS certificates; documenting a bypass as the normal connection method would defeat token confidentiality.

## API tokens and rotation

Every REST route, including health, requires `Authorization: Bearer <token>`. Use random tokens with at least 256 bits of entropy, display the plaintext only at creation, and persist a one-way cryptographic verifier plus token identifier, creation/expiry/revocation timestamps. Compare verifiers in constant time. V1 tokens grant gateway-wide access; finer-grained scopes are future work, so do not imply room-level authorization exists.

Token administration is a local operational action, not an undocumented v1 HTTP endpoint. Rotation creates a replacement token, permits a deliberately bounded overlap while clients migrate, then revokes the old token. Revocation prevents new requests and disconnects associated WebSocket sessions; expiry is enforced on existing sessions too. Do not put tokens in URLs, command-line examples that persist shell history, or error bodies. Use `401` for missing/invalid/expired credentials and `403` for explicitly forbidden requests.

## WebSocket authentication

`/api/v1/events` uses the same tokens. Native clients may supply the Authorization header during upgrade. Browser clients cannot reliably set that header: after a successful permitted upgrade, their first application frame is an authentication message as specified in [API.md](API.md). An unauthenticated connection receives no events and is closed if authentication is absent or invalid within five seconds. Bound unauthenticated connection counts and frame sizes. Query-string and subprotocol tokens are forbidden. After authentication the socket is receive-only apart from protocol ping/pong; unsupported application messages close with code 1008.

Check the browser Origin against an explicit allowlist before upgrading; CORS is not a WebSocket access control. Native clients without Origin still require token authentication. Recheck token validity throughout the connection and close revoked sessions. Use `wss:` in LAN mode.

## Rate limits, CORS, and denial of service

Apply bounded request-body sizes, schema validation, per-IP unauthenticated limits, per-token authenticated budgets, and global concurrency limits. Discovery, commands, scene activations, effect starts, and WebSocket connections need separate cost budgets. Return `429` with `Retry-After` on REST throttling; never bypass adapter budgets because a client can enqueue quickly. Bound the operation queue and reject admission when saturated. Disconnect slow event consumers rather than grow memory indefinitely; clients reconcile with REST after reconnect.

CORS is disabled by default. Explicitly allow intended browser origins and required methods/headers only; never reflect arbitrary origins. Bearer-token authentication is not cookie based, and wildcard origins with credentials are not an acceptable substitute for policy. An allowed Origin is not authentication. Return generic public errors with an operation/request identifier for diagnosis rather than exception stacks or protocol dumps.

## Manufacturer credentials and storage

Manufacturer passwords, refresh tokens, device local keys, and cloud API secrets are not ordinary device metadata. Keep them out of public Device objects, adapter addresses, events, OpenAPI examples, and configuration exports. Prefer an OS credential store. Where it is unavailable, store authenticated ciphertext in a separate credentials table and keep its encryption key in a restricted owner-only file outside the database and repository. Never store plaintext credentials in SQLite; filesystem permissions alone are defense in depth, not the encryption design. API-token verifiers do not require reversible encryption.

Restrict database, WAL/SHM files, credential-key files, backups, and configuration directories to the service account. Backups must preserve encryption and must not package the decryption key with the database. Document that a fully compromised service account can use its live credentials; at-rest encryption does not prevent that. Rotate or revoke manufacturer credentials through their provider when compromised, independently of gateway-token rotation.

## Logs and repository hygiene

Use allowlisted structured log fields. Redact Authorization headers, authentication frames, cookies, passwords, API keys, device local keys, refresh/access tokens, cloud credentials, encryption keys, credential-bearing URLs, and adapter protocol payloads before serialization. Redaction applies to HTTP logs, exceptions, diagnostics, test snapshots, and crash artifacts. Avoid recording full network addresses or persistent identifiers unnecessarily. Never log the body of WebSocket authentication frames.

Never commit passwords, API keys, device local keys, refresh tokens, cloud credentials, real API tokens, encryption keys, populated credential databases, secret-bearing backups, or environment files containing secrets. Examples use unmistakable dummy values. A secret accidentally committed must be revoked; deleting the latest copy alone is insufficient.

Phase 1 verification must cover authentication on every route, token revocation and rotation, Origin enforcement, first-frame authentication timeout, oversized input, request throttling, and redaction of representative nested adapter errors.

# ADR-0008: Built-in SQLite persistence

Status: Proposed; pending Claude’s independent review.

## Decision

Use Node’s built-in node:sqlite DatabaseSync rather than better-sqlite3 for low-volume configuration and identity persistence. Use transactions, prepared statements, schema migrations, foreign keys, and tested backup/recovery; keep transactions short because DatabaseSync blocks the event loop.

## Alternatives considered

better-sqlite3 is a mature synchronous option but adds a native binding dependency and potential compile/install steps. An external database adds deployment and administration costs. JSON files simplify first startup but weaken relational integrity and concurrent update handling.

## Reason

This is a deliberate specialization of a generic “any SQLite library” instruction: built-in SQLite is boring and reliable for a standalone local service and avoids an extra native-binding compile step. The coordinator and this author verified Node v26.8.2 on this machine can create a DatabaseSync in-memory database and run a query.

## Advantages

Local single-file persistence; no external service; no separate SQLite native addon to compile; transactional configuration updates.

## Disadvantages

DatabaseSync can stall event delivery during long queries. The module was introduced in Node 22.5, but “introduced” must not be represented as stable on every Node >=22.5: release lines differ in flags/API maturity. The verified deployment baseline is Node v26.8.2; test other supported releases explicitly.

## Migration and consequences

The concurrent implementation must align its engine declaration and dependencies to the chosen runtime and remove better-sqlite3 use; this documentation task does not edit package.json. Preserve logical SQLite schema where compatible and test migrations/backups before driver replacement. Never persist plaintext manufacturer secrets; use encrypted storage described in SECURITY.md.

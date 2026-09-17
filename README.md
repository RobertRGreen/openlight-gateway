# OpenLight Gateway

OpenLight is a standalone, local-first lighting API. It lets automation and PC RGB clients control lights through a shared device, capability, command, and event model. It has no GUI.

The working backend is the **mock adapter**: five simulated devices demonstrate RGB, tunable white, dimmable white, RGBW, and offline behavior. Govee, Feit Electric, and Hubspace/Afero fit the adapter architecture but **are not implemented; real hardware is not supported yet**. The REST API, authenticated WebSocket events, SQLite persistence, rooms, groups, scenes, and operation results use the existing core. Static and pulse effects execute; the other catalog entries are planned and return `effect_not_implemented`.

## Architecture

Clients → Fastify REST/WebSocket API → lighting core → adapters → devices. The core owns persistent identity, capabilities, reconciliation, operation scheduling, and per-device outcomes. SQLite stores configuration, token verifiers, and retained operations/idempotency records. Observed state is distinct from requested state; accepted commands return an operation to poll. See [architecture](docs/ARCHITECTURE.md) and the [API contract](docs/API.md).

## Quick start

Use Node with working built-in `node:sqlite` support. This checkout was tested on Node v26.8.2; the package declares Node >=22.5, but a broader runtime matrix has not been validated.

```sh
npm install
npm run dev
```

The default address is `http://localhost:3000` (bound to `127.0.0.1`), the database is `./data/openlight.sqlite`, and mDNS is off. **All routes require a Bearer token, including localhost and health.** In another terminal, create a local token using the same database and configuration. Capture it without writing the literal token into shell history:

```sh
export OPENLIGHT_TOKEN="$(node --import tsx src/service/token.ts create)"
auth_config() { printf 'header = "Authorization: Bearer %s"\n' "$OPENLIGHT_TOKEN"; }
auth_config | curl --config - http://localhost:3000/api/v1/health
auth_config | curl --config - http://localhost:3000/api/v1/devices
```

The token is displayed only at creation (the command above captures it); the database stores its verifier. `node --import tsx src/service/token.ts rotate TOKEN_ID 60000` allows a 60-second overlap; `revoke TOKEN_ID` revokes it. TOKEN_ID is the UUID before the dot, not the secret. Keep `API_TOKEN_SALT` consistent across the server and CLI if configured.

Claude verified these authenticated requests against the live mock-backed server on September 17, 2026. `/health` returned:

```json
{"status":"ready","gatewayId":"8155b772-5a63-4b21-8430-322e5a8971cd","bootId":"9a5fd5ea-e10f-411c-a01f-e922ef6c1a8c"}
```

`/devices` returned an `items` collection with all five mock devices. This excerpt retains the observed RGB bulb response; its UUID is abbreviated and the remaining four devices (temperature, white, RGBW, and offline) are omitted:

```json
{
  "items": [
    {
      "id": "b38c2e88-...",
      "name": "Mock RGB bulb",
      "manufacturer": "OpenLight",
      "model": "rgb",
      "adapter": "mock",
      "address": {"transport": "mock", "endpoint": null},
      "room": null,
      "groups": [],
      "capabilities": [
        {"type": "power"},
        {"type": "brightness", "minimum": 0, "maximum": 100, "step": 1},
        {"type": "rgb"},
        {"type": "colorTemperature", "minimum": 2200, "maximum": 6500, "step": 100}
      ],
      "state": {"power": false, "brightness": 50, "rgb": {"r": 255, "g": 255, "b": 255}, "colorTemperature": 2700},
      "stateObservedAt": "2026-09-17T20:18:06.900Z",
      "stateStale": false,
      "revision": 1,
      "availability": "online",
      "metadata": {"extensions": {}}
    }
  ]
}
```

IDs and observation timestamps will differ for your installation.

## Commands and events

Select the RGB device UUID from `/devices`. Every POST requires a fresh UUID `Idempotency-Key`; reuse that key and identical JSON only when retrying the same request.

```sh
DEVICE_ID='<RGB device UUID from the response>'
KEY="$(node -p 'crypto.randomUUID()')"
auth_config | curl --config - -X POST \
  "http://localhost:3000/api/v1/devices/$DEVICE_ID/commands" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
  --data '{"state":{"power":true,"brightness":65,"rgb":{"r":255,"g":0,"b":128}}}'
```

None of the five mock devices advertises the `transitions` capability. Adding `transitionMs` to this command returns `422 capability_mismatch` on `/transitionMs`.

A `202` response includes an Operation and `Location: /api/v1/operations/{id}`. Poll that authenticated URL for terminal results. Group results can be `partial`; a white-only device rejects RGB with `422 capability_mismatch`, and a known offline singleton returns `409 device_offline`. PATCH and DELETE require the current detail response's ETag in `If-Match`.

A native WebSocket client supplies the same Authorization header during upgrade. A browser needs an explicitly allowed Origin (for example start the server with `CORS_ORIGINS=http://localhost:8080`) and sends authentication as its first frame within five seconds:

```js
// Run from your explicitly allowed browser application; token comes from user input.
const ws = new WebSocket('ws://localhost:3000/api/v1/events');
const buffered = [];
ws.onopen = () => ws.send(JSON.stringify({ type: 'authenticate', token }));
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.type === 'authenticated') {
    // Fetch authenticated REST snapshots while buffering incoming events.
    console.log('Authenticated', message.gatewayId, message.bootId);
  } else {
    buffered.push(message);
    console.log(message.type, message.subject, message.data);
  }
};
```

After fetching snapshots, apply newer device-state revisions from the buffer; refetch aggregate/configuration resources. Refetch after sequence gaps or a changed bootId. There is no event replay. Authenticated sockets are receive-only except protocol ping/pong. Never place tokens in URLs or subprotocols. Use `wss:` in LAN mode.

## Adapters and security

Adapters implement discovery, transport, capabilities, observation, and writes. The core uses their shared interface rather than manufacturer branches. Adding a manufacturer requires protocol research, truthful capability mapping, bounded transport calls, and conformance tests; see [adding adapters](docs/ADAPTERS.md).

Localhost is the default, not an authentication bypass. Host validation, explicit browser Origins, bounded bodies and queues, request budgets, and token verification protect the API. LAN binding requires `BIND_MODE=lan` plus gateway TLS (`TLS_MODE=gateway`, certificate/key paths) or an explicitly trusted TLS proxy (`TLS_MODE=proxy`, `TRUSTED_PROXIES`). Set `ALLOWED_HOSTS` to the intended hostname(s); enable `MDNS_ENABLED=true` only deliberately. Manufacturer credentials do not belong in normalized state or logs. See [security](docs/SECURITY.md).

## Development and installation

```sh
npm run typecheck
npm test
npm run build
npm start
```

The [systemd user unit](docs/openlight-gateway.service) includes installation instructions for a built checkout at `~/openlight-gateway`. Adjust the path and Node executable for your installation. It is supplied only; development does not install or enable it.

## Roadmap

Phase 1 is the mock-backed gateway and its independent acceptance review. Later phases add researched and hardware-tested Govee/Feit/Hubspace adapters, local standards and bridges, then PC RGB coordination and richer effects. Scoped tokens and durable event replay are future work. See [the roadmap](docs/ROADMAP.md).

# OpenLight Gateway

OpenLight is a standalone, local-first lighting API. It lets automation and PC RGB clients control lights through a shared device, capability, command, and event model. It has no GUI.

The default backend is the **mock adapter**: five simulated devices demonstrate RGB, tunable white, dimmable white, RGBW, and offline behavior. An opt-in **Govee LAN adapter** implements UDP discovery and control; independent hardware verification is pending (the maintainer's own Govee bulbs don't support the LAN API). A separate opt-in **Govee Cloud adapter** supports devices available through the official Developer API, including bulbs without LAN Control. An opt-in **Feit Electric adapter** speaks Tuya's local protocol directly (versions 3.3, 3.4, and 3.5) — **hardware-verified**: discovery, state readback, power, brightness, and RGB color have all been confirmed working against a real Feit bulb (Tuya protocol 3.5). Hubspace/Afero is not implemented. The REST API, authenticated WebSocket events, SQLite persistence, rooms, groups, scenes, and operation results use the existing core. Static and pulse effects execute; the other catalog entries are planned and return `effect_not_implemented`.

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
export OPENLIGHT_TOKEN="$(node --env-file-if-exists=.env --import tsx src/service/token.ts create)"
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

### Govee LAN setup

For each supported device, manually enable **LAN Control** in the official Govee Home app before discovery. Devices without this toggle, or with it disabled, will not respond; the gateway cannot enable it automatically. Keep the gateway and devices on a network that permits multicast discovery and UDP responses, then opt in:

```sh
GOVEE_ADAPTER_ENABLED=true npm run dev
```

(Or set `GOVEE_ADAPTER_ENABLED=true` in `.env` for it to persist across restarts — see `.env.example`.)

Startup discovery sends the scan to `239.255.255.250:4001`, receives responses on UDP port `4002`, and sends device commands to each device's IP on UDP port `4003`. Permit these ports through the host/network firewall. `GOVEE_DISCOVERY_TIMEOUT_MS` defaults to 1500 milliseconds and is bounded by `ADAPTER_TIMEOUT_MS`. Discovery runs in the background so its deadline or a socket failure does not delay mock/API readiness. Restart the gateway to repeat startup discovery after enabling LAN Control or changing the network.

Govee LAN devices advertise only power, brightness (0–100%), and RGB color. Color temperature, effects, transitions, and segments are not exposed by this LAN integration, even when available in Govee's app. State is read with `devStatus`; writes and observations remain subject to UDP loss and device availability. Tests use an injected fake transport; live hardware acceptance is pending Claude's independent review.

### Govee Cloud setup

Obtain a Developer API key through the Govee Home app and set `GOVEE_API_KEY` in `.env` (copy from `.env.example` if you haven't already — `npm run dev`/`npm start` load it automatically via Node's `--env-file-if-exists`). Enable `GOVEE_CLOUD_ADAPTER_ENABLED=true` (default `false`) and restart the gateway. The flag requires a non-empty key; missing credentials produce a clear startup error while mock/API/LAN readiness remains available. Cloud discovery runs in the background and queries the account's device list once at startup. Cloud startup failures remain isolated from the other adapters.

This is a separate adapter identity, `govee-cloud`; LAN retains `govee` and does not require an API key. Devices without a LAN Control toggle can use the cloud adapter if the Developer API lists them. **Known limitation:** enabling both adapters can register the same physical bulb twice, once under each adapter identity; there is no cross-adapter deduplication.

Capabilities come from each device's API response: power, brightness with its actual range and step, RGB, and color temperature with its actual Kelvin range. Effects, transitions, and segments are not exposed. The cloud API uses packed RGB integers; OpenLight accepts ordinary RGB channels. Direct adapter calls with brightness `0` send power off because Govee's brightness range starts at `1`. REST callers should send `{"state":{"power":false}}` to turn off: REST validation preserves the advertised brightness minimum and rejects brightness below it.

Cloud requests require internet access and use separate limits: control 12 requests/second/account with burst 80, state 30 requests/minute/device, and discovery 30 requests/minute/account with burst 30. A device state response reporting offline produces an offline availability update and an `OFFLINE` error; its cached values are not returned as a fresh observation. Tests mock HTTP; live hardware acceptance and Claude's independent review remain pending. See [manufacturer research](docs/DEVICE-RESEARCH.md).

### Feit Electric (Tuya local) setup

Feit bulbs are unbranded Tuya hardware with no protocol of their own, so this adapter speaks Tuya's local protocol directly — no cloud dependency at runtime, no network discovery. You extract each device's credentials once, outside this repo, using the community `tinytuya wizard` tool (requires a free Tuya IoT Platform developer account and re-pairing one bulb into Tuya's own "Smart Life" app to link it): it writes a `devices.json` with each device's `id`, `key` (local key), `ip`, and `version`.

Configure devices via `FEIT_DEVICES`, a JSON array of `{id, name, ip, localKey, version, dpsMap?}`:

```sh
FEIT_ADAPTER_ENABLED=true FEIT_DEVICES='[{"id":"...","name":"Bedroom Lamp","ip":"192.168.1.50","localKey":"...","version":"3.5"}]' npm run dev
```

For a persistent setup, put both in `.env` instead (loaded automatically by `npm run dev`/`npm start`) — **wrap `FEIT_DEVICES` in single quotes there**: a local key is a random string that can contain a literal `#`, which Node's `.env` parser otherwise treats as a comment and silently truncates the value. See `.env.example`.

`version` must be `"3.3"`, `"3.4"`, or `"3.5"` — anything else is rejected outright rather than guessed at. `dpsMap` lets you override the data-point numbering/ranges for products that don't match the common defaults (power=DP20, mode=DP21, brightness=DP22 range 10–1000, colour=DP24); colour temperature is only advertised as a capability when you supply both a calibrated raw range and a real Kelvin range — there's no fabricated default. Colour encoding (legacy hex string vs newer JSON `{h,s,v}`) is auto-detected per device at read time, no configuration needed.

**Hardware-verified (2026-09-18):** discovery, capability reporting, state readback, `setPower`, `setBrightness`, and `setColor` were all confirmed working end-to-end against a real Feit RGBCW bulb on protocol 3.5 — every write was verified by reading the resulting device state back and matching the requested value exactly. Versions 3.3 and 3.4 are implemented against the same protocol family but not yet confirmed against real 3.3/3.4 hardware.

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

Phase 1 is the merged mock-backed gateway. Govee LAN, Govee Cloud, and Feit Electric (Tuya local) are implemented; Feit is hardware-verified, Govee LAN awaits LAN-capable hardware, Govee Cloud awaits a live-verified run with a real API key. Later work adds Hubspace, local standards and bridges, then PC RGB coordination and richer effects. Scoped tokens and durable event replay are future work. See [the roadmap](docs/ROADMAP.md).

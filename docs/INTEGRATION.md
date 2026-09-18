# Integrating OpenLight into another application

This is a practical guide for consuming the OpenLight Gateway API from an external application — a PC RGB controller, a game, a home automation script, anything that wants to treat smart lighting as "just another controllable lighting backend." OpenLight itself has no knowledge of, or dependency on, any specific consumer; this document exists so a consumer doesn't have to re-derive the contract from [API.md](API.md) and [openapi.yaml](../openapi/openapi.yaml) from scratch.

## When to use this

If your application already has its own concept of controllable lighting devices — physical RGB peripherals, a scene/effect engine, a desired-state model — the natural integration shape is to treat OpenLight as one more backend behind that abstraction: your app keeps owning scene definitions and scheduling, and forwards the specific commands destined for OpenLight-managed devices through the client described below. OpenLight forwards those commands to real bulbs and reports back what actually happened (including partial failures and capability mismatches), and separately emits events when a light changes state for reasons your app didn't initiate (someone used a physical switch, another app, or the manufacturer's own app).

## Authentication

Every route, including `GET /api/v1/health`, requires a Bearer token unless the deployment has deliberately disabled auth (not the default — see [SECURITY.md](SECURITY.md)). Create one from the gateway's own machine:

```sh
node --env-file-if-exists=.env --import tsx src/service/token.ts create
```

This prints the plaintext token to stdout once — it is never recoverable again (the database only stores a verifier). Capture it into a secret store your integration controls, not into shell history or a committed file. `token.ts rotate TOKEN_ID OVERLAP_MS` and `token.ts revoke TOKEN_ID` manage existing tokens; `TOKEN_ID` is the UUID portion before the token's `.`, not the secret itself. Send it as `Authorization: Bearer <token>` on every REST request and on the WebSocket upgrade (see below).

## REST basics

Base path: `/api/v1`. All requests/responses are JSON. All `POST` requests require an `Idempotency-Key` header (any UUID you generate fresh per logically distinct command — reusing the same key with the same body returns the original result without re-executing; reusing it with a different body is a `409`).

**Health check**

```sh
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/health
# {"status":"ready","gatewayId":"...","bootId":"..."}
```

```python
resp = session.get(f"{base_url}/health")
resp.raise_for_status()
```

**List devices**

```sh
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/devices
```

Returns `{"items":[Device, ...]}`. Each `Device` carries its normalized `capabilities` (an array of typed descriptors — `power`, `brightness`, `rgb`, `rgbw`, `rgbww`, `colorTemperature`, `effects`, `transitions`, `segments`, each with its own real min/max/step where applicable) and its last observed `state`/`stateObservedAt`/`stateStale`/`availability`. Never assume a device supports a capability it didn't advertise — sending an unsupported field is rejected (see Error handling below), never silently approximated.

**Read a device's state**

```sh
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/devices/$DEVICE_ID/state
```

This is a cached, possibly-stale snapshot (`{"state":{...},"observedAt":...,"stale":bool,"revision":N}`), not a synchronous hardware poll — the gateway reconciles state via background subscriptions/polling per its own adapter budgets.

**Send a command**

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"state":{"power":true,"brightness":80,"rgb":{"r":155,"g":0,"b":255}},"transitionMs":500}' \
  http://localhost:3000/api/v1/devices/$DEVICE_ID/commands
```

This always returns `202` with an `Operation` in `queued` status and `Location: /api/v1/operations/{id}` — **admission is not proof of execution**. Poll `GET /api/v1/operations/{id}` until `status` is terminal (`succeeded`, `partial`, or `failed`):

**Important:** a command can be rejected two different ways, and a real client has to handle both. A structurally-invalid request or a capability mismatch (e.g. RGB on a white-only bulb) is rejected **synchronously** with a `4xx` and an `{"error": {...}}` body — no `Operation` is ever created for it. A request that *is* admitted (`202`) can still end up `partial` or `failed` once the gateway actually tries to reach the device (e.g. it went offline between admission and dispatch). The reference client below normalizes both into the same shape so calling code only has to check one thing:

```python
def send_command(self, device_id: str, state: dict, transition_ms: int | None = None) -> dict:
    body = {"state": state}
    if transition_ms is not None:
        body["transitionMs"] = transition_ms
    resp = self._session.post(
        f"{self._base_url}/devices/{device_id}/commands",
        json=body,
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    if resp.status_code == 202:
        return self._poll_operation(resp.json()["id"])
    if resp.status_code in (400, 404, 409, 422):
        # Synchronous rejection: normalize into the same {"results": [...]} shape as a
        # polled Operation, so callers only need one code path to check outcomes.
        return {"status": "rejected", "results": [{"deviceId": device_id, "status": "failed", "error": resp.json()["error"]}]}
    resp.raise_for_status()  # anything else (5xx, etc.) is a real unexpected failure

def _poll_operation(self, operation_id: str, timeout_s: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        resp = self._session.get(f"{self._base_url}/operations/{operation_id}")
        resp.raise_for_status()
        op = resp.json()
        if op["status"] in ("succeeded", "partial", "failed"):
            return op
        time.sleep(0.1)
    raise TimeoutError(f"Operation {operation_id} did not complete in time")
```

**Groups and their partial-failure shape**

`POST /api/v1/groups/{id}/commands` behaves the same way — 202 + a pollable `Operation` — but its `results` array has one entry per group member, and the terminal `status` can be `partial`:

```json
{
  "id": "b780bb96-...", "kind": "group.command", "status": "partial",
  "targetDeviceIds": ["dev-1", "dev-2"],
  "results": [
    {"deviceId": "dev-1", "status": "succeeded", "confirmation": "observed", "fieldResults": [{"path": "/power", "status": "applied"}]},
    {"deviceId": "dev-2", "status": "failed", "confirmation": "unconfirmed", "error": {"code": "device_offline", "message": "Device is offline"}}
  ]
}
```

**A `202` (or even a terminal `succeeded` operation status) never means "every target device succeeded" for a group — always read `results[]` per device.** See Error handling below.

**Scenes**

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  http://localhost:3000/api/v1/scenes/$SCENE_ID/activate
```

Same 202-plus-pollable-Operation pattern. By default scene activation does not permit lossy fallbacks (`allowDegraded:false`); a device that can't reproduce the exact requested state is a failed target for that scene unless the caller explicitly opts into documented degradation.

**Other routes** (full detail in [API.md](API.md) / [openapi.yaml](../openapi/openapi.yaml)): `GET/POST /rooms`, `GET/PATCH/DELETE /rooms/{id}`, `GET /rooms/{id}/state`, `GET/POST /groups`, `GET/PATCH/DELETE /groups/{id}`, `GET /groups/{id}/state`, `GET/POST /scenes`, `GET/PATCH/DELETE /scenes/{id}`, `GET /effects`, `GET /effects/{id}`, `POST /effects/{id}/start`, `GET /effect-runs`, `GET /effect-runs/{id}`, `POST /effect-runs/{id}/stop`, `POST /discovery/start`, `PATCH /devices/{id}` (metadata/room/group membership, not state).

## Error handling a real integration must handle

- **`422 capability_mismatch`** — a command targeted a capability the device doesn't advertise (e.g. `rgb` on a white-only bulb). Don't crash; skip or report that field for that device.
  ```json
  {"error":{"code":"capability_mismatch","message":"Device does not support rgb","requestId":"req-28",
    "details":[{"path":"/state/rgb","code":"unsupported_capability","message":"Required capability rgb is absent","deviceId":"...","capability":"rgb"}]}}
  ```
- **`409 device_offline`** — a known-offline single device rejects the command outright without queuing it.
- **`422 validation_error`** — malformed/out-of-range request body; `details[]` gives per-field `path`/`code`/`message`.
- **Partial group results** — see above; always inspect `results[]`, never trust the outer status alone.
- **Idempotency conflicts (`409 idempotency_conflict`)** — reusing an `Idempotency-Key` with a different body. Generate a fresh key per logically distinct command, and don't blindly retry an already-admitted command past the idempotency retention window without checking the operation's actual outcome first.

```python
op = client.send_command(device_id, {"rgb": {"r": 255, "g": 0, "b": 0}})
for result in op["results"]:  # send_command() normalizes both a rejected admission and a polled Operation into this shape
    if result["status"] != "succeeded":
        error = result.get("error", {})
        if error.get("code") == "capability_mismatch":
            log.warning("device %s can't do %s, skipping", result["deviceId"], error["details"][0]["capability"])
        elif error.get("code") == "device_offline":
            log.warning("device %s is offline", result["deviceId"])
        else:
            log.error("device %s command failed: %s", result["deviceId"], error)
```

## WebSocket events (`/api/v1/events`)

Native (non-browser) clients authenticate by sending `Authorization: Bearer <token>` as a header on the WebSocket upgrade request itself — no first-frame handshake required (that flow is for browser clients, which can't set that header on a WebSocket connect and instead send `{"type":"authenticate","token":"..."}` as their first message). On success the server sends `{"type":"authenticated","gatewayId":"...","bootId":"..."}`. The connection is receive-only after that (aside from protocol ping/pong) — malformed or unexpected application frames close it. Query strings and subprotocols are rejected; a token with no `Authorization` header and no browser `Origin` header is also rejected.

The event envelope (a long-term compatibility contract):

```json
{
  "schemaVersion": "1.0", "id": "a78adb8a-...", "sequence": 42,
  "gatewayId": "f8603ea7-...", "bootId": "5026cf62-...",
  "type": "device.state_changed", "occurredAt": "2026-09-18T18:00:01Z",
  "subject": {"type": "device", "id": "..."},
  "correlationId": "b780bb96-...",
  "data": {"state": {"power": true, "brightness": 65}, "observedAt": "...", "stale": false, "revision": 8}
}
```

Subscribe to `device.state_changed` (and `device.connected`/`device.disconnected`) so your integration notices lights that changed for reasons it didn't initiate — a physical switch, another app, the manufacturer's own app. Don't rely solely on your own command results to know current state. There is no event replay: after connecting, a reconnect, or a detected `sequence` gap / new `bootId`, refetch the affected resource(s) via REST rather than assuming you didn't miss anything.

```python
import json
import time
import websockets

class _EventSubscriber:
    def __init__(self, ws_url: str, token: str, on_event, on_gap):
        self._ws_url, self._token, self._on_event, self._on_gap = ws_url, token, on_event, on_gap
        self._last_sequence = None
        self._boot_id = None

    async def run(self):
        while True:
            try:
                async with websockets.connect(self._ws_url, additional_headers={"Authorization": f"Bearer {self._token}"}) as ws:
                    control = json.loads(await ws.recv())
                    assert control["type"] == "authenticated"
                    if self._boot_id != control["bootId"]:
                        self._boot_id = control["bootId"]
                        self._on_gap()  # new boot: refetch REST snapshots before trusting further events
                    self._last_sequence = None
                    async for raw in ws:
                        event = json.loads(raw)
                        if self._last_sequence is not None and event["sequence"] != self._last_sequence + 1:
                            self._on_gap()  # missed something: refetch the affected resource
                        self._last_sequence = event["sequence"]
                        self._on_event(event)
            except (websockets.ConnectionClosed, OSError):
                time.sleep(2)  # reconnect with backoff; a fresh handshake resynchronizes bootId
```

## A complete reference Python client

Requires `pip install requests websockets`.

```python
import asyncio
import json
import time
import uuid

import requests
import websockets


class OpenLightClient:
    def __init__(self, base_url: str, token: str):
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {token}"

    def list_devices(self) -> list[dict]:
        resp = self._session.get(f"{self._base_url}/devices")
        resp.raise_for_status()
        return resp.json()["items"]

    def get_device(self, device_id: str) -> dict:
        resp = self._session.get(f"{self._base_url}/devices/{device_id}")
        resp.raise_for_status()
        return resp.json()

    def send_command(self, device_id: str, state: dict, transition_ms: int | None = None) -> dict:
        body = {"state": state}
        if transition_ms is not None:
            body["transitionMs"] = transition_ms
        resp = self._session.post(
            f"{self._base_url}/devices/{device_id}/commands",
            json=body,
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        if resp.status_code == 202:
            return self._poll_operation(resp.json()["id"])
        if resp.status_code in (400, 404, 409, 422):
            return {"status": "rejected", "results": [{"deviceId": device_id, "status": "failed", "error": resp.json()["error"]}]}
        resp.raise_for_status()

    def _poll_operation(self, operation_id: str, timeout_s: float = 10.0) -> dict:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            resp = self._session.get(f"{self._base_url}/operations/{operation_id}")
            resp.raise_for_status()
            op = resp.json()
            if op["status"] in ("succeeded", "partial", "failed"):
                return op
            time.sleep(0.1)
        raise TimeoutError(f"Operation {operation_id} did not complete in time")

    def subscribe(self, on_event, on_gap=lambda: None) -> None:
        """Blocking; run in its own thread/process, or call `asyncio.run(self.subscribe_async(...))` yourself."""
        ws_url = self._base_url.replace("http://", "ws://").replace("https://", "wss://") + "/events"
        asyncio.run(self._subscribe_async(ws_url, on_event, on_gap))

    async def _subscribe_async(self, ws_url: str, on_event, on_gap) -> None:
        last_sequence = None
        boot_id = None
        while True:
            try:
                async with websockets.connect(ws_url, additional_headers={"Authorization": f"Bearer {self._token}"}) as ws:
                    control = json.loads(await ws.recv())
                    if boot_id != control["bootId"]:
                        boot_id = control["bootId"]
                        on_gap()
                    last_sequence = None
                    async for raw in ws:
                        event = json.loads(raw)
                        if last_sequence is not None and event["sequence"] != last_sequence + 1:
                            on_gap()
                        last_sequence = event["sequence"]
                        on_event(event)
            except (websockets.ConnectionClosed, OSError):
                await asyncio.sleep(2)


if __name__ == "__main__":
    client = OpenLightClient("http://localhost:3000/api/v1", token="...")
    for device in client.list_devices():
        print(device["id"], device["name"], device["availability"])
```

## Using OpenLight as a backend in a consumer's own architecture

A consumer with its own "desired state → scheduler → hardware backend" architecture (a common shape for RGB/lighting controllers: a single authoritative desired-state store, a scheduler that diffs desired vs. last-known state and writes only what changed, and one backend class per hardware family) can treat `OpenLightClient` as one more backend alongside its native ones:

- **Outbound**: when the consumer's scheduler decides an OpenLight-managed zone's desired state changed, translate that zone's normalized color/brightness/power/transition into `send_command(device_id, state, transition_ms)` and fold the returned `Operation`'s per-field results back into the consumer's own last-known-state bookkeeping — a `capability_mismatch` or `device_offline` result should surface the same way a native backend's own write failure would, not crash the scheduler.
- **Inbound**: run `subscribe()` on a background thread/task and feed `device.state_changed` (and `device.connected`/`device.disconnected`) events into the consumer's own reconciliation path — the same path that already has to handle a native device being changed by something outside the consumer's control. This is what lets an OpenLight-managed light that got turned on/off from a physical switch, another app, or the manufacturer's app get picked up correctly instead of being silently overwritten on the next scheduler tick.
- Treat OpenLight's device UUIDs as another backend's native device identifiers — stable across restarts, safe to persist in the consumer's own zone-to-device mapping.

This keeps OpenLight and the consumer decoupled in both directions: OpenLight never needs to know the consumer exists, and the consumer's core scheduling/effect logic doesn't need a special case for "this zone happens to be a smart bulb."

# Presets: animated palettes that bulbs play by themselves

A **preset** is a named palette (1–8 colors) plus a mode and a speed. You create it once through the API, then any
supported bulb can play it with a single command. The bulb runs the animation itself, so there is no per-frame traffic,
no polling, and no rate-limit pressure. This is how you get smooth multi-color "breathing" instead of one static color.

Presets are created, edited and deleted **live**: devices start or stop advertising them immediately, with no gateway
restart. They are stored in the gateway's database and survive restarts.

> Status: hardware-verified on Feit Electric (Tuya) bulbs. Other adapters do not support presets yet; see
> [Device support](#device-support).

## Presets vs scenes vs software effects

| | What it is | Who runs the animation | Use it for |
|---|---|---|---|
| **Preset** (this doc) | One looping palette | **The bulb itself** | Smooth ambient animation, "themes" |
| **Scene** (`/scenes`) | A set of device states applied once | Nobody; it is a one-shot snapshot | "Movie night": this bulb red, that one off |
| **Software effect** (`/effects`) | Frames computed by the gateway | **The gateway**, frame by frame | Effects the hardware cannot do itself |

A preset is not a scene: it does not contain device states and is not tied to particular devices. Any device that
advertises the preset can play it.

## Quick start

All examples assume `BASE=http://localhost:3000/api/v1` and `TOKEN` holds a bearer token (see
[INTEGRATION.md](INTEGRATION.md#authentication)).

```bash
# 1. Create. POST needs an Idempotency-Key (any UUID).
curl -s -X POST "$BASE/presets" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"Cyber","colors":["#00fff2","#ff2079"],"mode":"gradient","speed":30}'
# 201 -> {"id":"9951bf64-...","name":"Cyber","mode":"gradient","speed":30,"colors":["#00fff2","#ff2079"],...}
# Headers: Location: /api/v1/presets/9951bf64-...   ETag: "030ad1e2..."

# 2. Play it on a bulb. Power on AND effect in one command: applying a preset does NOT turn a bulb on by itself.
curl -s -X POST "$BASE/devices/$DEVICE_ID/commands" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"state":{"power":true,"effect":"9951bf64-..."}}'
# 202 -> an Operation; poll GET /operations/{id} until status is succeeded/partial/failed.

# 3. Stop it (the bulb returns to the color or white mode it had before).
curl -s -X POST "$BASE/devices/$DEVICE_ID/commands" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"state":{"effect":null}}'

# 4. Edit (partial). PATCH requires the current ETag in If-Match.
ETAG=$(curl -si "$BASE/presets/$ID" -H "Authorization: Bearer $TOKEN" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
curl -s -X PATCH "$BASE/presets/$ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "If-Match: $ETAG" \
  -d '{"speed":60}'

# 5. Delete. Also requires If-Match. 204 on success.
curl -s -X DELETE "$BASE/presets/$ID" -H "Authorization: Bearer $TOKEN" -H "If-Match: $ETAG"
```

## The preset object

| Field | Type | Rules |
|---|---|---|
| `id` | UUID string | Assigned by the gateway, opaque and permanent. **Also the effect ID** you use in commands. |
| `name` | string | 1–64 characters, not blank. Surrounding whitespace is trimmed. Names need not be unique. |
| `colors` | string[] | 1–8 entries, each `#rrggbb` (the `#` is optional on input). Stored lowercase with `#`. Played in order, looping. |
| `mode` | string | `gradient` (default): fade smoothly between colors. `jump`: snap between colors. `static`: hold each color. |
| `speed` | integer | 1–100, default 50. **Higher is faster.** See [Speed](#speed-and-color-guidance). |
| `createdAt`, `updatedAt` | ISO 8601 | Set by the gateway. |

Validation is strict: unknown properties are rejected, and invalid values return `422 validation_error` with a message
naming the rule that failed. The collection holds at most 10,000 presets (`422 resource_limit`).

## Endpoints

| Method | Path | Purpose | Success |
|---|---|---|---|
| GET | `/presets` | List all presets, in creation order | 200 `{"items":[...]}` |
| POST | `/presets` | Create (needs `Idempotency-Key`) | 201 + `Location` + `ETag` |
| GET | `/presets/{id}` | Read one | 200 + `ETag` |
| PATCH | `/presets/{id}` | Edit supplied fields (needs `If-Match`) | 200 + new `ETag` |
| DELETE | `/presets/{id}` | Delete (needs `If-Match`) | 204 |

Behaviour that matters to a client:

* **PATCH is partial.** Only the fields you send change, and `colors`, if sent, **replaces the whole list** (it is not
  merged). The merged result is validated again, so `{"speed":500}` fails and changes nothing. An empty patch is rejected.
* **Optimistic concurrency.** `GET` returns an `ETag`. `PATCH` and `DELETE` must send it as `If-Match`. A missing header
  is `428 precondition_required`; a stale one is `412 precondition_failed` (someone else changed the preset: re-read and
  retry). The ETag changes on every edit.
* **Idempotent create.** Repeating a `POST` with the same `Idempotency-Key` and body returns the original response
  instead of creating a second preset, so it is safe to retry after a network failure. A *new* key creates a *new*
  preset, even with an identical body: names are not unique.
* **Auth.** Every endpoint needs a bearer token (`401` without one).
* **Unknown or malformed ids:** `404 not_found` for an unknown UUID, `422 validation_error` for something that is not a UUID.

Full request/response schemas are in [`openapi/openapi.yaml`](../openapi/openapi.yaml) (`Preset`, `PresetCreate`,
`PresetPatch`).

## Applying a preset

Presets use the normal command endpoint. The preset's `id` is an **effect ID**:

```json
POST /devices/{deviceId}/commands
{ "state": { "power": true, "effect": "<preset id>" } }
```

* **Applying a preset does not turn a bulb on.** If the bulb is off, `{"effect": "<id>"}` alone is accepted and the
  operation reports `succeeded`, but the bulb stays dark. Always send `power: true` with it. The core runs `power` first,
  then the effect, so the combined command is the supported way to play a preset from off. (Hardware-verified.)
* **Stopping:** `{"state":{"effect":null}}` ends the animation and returns the bulb to the color or white mode it was in
  before the preset started.
* **No mixing:** `effect` cannot be combined with `rgb`, `rgbw`, `rgbww`, `colorTemperature` or `segments` in one command
  (`422 validation_error`). Sending a color or color-temperature command to a playing bulb switches it out of scene mode,
  which ends the animation.
* **Brightness is not supported while a preset plays.** The preset's own colors carry their brightness (a dark hex such
  as `#101010` produces a dim step). A separate `brightness` command may be ignored or may end the animation; do not
  rely on either.
* **Groups** (`POST /groups/{id}/commands`) work the same way. Members that do not advertise the effect fail with
  `capability_mismatch` in their per-device result, and the operation is `partial`.
* **Confirmation:** the gateway reads the bulb back after the write. A successful start reports `confirmation: observed`
  and the device's `state.effect` equals the preset id.

### What a playing device looks like

```json
{ "power": true, "brightness": 100, "rgb": {"r":255,"g":0,"b":25}, "effect": "9951bf64-..." }
```

While a scene plays, the bulb reports no color of its own, so `rgb` and `brightness` in the gateway's state are the **last
values seen before the scene** and are stale. Treat **`effect` as the truth**: it is the id of the preset playing, or
`null` when none is.

## How devices learn about presets (live, no restart)

A device that supports presets advertises them as an `effects` capability whose `effectIds` are the preset ids:

```json
"capabilities": [ {"type":"power"}, {"type":"brightness","minimum":0,"maximum":100,"step":1}, {"type":"rgb"},
                  {"type":"effects","effectIds":["9951bf64-...","c0ffee00-..."]} ]
```

* Creating, editing or deleting a preset updates every supporting device immediately and publishes
  `device.capabilities_changed` for each. The capability is **absent** while no presets exist.
* After a gateway restart, saved presets are advertised from the very first discovery.
* Applying an id that is not advertised is rejected at admission with `422 capability_mismatch` (no operation is created).

## Editing and deleting presets that are playing

The bulb receives the animation as data at the moment you apply it, so changing the preset later does not reach it:

| You do | Bulbs already playing it | To pick up the change |
|---|---|---|
| **Edit** the preset | Keep looping the **old** version | Apply the preset again |
| **Delete** the preset | Keep looping the last animation they received | Stop them with `{"effect":null}` |

The gateway does not poll bulbs, so a playing device's `state.effect` keeps showing the old id **until the gateway next reads
it** (any command to it, or a state refresh); it then becomes `null`, meaning "no known preset is playing".

**Stop a bulb before deleting its preset.** If you delete the *last* preset, devices stop advertising `effects`, and
`{"effect":null}` is then rejected with `capability_mismatch`. A bulb left looping in that state can still be ended by
sending it a color command or turning it off.

## Device support

| Adapter | Presets | Notes |
|---|---|---|
| Feit Electric (Tuya local) | **Yes** | Bulb-side scenes. Up to 8 colors; speed is approximate (below). |
| Govee (LAN / Cloud), Hubspace, mock | No | They advertise no `effects` capability for presets, so applying one is `422 capability_mismatch`. |

A consumer that targets mixed hardware should read each device's `capabilities`, play the preset where `effects`
includes its id, and fall back to a static color (`rgb`) elsewhere.

## Speed and color guidance

* **Speed is a relative knob, not a time.** It was calibrated by eye on real bulbs: higher is faster (about 10 = slow,
  50 = moderate, 100 = fast). There is no known real-time unit, so do not promise seconds per step. If you need a
  specific tempo, tune the number on the real bulb.
* **Gradients take the short way around the hue wheel.** Red to blue fades through pink and purple, not through
  yellow/green. Choose colors in the order you want the loop to pass through.
* **Keep hues well apart.** Colors only ~20° apart read as one color: teal `#00fff2` (177°) and neon green `#00ff9f`
  (157°) look almost identical in a gradient. Aim for 40–60° or more between neighbours if you want distinct steps.
* **Dark colors are dim colors.** A step's brightness is the largest channel of its hex value.
* **Looping:** the last color blends or jumps back to the first.

## Errors

| Status | `error.code` | When |
|---|---|---|
| 400 | `invalid_idempotency_key` | `POST` without a UUID `Idempotency-Key` |
| 401 | `unauthorized` | Missing or invalid bearer token |
| 404 | `not_found` | Unknown preset id |
| 412 | `precondition_failed` | `If-Match` is stale: re-read, retry |
| 422 | `validation_error` | Bad name/colors/mode/speed, unknown property, empty patch, malformed id, or `effect` mixed with a color field (`details` says which) |
| 422 | `capability_mismatch` | Device does not advertise this effect id (device unsupported, id deleted, or typo) |
| 428 | `precondition_required` | `PATCH`/`DELETE` without `If-Match` |
| 429 | `rate_limited` | Request budget exceeded; back off |

Error bodies are always `{"error":{"code","message","requestId","details":[...]}}`.

## Events

Preset changes are published on the WebSocket (`/api/v1/events`, see [INTEGRATION.md](INTEGRATION.md#websocket-events-apiv1events)):

| Event | Subject | Data |
|---|---|---|
| `preset.created` / `preset.updated` / `preset.deleted` | `{type:"preset", id}` | `{preset: Preset}` (the deleted event carries the removed preset) |
| `device.capabilities_changed` | `{type:"device", id}` | `{capabilities: Capability[]}` full replacement, one per affected device |
| `device.state_changed` | `{type:"device", id}` | Full state snapshot; `effect` changes when a preset starts or stops |

Use `preset.*` to keep a UI in sync with presets created elsewhere.

## Python client

Requires `pip install requests`. This pairs with the `OpenLightClient` in [INTEGRATION.md](INTEGRATION.md#a-complete-reference-python-client)
(use its `send_command` to play and stop presets).

```python
import uuid

import requests


class OpenLightPresets:
    """Create, edit and delete presets. Playing/stopping is a normal device command (see the usage below)."""

    def __init__(self, base_url: str, token: str):
        self._base = base_url.rstrip("/")
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {token}"

    @staticmethod
    def _check(resp: requests.Response) -> requests.Response:
        if resp.status_code >= 400:
            error = resp.json().get("error", {})
            raise RuntimeError(f"{resp.status_code} {error.get('code')}: {error.get('message')} {error.get('details', '')}")
        return resp

    def list(self) -> list[dict]:
        return self._check(self._session.get(f"{self._base}/presets")).json()["items"]

    def get(self, preset_id: str) -> dict:
        return self._check(self._session.get(f"{self._base}/presets/{preset_id}")).json()

    def create(self, name: str, colors: list[str], mode: str = "gradient", speed: int = 50) -> dict:
        # A fresh Idempotency-Key per logical create. Reuse the SAME key only to retry that same request.
        resp = self._session.post(
            f"{self._base}/presets",
            json={"name": name, "colors": colors, "mode": mode, "speed": speed},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        return self._check(resp).json()

    def update(self, preset_id: str, **fields) -> dict:
        """Partial edit: pass only the fields to change (name, colors, mode, speed). Retries once if the ETag went stale."""
        for attempt in range(2):
            etag = self._check(self._session.get(f"{self._base}/presets/{preset_id}")).headers["ETag"]
            resp = self._session.patch(f"{self._base}/presets/{preset_id}", json=fields, headers={"If-Match": etag})
            if resp.status_code != 412 or attempt == 1:
                return self._check(resp).json()

    def delete(self, preset_id: str) -> None:
        etag = self._check(self._session.get(f"{self._base}/presets/{preset_id}")).headers["ETag"]
        self._check(self._session.delete(f"{self._base}/presets/{preset_id}", headers={"If-Match": etag}))


# Usage
# presets = OpenLightPresets("http://localhost:3000/api/v1", token="...")
# cyber = presets.create("Cyber", ["#00fff2", "#ff2079"], mode="gradient", speed=30)
# client.send_command(device_id, {"power": True, "effect": cyber["id"]})   # play  (OpenLightClient from INTEGRATION.md)
# presets.update(cyber["id"], speed=60)                                      # edit: re-play to pick it up
# client.send_command(device_id, {"effect": None})                           # stop BEFORE deleting
# presets.delete(cyber["id"])
```

## Building "save a preset" in another application

A consumer app with its own presets (for example an RGB controller whose themes define palettes) can mirror them to the
bulbs so the same theme animates the lights instead of showing static colors.

1. **Keep a mapping** from your preset id to the gateway preset `id` (persist it; the gateway id is permanent).
2. **On save:** if you have no mapping, `POST /presets` and store the returned `id`. If you do, `PATCH /presets/{id}`
   with the changed fields. If the gateway answers `404`, the preset was deleted elsewhere: create it again and update
   your mapping.
3. **On delete:** stop any bulbs playing it (`{"effect":null}`), then `DELETE /presets/{id}` and drop the mapping.
4. **On activate:** for each bulb, check `capabilities` for an `effects` entry containing the id. If present, send
   `{"power": true, "effect": "<id>"}`; otherwise fall back to a static `rgb` command.
5. **On deactivate / switching to a static look:** send `{"effect": null}` first, or just send the next color command,
   which also ends the scene.
6. **After an edit,** re-apply the preset to bulbs that are playing it; they keep the old version until you do.
7. **Never assume sync:** `GET /presets` is cheap, so reconcile at startup (or subscribe to `preset.*` events) rather than
   trusting local state.

Map your own palette to `colors` carefully: at most 8 entries, and keep hues apart (see
[Speed and color guidance](#speed-and-color-guidance)).

## Design notes

* **Why the preset id is the effect id.** Commands already carry an `effect` string and devices already advertise
  `effects: {effectIds}`; using the preset id reuses both, so presets need no new command shape. The cost is that the
  effect field cannot carry parameters: every variation (speed, palette) is its own preset.
* **Why presets are not scenes.** A scene is a frozen set of device states; a preset is one looping animation that is
  independent of any particular device.
* **Why edits do not reach playing bulbs.** The animation is sent to the bulb as data when applied. The gateway cannot
  change what a bulb is already running; re-applying is the only mechanism.
* **Where it lives.** `src/core/presets` owns validation, persistence and events; the Feit adapter turns presets into the
  bulb's native scene format and re-advertises them via `setScenes()`. Adapter authors: implement `effects` and re-emit a
  `capabilities` event when your device's playable effect ids change (see [ADAPTERS.md](ADAPTERS.md)).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Command returns `422 capability_mismatch` for a preset id | The device does not advertise that id: unsupported hardware, the preset was deleted, or a stale/typo'd id. `GET /devices/{id}` and read `capabilities`. |
| Preset "applied" but the bulb stays dark | It was off. Send `power: true` together with `effect`. |
| Edited preset looks unchanged | The bulb still runs the old version. Apply the preset again. |
| Bulb keeps looping after you deleted its preset | Send it a color command or `power: false`. (`effect: null` is refused when the last preset is gone.) |
| `state.rgb` / `state.brightness` look wrong while playing | They are stale pre-scene values. Use `state.effect`. |
| Two colors look like one | Their hues are too close; spread them 40–60° or more. |
| `428` / `412` on edit or delete | Send the current `ETag` as `If-Match`; re-read after a `412`. |
| Nothing advertises presets after creating one | Only Feit bulbs support presets today, and the bulb must be online and discovered. |

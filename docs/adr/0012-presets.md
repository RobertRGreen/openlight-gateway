# ADR-0012: Presets as database-backed native effects

Status: Accepted; hardware-verified on Feit Electric (Tuya) bulbs, 2026-10-06.

## Decision

Add a `presets` resource (`/api/v1/presets`: create, list, read, edit, delete) holding a named palette (1–8 `#rrggbb`
colors), a `mode` (`gradient`, `jump`, `static`) and a `speed` (1–100), stored in the gateway database. A preset's `id` is
its **effect ID**: devices that can play presets advertise them as an `effects` capability, and a preset is played with the
existing command `{"state":{"effect":"<preset id>"}}` (stopped with `effect:null`). The bulb runs the animation itself. The
Feit adapter compiles presets to the bulb's native scene format (Tuya DP 25) and is told about every change through
`setScenes()`, re-advertising its capabilities live.

## Alternatives considered

* **Scenes defined in static configuration (`FEIT_SCENES` env).** Built first and discarded: adding a palette meant
  editing config and restarting the gateway, which defeats creating a preset from another app's UI.
* **Parametrized effects in the command** (`effect` with colors/speed inline). Flexible and needs no stored resource, but
  changes the command schema, core validation, OpenAPI and every adapter, and the advertised-capability model (effect ids
  are enumerated) has nowhere to put parameters.
* **Frame-by-frame software effects** through the existing effect scheduler. Rejected for this use: each Feit command is a
  real network round trip, and the bulbs can animate natively from one command.
* **Extending `/scenes`.** A scene is a frozen set of device states applied once; a preset is one device-independent loop.
  Overloading scenes would blur both.

## Reason

Bulbs can loop a palette on their own, which removes per-frame traffic and rate-limit pressure. Reusing the effect id
and capability advertisement keeps the command API unchanged and lets every existing safeguard (capability checks,
admission-time rejection, observed confirmation) apply. Storing presets in the database makes them creatable at runtime and
durable across restarts.

## Advantages

Smooth multi-color animation from a single write. No change to the command shape. Live create/edit/delete with no
restart. Capability-based, so unsupported hardware is rejected cleanly instead of silently degraded.

## Disadvantages

The effect field carries no parameters, so every variation is its own preset. A bulb receives the animation as data when
applied, so an edit does not reach bulbs already playing it (re-apply), and deleting the last preset removes the `effects`
capability, after which `effect:null` is refused (a color command or power-off still ends the scene). `speed` is an
approximate relative knob calibrated by eye; the bulb's real timing unit is unknown. While a scene plays the bulb reports no
color, so the gateway's `rgb`/`brightness` state is stale and `effect` is authoritative. Only Feit bulbs support presets.

## Migration and consequences

Database schema version 2 adds the `presets` collection; existing version-1 databases are upgraded in place on startup
without data loss. The short-lived `FEIT_SCENES` setting is removed. New events: `preset.created`, `preset.updated`,
`preset.deleted`. Operational detail and examples are in [docs/PRESETS.md](../PRESETS.md).

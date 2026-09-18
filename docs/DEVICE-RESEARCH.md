# Manufacturer integration research

Research pass conducted 2026-09-17. Findings are a snapshot, not a permanent guarantee — cloud APIs and unofficial protocols have broken before (see Govee, below) and will again. Re-verify before building or shipping an adapter, and re-check this document's age before trusting it.

## Summary comparison

| | Govee | Feit Electric | Hubspace (Afero) |
|---|---|---|---|
| Official cloud API | Yes, documented, actively maintained ([developer.govee.com](https://developer.govee.com/)) | No public developer API | No OEM/public developer API; only a limited, non-comprehensive Afero platform API description |
| Official LAN protocol | Yes, documented by Govee itself (community "LAN API 101" guide), UDP-based | No — Feit's own app has no local protocol; local control is only possible via the underlying Tuya stack | No |
| Local control without cloud | Yes, for LAN-API-enabled models only, and only a power/brightness/color subset | Only via Tuya local-key extraction (LocalTuya/Tuya-Local), unofficial and per-device | No — Afero's architecture is cloud-mediated (Keycloak-issued JWTs), no documented local path |
| Auth model | Cloud: per-account API key (must apply via app). LAN: none (open on local network once enabled in-app) | Tuya cloud account + per-device local key extraction for local control | Keycloak-issued JWT bearer tokens against Afero's cloud |
| Protocol stability (recent history) | Cloud API broke for third-party clients in March 2026 ("app version too low") | Tuya cloud has a history of forced re-auth/deprecation cycles; not observed to have broken in this pass | No official contract to break, but the unofficial integration needed a 2026.7.x hot-fix release for reliability regressions |
| Maintained OSS libraries | Several; **fragmented and inconsistent** — see below | LocalTuya / Tuya-Local (general Tuya libraries, not Feit-specific) | `aioafero` (PyPI, active, used by Home Assistant's unofficial integration) |
| Recommended Phase 1 target | **Govee LAN API** — confirms the brief's suggestion | Not recommended first — no distinct local protocol of its own | Not recommended first — no local protocol, cloud-only, undocumented |

**Recommendation confirmed:** build the Govee adapter first, and build it LAN-first with the documented UDP protocol, not the cloud API. Treat the Govee cloud API as an optional fallback behind a feature flag, not a dependency — it has already broken for third-party clients once in 2026 (see below), which is exactly the failure mode `docs/ARCHITECTURE.md`'s local-first ordering is designed to tolerate.

---

## Govee

### Official cloud API
Govee publishes and actively maintains a documented REST API at [developer.govee.com](https://developer.govee.com/), with a [PDF API reference](https://govee-public.s3.amazonaws.com/developer-docs/GoveeDeveloperAPIReference.pdf) and a [Postman collection](https://www.postman.com/postman/program-smart-lights/documentation/ukwv4ft/govee-lights-developer-api). Access requires applying for an API key through the Govee Home app (community post: ["API Days: Applying for an API Key"](https://community.govee.com/posts/api-days-applying-for-an-api-key-day-2-getting-st/124855)).

**Rate limits:** ~10 requests/minute per device, and a hard cap of 10,000 requests/24h per account ([hacs-govee issue #129](https://github.com/LaggAt/hacs-govee/issues/129), [#107](https://github.com/LaggAt/hacs-govee/issues/107)). The API returns `X-RateLimit-Reset` when throttled. This confirms the mission brief's "never hammer cloud APIs" concern is not theoretical for Govee specifically — the effect scheduler must budget per-device, not just globally.

**2026 stability incident:** since March 2026, `wez/govee2mqtt` — a widely used bridge — stopped authenticating against Govee's cloud entirely, failing with "The app version is too low, please upgrade the version!" ([issue #628](https://github.com/wez/govee2mqtt/issues/628), [#626](https://github.com/wez/govee2mqtt/issues/626), [#627](https://github.com/wez/govee2mqtt/issues/627)). This is a live, current example of a manufacturer cloud API breaking third-party access with no warning — exactly the scenario `docs/ARCHITECTURE.md`'s adapter-isolation and local-first design is meant to survive. The documented workaround in the community was to drop cloud credentials entirely and rely on LAN-only control, at the cost of devices that don't support the LAN API becoming uncontrollable.

### Local LAN protocol
Govee documents its own LAN API in a community guide, ["Mastering the LAN API Series: LAN API 101"](https://community.govee.com/posts/mastering-the-lan-api-series-lan-api-101/136755). Confirmed protocol shape, cross-referenced against [`wez/govee-lan-hass`](https://github.com/wez/govee-lan-hass) and its [port-usage issue #28](https://github.com/wez/govee-lan-hass/issues/28):

- Multicast discovery: UDP `239.255.255.250:4001`
- Gateway listens for device responses on UDP port `4002`
- Commands are sent to each device's IP on UDP port `4003`
- The device must first be LAN-enabled from inside the official Govee Home app (BLE-paired, then "LAN Control" toggled on) — **no automatic enablement is possible**, so OpenLight's discovery flow must document this manual prerequisite to the user.
- **Capability scope is limited:** the LAN API only supports on/off, brightness, and color. Effects, color temperature (on some models), and segmented control are cloud-only or unsupported locally, even on models that expose those features in the official app. This directly confirms the mission brief's "do not assume all models expose the same protocol" and "capabilities MUST be detected per device" requirements — LAN-vs-cloud capability parity cannot be assumed and must be probed per device.

### Maintained OSS libraries (fragmented ecosystem — verify before depending on any one)
- [`wez/govee2mqtt`](https://github.com/wez/govee2mqtt) — broken for cloud auth since March 2026 (see above); LAN-only fallback still reported working.
- [`florianhorner/govee2mqtt-extended`](https://github.com/florianhorner/govee2mqtt-extended) — active fork with device fixes and crash hardening; explicitly "prefer upstream unless you need these specific changes."
- [`wez/govee-lan-hass`](https://github.com/wez/govee-lan-hass) — the search results describe this integration as no longer actively maintained upstream, having broken after a Home Assistant 2026.3.0 update (removed deprecated light constants); a maintained fork exists in the ecosystem.
- [`pantsoftime/New-2026-Govee-LAN-Control`](https://github.com/pantsoftime/New-2026-Govee-LAN-Control) — a 2026-dated fork/continuation, unverified maturity.
- [`Joery-M/Govee-LAN-Control`](https://github.com/Joery-M/Govee-LAN-Control) — Node.js LAN-only package; useful as an implementation reference for OpenLight's own TypeScript LAN client (no need to depend on it directly — the UDP protocol is simple enough to implement natively against the adapter contract).

**Conclusion for OpenLight:** implement Govee's LAN UDP protocol directly (it is simple and documented by Govee themselves) rather than depending on any single third-party library, all of which have shown breakage in 2026. Treat the cloud API purely as an optional, separately-gated fallback for LAN-incapable devices, with the explicit expectation that it may become unavailable at any time.

---

## Feit Electric

Feit Electric smart bulbs are confirmed to be **Tuya-derived hardware** — multiple independent Home Assistant community threads describe them as "Tuya-based" and control them through Tuya's ecosystem rather than anything Feit-specific ([community thread 1](https://community.home-assistant.io/t/feit-electric-tuya-bulb-only-has-an-off-and-on-control/981765), [community thread 2](https://community.home-assistant.io/t/feit-electric-bpa800-rgbw-ag-2-smart-wifi-bulb-tuya/121212), [Feit integration thread](https://community.home-assistant.io/t/feit-electric-integration/250212)).

- **No official developer API.** Feit does not publish a public/developer API of its own; the official Feit Electric app is the only sanctioned control path, and it is itself a Tuya-white-label app.
- **Local control is possible but per-device and unofficial**, via the general Tuya local protocol: extracting each device's local key (commonly through [LocalTuya](https://community.home-assistant.io/t/how-i-made-tuya-local-work-with-full-color-controls/478030) or Tuya-Local) and then issuing local LAN commands using Tuya's (also reverse-engineered) local protocol. This is **not Feit-specific** — it is the same generic Tuya local-key extraction process used for any Tuya white-label device, and it has a documented history of breaking on firmware updates (one community report: ["Newer firmware versions have sometimes prevented Tuya-convert from working"](https://www.alexwhittemore.com/setting-up-feit-dimmer-switches-costco-with-localtuya/)).
- **Capability inconsistency confirmed:** one community report describes a Feit/Tuya bulb exposing only on/off control despite the device supporting more in the official app — reinforcing per-device capability detection rather than trusting model-name-based assumptions.
- No evidence found of an official or stable "Feit LAN API" distinct from generic Tuya local control.

**Conclusion for OpenLight:** a Feit adapter is realistically **a Tuya-local adapter with Feit-specific device-capability presets**, not a bespoke Feit protocol. It requires the user to extract a local key per device (a real UX/onboarding burden — document this clearly, do not promise "automatic discovery" for Feit devices). Given the local-key-extraction friction and Tuya's history of firmware-triggered breakage, this is a reasonable **second** adapter after Govee, not a first.

### Feit addendum — 2026-09-18

User-provided `tinytuya wizard --include_map` results identify the actual Feit bulbs as Tuya protocol **3.5**, the primary target for this installation; older 3.3 devices remain supported. Product `ofq66tvgiu9vuszp`, model `RGBCW`, reports DP 20 `switch_led` (boolean), DP 21 `work_mode` (white/colour/scene/music), DP 22 `bright_value_v2` (10–1000), DP 23 `temp_value_v2` (0–1000), and DP 24 `colour_data_v2` (JSON object `{h,s,v}`, with ranges 0–360, 0–1000, 0–1000). Colour encoding must be detected from the observed DP value: legacy strings retain the hex codec; JSON objects use numeric HSV fields.

The protocol extension uses authenticated session negotiation on each short-lived TCP connection for 3.4/3.5, with 55AA/HMAC frames for 3.4 and 6699/AES-GCM frames for 3.5. The supplied community-derived 3.5 session-key formula takes bytes 12–28 of the GCM ciphertext-plus-tag buffer; this unusual slice, and all new protocol behavior, still require independent review and live-hardware confirmation. Constructed tests use fake credentials only. CONTROL remains unconfirmed until DP_QUERY reports the requested values.

---

## Hubspace (Afero)

Hubspace is Home Depot's smart-home brand; the underlying platform is **Afero's** IoT cloud (afero.io). Distinguishing the tiers precisely, per the mission brief's request:

- **Official documented API: does not exist for third parties.** Afero's own site ([afero.io](https://www.afero.io/)) describes its platform at a marketing/OEM level; there is no public, comprehensive developer API reference for Hubspace devices. One community source states directly: "there is no official documentation for Hubspace products."
- **Officially-described-but-thin API:** Afero does expose *some* API surface (used by OEM partners like Home Depot to build the Hubspace app), described as "simple" but "in no way comprehensive." This is not something OpenLight should build against directly without a partner relationship.
- **Unofficial/reverse-engineered API: this is the only practical option today**, via [`aioafero`](https://pypi.org/project/aioafero/) (PyPI, actively maintained, source at [Expl0dingBanana/aioafero](https://github.com/Expl0dingBanana/aioafero)), which implements discovery, state polling, and typed commands against what it calls "AferoBridgeV1." It is consumed by the unofficial Home Assistant integration [`Emkraan/homeassistant-hubspace`](https://github.com/Emkraan/homeassistant-hubspace) (explicitly "not affiliated with or endorsed by Hubspace, Afero, or The Home Depot"), which needed a 2026.7.2 hot-fix for stale-device and resource-leak regressions in the 2026.7.0/2026.7.1 betas — i.e. this integration is actively developed but not yet fully stable.
- **Authentication is the hard part:** Hubspace/Afero uses **Keycloak-issued JWT bearer tokens**, not a simple API key — a developer must authenticate through Afero's Keycloak instance to obtain a token before calling the platform API. (Earlier community write-ups referenced AWS Cognito; current sourcing points to Keycloak — treat the exact identity-provider detail as subject to change and re-verify at adapter-build time rather than hardcoding assumptions from this document.)
- **No local/LAN protocol of any kind was found.** Hubspace/Afero appears to be cloud-mediated only; there is no evidence of a documented or reverse-engineered local control path. This is the **opposite end of the local-first spectrum** from Govee.
- Other unofficial clients exist with varying maintenance status: [`jdeath/Hubspace-Homeassistant`](https://github.com/jdeath/Hubspace-Homeassistant) (older, appears superseded by the aioafero-based integration), [`shawngmc/hubspace-ng`](https://github.com/shawngmc/hubspace-ng) (Python package, alternative implementation), and Homebridge variants ([`sajmonr/homebridge-hubspace`](https://github.com/sajmonr/homebridge-hubspace), [`XenuIsWatching/homebridge-hubspace`](https://github.com/XenuIsWatching/homebridge-hubspace)).

**Conclusion for OpenLight:** a Hubspace adapter is inherently **cloud-only, unofficial, and Keycloak-JWT-authenticated** — the least trustworthy of the three initial ecosystems by the architecture's own local-first ranking. Build it last, isolate it aggressively per `docs/ARCHITECTURE.md`'s adapter-isolation model (a broken/rotated Keycloak flow must not affect Govee or Feit adapters), and set explicit user expectations that Hubspace support depends entirely on an unofficial, actively-changing reverse-engineered library.

---

## Cross-cutting implications for the adapter contract

1. **Capability detection must be genuinely per-device, not per-model or per-brand.** All three ecosystems showed evidence of capability mismatches between what a device nominally supports (per marketing/app) and what a given control path (LAN vs cloud, or a specific Tuya local key) can actually reach.
2. **Cloud dependency is a real, current risk, not a hypothetical one.** Govee's March 2026 cloud-auth breakage is the concrete case study motivating `docs/ARCHITECTURE.md`'s adapter-isolation and local-first-with-explicit-fallback design — this is not speculative future-proofing.
3. **None of the three ecosystems support automatic zero-touch discovery + control out of the box:** Govee LAN requires a manual per-device in-app toggle; Feit/Tuya requires local-key extraction; Hubspace has no local path at all and requires cloud auth. `docs/ARCHITECTURE.md`'s manual/static discovery provider is not a fallback for an edge case — it is necessary, routine onboarding for at least two of the three initial ecosystems.
4. **Ecosystem-specific OSS libraries are all young, forked, or recently broken.** Depend on the underlying protocol/API directly where documented (Govee LAN, Govee cloud, aioafero's approach for Hubspace) rather than taking a hard dependency on any single third-party library's release cadence.


## 2026-09-17 addendum: verified Govee Developer API v1 limits

The task supervisor independently fetched [Govee's live Developer API reference](https://developer.govee.com/reference) on 2026-09-17. These official endpoint-specific figures supersede the older, less precise third-party rate-limit figures in the original research above, which are preserved for provenance:

| Endpoint | Verified limit | Burst |
|---|---|---|
| `GET /router/api/v1/user/devices` | 30 requests/minute/account | 30 |
| `POST /router/api/v1/device/control` | 12 requests/second/account (approximately 720/minute) | 80 |
| `POST /router/api/v1/device/state` | 30 requests/minute/device | Not separately specified |

All endpoints use `https://openapi.api.govee.com` and the `Govee-API-Key` header. Control uses `requestId` and a `payload` containing `sku`, `device`, and one capability with `type`, `instance`, and `value`. RGB values are packed integers from 0 to 16777215. Brightness is an integer from 1 to 100; the adapter maps a direct normalized brightness-zero call to power off. Device capabilities and brightness/temperature ranges must come from each list entry's `capabilities[].parameters.range`, rather than global SKU assumptions. State values come from `payload.capabilities[].state.value`, matched by capability type and instance; the online capability supplies availability.

The Govee Cloud integration is a separate opt-in adapter for devices available through the Developer API, including basic RGB bulbs without LAN Control. It does not depend on LAN discovery. Both adapters can expose the same physical device under separate identities when enabled simultaneously.

## 2026-09-18 addendum: Tuya v3.4/v3.5 local protocol, hardware-confirmed corrections

The Feit section above and the initial v3.4/v3.5 implementation were based on community documentation (`jasonacox/tinytuya`'s `PROTOCOL.md`) that, while broadly accurate on framing, turned out to have gaps significant enough to block real hardware from responding at all. These were found and fixed through live iteration against a real Feit RGBCW bulb (Tuya protocol 3.5) and cross-checked against tinytuya's actual Python source (`XenonDevice.py`, `crypto_helper.py`, `command_types.py`), not just its documentation. Recorded here so a future adapter (or anyone re-deriving this protocol) doesn't hit the same three walls:

1. **Session-key handshake messages (SESS_KEY_NEG_START/RESP/FINISH, commands 0x03/0x04/0x05) are single-encrypted, not double-encrypted, under v3.5.** They travel as GCM-encrypted 6699 frames using the real static local key; the frame-level GCM encryption is the *only* encryption layer. A first implementation attempt additionally AES-ECB-encrypted the nonce/HMAC payloads before GCM-wrapping them (correct for v3.4, which lacks frame-level encryption and needs it — but wrong for v3.5, which doesn't). The device silently uses whatever bytes it decrypts from the GCM layer as the literal nonce; sending an extra ECB layer means the device authenticates against the wrong value and the handshake fails cryptographically (not with an error frame — Tuya devices seem to fail this kind of thing silently).

2. **The per-connection sequence number must increment for every message sent, not stay fixed.** Reusing the same sequence for START, FINISH, and the first real command causes the device to accept START but then silently close the TCP connection (clean FIN, no error) right after FINISH. Real tinytuya increments `self.seqno` on every packed message, including handshake sub-messages.

3. **v3.4 and v3.5 devices route queries and writes through different command IDs and payload shapes than v3.3**, confirmed from tinytuya's `command_types.py` and `payload_dict['v3.4']`/`['v3.5']` (identical for both):
   - Status query: command `0x10` (`DP_QUERY_NEW`), payload is a **literal empty JSON object `{}`** — no `devId`/`uid`/`t`.
   - Write: command `0x0d` (`CONTROL_NEW`), payload `{"protocol": 5, "t": <int seconds>, "data": {"dps": {<id>: <value>, ...}}}` — note `t` is a real integer here, and the DP values are nested under `data.dps`, not a top-level `dps` key like v3.3's classic `CONTROL`(`0x07`) shape.
   - v3.3 is unaffected and keeps using the classic `0x0a`/`0x07` commands with `{devId,uid,t[,dps]}`.

4. **The v3.5 session-key derivation is simpler than the community doc's `[12:28]` slice notation suggests, and getting the slice semantics wrong produces a session key the device never derives (with no diagnostic — everything after the handshake just times out).** `session_key` is just the raw AES-GCM ciphertext output of encrypting the 16-byte `client_nonce XOR device_nonce` with the local key and `client_nonce[:12]` as the IV — no auth tag involved, no boundary-crossing slice needed. The `[12:28]` notation in community docs only makes sense because tinytuya's own Python crypto wrapper (`AESCipher.encrypt`) *prepends* the IV to its return value (`iv + ciphertext + tag`) before that slice is taken — in a raw `node:crypto` implementation (or any implementation where `encrypt()` returns ciphertext alone, no IV prefix), that prepend doesn't exist, so replicating the `[12:28]` slice literally extracts the wrong bytes (the tail of the ciphertext concatenated with the head of the tag). If porting slice-notation protocol descriptions from a wrapped/higher-level reference implementation, always check what the wrapper's return value actually contains, not just the slice indices.

Also confirmed live: this specific product's `colour_data_v2` data point (DP 24), despite being typed `"Json"` in the Tuya cloud schema (`{"h":...,"s":...,"v":...}`), is actually represented as the legacy **12-character hex string** on the wire in local DP_QUERY responses (e.g. `"001f019803e8"`), not a nested JSON object. The adapter's runtime type-detection (string → hex codec, object → JSON codec) already handles this correctly without needing a config change — but it's a reminder that a product's Tuya *cloud* schema type name doesn't necessarily predict its *local protocol* wire representation.

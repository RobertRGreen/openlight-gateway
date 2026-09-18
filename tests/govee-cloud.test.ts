import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoveeCloudAdapter } from '../src/adapters/govee/cloud-adapter.js';
import type { AdapterEvent, CallContext } from '../src/adapters/types.js';

let apiKey = 'secret-govee-test-key-never-log';
let setupCount = 0;
const nativeId = 'AA:BB:CC:DD:EE:FF:00:11';
const base = 'https://openapi.api.govee.com/router/api/v1';
const power = { type: 'devices.capabilities.on_off', instance: 'powerSwitch', parameters: { dataType: 'ENUM', options: [{ name: 'on', value: 1 }, { name: 'off', value: 0 }] } };
const brightness = { type: 'devices.capabilities.range', instance: 'brightness', parameters: { dataType: 'INTEGER', range: { min: 1, max: 100, precision: 1 } } };
const rgb = { type: 'devices.capabilities.color_setting', instance: 'colorRgb', parameters: { dataType: 'INTEGER', range: { min: 0, max: 16777215 } } };
const temperature = { type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', parameters: { dataType: 'INTEGER', range: { min: 2200, max: 6500, precision: 100 } } };
const devices = [
 { sku: 'H6008', device: nativeId, deviceName: 'RGB bulb', capabilities: [power, brightness, rgb, temperature] },
 { sku: 'H-WHITE', device: 'WHITE', deviceName: 'White bulb', capabilities: [power, { ...brightness, parameters: { dataType: 'INTEGER', range: { min: 5, max: 95, precision: 5 } } }, { ...temperature, parameters: { dataType: 'INTEGER', range: { min: 2700, max: 4000, precision: 100 } } }] },
 { sku: 'H-POWER', device: 'POWER', deviceName: 'Switch', capabilities: [power] },
];
const context = (signal = new AbortController().signal): CallContext => ({ operationId: 'cloud-test', correlationId: null, signal, deadlineAt: Date.now() + 5000 });
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const state = (capabilities: unknown[]) => ({ requestId: 'response-id', msg: 'success', code: 200, payload: { sku: 'H6008', device: nativeId, capabilities } });
const field = (capability: { type: string; instance: string }, value: unknown) => ({ type: capability.type, instance: capability.instance, state: { value } });
async function discover(adapter: GoveeCloudAdapter, ctx = context()) { const found = []; for await (const device of adapter.discover(ctx)) found.push(device); return found; }
const adapters: GoveeCloudAdapter[] = [];
function setup(commandTimeoutMs = 50) {
 apiKey = `secret-govee-test-key-never-log-${++setupCount}`;
 const fetch = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal('fetch', fetch);
 const logger = { warn: vi.fn() };
 const adapter = new GoveeCloudAdapter({ apiKey, commandTimeoutMs, logger }); adapters.push(adapter);
 return { adapter, fetch, logger };
}
async function ready() { const result = setup(); result.fetch.mockResolvedValueOnce(response({ code: 200, message: 'success', data: devices })); await discover(result.adapter); result.fetch.mockClear(); return result; }
function request(fetch: ReturnType<typeof setup>['fetch']) { const [url, init] = fetch.mock.calls[0]!; return { url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined }; }
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.disconnect(context()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Govee Cloud adapter using mocked native fetch', () => {
 it('lists once with the exact endpoint and headers and detects capabilities and ranges per device', async () => {
  const { adapter, fetch } = setup(); fetch.mockResolvedValueOnce(response({ code: 200, message: 'success', data: devices }));
  const found = await discover(adapter); expect(fetch).toHaveBeenCalledOnce();
  const { url, init } = request(fetch); expect(url).toBe(`${base}/user/devices`); expect(init?.method ?? 'GET').toBe('GET');
  const headers = new Headers(init?.headers); expect(headers.get('Content-Type')).toBe('application/json'); expect(headers.get('Govee-API-Key')).toBe(apiKey);
  expect(adapter.id).toBe('govee-cloud'); expect(found.map(d => [d.nativeId, d.model, d.name, d.address?.transport])).toEqual(devices.map(d => [d.device, d.sku, d.deviceName, 'cloud']));
  expect(await adapter.getCapabilities(nativeId, context())).toEqual([{ type: 'power' }, { type: 'brightness', minimum: 1, maximum: 100, step: 1 }, { type: 'rgb' }, { type: 'colorTemperature', minimum: 2200, maximum: 6500, step: 100 }]);
  expect(await adapter.getCapabilities('WHITE', context())).toEqual([{ type: 'power' }, { type: 'brightness', minimum: 5, maximum: 95, step: 5 }, { type: 'colorTemperature', minimum: 2700, maximum: 4000, step: 100 }]);
  expect(await adapter.getCapabilities('POWER', context())).toEqual([{ type: 'power' }]);
 });
 it('returns detached device and capability objects', async () => {
  const { adapter } = await ready(); const listed = await adapter.getDevices(context()); listed[0]!.name = 'mutated';
  const capabilities = await adapter.getCapabilities(nativeId, context()); capabilities.splice(0);
  expect((await adapter.getDevices(context()))[0]!.name).toBe('RGB bulb'); expect(await adapter.getCapabilities(nativeId, context())).toHaveLength(4);
 });
 it('packs RGB to an integer for control and unpacks it from matching state capabilities', async () => {
  const { adapter, fetch } = await ready(); fetch.mockResolvedValueOnce(response({ code: 200, msg: 'success' }));
  expect(await adapter.setColor(nativeId, { mode: 'rgb', value: { r: 18, g: 52, b: 171 } }, context())).toMatchObject({ transport: 'cloud', acknowledgment: 'accepted' });
  expect(request(fetch)).toMatchObject({ url: `${base}/device/control`, init: { method: 'POST' }, body: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i), payload: { sku: 'H6008', device: nativeId, capability: { type: rgb.type, instance: rgb.instance, value: 0x1234ab } } } });
  fetch.mockClear(); fetch.mockResolvedValueOnce(response(state([field(power, 1), field(brightness, 42), field(rgb, 0x1234ab), field(temperature, 2700)])));
  expect(await adapter.getState(nativeId, context())).toMatchObject({ state: { power: true, brightness: 42, rgb: { r: 18, g: 52, b: 171 }, colorTemperature: 2700 }, complete: true, observedAt: expect.any(String) });
  expect(request(fetch)).toMatchObject({ url: `${base}/device/state`, init: { method: 'POST' }, body: { requestId: expect.any(String), payload: { sku: 'H6008', device: nativeId } } });
 });
 it('marks incomplete observations and maps online capability to availability', async () => {
  const { adapter, fetch } = await ready(); const events: AdapterEvent[] = []; adapter.onEvent(event => events.push(event));
  fetch.mockResolvedValueOnce(response(state([field(power, 0), field({ type: 'wrong.type', instance: brightness.instance }, 42), field({ type: 'devices.capabilities.online', instance: 'online' }, true)])));
  expect(await adapter.getState(nativeId, context())).toMatchObject({ state: { power: false }, complete: false });
  expect(events).toContainEqual({ type: 'availability', nativeId, status: 'online' });
  fetch.mockResolvedValueOnce(response(state([field(power, 1), field({ type: 'devices.capabilities.online', instance: 'online' }, false)])));
  await expect(adapter.getState(nativeId, context())).rejects.toMatchObject({ code: 'OFFLINE' }); expect(events).toContainEqual({ type: 'availability', nativeId, status: 'offline' });
 });
 it('maps zero brightness to power off and sends nonzero brightness and temperature with their native capabilities', async () => {
  const { adapter, fetch } = await ready(); fetch.mockImplementation(async () => response({ code: 200 }));
  await adapter.setBrightness(nativeId, 0, context()); expect(request(fetch).body.payload.capability).toEqual({ type: power.type, instance: power.instance, value: 0 });
  fetch.mockClear(); await adapter.setBrightness(nativeId, 42, context()); expect(request(fetch).body.payload.capability).toEqual({ type: brightness.type, instance: brightness.instance, value: 42 });
  fetch.mockClear(); await adapter.setTemperature('WHITE', 3000, context()); expect(request(fetch).body.payload).toEqual({ sku: 'H-WHITE', device: 'WHITE', capability: { type: temperature.type, instance: temperature.instance, value: 3000 } });
 });
 it('rejects unsupported modes and absent capabilities, unknown devices and invalid per-device values before sending', async () => {
  const { adapter, fetch } = await ready();
  for (const color of [{ mode: 'rgbw', value: { r: 0, g: 0, b: 0, w: 1 } }, { mode: 'rgbww', value: { r: 0, g: 0, b: 0, warmWhite: 1, coolWhite: 1 } }] as const) await expect(adapter.setColor(nativeId, color, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  await expect(adapter.setColor('WHITE', { mode: 'rgb', value: { r: 1, g: 2, b: 3 } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  await expect(adapter.getState('missing', context())).rejects.toMatchObject({ code: 'OFFLINE' });
  await expect(adapter.setTemperature('WHITE', 6500, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  await expect(adapter.setBrightness('WHITE', 1, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  await expect(adapter.setBrightness(nativeId, 12.5, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  await expect(adapter.setColor(nativeId, { mode: 'rgb', value: { r: 256, g: 0, b: 0 } }, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' }); expect(fetch).not.toHaveBeenCalled();
 });
 it.each([401, 403])('maps HTTP %s to AUTH_FAILED without leaking upstream secrets', async status => {
  const { adapter, fetch, logger } = await ready(); fetch.mockResolvedValueOnce(response({ code: status, message: apiKey }, status));
  const error = await adapter.setPower(nativeId, true, context()).catch(error => error); expect(error).toMatchObject({ code: 'AUTH_FAILED' }); expect(error.message).not.toContain(apiKey); expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
 });
 it('maps HTTP 429 and Retry-After to RATE_LIMITED', async () => {
  const { adapter, fetch } = await ready(); fetch.mockResolvedValueOnce(response({ code: 429 }, 429, { 'Retry-After': '7' }));
  await expect(adapter.setPower(nativeId, true, context())).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 7000 });
 });
 it('honors upstream control cooldown without blocking independent state reads', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { adapter, fetch } = await ready(); fetch.mockResolvedValueOnce(response({ code: 429 }, 429, { 'Retry-After': '7' }));
  await expect(adapter.setPower(nativeId, true, context())).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 7000 });
  await expect(adapter.setPower(nativeId, false, context())).rejects.toMatchObject({ code: 'TIMEOUT', delivery: 'not_sent' }); expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(response(state([field(power, 1)])));
  expect(await adapter.getState(nativeId, context())).toMatchObject({ state: { power: true }, complete: false }); expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('uses a positive retry delay when throttling has no headers', async () => {
  const { adapter, fetch } = await ready(); fetch.mockResolvedValueOnce(response({ code: 429 }, 429));
  const error = await adapter.getState(nativeId, context()).catch(error => error); expect(error.code).toBe('RATE_LIMITED'); expect(error.retryAfterMs).toBeGreaterThan(0);
 });
 it('recognizes rate-limit reset epoch headers', async () => {
  const { adapter, fetch } = await ready(); const reset = Math.ceil(Date.now() / 1000) + 10; fetch.mockResolvedValueOnce(response({ code: 429 }, 429, { 'X-RateLimit-Reset': String(reset) }));
  const error = await adapter.getState(nativeId, context()).catch(error => error); expect(error.code).toBe('RATE_LIMITED'); expect(error.retryAfterMs).toBeGreaterThan(9000); expect(error.retryAfterMs).toBeLessThanOrEqual(11000);
 });
 it.each([[200, 401, 'AUTH_FAILED'], [200, 429, 'RATE_LIMITED'], [200, 500, 'TRANSPORT_ERROR'], [503, 503, 'TRANSPORT_ERROR']] as const)('rejects HTTP %s with envelope code %s as %s', async (http, code, expected) => {
  const { adapter, fetch, logger } = await ready(); fetch.mockResolvedValueOnce(response({ code, message: apiKey }, http));
  const error = await adapter.setPower(nativeId, true, context()).catch(error => error); expect(error.code).toBe(expected); expect(error.message).not.toContain(apiKey); expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
 });
 it('sanitizes network exceptions and event-consumer exceptions', async () => {
  const { adapter, fetch, logger } = await ready(); adapter.onEvent(() => { throw new Error(apiKey); }); fetch.mockRejectedValueOnce(new Error(`Govee-API-Key: ${apiKey}`));
  const error = await adapter.getState(nativeId, context()).catch(error => error); expect(error.code).toBe('TRANSPORT_ERROR'); expect(error.message).not.toContain(apiKey); expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
 });
 it('bounds a fetch that ignores AbortSignal and aborts the underlying request', async () => {
  const { adapter, fetch } = await ready(); fetch.mockImplementation(() => new Promise<Response>(() => {}));
  await expect(adapter.getState(nativeId, context())).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
 });
 it('bounds a stalled response body', async () => {
  const { adapter, fetch } = await ready(); const stalled = response({}); vi.spyOn(stalled, 'json').mockImplementation(() => new Promise(() => {})); fetch.mockResolvedValueOnce(stalled);
  await expect(adapter.getState(nativeId, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
 });
 it('cancels caller-aborted and disconnected requests', async () => {
  const { adapter, fetch } = await ready(); fetch.mockImplementation(() => new Promise<Response>(() => {}));
  const abort = new AbortController(); const pending = adapter.getState(nativeId, context(abort.signal)); abort.abort(); await expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
  const next = adapter.getState(nativeId, context()); const checked = expect(next).rejects.toMatchObject({ code: 'CANCELED' }); await adapter.disconnect(context()); await checked;
 });
 it('enforces the 80-control burst then replenishes at 12 requests/second', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { adapter, fetch } = await ready(); fetch.mockImplementation(async () => response({ code: 200 }));
  for (let i = 0; i < 80; i++) await adapter.setPower(nativeId, true, context());
  expect(fetch).toHaveBeenCalledTimes(80);
  await expect(adapter.setPower(nativeId, true, context())).rejects.toMatchObject({ code: 'TIMEOUT', delivery: 'not_sent' }); expect(fetch).toHaveBeenCalledTimes(80);
  clock.mockReturnValue(1084); await adapter.setPower(nativeId, true, context()); expect(fetch).toHaveBeenCalledTimes(81);
 });
 it('enforces state reads per device independently of control and discovery budgets', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { adapter, fetch } = await ready(); fetch.mockImplementation(async (_url, init) => {
   const payload = JSON.parse(String(init?.body)).payload;
   return response({ code: 200, payload: { sku: payload.sku, device: payload.device, capabilities: [field(power, 1)] } });
  });
  for (let i = 0; i < 30; i++) await adapter.getState(nativeId, context());
  await expect(adapter.getState(nativeId, context())).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(fetch).toHaveBeenCalledTimes(30);
  await adapter.getState('POWER', context()); await adapter.setPower(nativeId, false, context()); expect(fetch).toHaveBeenCalledTimes(32);
 });
 it('enforces the account discovery window and permits requests after it expires', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { adapter, fetch } = setup(); fetch.mockImplementation(async () => response({ code: 200, data: devices }));
  for (let i = 0; i < 30; i++) await discover(adapter);
  await expect(discover(adapter)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(fetch).toHaveBeenCalledTimes(30);
  clock.mockReturnValue(61001); await discover(adapter); expect(fetch).toHaveBeenCalledTimes(31);
 });
 it('omits secrets from warnings for malformed upstream data', async () => {
  const { adapter, fetch, logger } = setup(); fetch.mockResolvedValueOnce(response({ code: 200, data: [{ device: apiKey }, { ...devices[0], capabilities: [{ ...brightness, parameters: { range: { min: apiKey } } }] }] }));
  await discover(adapter); expect(logger.warn).toHaveBeenCalled(); expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
 });
 it('publishes the verified endpoint quotas without credentials in scheduling keys', () => {
  const { adapter } = setup(); expect(adapter.scheduling.budgets).toEqual(expect.arrayContaining([
   expect.objectContaining({ scope: 'account', maxRequests: 12, windowMs: 1000, burst: 80 }),
   expect.objectContaining({ scope: 'device', maxRequests: 30, windowMs: 60000 }),
   expect.objectContaining({ scope: 'account', maxRequests: 30, windowMs: 60000, burst: 30 }),
  ])); expect(JSON.stringify(adapter.scheduling)).not.toContain(apiKey);
 });
});

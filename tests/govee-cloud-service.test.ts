import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createGateway, type Gateway } from '../src/service/index.js';
import { createLogger } from '../src/security/logger.js';
import { createApp } from '../src/api/rest/index.js';

let gateway: Gateway | undefined;
afterEach(async () => { await gateway?.stop(); gateway = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent', MOCK_LATENCY_MS: '0', ...env });
const apiKey = 'cloud-service-secret-api-key';
const enabled = { GOVEE_CLOUD_ADAPTER_ENABLED: 'true', GOVEE_API_KEY: apiKey };

it('defaults cloud to disabled and requires explicit boolean opt-in', async () => {
  expect(config().goveeCloudAdapterEnabled).toBe(false);
  expect(config(enabled).goveeCloudAdapterEnabled).toBe(true);
  expect(() => config({ GOVEE_CLOUD_ADAPTER_ENABLED: '1' })).toThrow();
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  gateway = await createGateway({ config: config({ GOVEE_API_KEY: apiKey }) });
  expect(gateway.runtime.list().map(adapter => adapter.id)).toEqual(['mock']);
  expect(fetch).not.toHaveBeenCalled();
});

it('logs missing credentials loudly while preserving mock readiness', async () => {
  const logger = createLogger('silent');
  const error = vi.spyOn(logger, 'error');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  gateway = await createGateway({ config: config({ GOVEE_CLOUD_ADAPTER_ENABLED: 'true', GOVEE_API_KEY: '  ' }), logger });
  expect(error).toHaveBeenCalledWith({ adapter: 'govee-cloud', errorCategory: 'configuration' }, expect.stringContaining('requires a non-empty GOVEE_API_KEY'));
  expect(gateway.isReady()).toBe(true);
  expect(gateway.registry.list()).toHaveLength(5);
  expect(gateway.runtime.list().map(adapter => adapter.id)).toEqual(['mock']);
  expect(fetch).not.toHaveBeenCalled();
});

it('isolates cloud authentication failure from mock commands and API readiness without logging the key', async () => {
  const logger = createLogger('silent');
  const warn = vi.spyOn(logger, 'warn'); const error = vi.spyOn(logger, 'error'); const debug = vi.spyOn(logger, 'debug');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 401, message: apiKey }), { status: 401 })));
  gateway = await createGateway({ config: config(enabled), logger });
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith({ adapter: 'govee-cloud', errorCategory: 'startup' }, expect.any(String)));
  expect(gateway.runtime.list().map(adapter => adapter.id)).toEqual(['mock', 'govee-cloud']);
  expect(gateway.isReady()).toBe(true);
  const device = gateway.registry.list().find(item => item.model === 'rgb')!;
  const operation = gateway.operations.submitCommand({ type: 'device', id: device.id }, { power: true });
  expect((await gateway.operations.wait(operation.id)).status).toBe('succeeded');
  const app = await createApp(gateway);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'localhost', authorization: `Bearer ${gateway.tokens.create().token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ready');
  } finally { await app.close(); }
  expect(JSON.stringify([warn.mock.calls, error.mock.calls, debug.mock.calls])).not.toContain(apiKey);
});

it('registers cloud devices separately and reuses the configured API key', async () => {
  let power = 1;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Govee-API-Key')).toBe(apiKey);
    if (String(input).endsWith('/device/control')) {
      const body = JSON.parse(String(init?.body));
      expect(body.payload).toEqual({ sku: 'H6008', device: 'cloud-bulb', capability: { type: 'devices.capabilities.on_off', instance: 'powerSwitch', value: 0 } });
      power = body.payload.capability.value;
      return new Response(JSON.stringify({ code: 200, msg: 'success' }), { status: 200 });
    }
    const data = String(input).endsWith('/user/devices')
      ? { code: 200, message: 'success', data: [{ sku: 'H6008', device: 'cloud-bulb', deviceName: 'Bedroom', capabilities: [{ type: 'devices.capabilities.on_off', instance: 'powerSwitch', parameters: { dataType: 'ENUM', options: [{ name: 'on', value: 1 }, { name: 'off', value: 0 }] } }] }] }
      : { code: 200, msg: 'success', payload: { sku: 'H6008', device: 'cloud-bulb', capabilities: [{ type: 'devices.capabilities.on_off', instance: 'powerSwitch', state: { value: power } }] } };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  gateway = await createGateway({ config: config(enabled) });
  await vi.waitFor(() => expect(gateway!.registry.list().find(item => item.adapter === 'govee-cloud')?.state.power).toBe(true));
  expect(gateway.registry.list().find(item => item.adapter === 'govee-cloud')).toMatchObject({ model: 'H6008', name: 'Bedroom' });
  const device = gateway.registry.list().find(item => item.adapter === 'govee-cloud')!;
  const operation = gateway.operations.submitCommand({ type: 'device', id: device.id }, { power: false });
  expect((await gateway.operations.wait(operation.id)).status).toBe('succeeded');
  expect(gateway.registry.get(device.id).state.power).toBe(false);
});

it('keeps a cloud device offline when the cloud reports it disconnected', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).endsWith('/user/devices')
    ? { code: 200, message: 'success', data: [{ sku: 'H6008', device: 'offline-bulb', deviceName: 'Disconnected bulb', capabilities: [{ type: 'devices.capabilities.on_off', instance: 'powerSwitch', parameters: {} }] }] }
    : { code: 200, msg: 'success', payload: { sku: 'H6008', device: 'offline-bulb', capabilities: [{ type: 'devices.capabilities.online', instance: 'online', state: { value: false } }, { type: 'devices.capabilities.on_off', instance: 'powerSwitch', state: { value: 1 } }] } }), { status: 200 })));
  gateway = await createGateway({ config: config(enabled) });
  await vi.waitFor(() => expect(gateway!.registry.list().find(item => item.adapter === 'govee-cloud')?.availability).toBe('offline'));
  expect(gateway.isReady()).toBe(true);
});

it('does not wait for cloud discovery before readiness and cancels it during shutdown', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error(apiKey)), { once: true }));
  }));
  gateway = await createGateway({ config: config(enabled) });
  expect(gateway.isReady()).toBe(true);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await gateway.stop();
  expect(signal?.aborted).toBe(true);
  expect(gateway.isStopping()).toBe(true);
});

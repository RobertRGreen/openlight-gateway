import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createGateway, type Gateway } from '../src/service/index.js';
import type { GoveeTransport } from '../src/adapters/govee/transport.js';
import { futureCloudScheduling } from '../src/adapters/govee/cloud.js';
import { createApp } from '../src/api/rest/index.js';

class ServiceTransport implements GoveeTransport {
  readonly messages = new Set<Parameters<GoveeTransport['onMessage']>[0]>();
  readonly errors = new Set<(error: Error) => void>();
  readonly sent: unknown[] = [];
  opened = 0;
  closed = 0;
  failOpen = false;
  simulateDevice = false;
  power = 0;
  async open() { this.opened++; if (this.failOpen) throw new Error('simulated socket failure'); }
  async send(payload: Uint8Array) {
    const command = JSON.parse(Buffer.from(payload).toString());
    this.sent.push(command);
    if (!this.simulateDevice) return;
    if (command.msg.cmd === 'turn') this.power = command.msg.data.value;
    const data = command.msg.cmd === 'scan'
      ? { ip: '192.0.2.12', device: 'AA:BB:CC:DD:EE:FF', sku: 'H6076' }
      : command.msg.cmd === 'devStatus' ? { onOff: this.power, brightness: 40, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 } : undefined;
    if (data) for (const listener of this.messages) listener(Buffer.from(JSON.stringify({ msg: { cmd: command.msg.cmd, data } })), { address: '192.0.2.12', port: 4003 });
  }
  onMessage(listener: Parameters<GoveeTransport['onMessage']>[0]) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onError(listener: (error: Error) => void) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  async close() { this.closed++; }
}

let gateway: Gateway | undefined;
afterEach(async () => { await gateway?.stop(); gateway = undefined; });
const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent', MOCK_LATENCY_MS: '0', ...env });

it('requires explicit Govee opt-in and validates its discovery window', () => {
  expect(config().goveeAdapterEnabled).toBe(false);
  expect(config({ GOVEE_ADAPTER_ENABLED: 'true' }).goveeAdapterEnabled).toBe(true);
  expect(() => config({ GOVEE_ADAPTER_ENABLED: '1' })).toThrow();
  expect(() => config({ GOVEE_DISCOVERY_TIMEOUT_MS: '-1' })).toThrow();
});

it('keeps default startup mock-only without opening the provided UDP transport', async () => {
  const transport = new ServiceTransport();
  gateway = await createGateway({ config: config(), goveeTransport: transport });
  expect(gateway.runtime.list().map(adapter => adapter.id)).toEqual(['mock']);
  expect(gateway.registry.list()).toHaveLength(5);
  expect(transport.opened).toBe(0);
});

it('isolates Govee socket startup failure while mock operations remain usable', async () => {
  const transport = new ServiceTransport();
  transport.failOpen = true;
  gateway = await createGateway({ config: config({ GOVEE_ADAPTER_ENABLED: 'true' }), goveeTransport: transport });
  await vi.waitFor(() => expect(transport.opened).toBe(1));
  expect(gateway.isReady()).toBe(true);
  expect(gateway.runtime.list().map(adapter => adapter.id)).toEqual(['mock', 'govee']);
  const device = gateway.registry.list().find(item => item.model === 'rgb')!;
  const operation = gateway.operations.submitCommand({ type: 'device', id: device.id }, { power: true });
  expect((await gateway.operations.wait(operation.id)).status).toBe('succeeded');
  const app = await createApp(gateway);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'localhost', authorization: `Bearer ${gateway.tokens.create().token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ready');
  } finally { await app.close(); }
});

it('discovers a Govee device into the registry and executes its command through the core', async () => {
  const transport = new ServiceTransport();
  transport.simulateDevice = true;
  gateway = await createGateway({ config: config({ GOVEE_ADAPTER_ENABLED: 'true', GOVEE_DISCOVERY_TIMEOUT_MS: '50' }), goveeTransport: transport });
  await vi.waitFor(() => expect(gateway!.registry.list().find(item => item.adapter === 'govee')?.availability).toBe('online'));
  const device = gateway.registry.list().find(item => item.adapter === 'govee')!;
  expect(device.model).toBe('H6076');
  expect(device.capabilities.map(capability => capability.type)).toEqual(['power', 'brightness', 'rgb']);
  expect(device.state).toEqual({ power: false, brightness: 40, rgb: { r: 1, g: 2, b: 3 } });
  const operation = gateway.operations.submitCommand({ type: 'device', id: device.id }, { power: true });
  expect((await gateway.operations.wait(operation.id)).status).toBe('succeeded');
  expect(transport.sent).toContainEqual({ msg: { cmd: 'turn', data: { value: 1 } } });
  expect(gateway.registry.get(device.id).state.power).toBe(true);
});

it('does not wait for Govee discovery before readiness and drains canceled discovery on stop', async () => {
  const transport = new ServiceTransport();
  gateway = await createGateway({ config: config({ GOVEE_ADAPTER_ENABLED: 'true', GOVEE_DISCOVERY_TIMEOUT_MS: '60000' }), goveeTransport: transport });
  expect(gateway.isReady()).toBe(true);
  await vi.waitFor(() => expect(transport.sent).toContainEqual({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
  await gateway.stop();
  expect(gateway.isStopping()).toBe(true);
  expect(transport.closed).toBeGreaterThan(0);
  expect(transport.messages.size).toBe(0);
  expect(transport.errors.size).toBe(0);
});

it('keeps both real cloud quota scopes in the unconnected future scaffold', () => {
  const profile = futureCloudScheduling('opaque-account-1');
  expect(profile.budgets).toEqual(expect.arrayContaining([
    expect.objectContaining({ scope: 'device', maxRequests: 10, windowMs: 60_000 }),
    expect.objectContaining({ scope: 'account', key: 'govee-cloud-opaque-account-1', maxRequests: 10_000, windowMs: 86_400_000 }),
  ]));
  expect(() => futureCloudScheduling('https://credential.example/key')).toThrow();
});

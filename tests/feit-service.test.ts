import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createGateway, type Gateway } from '../src/service/index.js';
import { createLogger } from '../src/security/logger.js';
import { createApp } from '../src/api/rest/index.js';
import type { CallContext } from '../src/adapters/types.js';
import type { FeitTransport } from '../src/adapters/feit/transport.js';
import { CONTROL, DP_QUERY, decodeFrame, decryptControl, encodeFrame, encodeQuery } from '../src/adapters/feit/protocol.js';

const localKey = '0123456789abcdef';
const device = { id: 'fixture-bulb', name: 'Fixture bulb', ip: '192.0.2.20', localKey, version: '3.3' };
class ServiceTransport implements FeitTransport {
  readonly requests: Uint8Array[] = [];
  readonly controls: Record<string, unknown>[] = [];
  dps: Record<string, unknown> = { '20': true, '21': 'white', '22': 505, '23': 500, '24': '000003e803e8' };
  closed = 0;
  applyControls = true;
  async request(_ip: string, packet: Uint8Array, _context: Pick<CallContext, 'signal' | 'deadlineAt'>, precedingControlPacket?: Uint8Array): Promise<Buffer> {
    this.requests.push(packet);
    const frame = decodeFrame(packet);
    expect(frame.command).toBe(DP_QUERY);
    if (precedingControlPacket) {
      const control = decodeFrame(precedingControlPacket);
      expect(control.command).toBe(CONTROL);
      const body = decryptControl(control.payload, localKey) as { dps: Record<string, unknown> };
      this.controls.push(body.dps);
      if (this.applyControls) Object.assign(this.dps, body.dps);
      // No CONTROL acknowledgement is provided: only the subsequent query replies.
    }
    return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: this.dps }));
  }
  async close() { this.closed++; }
}
let gateway: Gateway | undefined;
afterEach(async () => { await gateway?.stop(); gateway = undefined; vi.restoreAllMocks(); });
const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent', MOCK_LATENCY_MS: '0', ...env });
const enabled = (devices: unknown = [device]) => config({ FEIT_ADAPTER_ENABLED: 'true', FEIT_DEVICES: JSON.stringify(devices) });

it('defaults Feit to disabled without parsing credentials or touching transport', async () => {
  expect(config().feitAdapterEnabled).toBe(false);
  expect(config().feitDevices).toBe('[]');
  expect(() => config({ FEIT_ADAPTER_ENABLED: '1' })).toThrow();
  const transport = new ServiceTransport();
  gateway = await createGateway({ config: config({ FEIT_DEVICES: '{invalid' }), feitTransport: transport });
  expect(gateway.runtime.list().map(adapter => adapter.id)).toEqual(['mock']);
  expect(transport.requests).toHaveLength(0);
});

it.each(['', '[]', '{}', 'null', '[null]', '[{}]', `[{"localKey":"${localKey}"`, JSON.stringify([{ ...device, localKey: 'short' }])])('isolates invalid Feit inventory without exposing credentials (%#)', async raw => {
  const logger = createLogger('silent');
  const error = vi.spyOn(logger, 'error');
  const transport = new ServiceTransport();
  gateway = await createGateway({ config: config({ FEIT_ADAPTER_ENABLED: 'true', FEIT_DEVICES: raw }), logger, feitTransport: transport });
  expect(error).toHaveBeenCalledWith({ adapter: 'feit', errorCategory: 'configuration' }, expect.stringContaining('requires FEIT_DEVICES to be a non-empty JSON array'));
  expect(JSON.stringify(error.mock.calls)).not.toContain(localKey);
  expect(gateway.isReady()).toBe(true);
  expect(gateway.registry.list()).toHaveLength(5);
  expect(transport.requests).toHaveLength(0);
});

it('isolates unsupported protocol startup while mock commands and API remain ready', async () => {
  const logger = createLogger('silent');
  const error = vi.spyOn(logger, 'error');
  const transport = new ServiceTransport();
  gateway = await createGateway({ config: enabled([{ ...device, version: '3.6' }]), logger, feitTransport: transport });
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith({ adapter: 'feit', errorCategory: 'startup' }, expect.stringContaining('protocol version 3.3')));
  expect(transport.requests).toHaveLength(0);
  const mock = gateway.registry.list().find(item => item.model === 'rgb')!;
  const operation = gateway.operations.submitCommand({ type: 'device', id: mock.id }, { power: true });
  expect((await gateway.operations.wait(operation.id)).status).toBe('succeeded');
  const app = await createApp(gateway);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'localhost', authorization: `Bearer ${gateway.tokens.create().token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ready');
  } finally { await app.close(); }
  expect(JSON.stringify(error.mock.calls)).not.toContain(localKey);
});

it('registers a manual Feit bulb with no default temperature capability and verifies power via core without a CONTROL acknowledgement', async () => {
  const transport = new ServiceTransport();
  gateway = await createGateway({ config: enabled(), feitTransport: transport });
  await vi.waitFor(() => expect(gateway!.registry.list().find(item => item.adapter === 'feit')?.availability).toBe('online'));
  const bulb = gateway.registry.list().find(item => item.adapter === 'feit')!;
  expect(bulb.capabilities.map(capability => capability.type)).toEqual(['power', 'brightness', 'rgb']);
  expect(bulb.state).toMatchObject({ power: true, brightness: 50 });
  expect(bulb.state.colorTemperature).toBeUndefined();
  expect(JSON.stringify(bulb)).not.toContain(localKey);
  const operation = gateway.operations.submitCommand({ type: 'device', id: bulb.id }, { power: false });
  expect((await gateway.operations.wait(operation.id)).status).toBe('succeeded');
  expect(transport.controls).toContainEqual({ '20': false });
  expect(gateway.registry.get(bulb.id).state.power).toBe(false);
  await gateway.stop();
  expect(transport.closed).toBeGreaterThan(0);
});

it('uses explicit fixture calibration for Kelvin capabilities and core temperature commands', async () => {
  const transport = new ServiceTransport();
  // Synthetic fixture calibration, not asserted as any real bulb's Kelvin range.
  const colorTemperature = { id: '23', rawMinimum: 0, rawMaximum: 1000, minimumKelvin: 2000, maximumKelvin: 6000, step: 1 };
  gateway = await createGateway({ config: enabled([{ ...device, dpsMap: { colorTemperature } }]), feitTransport: transport });
  await vi.waitFor(() => expect(gateway!.registry.list().find(item => item.adapter === 'feit')?.state.colorTemperature).toBe(4000));
  const bulb = gateway.registry.list().find(item => item.adapter === 'feit')!;
  expect(bulb.capabilities).toContainEqual(expect.objectContaining({ type: 'colorTemperature', minimum: 2000, maximum: 6000 }));
  const operation = gateway.operations.submitCommand({ type: 'device', id: bulb.id }, { colorTemperature: 5000 });
  expect((await gateway.operations.wait(operation.id)).status).toBe('succeeded');
  expect(transport.controls).toContainEqual({ '21': 'white', '23': 750 });
  expect(gateway.registry.get(bulb.id).state.colorTemperature).toBe(5000);
});

it('keeps readiness independent of pending device queries and cancels them on shutdown', async () => {
  const transport = new ServiceTransport();
  let signal: AbortSignal | undefined;
  vi.spyOn(transport, 'request').mockImplementation((_ip, _packet, context) => {
    signal = context.signal;
    return new Promise<Buffer>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error(localKey)), { once: true }));
  });
  gateway = await createGateway({ config: enabled(), feitTransport: transport });
  expect(gateway.isReady()).toBe(true);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await gateway.stop();
  expect(signal?.aborted).toBe(true);
  expect(transport.closed).toBeGreaterThan(0);
});

it('keeps a core write unconfirmed when query DPS disagree with CONTROL', async () => {
  const transport = new ServiceTransport();
  transport.applyControls = false;
  gateway = await createGateway({ config: { ...enabled(), adapterTimeoutMs: 500 }, feitTransport: transport });
  await vi.waitFor(() => expect(gateway!.registry.list().find(item => item.adapter === 'feit')?.availability).toBe('online'));
  const bulb = gateway.registry.list().find(item => item.adapter === 'feit')!;
  const operation = gateway.operations.submitCommand({ type: 'device', id: bulb.id }, { power: false });
  const result = await gateway.operations.wait(operation.id);
  expect(result.status).toBe('failed');
  expect(result.results[0]?.confirmation).toBe('unconfirmed');
  expect(result.results[0]?.fieldResults).toContainEqual({ path: '/power', status: 'unconfirmed' });
  expect(result.results[0]?.error?.code).toBe('adapter_timeout');
  expect(gateway.registry.get(bulb.id).state.power).toBe(true);
  expect(transport.controls).toEqual([{ '20': false }]);
});

it('keeps a core write unconfirmed when the verification query never replies', async () => {
  const transport = new ServiceTransport();
  gateway = await createGateway({ config: { ...enabled(), adapterTimeoutMs: 500 }, feitTransport: transport });
  await vi.waitFor(() => expect(gateway!.registry.list().find(item => item.adapter === 'feit')?.availability).toBe('online'));
  const bulb = gateway.registry.list().find(item => item.adapter === 'feit')!;
  vi.spyOn(transport, 'request').mockImplementation((_ip, _packet, context) => new Promise<Buffer>((_resolve, reject) => {
    context.signal.addEventListener('abort', () => reject(new Error(localKey)), { once: true });
  }));
  const operation = gateway.operations.submitCommand({ type: 'device', id: bulb.id }, { power: false });
  const result = await gateway.operations.wait(operation.id);
  expect(result.status).toBe('failed');
  expect(result.results[0]?.confirmation).toBe('unconfirmed');
  expect(result.results[0]?.error?.code).toBe('device_offline');
  expect(gateway.registry.get(bulb.id).state.power).toBe(true);
  expect(JSON.stringify(result)).not.toContain(localKey);
});

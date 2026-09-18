import { describe, expect, it, vi } from 'vitest';
import { AdapterError } from '../src/adapters/types.js';
import type { CallContext } from '../src/adapters/types.js';
import { FeitAdapter } from '../src/adapters/feit/index.js';
import type { FeitDeviceConfig } from '../src/adapters/feit/index.js';
import type { FeitTransport } from '../src/adapters/feit/transport.js';
import { CONTROL, decodeFrame, decodeQuery, decryptControl, encodeFrame, encodeQuery } from '../src/adapters/feit/protocol.js';

const key = '0123456789abcdef';
const device: FeitDeviceConfig = { id: 'bulb', name: 'Desk', ip: '192.0.2.10', localKey: key, version: '3.3' };
const context = (signal = new AbortController().signal): CallContext => ({ operationId: 'test', correlationId: null, signal, deadlineAt: Date.now() + 5000 });
class FakeTransport implements FeitTransport {
 dps: Record<string, unknown> = { '20': true, '21': 'colour', '22': 505, '24': '000003e803e8' };
 writes: Record<string, unknown>[] = [];
 contexts: { signal: AbortSignal; deadlineAt: number }[] = [];
 close = vi.fn(async () => {});
 async request(_ip: string, packet: Uint8Array, ctx: { signal: AbortSignal; deadlineAt: number }, preceding?: Uint8Array): Promise<Buffer> {
  this.contexts.push(ctx); const frame = decodeFrame(packet);
  if (preceding) { const control = decryptControl(decodeFrame(preceding).payload, key) as Record<string, unknown>; this.writes.push(control); Object.assign(this.dps, control.dps); }
  expect(decodeQuery(frame.payload)).toMatchObject({ devId: 'bulb', uid: 'bulb' });
  return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: this.dps }));
 }
}
async function setup(config: FeitDeviceConfig = device, transport = new FakeTransport()) {
 const adapter = new FeitAdapter({ devices: [config], transport, commandTimeoutMs: 50 });
 const discovered = []; for await (const found of adapter.discover(context())) discovered.push(found);
 return { adapter, transport, discovered };
}
describe('Feit manually configured Tuya adapter', () => {
 it('discovers without traffic and keeps credentials and mutations out of inventory', async () => {
  const config = structuredClone(device); const { adapter, transport, discovered } = await setup(config);
  expect(transport.contexts).toHaveLength(0); expect(JSON.stringify(discovered)).not.toContain(key);
  config.name = 'changed'; discovered[0]!.name = 'mutated';
  expect((await adapter.getDevices(context()))[0]!.name).toBe('Desk');
  expect(await adapter.getCapabilities('bulb', context())).toEqual([{ type: 'power' }, { type: 'brightness', minimum: 0, maximum: 100, step: 1 }, { type: 'rgb' }]);
 });
 it('normalizes default DP_QUERY and isolates observations from event listener mutation', async () => {
  const { adapter } = await setup();
  adapter.onEvent(event => { if (event.type === 'observation') event.observation.state.power = false; });
  const result = await adapter.getState('bulb', context());
  expect(result).toMatchObject({ state: { power: true, brightness: 50, rgb: { r: 255, g: 0, b: 0 } }, complete: true });
  expect(result.nativeSequence).toBeUndefined(); expect(Number.isNaN(Date.parse(result.observedAt))).toBe(false);
 });
 it('normalizes overridden DPS and calibrated temperature, excludes stale colour in white mode', async () => {
  const transport = new FakeTransport(); transport.dps = { '1': false, '2': 'white', '3': 120, '4': 50, '5': '000003e803e8' };
  const { adapter } = await setup({ ...device, dpsMap: { power: '1', workMode: '2', brightness: { id: '3', minimum: 20, maximum: 220, step: 10 }, colour: '5', colorTemperature: { id: '4', rawMinimum: 0, rawMaximum: 100, minimumKelvin: 2000, maximumKelvin: 6000, step: 5 } } }, transport);
  expect(await adapter.getState('bulb', context())).toMatchObject({ state: { power: false, brightness: 50, colorTemperature: 4000 }, complete: true });
  expect((await adapter.getState('bulb', context())).state.rgb).toBeUndefined();
  await adapter.setTemperature('bulb', 4100, context());
  expect(transport.writes.at(-1)!.dps).toEqual({ '2': 'white', '4': 55 });
  await adapter.setBrightness('bulb', 51, context()); expect(transport.writes.at(-1)!.dps).toEqual({ '2': 'white', '3': 120 });
  expect(await adapter.getCapabilities('bulb', context())).toContainEqual({ type: 'colorTemperature', minimum: 2000, maximum: 6000, step: 1 });
  await expect(adapter.setTemperature('bulb', 1999, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
 });
 it.each([undefined, {}, { rawMinimum: 0, rawMaximum: 1000 }, { minimumKelvin: 2000, maximumKelvin: 6000 }, { rawMinimum: 0, minimumKelvin: 2000, maximumKelvin: 6000 }])('does not fabricate temperature support for missing calibration: %j', async calibration => {
  const { adapter } = await setup({ ...device, dpsMap: { ...(calibration === undefined ? {} : { colorTemperature: calibration }) } });
  expect((await adapter.getCapabilities('bulb', context())).some(cap => cap.type === 'colorTemperature')).toBe(false);
  await expect(adapter.setTemperature('bulb', 3000, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
 });
 it('writes encrypted CONTROL with required identity, time, work mode, and HSV DPs', async () => {
  const { adapter, transport } = await setup();
  expect(await adapter.setPower('bulb', false, context())).toMatchObject({ transport: 'lan', acknowledgment: 'applied', observation: { state: { power: false } } });
  await adapter.setBrightness('bulb', 50, context());
  await adapter.setColor('bulb', { mode: 'rgb', value: { r: 0, g: 255, b: 0 } }, context());
  expect(transport.writes[0]).toMatchObject({ devId: 'bulb', uid: 'bulb', t: expect.stringMatching(/^\d+$/), dps: { '20': false } });
  expect(transport.writes[1]!.dps).toEqual({ '21': 'white', '22': 505 });
  expect(transport.writes[2]!.dps).toEqual({ '21': 'colour', '24': '007803e803e8' });
  await expect(adapter.setBrightness('bulb', 101, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  await expect(adapter.setColor('bulb', { mode: 'rgb', value: { r: -1, g: 0, b: 0 } }, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
 });
 it('supports disabling colour and rejects unsupported color modes', async () => {
  const { adapter } = await setup({ ...device, dpsMap: { colour: null } });
  expect(await adapter.getCapabilities('bulb', context())).toHaveLength(2);
  await expect(adapter.setColor('bulb', { mode: 'rgb', value: { r: 0, g: 0, b: 0 } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
 });
 it.each(['3.1', '3.4', '3.5'])('rejects protocol %s at discovery before yielding or sending', async version => {
  const transport = new FakeTransport(); const adapter = new FeitAdapter({ devices: [{ ...device, version }], transport });
  await expect(adapter.discover(context())[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining(version) });
  expect(transport.contexts).toHaveLength(0);
 });
 it('bounds fake transports ignoring abort and maps timeout correctly', async () => {
  const { adapter, transport } = await setup(); const request = vi.spyOn(transport, 'request').mockImplementation(async (_ip, _packet, ctx) => { transport.contexts.push(ctx); return new Promise(() => {}); });
  await expect(adapter.setPower('bulb', true, context())).rejects.toMatchObject({ code: 'OFFLINE' });
  expect(transport.contexts[0]!.signal.aborted).toBe(true); expect(request).toHaveBeenCalledTimes(2);
 });
 it('retries only DP_QUERY after mismatched state and requires exact raw work mode', async () => {
  const { adapter, transport } = await setup();
  let controls = 0; let queries = 0;
  vi.spyOn(transport, 'request').mockImplementation(async (_ip, packet, _ctx, preceding) => {
   queries++; if (preceding) controls++;
   const frame = decodeFrame(packet);
   return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: { '20': true, '21': 'colour', '22': 505 } }));
  });
  await expect(adapter.setBrightness('bulb', 50, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(controls).toBe(1); expect(queries).toBe(2);
 });
 it('accepts matching second query without replaying CONTROL', async () => {
  const { adapter, transport } = await setup(); let controls = 0; let queries = 0;
  vi.spyOn(transport, 'request').mockImplementation(async (_ip, packet, _ctx, preceding) => {
   queries++; if (preceding) controls++;
   const frame = decodeFrame(packet);
   return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: { '20': queries === 2, '21': 'white', '22': 505 } }));
  });
  expect(await adapter.setPower('bulb', true, context())).toMatchObject({ acknowledgment: 'applied', observation: { state: { power: true } } });
  expect(controls).toBe(1); expect(queries).toBe(2);
 });
 it('does not round mismatching raw brightness into a successful write', async () => {
  const { adapter, transport } = await setup();
  vi.spyOn(transport, 'request').mockImplementation(async (_ip, packet) => {
   const frame = decodeFrame(packet); return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: { '20': true, '21': 'white', '22': 506 } }));
  });
  await expect(adapter.setBrightness('bulb', 50, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
 });
 it('retains injected transport if caller mutates options', async () => {
  const transport = new FakeTransport(); const options = { devices: [device], transport }; const adapter = new FeitAdapter(options);
  options.transport = new FakeTransport(); await adapter.connect(context()); await adapter.getState('bulb', context());
  expect(transport.contexts).toHaveLength(1); expect(options.transport.contexts).toHaveLength(0);
 });
 it.each([{ power: null }, { workMode: null }, { brightness: null }, { brightness: { id: null } }, { brightness: { minimum: null } }, { brightness: { maximum: null } }, { brightness: { step: null } }])('rejects explicit invalid null config values: %j', dpsMap => {
  expect(() => new FeitAdapter({ devices: [{ ...device, dpsMap } as unknown as FeitDeviceConfig], transport: new FakeTransport() })).toThrow('Invalid Feit manual device configuration');
 });
 it('redacts uncloneable config and validates finite deadlines', async () => {
  const transport = new FakeTransport();
  expect(() => new FeitAdapter({ devices: [{ ...device, extra: () => key } as FeitDeviceConfig], transport })).toThrow('Invalid Feit manual device configuration');
  const { adapter } = await setup(); await expect(adapter.getState('bulb', { ...context(), deadlineAt: NaN })).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
 });
 it('cancels while waiting to retry and never sends a second query', async () => {
  const { adapter, transport } = await setup(); const controller = new AbortController();
  vi.spyOn(transport, 'request').mockImplementation(async (_ip, packet) => { const frame = decodeFrame(packet); return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: { '20': false } })); });
  const pending = adapter.setPower('bulb', true, context(controller.signal)); const checked = expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
  await new Promise(resolve => setTimeout(resolve, 1)); controller.abort(); await checked;
  expect(transport.request).toHaveBeenCalledOnce();
 });
 it('cancels in-flight calls and closes resources on disconnect', async () => {
  const { adapter, transport } = await setup(); vi.spyOn(transport, 'request').mockImplementation(async () => new Promise(() => {}));
  const pending = adapter.getState('bulb', context()); const checked = expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
  await adapter.disconnect(context()); await checked; expect(transport.close).toHaveBeenCalledOnce();
  await expect(adapter.getState('bulb', context())).rejects.toMatchObject({ code: 'OFFLINE' });
 });
 it('caller cancellation and expired deadlines avoid transport traffic', async () => {
  const { adapter, transport } = await setup(); const controller = new AbortController(); controller.abort();
  await expect(adapter.getState('bulb', context(controller.signal))).rejects.toMatchObject({ code: 'CANCELED' });
  await expect(adapter.getState('bulb', { ...context(), deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(transport.contexts).toHaveLength(0);
 });
 it.each(['OFFLINE', 'TRANSPORT_ERROR', 'TIMEOUT'] as const)('redacts malicious typed transport %s messages', async code => {
  const logger = { warn: vi.fn() }; const transport = new FakeTransport(); const adapter = new FeitAdapter({ devices: [device], transport, logger, commandTimeoutMs: 25 }); await adapter.connect(context());
  vi.spyOn(transport, 'request').mockRejectedValue(new AdapterError(code, `leaked ${key}`));
  try { await adapter.getState('bulb', context()); throw new Error('expected failure'); } catch (error) { expect(error).toMatchObject({ code: code === 'TIMEOUT' ? 'OFFLINE' : code }); expect(String(error)).not.toContain(key); expect(JSON.stringify(error)).not.toContain(key); }
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(key);
 });
 it('redacts malformed payload and configuration errors', async () => {
  const logger = { warn: vi.fn() }; const transport = new FakeTransport(); const adapter = new FeitAdapter({ devices: [device], transport, logger, commandTimeoutMs: 25 }); await adapter.connect(context());
  vi.spyOn(transport, 'request').mockImplementation(async (_ip, packet) => { const frame = decodeFrame(packet); return encodeFrame(frame.sequence, frame.command, Buffer.from(key)); });
  await expect(adapter.getState('bulb', context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', message: 'Feit TCP transport failed' });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(key);
  expect(() => new FeitAdapter({ devices: [{ ...device, name: key }], transport })).toThrow('Invalid Feit manual device configuration');
  expect(() => new FeitAdapter({ devices: [{ ...device, dpsMap: { brightness: { step: 0 } } }], transport })).toThrow('Invalid Feit manual device configuration');
 });
 it('rejects corrupt and mismatched query responses without claiming success', async () => {
  const { adapter, transport } = await setup();
  vi.spyOn(transport, 'request').mockResolvedValue(Buffer.from('truncated'));
  await expect(adapter.getState('bulb', context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
  vi.mocked(transport.request).mockImplementation(async (_ip, packet) => { const frame = decodeFrame(packet); return encodeFrame(frame.sequence + 1, frame.command, Buffer.alloc(4)); });
  await expect(adapter.setPower('bulb', true, context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
  vi.mocked(transport.request).mockImplementation(async (_ip, packet) => { const frame = decodeFrame(packet); return encodeFrame(frame.sequence, frame.command, Buffer.from([0, 0, 0, 1])); });
  await expect(adapter.setPower('bulb', true, context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
 });
});

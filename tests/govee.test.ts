import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoveeAdapter } from '../src/adapters/govee/index.js';
import type { GoveeTransport } from '../src/adapters/govee/transport.js';
import type { CallContext } from '../src/adapters/types.js';

class FakeTransport implements GoveeTransport {
 messages = new Set<(payload: Uint8Array, remote: { address: string; port: number }) => void>();
 errors = new Set<(error: Error) => void>();
 sent: { body: any; address: string; port: number }[] = [];
 respond: (body: any, address: string) => void = () => {};
 open = vi.fn(async () => {});
 close = vi.fn(async () => {});
 async send(payload: Uint8Array, address: string, port: number) { const body = JSON.parse(Buffer.from(payload).toString()); this.sent.push({ body, address, port }); this.respond(body, address); }
 onMessage(listener: (payload: Uint8Array, remote: { address: string; port: number }) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
 onError(listener: (error: Error) => void) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
 receive(body: unknown, address = '192.168.1.10') { this.raw(JSON.stringify(body), address); }
 raw(body: string, address = '192.168.1.10') { for (const listener of this.messages) listener(Buffer.from(body), { address, port: 4003 }); }
}
const nativeId = 'AA:BB:CC:DD:EE:FF';
const scan = (device = nativeId, sku = 'H6199') => ({ msg: { cmd: 'scan', data: { device, sku, ip: '192.168.1.10' } } });
const status = (data: unknown = { onOff: 1, brightness: 42, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 }) => ({ msg: { cmd: 'devStatus', data } });
const context = (signal = new AbortController().signal): CallContext => ({ operationId: 'test', correlationId: null, signal, deadlineAt: Date.now() + 5000 });
async function discover(adapter: GoveeAdapter, ctx = context()) { const result = []; for await (const device of adapter.discover(ctx)) result.push(device); return result; }
const adapters: GoveeAdapter[] = [];
function setup() {
 const transport = new FakeTransport(); const logger = { warn: vi.fn() };
 const adapter = new GoveeAdapter({ transport, discoveryTimeoutMs: 5, commandTimeoutMs: 30, logger });
 adapters.push(adapter); return { adapter, transport, logger };
}
async function ready() { const value = setup(); value.transport.respond = body => { if (body.msg.cmd === 'scan') value.transport.receive(scan()); }; await discover(value.adapter); value.transport.sent = []; return value; }
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.disconnect(context()); });

describe('Govee LAN adapter with injected transport', () => {
 it('sends multicast scan and discovers multiple stable identities, deduplicating replies', async () => {
  const { adapter, transport } = setup();
  transport.respond = () => { transport.receive(scan()); transport.receive(scan()); transport.receive(scan('11:22:33:44:55:66:77:88', 'H6008'), '192.168.1.11'); };
  const devices = await discover(adapter);
  expect(transport.sent).toEqual([{ body: { msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }, address: '239.255.255.250', port: 4001 }]);
  expect(devices.map(d => [d.nativeId, d.model, d.address?.endpoint])).toEqual([[nativeId, 'H6199', '192.168.1.10'], ['11:22:33:44:55:66:77:88', 'H6008', '192.168.1.11']]);
  expect(await adapter.getDevices(context())).toEqual(devices); expect(transport.messages.size).toBe(0);
 });
 it('skips malformed and unexpected responses, logs without raw bodies', async () => {
  const { adapter, transport, logger } = setup();
  transport.respond = () => { transport.raw('secret garbage'); transport.receive(null); transport.receive({ msg: { cmd: 'scan', data: {} } }); transport.receive(status()); transport.receive(scan()); };
  expect(await discover(adapter)).toHaveLength(1); expect(logger.warn).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret garbage');
 });
 it('returns an empty bounded discovery when LAN devices do not respond', async () => { const { adapter } = setup(); expect(await discover(adapter)).toEqual([]); });
 it('updates an address while preserving native identity', async () => {
  const { adapter, transport } = await ready(); transport.respond = () => transport.receive(scan(), '192.168.1.99');
  await discover(adapter); expect(await adapter.getDevices(context())).toMatchObject([{ nativeId, address: { endpoint: '192.168.1.99' } }]);
 });
 it('advertises only power, brightness and RGB, and rejects temperature directly', async () => {
  const { adapter } = await ready(); expect((await adapter.getCapabilities(nativeId, context())).map(c => c.type)).toEqual(['power', 'brightness', 'rgb']);
  expect(adapter.effects).toBeUndefined(); expect(adapter.transitions).toBeUndefined(); expect(adapter.segments).toBeUndefined();
  await expect(adapter.setTemperature(nativeId, 2700, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
 });
 it.each([
  ['turn', { value: 1 }, (a: GoveeAdapter) => a.setPower(nativeId, true, context())],
  ['turn', { value: 0 }, (a: GoveeAdapter) => a.setPower(nativeId, false, context())],
  ['brightness', { value: 42 }, (a: GoveeAdapter) => a.setBrightness(nativeId, 42, context())],
  ['colorwc', { color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 }, (a: GoveeAdapter) => a.setColor(nativeId, { mode: 'rgb', value: { r: 1, g: 2, b: 3 } }, context())],
 ] as const)('sends %s unicast command and verifies physical readback', async (cmd, data, call) => {
  const { adapter, transport } = await ready();
  transport.respond = body => { if (body.msg.cmd === 'devStatus') transport.receive(status({ onOff: cmd === 'turn' ? data.value : 1, brightness: 42, color: { r: 1, g: 2, b: 3 } })); };
  const receipt = await call(adapter);
  expect(transport.sent).toEqual([{ body: { msg: { cmd, data } }, address: '192.168.1.10', port: 4003 }, { body: { msg: { cmd: 'devStatus', data: {} } }, address: '192.168.1.10', port: 4003 }]);
  expect(receipt).toMatchObject({ transport: 'lan', acknowledgment: 'applied', observation: { complete: true } });
 });
 it('maps unanswered write to TIMEOUT and retries status only, never the write', async () => {
  const { adapter, transport } = await ready(); transport.respond = () => {};
  await expect(adapter.setPower(nativeId, true, context())).rejects.toMatchObject({ code: 'TIMEOUT', delivery: 'unknown' });
  expect(transport.sent.map(p => p.body.msg.cmd)).toEqual(['turn', 'devStatus', 'devStatus']); expect(transport.messages.size).toBe(0);
 });
 it('maps no-response reads to OFFLINE and rejects wrong-source replies', async () => {
  const { adapter, transport } = await ready(); transport.respond = () => transport.receive(status(), '192.168.1.99');
  await expect(adapter.getState(nativeId, context())).rejects.toMatchObject({ code: 'OFFLINE' });
 });
 it('does not mistake a mismatched readback for applied state', async () => {
  const { adapter, transport } = await ready(); const events: unknown[] = []; adapter.onEvent(event => events.push(event)); transport.respond = () => transport.receive(status({ onOff: 0 }));
  await expect(adapter.setPower(nativeId, true, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(events).toContainEqual({ type: 'availability', nativeId, status: 'online' });
  expect(events).not.toContainEqual({ type: 'availability', nativeId, status: 'offline' });
 });
 it('reports complete only for all parsed LAN fields and ignores white-mode stale RGB', async () => {
  const { adapter, transport } = await ready(); transport.respond = () => transport.receive(status());
  expect(await adapter.getState(nativeId, context())).toMatchObject({ state: { power: true, brightness: 42, rgb: { r: 1, g: 2, b: 3 } }, complete: true });
  transport.respond = () => transport.receive(status({ onOff: 0, brightness: 'bad', color: { r: -1, g: 0, b: 0 } }));
  expect(await adapter.getState(nativeId, context())).toMatchObject({ state: { power: false }, complete: false });
  transport.respond = () => transport.receive(status({ onOff: 1, brightness: 20, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 2700 }));
  expect((await adapter.getState(nativeId, context())).state).toEqual({ power: true, brightness: 20 });
 });
 it('skips malformed status data until a valid response arrives', async () => {
  const { adapter, transport, logger } = await ready(); transport.respond = () => { transport.raw('garbage'); transport.receive(status({ onOff: 7 })); transport.receive(status()); };
  expect((await adapter.getState(nativeId, context())).complete).toBe(true); expect(logger.warn).toHaveBeenCalledTimes(2);
 });
 it('validates integer ranges before any packets are sent', async () => {
  const { adapter, transport } = await ready(); await expect(adapter.setBrightness(nativeId, 100.5, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  await expect(adapter.setColor(nativeId, { mode: 'rgb', value: { r: 256, g: 0, b: 0 } }, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' }); expect(transport.sent).toEqual([]);
 });
 it('cancels pending reads, cleans listeners and stops retries', async () => {
  const { adapter, transport } = await ready(); transport.respond = () => {};
  const abort = new AbortController(); const result = adapter.getState(nativeId, context(abort.signal)); abort.abort();
  await expect(result).rejects.toMatchObject({ code: 'CANCELED' }); expect(transport.messages.size).toBe(0);
 });
 it('isolates socket errors and consumer callback failures', async () => {
  const { adapter, transport } = await ready(); adapter.onEvent(() => { throw new Error('consumer'); });
  transport.respond = () => { for (const listener of transport.errors) listener(new Error('secret socket error')); };
  await expect(adapter.getState(nativeId, context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', message: 'Govee UDP transport failed' });
 });
 it('normalizes rejected sends to TRANSPORT_ERROR', async () => {
  const { adapter, transport } = await ready(); transport.send = async () => { throw new Error('socket failure'); };
  await expect(adapter.setPower(nativeId, true, context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
 });
 it('disconnect cancels active work and releases subscriptions idempotently', async () => {
  const { adapter, transport } = await ready(); transport.respond = () => {};
  const result = adapter.getState(nativeId, context()); const checked = expect(result).rejects.toMatchObject({ code: 'CANCELED' });
  await adapter.disconnect(context()); await checked; await adapter.disconnect(context()); expect(transport.messages.size).toBe(0); expect(transport.errors.size).toBe(0);
 });
 it('rejects malformed direct RGB calls with typed errors', async () => {
  const { adapter } = await ready();
  await expect(adapter.setColor(nativeId, null as any, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  await expect(adapter.setColor(nativeId, { mode: 'rgb', value: null } as any, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
 });
 it('prevents same-device concurrent status correlation ambiguity', async () => {
  const { adapter, transport } = await ready(); transport.respond = () => {};
  const first = adapter.getState(nativeId, context()); const checked = expect(first).rejects.toMatchObject({ code: 'CANCELED' });
  await expect(adapter.getState(nativeId, context())).rejects.toMatchObject({ code: 'RATE_LIMITED', delivery: 'not_sent' });
  await adapter.disconnect(context()); await checked;
 });
 it('closes a timed-out or canceled pending open without reporting connected', async () => {
  const { adapter, transport } = setup(); const events: unknown[] = []; adapter.onEvent(event => events.push(event));
  let opened!: () => void; transport.open = vi.fn(() => new Promise<void>(resolve => { opened = resolve; }));
  await expect(adapter.connect(context())).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(transport.close).toHaveBeenCalledOnce(); opened(); await Promise.resolve();
  expect(events).not.toContainEqual({ type: 'connection', connected: true });
  const abort = new AbortController(); const connecting = adapter.connect(context(abort.signal)); abort.abort();
  await expect(connecting).rejects.toMatchObject({ code: 'CANCELED' }); expect(transport.close).toHaveBeenCalledTimes(2); opened();
 });
 it('bounds hung shutdown and removes error subscriptions', async () => {
  const { adapter, transport } = await ready(); transport.close = vi.fn(() => new Promise<void>(() => {}));
  await expect(adapter.disconnect(context())).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(transport.errors.size).toBe(0);
  transport.close = vi.fn(async () => {});
 });

});

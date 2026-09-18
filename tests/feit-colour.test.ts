import { describe, expect, it } from 'vitest';
import { FeitAdapter } from '../src/adapters/feit/index.js';
import type { CallContext } from '../src/adapters/types.js';
import type { FeitTransport } from '../src/adapters/feit/transport.js';
import { decodeFrame, decryptControl, encodeFrame, encodeQuery } from '../src/adapters/feit/protocol.js';

const key = '0123456789abcdef';
const context = (): CallContext => ({ operationId: 'colour', correlationId: null, signal: new AbortController().signal, deadlineAt: Date.now() + 5000 });
class ColourTransport implements FeitTransport {
 dps: Record<string, unknown>;
 controls: Record<string, unknown>[] = [];
 queries = 0;
 constructor(colour: unknown) { this.dps = { '20': true, '21': 'white', '22': 505, '24': colour }; }
 async close() {}
 async request(_ip: string, packet: Uint8Array, _context: unknown, preceding?: Uint8Array): Promise<Buffer> {
  this.queries++;
  if (preceding) {
   const body = decryptControl(decodeFrame(preceding).payload, key) as { dps: Record<string, unknown> };
   this.controls.push(body.dps); Object.assign(this.dps, structuredClone(body.dps));
  }
  const frame = decodeFrame(packet);
  return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: this.dps }));
 }
}
async function setup(colour: unknown) {
 const transport = new ColourTransport(colour);
 const adapter = new FeitAdapter({ transport, devices: [{ id: 'bulb', name: 'Desk', ip: '192.0.2.10', localKey: key, version: '3.3' }], commandTimeoutMs: 100 });
 await adapter.connect(context()); return { transport, adapter };
}
describe('Feit runtime colour encoding', () => {
 it.each([
  ['000003e803e8', '007803e803e8'],
  [{ h: 0, s: 1000, v: 1000 }, { h: 120, s: 1000, v: 1000 }],
 ])('learns encoding from a query before first write, including white mode: %j', async (initial, expected) => {
  const { adapter, transport } = await setup(initial);
  const receipt = await adapter.setColor('bulb', { mode: 'rgb', value: { r: 0, g: 255, b: 0 } }, context());
  expect(transport.queries).toBe(2);
  expect(transport.controls).toEqual([{ '21': 'colour', '24': expected }]);
  expect(receipt).toMatchObject({ acknowledgment: 'applied', observation: { state: { rgb: { r: 0, g: 255, b: 0 } } } });
 });
 it.each(['invalid', { h: 0, s: 'invalid', v: 1000 }])('preserves white observations with malformed inactive colour: %j', async colour => {
  const { adapter, transport } = await setup(colour);
  expect(await adapter.getState('bulb', context())).toMatchObject({ state: { power: true, brightness: 50 }, complete: true });
  await expect(adapter.setColor('bulb', { mode: 'rgb', value: { r: 255, g: 0, b: 0 } }, context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
  expect(transport.controls).toEqual([]);
  transport.dps['21'] = 'colour';
  await expect(adapter.getState('bulb', context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
 });
 it('refreshes runtime encoding when subsequent queries change its shape', async () => {
  const { adapter, transport } = await setup('000003e803e8');
  await adapter.getState('bulb', context());
  transport.dps['24'] = { h: 0, s: 1000, v: 1000 };
  await adapter.getState('bulb', context());
  await adapter.setColor('bulb', { mode: 'rgb', value: { r: 0, g: 0, b: 255 } }, context());
  expect(transport.controls[0]!['24']).toEqual({ h: 240, s: 1000, v: 1000 });
 });
 it.each([undefined, 'invalid', { h: 0, s: '1000', v: 1000 }, { h: 361, s: 1000, v: 1000 }])('does not guess encoding for missing or invalid colour: %j', async colour => {
  const { adapter, transport } = await setup(colour);
  await expect(adapter.setColor('bulb', { mode: 'rgb', value: { r: 255, g: 0, b: 0 } }, context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
  expect(transport.controls).toEqual([]);
 });
});

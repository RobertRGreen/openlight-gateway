import { describe, expect, it, vi } from 'vitest';
import type { CallContext } from '../src/adapters/types.js';
import { FeitAdapter, compileFeitScene } from '../src/adapters/feit/index.js';
import type { FeitDeviceConfig, FeitSceneConfig } from '../src/adapters/feit/index.js';
import type { FeitTransport } from '../src/adapters/feit/transport.js';
import { decodeFrame, decodeQuery, decryptControl, encodeFrame, encodeQuery } from '../src/adapters/feit/protocol.js';

const key = '0123456789abcdef';
const device: FeitDeviceConfig = { id: 'bulb', name: 'Desk', ip: '192.0.2.10', localKey: key, version: '3.3' };
const context = (): CallContext => ({ operationId: 'test', correlationId: null, signal: new AbortController().signal, deadlineAt: Date.now() + 5000 });
class FakeTransport implements FeitTransport {
 dps: Record<string, unknown> = { '20': true, '21': 'colour', '22': 505, '24': '000003e803e8', '25': '000e0d0000000000000000c80000' };
 writes: Record<string, unknown>[] = [];
 close = vi.fn(async () => {});
 async request(_ip: string, packet: Uint8Array, _ctx: unknown, preceding?: Uint8Array): Promise<Buffer> {
  const frame = decodeFrame(packet);
  if (preceding) { const control = decryptControl(decodeFrame(preceding).payload, key) as Record<string, unknown>; this.writes.push(control.dps as Record<string, unknown>); Object.assign(this.dps, control.dps); }
  expect(decodeQuery(frame.payload)).toMatchObject({ devId: 'bulb' });
  return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: this.dps }));
 }
}
const scenes: Record<string, FeitSceneConfig> = { aurora: { colors: ['#ff0000', '#0000ff'], speed: 20 } };
async function setup(withScenes = scenes) {
 const transport = new FakeTransport(); const adapter = new FeitAdapter({ devices: [device], transport, commandTimeoutMs: 50, scenes: withScenes });
 for await (const _ of adapter.discover(context())) { /* connect */ }
 return { adapter, transport };
}

describe('Feit native scenes (DP 25 hex)', () => {
 it('compiles to the exact payload that made a real bulb fade red to blue', () => {
  // Hardware-verified 2026-10-06 on Bedroom Fan 4: red -> pink -> purple -> blue loop.
  expect(compileFeitScene('aurora', scenes.aurora!)).toBe('01141402000003e803e80000000014140200f003e803e800000000');
 });
 it('encodes mode and speed, and rejects invalid scenes', () => {
  expect(compileFeitScene('x', { colors: ['00ff00'], mode: 'jump', speed: 100 })).toBe('01646401007803e803e800000000');
  for (const bad of [{ colors: [] }, { colors: Array(9).fill('#ffffff') }, { colors: ['red'] }, { colors: ['#fff'] }, { colors: ['#ffffff'], speed: 0 }, { colors: ['#ffffff'], speed: 101 }, { colors: ['#ffffff'], mode: 'fade' }] as unknown as FeitSceneConfig[]) expect(() => compileFeitScene('x', bad)).toThrowError(expect.objectContaining({ code: 'OUT_OF_RANGE' }));
  expect(() => compileFeitScene('', { colors: ['#ffffff'] })).toThrowError(expect.objectContaining({ code: 'OUT_OF_RANGE' }));
 });
 it('advertises effects only when scenes are configured', async () => {
  const { adapter } = await setup();
  expect(await adapter.getCapabilities('bulb', context())).toContainEqual({ type: 'effects', effectIds: ['aurora'] });
  const bare = await setup({});
  expect(bare.adapter.effects).toBeUndefined();
  expect((await bare.adapter.getCapabilities('bulb', context())).map(c => c.type)).not.toContain('effects');
 });
 it('start writes scene mode and data together and reports the running effect; stop restores the previous mode', async () => {
  const { adapter, transport } = await setup();
  await adapter.getState('bulb', context()); // learn colour mode
  expect((await adapter.getState('bulb', context())).state.effect).toBeNull();
  const started = await adapter.effects!.start('bulb', 'aurora', context());
  expect(transport.writes.at(-1)).toEqual({ '21': 'scene', '25': compileFeitScene('aurora', scenes.aurora!) });
  expect(started.observation!.state.effect).toBe('aurora');
  const stopped = await adapter.effects!.stop('bulb', context());
  expect(transport.writes.at(-1)).toEqual({ '21': 'colour' });
  expect(stopped.observation!.state.effect).toBeNull();
 });
 it('rejects an unknown scene id without writing', async () => {
  const { adapter, transport } = await setup();
  await expect(adapter.effects!.start('bulb', 'nope', context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  expect(transport.writes).toHaveLength(0);
 });
});

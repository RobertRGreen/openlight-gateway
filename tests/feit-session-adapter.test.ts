import { describe, expect, it } from 'vitest';
import { FeitAdapter } from '../src/adapters/feit/index.js';
import type { CallContext } from '../src/adapters/types.js';
import type { FeitTransport } from '../src/adapters/feit/transport.js';
import { DP_QUERY_NEW, encodeQuery } from '../src/adapters/feit/protocol.js';

const context = (): CallContext => ({ operationId: 'session', correlationId: null, signal: new AbortController().signal, deadlineAt: Date.now() + 5000 });
type SessionRequest = Parameters<NonNullable<FeitTransport['requestSession']>>[1];
class SessionTransport implements FeitTransport {
 requests: SessionRequest[] = [];
 apply = true;
 sequenceMismatch = false;
 command = DP_QUERY_NEW;
 dps: Record<string, unknown> = { '20': true, '21': 'colour', '22': 505, '24': { h: 0, s: 1000, v: 1000 } };
 async close() {}
 async request(): Promise<Buffer> { throw new Error('Unexpected legacy request'); }
 async requestSession(_ip: string, request: SessionRequest) {
  this.requests.push(request);
  if (request.preceding && this.apply) Object.assign(this.dps, (request.preceding.payload as {data: {dps: Record<string, unknown>}}).data.dps);
  return { sequence: (request.sequence + 2 + (request.preceding ? 1 : 0) + (this.sequenceMismatch ? 71 : 0)) >>> 0, command: this.command, payload: encodeQuery({ dps: this.dps }) };
 }
}
async function setup(version: '3.4' | '3.5') {
 const transport = new SessionTransport();
 const adapter = new FeitAdapter({ devices: [{ id: 'bulb', name: 'Desk', ip: '192.0.2.10', localKey: '0123456789abcdef', version }], transport, commandTimeoutMs: 80 });
 await adapter.connect(context()); return { adapter, transport };
}
describe('Feit session adapter integration', () => {
 it.each(['3.4', '3.5'] as const)('sends control then verifies actual DPS for %s', async version => {
  const { adapter, transport } = await setup(version);
  expect(await adapter.setPower('bulb', false, context())).toMatchObject({ acknowledgment: 'applied', observation: { state: { power: false } } });
  expect(transport.requests).toHaveLength(1);
  expect(transport.requests[0]!.version).toBe(version);
  expect(transport.requests[0]!.queryPayload).toEqual({});
  const payload = transport.requests[0]!.preceding!.payload as { protocol: number; t: number; data: unknown };
  expect(payload).toEqual({ protocol: 5, t: expect.any(Number), data: { dps: { '20': false } } });
  expect(Number.isInteger(payload.t)).toBe(true);
  expect(Math.abs(payload.t - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
 });
 it.each(['3.4', '3.5'] as const)('does not accept unchanged state as write success for %s or replay control', async version => {
  const { adapter, transport } = await setup(version); transport.apply = false;
  await expect(adapter.setPower('bulb', false, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(transport.requests).toHaveLength(2);
  expect(transport.requests.filter(request => request.preceding)).toHaveLength(1);
 });
 it.each(['3.4', '3.5'] as const)('writes and verifies JSON HSV by channel values for %s', async version => {
  const { adapter, transport } = await setup(version);
  expect(await adapter.setColor('bulb', { mode: 'rgb', value: { r: 0, g: 255, b: 0 } }, context())).toMatchObject({ acknowledgment: 'applied', observation: { state: { rgb: { r: 0, g: 255, b: 0 } } } });
  expect(transport.requests).toHaveLength(2);
  expect(transport.requests[1]!.preceding).toMatchObject({ payload: { protocol: 5, data: { dps: { '21': 'colour', '24': { h: 120, s: 1000, v: 1000 } } } } });
 });
 it('rejects raw HSV mismatch even when both values normalize to the same RGB', async () => {
  const { adapter, transport } = await setup('3.5'); transport.apply = false;
  transport.dps['24'] = { h: 0, s: 999, v: 1000 };
  await expect(adapter.setColor('bulb', { mode: 'rgb', value: { r: 255, g: 0, b: 0 } }, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(transport.requests.filter(request => request.preceding)).toHaveLength(1);
  expect(transport.requests).toHaveLength(3);
 });
 it('accepts nonmatching v3.5 sequence but rejects an unrelated command', async () => {
  const { adapter, transport } = await setup('3.5'); transport.sequenceMismatch = true;
  expect(await adapter.getState('bulb', context())).toMatchObject({ state: { power: true } });
  transport.command = 7;
  await expect(adapter.getState('bulb', context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
 });
 it('preserves v3.4 sequence matching', async () => {
  const { adapter, transport } = await setup('3.4'); transport.sequenceMismatch = true;
  await expect(adapter.getState('bulb', context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
 });
});

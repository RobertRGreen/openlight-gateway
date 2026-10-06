import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { createGateway, type Gateway } from '../src/service/index.js';
import { createApp } from '../src/api/rest/index.js';
import type { CallContext } from '../src/adapters/types.js';
import type { FeitTransport } from '../src/adapters/feit/transport.js';
import { compileFeitScene } from '../src/adapters/feit/index.js';
import { decodeFrame, decryptControl, encodeFrame, encodeQuery } from '../src/adapters/feit/protocol.js';
import type { Device } from '../src/core/model.js';
import type { Operation } from '../src/core/operations/types.js';
import type { Preset } from '../src/core/presets/index.js';

const localKey = '0123456789abcdef';
class Transport implements FeitTransport {
  controls: Record<string, unknown>[] = [];
  dps: Record<string, unknown> = { '20': true, '21': 'colour', '22': 505, '24': '000003e803e8', '25': '000e0d0000000000000000c80000' };
  async request(_ip: string, packet: Uint8Array, _context: Pick<CallContext, 'signal' | 'deadlineAt'>, preceding?: Uint8Array): Promise<Buffer> {
    const frame = decodeFrame(packet);
    if (preceding) { const body = decryptControl(decodeFrame(preceding).payload, localKey) as { dps: Record<string, unknown> }; this.controls.push(body.dps); Object.assign(this.dps, body.dps); }
    return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps: this.dps }));
  }
  async close() {}
}
let gateway: Gateway, app: FastifyInstance, token: string, transport: Transport;
const prefix = '/api/v1';
async function request(method: InjectOptions['method'], path: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url: prefix + path, headers: { host: 'localhost', authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
}
const bulb = async () => (await request('GET', '/devices')).json<{ items: Device[] }>().items.find(d => d.adapter === 'feit')!;
const effectIds = (device: Device) => (device.capabilities.find(c => c.type === 'effects') as { effectIds: string[] } | undefined)?.effectIds;
async function finish(response: Awaited<ReturnType<typeof request>>): Promise<Operation> {
  expect(response.statusCode).toBe(202); let operation = response.json<Operation>();
  await expect.poll(async () => { operation = (await request('GET', `/operations/${operation.id}`)).json<Operation>(); return operation.status; }, { timeout: 4000, interval: 10 }).not.toMatch(/^(queued|running)$/);
  return operation;
}
beforeEach(async () => {
  transport = new Transport();
  gateway = await createGateway({ feitTransport: transport, config: loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent', MOCK_LATENCY_MS: '0', MDNS_ENABLED: 'false', FEIT_ADAPTER_ENABLED: 'true', FEIT_DEVICES: JSON.stringify([{ id: 'fixture-bulb', name: 'Fixture bulb', ip: '192.0.2.20', localKey, version: '3.3' }]) }) });
  token = gateway.tokens.create().token; app = await createApp(gateway); await app.ready();
  await expect.poll(async () => await bulb(), { timeout: 4000 }).toBeDefined(); // Feit startup continues in the background after createGateway returns
});
afterEach(async () => { await app?.close(); await gateway?.stop(); });

describe('presets drive Feit native effects end to end', () => {
  it('advertises, plays, stops, and un-advertises a preset live without a restart', async () => {
    expect(effectIds(await bulb())).toBeUndefined();

    const preset = (await request('POST', '/presets', { name: 'Cyber', colors: ['#00fff2', '#ff2079'], speed: 30 })).json<Preset>();
    await expect.poll(async () => effectIds(await bulb())).toEqual([preset.id]);

    const started = await finish(await request('POST', `/devices/${(await bulb()).id}/commands`, { state: { effect: preset.id } }));
    expect(started.status).toBe('succeeded'); expect(started.results[0]).toMatchObject({ confirmation: 'observed', fieldResults: [{ path: '/effect', status: 'applied' }] });
    expect(transport.controls.at(-1)).toEqual({ '21': 'scene', '25': compileFeitScene(preset.id, preset) });
    expect((await bulb()).state.effect).toBe(preset.id);

    const stopped = await finish(await request('POST', `/devices/${(await bulb()).id}/commands`, { state: { effect: null } }));
    expect(stopped.status).toBe('succeeded'); expect(transport.controls.at(-1)).toEqual({ '21': 'colour' });
    expect((await bulb()).state.effect).toBeNull();

    const etag = String((await request('GET', `/presets/${preset.id}`)).headers.etag);
    expect((await request('DELETE', `/presets/${preset.id}`, undefined, { 'if-match': etag })).statusCode).toBe(204);
    await expect.poll(async () => effectIds(await bulb())).toBeUndefined();
    // Capability mismatches are rejected at admission (no operation is created).
    const refused = await request('POST', `/devices/${(await bulb()).id}/commands`, { state: { effect: preset.id } });
    expect(refused.statusCode).toBe(422); expect(refused.json().error.code).toBe('capability_mismatch');
  });
  it('deleting the last preset while playing: effect:null is refused, a color command still ends the scene', async () => {
    const preset = (await request('POST', '/presets', { name: 'p', colors: ['#ff0000', '#0000ff'] })).json<Preset>();
    await expect.poll(async () => effectIds(await bulb())).toEqual([preset.id]);
    const id = (await bulb()).id;
    expect((await request('POST', `/devices/${id}/commands`, { state: { effect: preset.id, rgb: { r: 1, g: 2, b: 3 } } })).statusCode).toBe(422); // mutually exclusive
    await finish(await request('POST', `/devices/${id}/commands`, { state: { power: true, effect: preset.id } }));
    const etag = String((await request('GET', `/presets/${preset.id}`)).headers.etag);
    expect((await request('DELETE', `/presets/${preset.id}`, undefined, { 'if-match': etag })).statusCode).toBe(204);
    await expect.poll(async () => effectIds(await bulb())).toBeUndefined();
    expect((await bulb()).state.effect).toBe(preset.id); // not re-read yet: documented
    const stop = await request('POST', `/devices/${id}/commands`, { state: { effect: null } });
    expect(stop.statusCode).toBe(422); expect(stop.json().error.code).toBe('capability_mismatch');
    await finish(await request('POST', `/devices/${id}/commands`, { state: { rgb: { r: 255, g: 0, b: 0 } } }));
    expect(transport.controls.at(-1)).toMatchObject({ '21': 'colour' });
    expect((await bulb()).state.effect).toBeNull();
  });
  it('an edited preset plays its new definition', async () => {
    const preset = (await request('POST', '/presets', { name: 'a', colors: ['#ff0000', '#0000ff'], speed: 20 })).json<Preset>();
    await expect.poll(async () => effectIds(await bulb())).toEqual([preset.id]);
    const etag = String((await request('GET', `/presets/${preset.id}`)).headers.etag);
    const edited = (await request('PATCH', `/presets/${preset.id}`, { speed: 80, mode: 'jump' }, { 'if-match': etag })).json<Preset>();
    await finish(await request('POST', `/devices/${(await bulb()).id}/commands`, { state: { effect: preset.id } }));
    expect(transport.controls.at(-1)).toEqual({ '21': 'scene', '25': compileFeitScene(preset.id, edited) });
    expect(transport.controls.at(-1)!['25']).not.toBe(compileFeitScene(preset.id, preset));
  });
  it('presets created before startup are advertised on the first discovery', async () => {
    const dir = mkdtempSync(`${tmpdir()}/openlight-pre-`);
    const path = `${dir}/g.sqlite`; const env = { DATABASE_PATH: path, LOG_LEVEL: 'silent', MOCK_LATENCY_MS: '0', MDNS_ENABLED: 'false', FEIT_ADAPTER_ENABLED: 'true', FEIT_DEVICES: JSON.stringify([{ id: 'fixture-bulb', name: 'Fixture bulb', ip: '192.0.2.20', localKey, version: '3.3' }]) };
    const first = await createGateway({ feitTransport: new Transport(), config: loadConfig(env) });
    const saved = first.presets.create({ name: 'persisted', colors: ['#ffffff'] }); await first.stop();
    const second = await createGateway({ feitTransport: new Transport(), config: loadConfig(env) });
    try {
      await expect.poll(() => second.registry.list().find(d => d.adapter === 'feit'), { timeout: 4000 }).toBeDefined();
      expect(effectIds(second.registry.list().find(d => d.adapter === 'feit')!)).toEqual([saved.id]);
    }
    finally { await second.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

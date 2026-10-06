import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HubspaceAdapter } from '../src/adapters/hubspace/index.js';
import type { CallContext } from '../src/adapters/types.js';

process.env.HUBSPACE_SETTLE_MS = '0';
const context = (): CallContext => ({ operationId: 'op', correlationId: null, signal: new AbortController().signal, deadlineAt: Date.now() + 5000 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fn = (functionClass: string, range: object = {}) => ({ functionClass, values: [{ name: functionClass, range }] });
const light = { id: 'dev-1', typeId: 'metadevice.device', friendlyName: 'Chandelier 1', description: { device: { deviceClass: 'light', manufacturerName: 'Ecosmart', model: 'X' }, functions: [fn('power'), fn('brightness', { min: 1, max: 100, step: 1 }), fn('color-rgb'), fn('color-temperature', { min: 2200, max: 6500, step: 100 })] } };
const metadevices = [{ id: 'room', typeId: 'metadevice.room' }, { id: 'plug', typeId: 'metadevice.device', description: { device: { deviceClass: 'switch' } } }, light];
const stateValues = [{ functionClass: 'power', value: 'on' }, { functionClass: 'brightness', value: 56 }, { functionClass: 'color-temperature', value: 2700 }, { functionClass: 'color-rgb', value: { 'color-rgb': { r: 0, g: 255, b: 255 } } }, { functionClass: 'available', value: true }];

function setup(refresh: Record<string, unknown> = { id_token: 'id-tok', expires_in: 3600 }) {
  const dir = mkdtempSync(join(tmpdir(), 'hubspace-'));
  const tokenFile = join(dir, 'token.json'); writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'refresh-1' }));
  const puts: unknown[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('openid-connect/token')) return json(refresh);
    if (u.endsWith('/v1/users/me')) return json({ accountAccess: [{ account: { accountId: 'acct-1' } }] });
    if (u.endsWith('/metadevices')) return json(metadevices);
    if (init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return json({}); }
    if (u.endsWith('/metadevices/dev-1/state')) return json({ values: stateValues });
    return json({}, 404);
  });
  return { adapter: new HubspaceAdapter({ tokenFile, fetch: fetch as unknown as typeof globalThis.fetch }), fetch, puts, tokenFile };
}
const sent = (puts: unknown[]) => (puts[0] as { values: { functionClass: string; value: unknown }[] }).values.map(v => [v.functionClass, v.value]);

describe('Hubspace adapter using mocked fetch', () => {
  it('discovers only lights and derives capabilities and ranges from the description', async () => {
    const { adapter } = setup();
    const devices = await adapter.getDevices(context());
    expect(devices.map(d => [d.nativeId, d.name, d.manufacturer, d.address?.transport])).toEqual([['dev-1', 'Chandelier 1', 'Ecosmart', 'cloud']]);
    expect(await adapter.getCapabilities('dev-1', context())).toEqual([{ type: 'power' }, { type: 'brightness', minimum: 0, maximum: 100, step: 1 }, { type: 'rgb' }, { type: 'colorTemperature', minimum: 2200, maximum: 6500, step: 100 }]);
  });
  it('parses state including the nested color-rgb shape', async () => {
    const { adapter } = setup();
    const observation = await adapter.getState('dev-1', context());
    expect(observation.state).toEqual({ power: true, brightness: 56, colorTemperature: 2700, rgb: { r: 0, g: 255, b: 255 } });
    expect(observation.complete).toBe(true);
  });
  it('setColor switches color-mode together with the rgb value', async () => {
    const { adapter, puts } = setup();
    expect(await adapter.setColor('dev-1', { mode: 'rgb', value: { r: 255, g: 0, b: 0 } }, context())).toMatchObject({ transport: 'cloud', acknowledgment: 'accepted' });
    expect(sent(puts)).toEqual([['color-mode', 'color'], ['color-rgb', { 'color-rgb': { r: 255, g: 0, b: 0 } }]]);
  });
  it('setTemperature switches to white mode and rejects values off the device step', async () => {
    const { adapter, puts } = setup();
    await adapter.setTemperature('dev-1', 2700, context());
    expect(sent(puts)).toEqual([['color-mode', 'white'], ['color-temperature', 2700]]);
    await expect(adapter.setTemperature('dev-1', 2750, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
    await expect(adapter.setTemperature('dev-1', 7000, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  });
  it('power and brightness map to their function classes; brightness 0 powers off', async () => {
    const { adapter, puts } = setup();
    await adapter.setPower('dev-1', false, context()); await adapter.setBrightness('dev-1', 40, context()); await adapter.setBrightness('dev-1', 0, context());
    expect(puts.map(p => (p as { values: { functionClass: string; value: unknown }[] }).values.map(v => [v.functionClass, v.value]))).toEqual([[['power', 'off']], [['brightness', 40]], [['power', 'off']]]);
    await expect(adapter.setBrightness('dev-1', 101, context())).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  });
  it('persists a rotated refresh token and reuses the id token', async () => {
    const { adapter, fetch, tokenFile } = setup({ id_token: 'id-tok', expires_in: 3600, refresh_token: 'refresh-2' });
    await adapter.getState('dev-1', context()); await adapter.getState('dev-1', context());
    expect(JSON.parse(readFileSync(tokenFile, 'utf8'))).toEqual({ refresh_token: 'refresh-2' });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('openid-connect/token'))).toHaveLength(1);
  });
  it('reports AUTH_FAILED for a rejected refresh and for a missing token file', async () => {
    await expect(setup({ error: 'invalid_grant' }).adapter.getState('dev-1', context())).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    const { adapter } = setup(); const missing = new HubspaceAdapter({ tokenFile: '/nonexistent/token.json' });
    await expect(missing.connect(context())).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(adapter.id).toBe('hubspace');
  });
  it('accepts the runtime\'s fractional deadlines (AbortSignal.timeout needs an integer)', async () => {
    const { adapter } = setup();
    await expect(adapter.getState('dev-1', { ...context(), deadlineAt: Date.now() + 4999.947998046875 })).resolves.toMatchObject({ complete: true });
  });
  it('maps an unavailable device to OFFLINE', async () => {
    const { adapter } = setup(); stateValues[stateValues.length - 1] = { functionClass: 'available', value: false };
    try { await expect(adapter.getState('dev-1', context())).rejects.toMatchObject({ code: 'OFFLINE' }); } finally { stateValues[stateValues.length - 1] = { functionClass: 'available', value: true }; }
  });
});

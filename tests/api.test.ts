import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createGateway, type Gateway } from '../src/service/index.js';
import { createApp } from '../src/api/rest/index.js';
import { loadConfig } from '../src/config/index.js';
import type { Device } from '../src/core/model.js';
import type { Operation } from '../src/core/operations/types.js';

let gateway: Gateway;
let app: FastifyInstance;
let directory: string;
let token: string;
let devices: Device[];
const sockets: { terminate(): void }[] = [];
const prefix = '/api/v1';

async function request(method: InjectOptions['method'], path: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url: prefix + path, headers: {
    host: 'localhost', authorization: `Bearer ${token}`,
    ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}), ...headers,
  }, ...(payload === undefined ? {} : { payload }) });
}
function device(model: string) { return devices.find(value => value.model === model)!; }
function errorEnvelope(response: Awaited<ReturnType<typeof request>>, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({ error: {
    code, message: expect.any(String), requestId: expect.any(String), details: expect.any(Array),
  } });
}
async function terminal(response: Awaited<ReturnType<typeof request>>): Promise<Operation> {
  expect(response.statusCode).toBe(202);
  const initial = response.json<Operation>();
  expect(response.headers.location).toBe(`${prefix}/operations/${initial.id}`);
  let result = initial;
  await expect.poll(async () => {
    const poll = await request('GET', `/operations/${initial.id}`);
    expect(poll.statusCode).toBe(200);
    result = poll.json<Operation>();
    return result.status;
  }, { timeout: 4000, interval: 10 }).not.toMatch(/^(queued|running)$/);
  return result;
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openlight-api-'));
  gateway = await createGateway({ config: loadConfig({
    DATABASE_PATH: join(directory, 'gateway.sqlite'), MOCK_LATENCY_MS: '0', LOG_LEVEL: 'silent',
    MDNS_ENABLED: 'false', CORS_ORIGINS: 'http://localhost:8080',
  }) });
  token = gateway.tokens.create().token;
  app = await createApp(gateway);
  await app.ready();
  const response = await request('GET', '/devices');
  expect(response.statusCode).toBe(200);
  devices = response.json<{ items: Device[] }>().items;
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  await gateway?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('mock-backed HTTP contract', () => {
  it('reports readiness, lists capabilities, and discovers without duplicating device identities', async () => {
    expect((await request('GET', '/health')).json()).toMatchObject({ status: 'ready', gatewayId: gateway.store.gatewayId });
    expect(devices).toHaveLength(5);
    expect(device('rgb')).toMatchObject({ manufacturer: 'OpenLight', availability: 'online', stateStale: false });
    expect(device('rgb').capabilities).toContainEqual({ type: 'rgb' });
    expect(device('white').capabilities).not.toContainEqual({ type: 'rgb' });
    expect(device('offline')).toMatchObject({ availability: 'offline', stateStale: true });
    const operation = await terminal(await request('POST', '/discovery/start', { adapterIds: ['mock'] }));
    expect(operation).toMatchObject({ kind: 'discovery', status: 'succeeded', targetDeviceIds: [], adapterResults: [{ adapterId: 'mock', status: 'succeeded' }] });
    expect(operation.discoveredDeviceIds?.sort()).toEqual(devices.map(value => value.id).sort());
    expect((await request('GET', '/devices')).json().items).toHaveLength(5);
  });

  it('executes power, brightness, and RGB commands and exposes observed state', async () => {
    const id = device('rgb').id;
    const state = { power: true, brightness: 65, rgb: { r: 12, g: 34, b: 56 } };
    const operation = await terminal(await request('POST', `/devices/${id}/commands`, { state }));
    expect(operation).toMatchObject({ kind: 'device.command', status: 'succeeded', request: { state }, targetDeviceIds: [id], results: [{ deviceId: id, status: 'succeeded', confirmation: 'observed', transport: 'mock', fallback: null, warnings: [], state }] });
    expect(operation.results[0]?.fieldResults).toEqual([{ path: '/power', status: 'applied' }, { path: '/brightness', status: 'applied' }, { path: '/rgb', status: 'applied' }]);
    expect((await request('GET', `/devices/${id}/state`)).json()).toMatchObject({ state, stale: false, observedAt: expect.any(String), revision: expect.any(Number) });
  });

  it('rejects RGB on a white-only bulb with the documented capability error', async () => {
    const id = device('white').id;
    const response = await request('POST', `/devices/${id}/commands`, { state: { rgb: { r: 255, g: 0, b: 0 } } });
    errorEnvelope(response, 422, 'capability_mismatch');
    expect(response.json().error.details).toEqual([{ path: '/state/rgb', code: 'unsupported_capability', message: 'Required capability rgb is absent', deviceId: id, capability: 'rgb' }]);
  });

  it('rejects an offline singleton and retains all outcomes for a partial group', async () => {
    const onlineId = device('white').id, offlineId = device('offline').id;
    errorEnvelope(await request('POST', `/devices/${offlineId}/commands`, { state: { power: true } }), 409, 'device_offline');
    const group = await request('POST', '/groups', { name: 'Mixed availability', deviceIds: [onlineId, offlineId] });
    expect(group.statusCode).toBe(201);
    const operation = await terminal(await request('POST', `/groups/${group.json().id}/commands`, { state: { power: true } }));
    expect(operation).toMatchObject({ kind: 'group.command', status: 'partial', targetDeviceIds: [onlineId, offlineId], request: { state: { power: true } }, completedAt: expect.any(String) });
    expect(operation.results).toEqual([
      expect.objectContaining({ deviceId: onlineId, status: 'succeeded', confirmation: 'observed', transport: 'mock', fallback: null, fieldResults: [{ path: '/power', status: 'applied' }], warnings: [] }),
      { deviceId: offlineId, status: 'failed', confirmation: 'unconfirmed', warnings: [], transport: null, fallback: null, fieldResults: [], error: { code: 'device_offline', message: 'Device is offline', requestId: expect.any(String), details: [] } },
    ]);
  });

  it('returns documented envelopes for unknown IDs, malformed JSON, schema errors, and missing idempotency keys', async () => {
    errorEnvelope(await request('GET', `/devices/${randomUUID()}`), 404, 'not_found');
    const path = `/devices/${device('rgb').id}/commands`;
    const malformed = await request('POST', path, '{', { 'content-type': 'application/json' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: expect.any(String), message: expect.any(String), requestId: expect.any(String), details: [] } });
    errorEnvelope(await request('POST', path, { state: { brightness: 101 } }), 422, 'validation_error');
    errorEnvelope(await request('POST', path, { state: { power: true }, unexpected: true }), 422, 'validation_error');
    const missingKey = await app.inject({ method: 'POST', url: prefix + path, headers: { host: 'localhost', authorization: `Bearer ${token}` }, payload: { state: { power: true } } });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toHaveProperty('error.requestId');
  });

  it('enforces authentication, Origin and Host policy, revocation and rotation', async () => {
    const id = randomUUID();
    const routes: [InjectOptions['method'], string][] = [
      ['GET', '/health'], ['GET', '/devices'], ['GET', `/devices/${id}`],
      ['PATCH', `/devices/${id}`], ['GET', `/devices/${id}/state`], ['POST', `/devices/${id}/commands`],
      ...(['rooms', 'groups', 'scenes'] as const).flatMap(collection => [
        ['GET', `/${collection}`], ['POST', `/${collection}`], ['GET', `/${collection}/${id}`],
        ['PATCH', `/${collection}/${id}`], ['DELETE', `/${collection}/${id}`],
      ] as [InjectOptions['method'], string][]),
      ['GET', `/rooms/${id}/state`], ['GET', `/groups/${id}/state`], ['POST', `/groups/${id}/commands`],
      ['POST', `/scenes/${id}/activate`], ['GET', '/effects'], ['GET', `/effects/${id}`],
      ['POST', `/effects/${id}/start`], ['GET', '/effect-runs'], ['GET', `/effect-runs/${id}`],
      ['POST', `/effect-runs/${id}/stop`], ['POST', '/discovery/start'], ['GET', `/operations/${id}`],
    ];
    for (const [method, path] of routes) {
      const response = await app.inject({ method, url: prefix + path, headers: { host: 'localhost' } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toHaveProperty('error.details');
    }
    expect((await request('GET', '/devices', undefined, { origin: 'https://untrusted.example' })).statusCode).toBe(403);
    expect((await request('GET', '/devices', undefined, { host: 'untrusted.example' })).statusCode).toBe(403);
    const replacement = gateway.tokens.rotate(gateway.tokens.verify(token)!.id);
    expect((await request('GET', '/devices')).statusCode).toBe(401);
    token = replacement.token;
    expect((await request('GET', '/devices')).statusCode).toBe(200);
    gateway.tokens.revoke(replacement.record.id);
    expect((await request('GET', '/devices')).statusCode).toBe(401);
  });

  it('bounds request bodies, rejects unsupported media, and throttles expensive discovery', async () => {
    const path = `/devices/${device('rgb').id}/commands`;
    errorEnvelope(await request('POST', path, { state: { power: true }, padding: 'x'.repeat(70_000) }), 413, 'payload_too_large');
    errorEnvelope(await request('POST', path, '<power>true</power>', { 'content-type': 'application/xml' }), 415, 'unsupported_media_type');
    for (let index = 0; index < 10; index++) expect((await terminal(await request('POST', '/discovery/start', {}))).status).toBe('succeeded');
    const limited = await request('POST', '/discovery/start', {});
    errorEnvelope(limited, 429, 'rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('replays canonical idempotent responses and requires current metadata ETags', async () => {
    const key = randomUUID();
    const first = await request('POST', '/groups', { name: 'Desk', deviceIds: [device('rgb').id] }, { 'idempotency-key': key });
    expect(first.statusCode).toBe(201);
    const replay = await request('POST', '/groups', { deviceIds: [device('rgb').id], name: 'Desk' }, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers.location).toBe(first.headers.location);
    errorEnvelope(await request('POST', '/groups', { name: 'Other', deviceIds: [] }, { 'idempotency-key': key }), 409, 'idempotency_conflict');
    expect((await request('GET', '/groups')).json().items).toHaveLength(1);
    const path = `/devices/${device('rgb').id}`;
    const read = await request('GET', path);
    expect(read.headers.etag).toBeTypeOf('string');
    expect((await request('PATCH', path, { name: 'Renamed' })).statusCode).toBe(428);
    await terminal(await request('POST', `${path}/commands`, { state: { power: true } }));
    expect((await request('GET', path)).headers.etag).toBe(read.headers.etag);
    const changed = await request('PATCH', path, { name: 'Renamed' }, { 'if-match': String(read.headers.etag) });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(read.headers.etag);
    expect((await request('PATCH', path, { name: 'Stale edit' }, { 'if-match': String(read.headers.etag) })).statusCode).toBe(412);
  });

  it('serves room/group/scene CRUD, inverse membership, aggregates and scene activation', async () => {
    const roomResponse = await request('POST', '/rooms', { name: 'Office' });
    const groupResponse = await request('POST', '/groups', { name: 'Desk', deviceIds: [device('rgb').id] });
    expect(roomResponse.statusCode).toBe(201); expect(groupResponse.statusCode).toBe(201);
    const room = roomResponse.json(), group = groupResponse.json();
    const devicePath = `/devices/${device('rgb').id}`;
    const detail = await request('GET', devicePath);
    expect(detail.json().groups).toEqual([group.id]);
    expect((await request('PATCH', devicePath, { room: room.id }, { 'if-match': String(detail.headers.etag) })).statusCode).toBe(200);
    for (const [collection, resource] of [['rooms', room], ['groups', group]] as const) {
      expect((await request('GET', `/${collection}`)).json().items).toEqual([resource]);
      const read = await request('GET', `/${collection}/${resource.id}`);
      expect(read.json()).toEqual(resource);
      expect((await request('PATCH', `/${collection}/${resource.id}`, { name: 'Updated' }, { 'if-match': String(read.headers.etag) })).statusCode).toBe(200);
      expect((await request('GET', `/${collection}/${resource.id}/state`)).json()).toMatchObject({ deviceStates: [{ deviceId: device('rgb').id, availability: 'online' }], mixed: false });
    }
    const sceneResponse = await request('POST', '/scenes', { name: 'Reading', entries: [{ target: { type: 'group', id: group.id }, state: { brightness: 70 } }] });
    expect(sceneResponse.statusCode).toBe(201);
    const scene = sceneResponse.json();
    expect((await request('GET', '/scenes')).json().items).toEqual([scene]);
    expect((await terminal(await request('POST', `/scenes/${scene.id}/activate`, {}))).status).toBe('succeeded');
    const readScene = await request('GET', `/scenes/${scene.id}`);
    expect((await request('PATCH', `/scenes/${scene.id}`, { name: 'Reading updated' }, { 'if-match': String(readScene.headers.etag) })).statusCode).toBe(200);
    const readGroup = await request('GET', `/groups/${group.id}`);
    errorEnvelope(await request('DELETE', `/groups/${group.id}`, undefined, { 'if-match': String(readGroup.headers.etag) }), 409, 'resource_in_use');
    for (const [collection, resource] of [['scenes', scene], ['groups', group], ['rooms', room]] as const) {
      const read = await request('GET', `/${collection}/${resource.id}`);
      expect((await request('DELETE', `/${collection}/${resource.id}`, undefined, { 'if-match': String(read.headers.etag) })).statusCode).toBe(204);
      expect((await request('GET', `/${collection}/${resource.id}`)).statusCode).toBe(404);
    }
    expect((await request('GET', devicePath)).json()).toMatchObject({ room: null, groups: [] });
  });

  it('starts, inspects, and idempotently stops an effect run, protecting reserved devices', async () => {
    const catalog = await request('GET', '/effects');
    const effect = catalog.json().items.find((value: { name: string }) => value.name === 'static');
    expect((await request('GET', `/effects/${effect.id}`)).json()).toEqual(effect);
    const start = await terminal(await request('POST', `/effects/${effect.id}/start`, { target: { type: 'device', id: device('rgb').id }, parameters: { state: { power: true } } }));
    expect(start.status).toBe('succeeded');
    const runPath = `/effect-runs/${start.effectRunId}`;
    expect((await request('GET', runPath)).json()).toMatchObject({ status: 'running', deviceIds: [device('rgb').id] });
    expect((await request('GET', '/effect-runs')).json().items).toHaveLength(1);
    errorEnvelope(await request('POST', `/devices/${device('rgb').id}/commands`, { state: { power: false } }), 409, 'effect_conflict');
    expect((await terminal(await request('POST', `${runPath}/stop`, {}))).status).toBe('succeeded');
    expect((await terminal(await request('POST', `${runPath}/stop`, {}))).status).toBe('succeeded');
    expect((await request('GET', runPath)).json().status).toBe('stopped');
  });

  it('persists topology, identity, and idempotency responses across a composition restart', async () => {
    const key = randomUUID();
    const room = (await request('POST', '/rooms', { name: 'Persistent room' }, { 'idempotency-key': key })).json();
    const group = (await request('POST', '/groups', { name: 'Persistent group', deviceIds: [device('rgb').id] })).json();
    const gatewayId = gateway.store.gatewayId, bootId = gateway.bus.bootId, config = gateway.config;
    await app.close(); await gateway.stop();
    gateway = await createGateway({ config });
    app = await createApp(gateway); await app.ready();
    expect(gateway.store.gatewayId).toBe(gatewayId); expect(gateway.bus.bootId).not.toBe(bootId);
    expect((await request('GET', `/rooms/${room.id}`)).json()).toEqual(room);
    expect((await request('GET', `/groups/${group.id}`)).json()).toEqual(group);
    expect((await request('POST', '/rooms', { name: 'Persistent room' }, { 'idempotency-key': key })).json()).toEqual(room);
    expect((await request('GET', '/rooms')).json().items).toHaveLength(1);
  });
});

describe('WebSocket contract using in-memory upgrade streams', () => {
  it('authenticates native clients and sends the exact device event envelope after a command', async () => {
    const frames: Record<string, any>[] = [];
    const socket = await app.injectWS(`${prefix}/events`, { headers: { host: 'localhost', authorization: `Bearer ${token}` } }, {
      onInit(ws) { ws.on('message', data => frames.push(JSON.parse(data.toString()))); },
    });
    sockets.push(socket);
    await expect.poll(() => frames[0]).toEqual({ type: 'authenticated', gatewayId: gateway.store.gatewayId, bootId: gateway.bus.bootId });
    const operation = await terminal(await request('POST', `/devices/${device('rgb').id}/commands`, { state: { power: true } }));
    await expect.poll(() => frames.some(frame => frame.type === 'operation.completed' && frame.correlationId === operation.id)).toBe(true);
    const event = frames.find(frame => frame.type === 'device.state_changed' && frame.subject.id === device('rgb').id)!;
    expect(event).toEqual({ schemaVersion: '1.0', id: expect.any(String), sequence: expect.any(Number), gatewayId: gateway.store.gatewayId, bootId: gateway.bus.bootId, occurredAt: expect.any(String), type: 'device.state_changed', subject: { type: 'device', id: device('rgb').id }, correlationId: expect.anything(), data: { state: expect.objectContaining({ power: true }), observedAt: expect.any(String), stale: false, revision: expect.any(Number) } });
    const sequences = frames.slice(1).map(frame => frame.sequence);
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(true);
  });

  it('withholds events until browser first-frame authentication, then rejects application messages', async () => {
    const frames: Record<string, unknown>[] = [];
    const socket = await app.injectWS(`${prefix}/events`, { headers: { host: 'localhost', origin: 'http://localhost:8080' } }, {
      onInit(ws) { ws.on('message', data => frames.push(JSON.parse(data.toString()))); },
    });
    sockets.push(socket);
    await terminal(await request('POST', `/devices/${device('rgb').id}/commands`, { state: { power: true } }));
    expect(frames).toEqual([]);
    socket.send(JSON.stringify({ type: 'authenticate', token }));
    await expect.poll(() => frames[0]?.type).toBe('authenticated');
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
    socket.send(JSON.stringify({ type: 'unsupported' }));
    expect(await closed).toBe(1008);
  });

  it('rejects invalid browser credentials and oversized authentication frames', async () => {
    for (const [frame, expectedCode] of [[JSON.stringify({ type: 'authenticate', token: 'invalid' }), 1008], ['x'.repeat(5000), 1009]] as const) {
      const frames: string[] = [];
      const socket = await app.injectWS(`${prefix}/events`, { headers: { host: 'localhost', origin: 'http://localhost:8080' } }, {
        onInit(ws) { ws.on('message', data => frames.push(data.toString())); },
      });
      sockets.push(socket);
      const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
      socket.send(frame);
      expect(await closed).toBe(expectedCode);
      expect(frames).toEqual([]);
    }
  });

  it('disconnects authenticated sessions when their token is revoked', async () => {
    const socket = await app.injectWS(`${prefix}/events`, { headers: { host: 'localhost', authorization: `Bearer ${token}` } });
    sockets.push(socket);
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
    gateway.tokens.revoke(gateway.tokens.verify(token)!.id);
    expect(await closed).toBe(1008);
  });

  it('closes a browser connection that does not authenticate within five seconds', async () => {
    const frames: string[] = [];
    const socket = await app.injectWS(`${prefix}/events`, { headers: { host: 'localhost', origin: 'http://localhost:8080' } }, {
      onInit(ws) { ws.on('message', data => frames.push(data.toString())); },
    });
    sockets.push(socket);
    expect(await new Promise<number>(resolve => socket.once('close', code => resolve(code)))).toBe(1008);
    expect(frames).toEqual([]);
  }, 7000);

});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createGateway, type Gateway } from '../src/service/index.js';
import { createApp } from '../src/api/rest/index.js';
import { loadConfig } from '../src/config/index.js';
import type { Preset } from '../src/core/presets/index.js';

let gateway: Gateway, app: FastifyInstance, directory: string, token: string;
const prefix = '/api/v1';
async function request(method: InjectOptions['method'], path: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url: prefix + path, headers: { host: 'localhost', authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
}
const create = async (body: object = { name: 'Cyber', colors: ['#00fff2', '#ff2079'], speed: 30 }) => (await request('POST', '/presets', body)).json<Preset>();
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openlight-presets-'));
  gateway = await createGateway({ config: loadConfig({ DATABASE_PATH: join(directory, 'gateway.sqlite'), MOCK_LATENCY_MS: '0', LOG_LEVEL: 'silent', MDNS_ENABLED: 'false' }) });
  token = gateway.tokens.create().token; app = await createApp(gateway); await app.ready();
});
afterEach(async () => { await app?.close(); await gateway?.stop(); if (directory) rmSync(directory, { recursive: true, force: true }); });

describe('presets HTTP contract', () => {
 it('creates with 201, Location, ETag, defaults, and normalized colors; lists and reads it back', async () => {
  const response = await request('POST', '/presets', { name: 'Cyber', colors: ['#00FFF2', 'ff2079'] });
  expect(response.statusCode).toBe(201);
  const preset = response.json<Preset>();
  expect(preset).toMatchObject({ id: expect.any(String), name: 'Cyber', mode: 'gradient', speed: 50, colors: ['#00fff2', '#ff2079'] });
  expect(response.headers.location).toBe(`${prefix}/presets/${preset.id}`); expect(response.headers.etag).toBeTypeOf('string');
  expect((await request('GET', '/presets')).json()).toEqual({ items: [preset] });
  const read = await request('GET', `/presets/${preset.id}`);
  expect(read.json()).toEqual(preset); expect(read.headers.etag).toBe(response.headers.etag);
 });
 it('replays an idempotent create instead of making a second preset', async () => {
  const key = randomUUID(); const body = { name: 'Cyber', colors: ['#00fff2'] };
  const first = await request('POST', '/presets', body, { 'idempotency-key': key });
  const second = await request('POST', '/presets', body, { 'idempotency-key': key });
  expect(second.json()).toEqual(first.json());
  expect((await request('GET', '/presets')).json().items).toHaveLength(1);
 });
 it.each([
  [{ name: '', colors: ['#ffffff'] }], [{ name: 'a', colors: [] }], [{ name: 'a', colors: ['nope'] }], [{ name: 'a', colors: ['#ffffff'], speed: 0 }], [{ name: 'a', colors: ['#ffffff'], mode: 'fade' }],
 ])('rejects invalid body %j with 422', async body => {
  const response = await request('POST', '/presets', body);
  expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('validation_error');
  expect((await request('GET', '/presets')).json().items).toEqual([]);
 });
 it('rejects missing fields and unknown properties', async () => {
  for (const body of [{ colors: ['#ffffff'] }, { name: 'a' }, { name: 'a', colors: ['#ffffff'], extra: 1 }]) expect((await request('POST', '/presets', body)).statusCode).toBeGreaterThanOrEqual(400);
  expect((await request('GET', '/presets')).json().items).toEqual([]);
 });
 it('PATCH requires a current If-Match, updates only supplied fields, and changes the ETag', async () => {
  const preset = await create(); const path = `/presets/${preset.id}`; const etag = String((await request('GET', path)).headers.etag);
  expect((await request('PATCH', path, { name: 'Neon' })).statusCode).toBe(428);
  const updated = await request('PATCH', path, { name: 'Neon' }, { 'if-match': etag });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ name: 'Neon', colors: ['#00fff2', '#ff2079'], speed: 30, mode: 'gradient' });
  expect(updated.headers.etag).not.toBe(etag);
  expect((await request('PATCH', path, { name: 'Stale' }, { 'if-match': etag })).statusCode).toBe(412);
  const bad = await request('PATCH', path, { speed: 101 }, { 'if-match': String(updated.headers.etag) });
  expect(bad.statusCode).toBe(422);
  expect((await request('PATCH', path, {}, { 'if-match': String(updated.headers.etag) })).statusCode).toBeGreaterThanOrEqual(400);
  expect((await request('GET', path)).json()).toMatchObject({ name: 'Neon', speed: 30 });
 });
 it('DELETE requires If-Match, returns 204, and the preset is then 404', async () => {
  const preset = await create(); const path = `/presets/${preset.id}`;
  expect((await request('DELETE', path)).statusCode).toBe(428);
  expect((await request('DELETE', path, undefined, { 'if-match': '"stale"' })).statusCode).toBe(412);
  expect((await request('DELETE', path, undefined, { 'if-match': String((await request('GET', path)).headers.etag) })).statusCode).toBe(204);
  expect((await request('GET', path)).statusCode).toBe(404);
  expect((await request('GET', '/presets')).json().items).toEqual([]);
 });
 it('unknown ids are 404 and ids must be UUIDs', async () => {
  expect((await request('GET', `/presets/${randomUUID()}`)).statusCode).toBe(404);
  expect((await request('GET', '/presets/not-a-uuid')).statusCode).toBe(422);
 });
 it('requires authentication', async () => {
  const response = await app.inject({ method: 'GET', url: `${prefix}/presets`, headers: { host: 'localhost' } });
  expect(response.statusCode).toBe(401);
 });
});

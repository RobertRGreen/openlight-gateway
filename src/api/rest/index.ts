import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Gateway } from '../../service/index.js';
import { GatewayError } from '../../core/errors.js';
import type { DeviceState } from '../../core/model.js';
import type { SceneEntry } from '../../core/scenes/index.js';
import { canonicalJson, StorageError } from '../../persistence/index.js';
import { isOriginAllowed } from '../../security/index.js';
import { registerWebSocket } from '../websocket/index.js';
import * as schemas from './schemas.js';

interface SavedResponse { status: number; body: unknown; headers: Record<string, string> }
const prefix = '/api/v1';
const tag = (value: unknown) => `"${createHash('sha256').update(canonicalJson(value)).digest('hex')}"`;
const pointer = (parts: (string | number)[]) => parts.length ? '/' + parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/') : '';
function parse<T>(schema: z.ZodType<T>, body: unknown): T { return schema.parse(body); }
function id(request: FastifyRequest): string { return parse(z.object({ id: schemas.uuid }).strict(), request.params).id; }
function condition(request: FastifyRequest, value: unknown): void {
  const supplied = request.headers['if-match'];
  if (!supplied) throw new GatewayError(428, 'precondition_required', 'If-Match is required');
  if (supplied !== tag(value)) throw new GatewayError(412, 'precondition_failed', 'Resource has changed');
}
function references<T>(path: string, action: () => T): T {
  try { return action(); } catch (error) {
    if (error instanceof GatewayError && error.statusCode === 404) throw new GatewayError(422, 'validation_error', 'Unknown resource reference', [{ path, code: 'unknown_reference', message: 'Referenced resource does not exist' }]);
    throw error;
  }
}
function detail(reply: FastifyReply, value: unknown) { return reply.header('ETag', tag(value)).send(value); }

export async function createApp(gateway: Gateway) {
  const { config } = gateway;
  const tls = config.tlsMode === 'gateway' ? { key: await readFile(config.tlsKeyPath), cert: await readFile(config.tlsCertPath) } : undefined;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: config.trustedProxies.length ? config.trustedProxies : false, ...(tls ? { https: tls } : {}) });
  const principals = new WeakMap<FastifyRequest, string>();
  const active = new WeakSet<FastifyRequest>();
  let concurrent = 0;
  const buckets = new Map<string, { count: number; until: number }>();
  function budget(key: string, limit: number) {
    const now = Date.now();
    if (buckets.size >= 10_000) for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 10_000) throw new GatewayError(429, 'rate_limited', 'Request limit exceeded');
      bucket = { count: 0, until: now + 60_000 }; buckets.set(key, bucket);
    }
    if (++bucket.count > limit) throw new GatewayError(429, 'rate_limited', 'Request limit exceeded');
  }
  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal gateway failure';
    let details: { path: string; code: string; message: string; deviceId?: string; capability?: string }[] = [];
    if (error instanceof GatewayError) { status = error.statusCode; ({ code, message, details } = error.detail); }
    else if (error instanceof StorageError) { status = error.statusCode; code = error.code; message = error.message; }
    else if (error instanceof z.ZodError) {
      status = 422; code = 'validation_error'; message = 'Invalid request';
      details = error.issues.map(issue => ({ path: pointer(issue.path), code: issue.code === 'too_small' || issue.code === 'too_big' ? 'out_of_range' : issue.code, message: issue.code === 'unrecognized_keys' ? 'Unknown properties are not allowed' : issue.message }));
    } else if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      status = error.statusCode;
      const labels: Record<number, [string, string]> = { 400: ['invalid_request', 'Invalid request syntax'], 413: ['payload_too_large', 'Request body is too large'], 415: ['unsupported_media_type', 'Unsupported content type'] };
      [code, message] = labels[status] ?? ['invalid_request', 'Invalid request'];
    }
    if (status === 429) reply.header('Retry-After', '60');
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    if (status >= 500) gateway.logger.error({ requestId: request.id, errorCategory: code }, 'API request failed');
    reply.code(status).send({ error: { code, message, requestId: request.id, details } });
  });
  app.setNotFoundHandler(() => { throw new GatewayError(404, 'not_found', 'Route not found'); });
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    if (!hostname || !config.allowedHosts.includes(hostname.toLowerCase())) throw new GatewayError(403, 'forbidden', 'Host is not allowed');
    if (!isOriginAllowed(request.headers.origin, config.cors)) throw new GatewayError(403, 'forbidden', 'Origin is not allowed');
    if (request.headers.origin) reply.header('Access-Control-Allow-Origin', request.headers.origin).header('Vary', 'Origin').header('Access-Control-Expose-Headers', 'ETag, Location, Retry-After');
    budget(`ip:${request.ip}`, 300);
    const upgrading = request.routeOptions.url === `${prefix}/events` && request.headers.upgrade?.toLowerCase() === 'websocket';
    if (!upgrading && concurrent >= 128) throw new GatewayError(429, 'rate_limited', 'Too many concurrent requests');
    if (!upgrading) { concurrent++; active.add(request); }
    if (request.method === 'OPTIONS' && request.headers.origin && config.cors.enabled) {
      const headers = String(request.headers['access-control-request-headers'] ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (!config.cors.allowedMethods.includes(String(request.headers['access-control-request-method'])) || headers.some(header => !config.cors.allowedHeaders.some(allowed => allowed.toLowerCase() === header))) throw new GatewayError(403, 'forbidden', 'CORS request is not allowed');
      return reply.header('Access-Control-Allow-Methods', config.cors.allowedMethods.join(', ')).header('Access-Control-Allow-Headers', config.cors.allowedHeaders.join(', ')).code(204).send();
    }
    if (upgrading) return;
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
    const principal = match?.[1] ? gateway.tokens.verify(match[1]) : undefined;
    if (!principal) throw new GatewayError(401, 'unauthorized', 'Valid Bearer authentication is required');
    principals.set(request, principal.id);
    budget(`token:${principal.id}`, 600);
    if (gateway.isStopping() && ['POST', 'PATCH', 'DELETE'].includes(request.method)) throw new GatewayError(503, 'gateway_stopping', 'Gateway is stopping');
  });
  app.addHook('onResponse', async request => { if (active.delete(request)) concurrent--; });
  app.options(`${prefix}/*`, async (_request, reply) => reply.code(204).send());

  // Admission and idempotency storage run synchronously in one transaction; no
  // duplicate request can slip between lookup and durable response persistence.
  function post<T>(path: string, schema: z.ZodType<T>, category: string, action: (body: T, request: FastifyRequest) => SavedResponse) {
    app.post(prefix + path, async (request, reply) => {
      const key = request.headers['idempotency-key'];
      if (!schemas.uuid.safeParse(key).success) throw new GatewayError(400, 'invalid_idempotency_key', 'Idempotency-Key must be a UUID');
      const body = parse(schema, request.body);
      const scope = `${principals.get(request)}:${request.method}:${request.url.split('?')[0]}`;
      const response = gateway.store.transaction(() => {
        const old = gateway.store.lookupIdempotency<SavedResponse>(scope, key as string, request.body);
        if (old) return old;
        budget(`${category}:${principals.get(request)}`, category === 'discovery' ? 10 : category === 'command' ? 120 : 60);
        // Reserve idempotency capacity before admitting physical work.
        gateway.store.ensureIdempotencyCapacity();
        const result = action(body, request);
        gateway.store.saveIdempotency(scope, key as string, request.body, result);
        return result;
      });
      for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
      return reply.code(response.status).send(response.body);
    });
  }
  const admitted = (operation: { id: string }): SavedResponse => ({ status: 202, body: operation, headers: { Location: `${prefix}/operations/${operation.id}` } });
  const created = (kind: string, resource: { id: string }): SavedResponse => ({ status: 201, body: resource, headers: { Location: `${prefix}/${kind}/${resource.id}`, ETag: tag(resource) } });
  app.get(`${prefix}/health`, async (_request, reply) => {
    const ready = gateway.isReady();
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', gatewayId: gateway.store.gatewayId, bootId: gateway.bus.bootId });
  });
  const metadata = (deviceId: string) => { const { id, name, room, groups } = gateway.registry.get(deviceId); return { id, name, room, groups }; };
  app.get(`${prefix}/devices`, async () => ({ items: gateway.registry.list() }));
  app.get(`${prefix}/devices/:id`, async (request, reply) => reply.header('ETag', tag(metadata(id(request)))).send(gateway.registry.get(id(request))));
  app.get(`${prefix}/devices/:id/state`, async request => gateway.registry.snapshot(id(request)));
  app.patch(`${prefix}/devices/:id`, async (request, reply) => {
    const deviceId = id(request); condition(request, metadata(deviceId)); const patch = parse(schemas.devicePatch, request.body);
    if (patch.room) references('/room', () => gateway.rooms.get(patch.room!));
    if (patch.groups) for (const groupId of patch.groups) references('/groups', () => gateway.groups.get(groupId));
    gateway.store.transaction(() => {
      if (patch.name !== undefined) gateway.registry.update(deviceId, { name: patch.name });
      if (patch.room !== undefined) gateway.rooms.assign(deviceId, patch.room);
      if (patch.groups) for (const group of gateway.groups.list()) {
        const included = patch.groups.includes(group.id);
        if (included !== group.deviceIds.includes(deviceId)) gateway.groups.update(group.id, { deviceIds: included ? [...group.deviceIds, deviceId] : group.deviceIds.filter(item => item !== deviceId) });
      }
    });
    return reply.header('ETag', tag(metadata(deviceId))).send(gateway.registry.get(deviceId));
  });
  for (const kind of ['device', 'group'] as const) post(`/${kind}s/:id/commands`, schemas.command, 'command', (body, request) => admitted(gateway.operations.submitCommand({ type: kind, id: id(request) }, body.state as DeviceState, { requestId: request.id, ...(body.transitionMs === undefined ? {} : { transitionMs: body.transitionMs }) })));
  app.get(`${prefix}/rooms`, async () => ({ items: gateway.rooms.list() }));
  post('/rooms', schemas.roomCreate, 'create', body => created('rooms', gateway.rooms.create(body.name)));
  app.get(`${prefix}/rooms/:id`, async (request, reply) => detail(reply, gateway.rooms.get(id(request))));
  app.patch(`${prefix}/rooms/:id`, async (request, reply) => { const resource = gateway.rooms.get(id(request)); condition(request, resource); const patch = parse(schemas.roomPatch, request.body); return detail(reply, gateway.rooms.update(resource.id, patch.name!)); });
  app.get(`${prefix}/rooms/:id/state`, async request => gateway.rooms.state(id(request)));
  app.get(`${prefix}/groups`, async () => ({ items: gateway.groups.list() }));
  post('/groups', schemas.groupCreate, 'create', body => created('groups', references('/deviceIds', () => gateway.groups.create(body.name, body.deviceIds))));
  app.get(`${prefix}/groups/:id`, async (request, reply) => detail(reply, gateway.groups.get(id(request))));
  app.patch(`${prefix}/groups/:id`, async (request, reply) => { const resource = gateway.groups.get(id(request)); condition(request, resource); const patch = parse(schemas.groupPatch, request.body); return detail(reply, references('/deviceIds', () => gateway.groups.update(resource.id, { ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.deviceIds === undefined ? {} : { deviceIds: patch.deviceIds }) }))); });
  app.get(`${prefix}/groups/:id/state`, async request => gateway.groups.state(id(request)));
  app.get(`${prefix}/scenes`, async () => ({ items: gateway.scenes.list() }));
  post('/scenes', schemas.sceneCreate, 'create', body => created('scenes', references('/entries', () => gateway.scenes.create(body.name, body.entries as SceneEntry[]))));
  app.get(`${prefix}/scenes/:id`, async (request, reply) => detail(reply, gateway.scenes.get(id(request))));
  app.patch(`${prefix}/scenes/:id`, async (request, reply) => { const resource = gateway.scenes.get(id(request)); condition(request, resource); const patch = parse(schemas.scenePatch, request.body); return detail(reply, references('/entries', () => gateway.scenes.update(resource.id, { ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.entries === undefined ? {} : { entries: patch.entries as SceneEntry[] }) }))); });
  for (const kind of ['rooms', 'groups', 'scenes'] as const) app.delete(`${prefix}/${kind}/:id`, async (request, reply) => { condition(request, gateway[kind].get(id(request))); gateway[kind].delete(id(request)); return reply.code(204).send(); });
  post('/scenes/:id/activate', schemas.sceneActivate, 'scene', (body, request) => admitted(gateway.scenes.activate(id(request), { requestId: request.id, ...(body.allowDegraded === undefined ? {} : { allowDegraded: body.allowDegraded }) })));
  app.get(`${prefix}/effects`, async () => ({ items: gateway.effects.list() }));
  app.get(`${prefix}/effects/:id`, async request => gateway.effects.get(id(request)));
  post('/effects/:id/start', schemas.effectStart, 'effect', (body, request) => { const effectId = id(request); gateway.effects.get(effectId); return admitted(references('/target', () => gateway.effects.start(effectId, body.target, body.parameters))); });
  app.get(`${prefix}/effect-runs`, async () => ({ items: gateway.effects.runs() }));
  app.get(`${prefix}/effect-runs/:id`, async request => gateway.effects.getRun(id(request)));
  post('/effect-runs/:id/stop', schemas.empty, 'effect', (_body, request) => admitted(gateway.effects.stop(id(request))));
  post('/discovery/start', schemas.discoveryStart, 'discovery', body => {
    const configured = gateway.runtime.list().map(adapter => adapter.id);
    const selected = body.adapterIds ?? configured;
    if (selected.some(adapterId => !configured.includes(adapterId))) throw new GatewayError(422, 'validation_error', 'Select configured adapters', [{ path: '/adapterIds', code: 'unknown_adapter', message: 'Adapter is not configured' }]);
    return admitted(gateway.operations.discover(selected));
  });
  app.get(`${prefix}/operations/:id`, async request => gateway.operations.get(id(request)));
  await registerWebSocket(app, gateway);
  return app;
}

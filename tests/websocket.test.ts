import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { registerWebSocket } from '../src/api/websocket/index.js';
import { createGateway, type Gateway } from '../src/service/index.js';
import { loadConfig } from '../src/config/index.js';

describe('WebSocket authentication and lifecycle', () => {
  let gateway: Gateway;
  let app: ReturnType<typeof Fastify>;
  let token: string;
  let tokenId: string;
  beforeEach(async () => {
    gateway = await createGateway({ config: loadConfig({ DATABASE_PATH: ':memory:', MOCK_LATENCY_MS: '0', LOG_LEVEL: 'silent', CORS_ORIGINS: 'https://controller.example' }) });
    const created = gateway.tokens.create(); token = created.token; tokenId = created.record.id;
    app = Fastify({ logger: false });
    await registerWebSocket(app, gateway);
    await app.ready();
  });
  afterEach(async () => { await app.close(); await gateway.stop(); });
  const browser = { headers: { host: 'localhost', origin: 'https://controller.example' } };

  it('authenticates native headers and closes invalid native headers with 1008', async () => {
    const messages: unknown[] = [];
    const socket = await app.injectWS('/api/v1/events', { headers: { host: 'localhost', authorization: `Bearer ${token}` } }, {
      onInit: ws => ws.on('message', data => messages.push(JSON.parse(data.toString()))),
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(messages).toEqual([{ type: 'authenticated', gatewayId: gateway.store.gatewayId, bootId: gateway.bus.bootId }]);
    socket.close();
    for (const authorization of ['Bearer invalid', 'Basic invalid']) {
      let closed: Promise<unknown[]>;
      await app.injectWS('/api/v1/events', { headers: { host: 'localhost', authorization } }, { onInit: ws => { closed = once(ws, 'close'); } });
      expect((await closed!)[0]).toBe(1008);
    }
  });

  it('withholds all events until the browser authenticates, sends control first, forwards exact envelopes', async () => {
    const messages: unknown[] = [];
    const socket = await app.injectWS('/api/v1/events', browser, { onInit: ws => ws.on('message', data => messages.push(JSON.parse(data.toString()))) });
    gateway.bus.publish('gateway.started', { type: 'gateway', id: gateway.store.gatewayId }, { reason: 'test' });
    await new Promise(resolve => setImmediate(resolve));
    expect(messages).toEqual([]);
    const authenticated = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'authenticate', token }));
    await authenticated;
    expect(messages).toEqual([{ type: 'authenticated', gatewayId: gateway.store.gatewayId, bootId: gateway.bus.bootId }]);
    const received = once(socket, 'message');
    const event = gateway.bus.publish('gateway.stopping', { type: 'gateway', id: gateway.store.gatewayId }, { reason: 'test' });
    await received;
    expect(messages[1]).toEqual(event);
    expect(Object.keys(messages[1] as object).sort()).toEqual(['schemaVersion', 'id', 'sequence', 'gatewayId', 'bootId', 'occurredAt', 'type', 'subject', 'correlationId', 'data'].sort());
    socket.close();
  });

  it('rejects disallowed Origins, Host rebinding, URL tokens and subprotocol tokens before upgrade', async () => {
    for (const [path, headers, status] of [
      ['/api/v1/events', { host: 'localhost', origin: 'https://evil.example' }, 403],
      ['/api/v1/events', { host: 'evil.example', origin: 'https://controller.example' }, 403],
      ['/api/v1/events?token=dummy', browser.headers, 400],
      ['/api/v1/events', { ...browser.headers, 'sec-websocket-protocol': 'dummy' }, 400],
    ] as const) await expect(app.injectWS(path, { headers })).rejects.toThrow(`Unexpected server response: ${status}`);
  });

  it('closes invalid credentials and unsupported application messages with 1008', async () => {
    for (const frame of [{ type: 'authenticate', token: 'invalid' }, { type: 'authenticate', token, unexpected: true }, { type: 'subscribe' }]) {
      const socket = await app.injectWS('/api/v1/events', browser);
      const closed = once(socket, 'close'); socket.send(JSON.stringify(frame));
      expect((await closed)[0]).toBe(1008);
    }
    const socket = await app.injectWS('/api/v1/events', browser);
    const authenticated = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', token })); await authenticated;
    const closed = once(socket, 'close'); socket.send('{}'); expect((await closed)[0]).toBe(1008);
  });

  it('cannot authenticate by racing a second frame after an invalid first frame', async () => {
    const messages: unknown[] = [];
    const socket = await app.injectWS('/api/v1/events', browser, { onInit: ws => ws.on('message', data => messages.push(JSON.parse(data.toString()))) });
    const closed = once(socket, 'close');
    socket.send('{}'); socket.send(JSON.stringify({ type: 'authenticate', token }));
    expect((await closed)[0]).toBe(1008);
    expect(messages).toEqual([]);
  });

  it('enforces the five second first-frame deadline', async () => {
    const socket = await app.injectWS('/api/v1/events', browser);
    expect((await once(socket, 'close'))[0]).toBe(1008);
  }, 10000);

  it('closes oversized frames with 1009', async () => {
    const socket = await app.injectWS('/api/v1/events', browser);
    const closed = once(socket, 'close'); socket.send('a'.repeat(4097)); expect((await closed)[0]).toBe(1009);
  });

  it('disconnects revoked sessions without waiting for another domain event', async () => {
    const socket = await app.injectWS('/api/v1/events', browser);
    const authenticated = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', token })); await authenticated;
    const closed = once(socket, 'close'); gateway.tokens.revoke(tokenId); expect((await closed)[0]).toBe(1008);
  });

  it('disconnects an expired session without waiting for another domain event', async () => {
    const expiring = gateway.tokens.create(new Date(Date.now() + 500).toISOString());
    const socket = await app.injectWS('/api/v1/events', browser);
    const authenticated = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', token: expiring.token })); await authenticated;
    expect((await once(socket, 'close'))[0]).toBe(1008);
  });

  it('bounds unauthenticated connections per source', async () => {
    const sockets = [];
    for (let i = 0; i < 8; i++) sockets.push(await app.injectWS('/api/v1/events', browser));
    await expect(app.injectWS('/api/v1/events', browser)).rejects.toThrow('Unexpected server response: 429');
    for (const socket of sockets) socket.close();
  });

  it('disconnects slow consumers with 1013', async () => {
    const socket = await app.injectWS('/api/v1/events', browser);
    const authenticated = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', token })); await authenticated;
    const serverSocket = [...app.websocketServer.clients].find(client => client.readyState === 1)!;
    Object.defineProperty(serverSocket, 'bufferedAmount', { configurable: true, get: () => 1024 * 1024 });
    const closed = once(socket, 'close');
    gateway.bus.publish('gateway.stopping', { type: 'gateway', id: gateway.store.gatewayId }, { reason: 'test' });
    expect((await closed)[0]).toBe(1013);
  });

  it('closes connected clients cleanly during application shutdown', async () => {
    const socket = await app.injectWS('/api/v1/events', browser);
    const closed = once(socket, 'close'); await app.close(); expect((await closed)[0]).toBe(1001);
  });
});

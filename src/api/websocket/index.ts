import websocket from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import { isOriginAllowed } from '../../security/index.js';
import type { Gateway } from '../../service/index.js';

const authentication = z.object({ type: z.literal('authenticate'), token: z.string().min(1).max(256) }).strict();
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 256;
const MAX_UNAUTHENTICATED = 32;
interface Session { socket: WebSocket; principalId: string | null; ip: string; deadline: ReturnType<typeof setTimeout> }

/** Forward the core's complete envelope unchanged; clients buffer while fetching REST snapshots. */
export async function registerWebSocket(app: FastifyInstance, gateway: Gateway): Promise<void> {
  const sessions = new Set<Session>();
  const budgets = new Map<string, { started: number; attempts: number }>();
  const consume = (key: string, limit: number): boolean => {
    const now = Date.now();
    for (const [id, value] of budgets) if (now - value.started >= 60_000) budgets.delete(id);
    let budget = budgets.get(key);
    if (!budget) {
      if (budgets.size >= 10_000) return false;
      budget = { started: now, attempts: 0 }; budgets.set(key, budget);
    }
    return ++budget.attempts <= limit;
  };
  let stopping = false;
  const valid = (session: Session): boolean => {
    if (!session.principalId) return false;
    const record = gateway.store.getToken(session.principalId);
    return !!record && !record.revokedAt && (record.expiresAt === null || Date.parse(record.expiresAt) > Date.now());
  };
  const close = (session: Session, code: number, reason: string): void => {
    clearTimeout(session.deadline);
    sessions.delete(session);
    session.socket.close(code, reason);
    // A peer that does not acknowledge close must not retain a socket indefinitely.
    const deadline = setTimeout(() => session.socket.terminate(), 1000);
    deadline.unref();
    session.socket.once('close', () => clearTimeout(deadline));
  };
  const unsubscribe = gateway.bus.subscribe(event => {
    const message = JSON.stringify(event);
    for (const session of sessions) {
      if (!session.principalId) continue;
      if (!valid(session)) { close(session, 1008, 'Authentication expired or revoked'); continue; }
      if (session.socket.readyState !== 1) continue;
      if (session.socket.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFERED_BYTES) {
        close(session, 1013, 'Consumer is too slow'); continue;
      }
      session.socket.send(message);
    }
  });
  const expiry = setInterval(() => {
    for (const session of sessions) if (session.principalId && !valid(session)) close(session, 1008, 'Authentication expired or revoked');
  }, 250);
  expiry.unref();

  await app.register(websocket, {
    options: { maxPayload: 4096, perMessageDeflate: false },
    preClose: async () => {
      stopping = true;
      unsubscribe();
      clearInterval(expiry);
      const connections = [...app.websocketServer.clients];
      for (const session of sessions) close(session, 1001, 'Gateway stopping');
      await Promise.all(connections.map(socket => new Promise<void>(resolve => {
        if (socket.readyState === 3) { resolve(); return; }
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
      })));
      await new Promise<void>(resolve => app.websocketServer.close(() => resolve()));
    },
  });

  app.get('/api/v1/events', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!consume(`ip:${request.ip}`, 60)) {
        reply.header('Retry-After', '60');
        throw new GatewayError(429, 'rate_limited', 'Event connection rate exceeded');
      }
      if (!isOriginAllowed(request.headers.origin, gateway.config.cors)) throw new GatewayError(403, 'forbidden', 'Origin is not allowed');
      const host = request.headers.host;
      const hostname = host?.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host?.split(':')[0];
      if (!hostname || !gateway.config.allowedHosts.includes(hostname)) throw new GatewayError(403, 'forbidden', 'Host is not allowed');
      if (request.url.includes('?') || request.headers['sec-websocket-protocol']) throw new GatewayError(400, 'validation_error', 'Query strings and subprotocols are not supported');
      if (stopping || gateway.isStopping()) throw new GatewayError(503, 'gateway_stopping', 'Gateway is stopping');
      const unauthenticated = [...sessions].filter(session => !session.principalId);
      if (sessions.size >= MAX_CONNECTIONS || (!request.headers.authorization && (unauthenticated.length >= MAX_UNAUTHENTICATED || unauthenticated.filter(session => session.ip === request.ip).length >= 8))) {
        reply.header('Retry-After', '1');
        throw new GatewayError(429, 'rate_limited', 'Too many event connections');
      }
    },
  }, (socket, request) => {
    // Recheck admission after upgrade: simultaneous handshakes may have passed
    // preValidation before an earlier handler registered its session.
    const unauthenticated = [...sessions].filter(session => !session.principalId);
    if (stopping || sessions.size >= MAX_CONNECTIONS || (!request.headers.authorization && (unauthenticated.length >= MAX_UNAUTHENTICATED || unauthenticated.filter(session => session.ip === request.ip).length >= 8))) {
      socket.close(1013, 'Event connection capacity reached');
      const deadline = setTimeout(() => socket.terminate(), 1000);
      deadline.unref();
      socket.once('close', () => clearTimeout(deadline));
      return;
    }
    const session: Session = {
      socket, principalId: null, ip: request.ip,
      deadline: setTimeout(() => close(session, 1008, 'Authentication required'), 5000),
    };
    session.deadline.unref();
    sessions.add(session);
    socket.once('close', () => { clearTimeout(session.deadline); sessions.delete(session); });
    const authenticate = (token: string): void => {
      const record = gateway.tokens.verify(token);
      if (!record) { close(session, 1008, 'Invalid authentication'); return; }
      if (!consume(`token:${record.id}`, 30)) { close(session, 1013, 'Event connection rate exceeded'); return; }
      session.principalId = record.id;
      clearTimeout(session.deadline);
      socket.send(JSON.stringify({ type: 'authenticated', gatewayId: gateway.bus.gatewayId, bootId: gateway.bus.bootId }));
    };
    // Attach synchronously so the first application frame cannot race initialization.
    socket.on('message', (data: Buffer, binary: boolean) => {
      if (socket.readyState !== 1) return;
      if (session.principalId || binary) { close(session, 1008, 'Unsupported application message'); return; }
      try {
        const parsed = authentication.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) { close(session, 1008, 'Invalid authentication frame'); return; }
        authenticate(parsed.data.token);
      } catch { close(session, 1008, 'Invalid authentication frame'); }
    });
    const header = request.headers.authorization;
    if (header !== undefined) {
      const match = /^Bearer ([^\s]+)$/i.exec(header);
      if (!match) close(session, 1008, 'Invalid authentication');
      else authenticate(match[1]!);
    } else if (!request.headers.origin) close(session, 1008, 'Authorization header required');
  });
}

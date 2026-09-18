import { Socket } from 'node:net';
import { AdapterError } from '../types.js';
import { CONTROL, DP_QUERY, CONTROL_NEW, DP_QUERY_NEW, encodeQuery, decodeFrame, frameLength, encodeSessionFrame, decodeSessionFrame, encryptSessionPayload, decryptSessionPayload, handshakeStart, handshakeFinish, deriveSessionKey } from './protocol.js';
import type { SessionVersion } from './protocol.js';

export interface SessionRequest {
  /** sequence seeds START; the transport assigns subsequent frame sequences. */
  version: SessionVersion; localKey: string; sequence: number; queryPayload: unknown;
  preceding?: { payload: unknown };
}
export interface SessionResponse { sequence: number; command: number; payload: Buffer }

export interface FeitTransport {
  /** Optionally send CONTROL before the query, without awaiting a CONTROL response. */
  request(ip: string, packet: Uint8Array, context: { signal: AbortSignal; deadlineAt: number }, precedingPacket?: Uint8Array): Promise<Buffer>;
  requestSession?(ip: string, request: SessionRequest, context: { signal: AbortSignal; deadlineAt: number }): Promise<SessionResponse>;
  close(): Promise<void>;
}

/** A short-lived TCP connection per request; no cloud, discovery or shared socket state. */
export class NodeFeitTransport implements FeitTransport {
  private readonly pending = new Set<() => void>();

  async request(ip: string, packet: Uint8Array, context: { signal: AbortSignal; deadlineAt: number }, precedingPacket?: Uint8Array): Promise<Buffer> {
    if (context.signal.aborted) throw new AdapterError('CANCELED', 'Feit request canceled');
    const remaining = context.deadlineAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new AdapterError('TIMEOUT', 'Feit request deadline elapsed', true);
    let expected: ReturnType<typeof decodeFrame>;
    try {
      expected = decodeFrame(packet);
      if (precedingPacket) {
        const preceding = decodeFrame(precedingPacket);
        if (preceding.command !== CONTROL || expected.command !== DP_QUERY || preceding.sequence === expected.sequence) throw new Error();
      }
    }
    catch { throw new AdapterError('TRANSPORT_ERROR', 'Invalid outgoing Feit packet'); }
    return new Promise<Buffer>((resolve, reject) => {
      let socket: Socket;
      try { socket = new Socket(); }
      catch { reject(new AdapterError('OFFLINE', 'Feit TCP connection failed', true)); return; }
      let finished = false;
      let connected = false;
      let sent = false;
      // Hold at most a single bounded frame, even if a data event coalesces many frames.
      let buffered = Buffer.alloc(0);
      let targetLength = 16;
      const finish = (error?: AdapterError, response?: Buffer) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        context.signal.removeEventListener('abort', canceled);
        this.pending.delete(closed);
        socket.removeAllListeners('connect');
        socket.removeAllListeners('data');
        socket.removeAllListeners('end');
        socket.removeAllListeners('close');
        // Retain the sanitized error listener through destroy for late socket errors.
        try { socket.destroy(); } catch { /* Cleanup must not prevent promise settlement. */ }
        if (error) reject(error); else resolve(response!);
      };
      const delivery = () => sent ? 'unknown' as const : 'not_sent' as const;
      const canceled = () => finish(new AdapterError('CANCELED', 'Feit request canceled', false, delivery()));
      const closed = () => finish(new AdapterError('OFFLINE', 'Feit transport closed', true, delivery()));
      const timer = setTimeout(() => finish(new AdapterError('TIMEOUT', 'Feit device did not respond before the deadline', true, delivery())), Math.min(remaining, 0x7fffffff));
      this.pending.add(closed);
      context.signal.addEventListener('abort', canceled, { once: true });
      socket.on('error', () => finish(new AdapterError(connected ? 'TRANSPORT_ERROR' : 'OFFLINE', connected ? 'Feit TCP socket failed' : 'Feit TCP connection failed', true, delivery())));
      socket.once('end', () => finish(new AdapterError('OFFLINE', 'Feit device closed without a response', true, delivery())));
      socket.once('close', () => finish(new AdapterError('OFFLINE', 'Feit connection closed without a response', true, delivery())));
      socket.once('connect', () => {
        connected = true;
        const write = (bytes: Uint8Array, next?: () => void) => {
          if (finished) return;
          try {
            sent = true;
            socket.write(bytes, error => {
              if (finished) return;
              if (error) finish(new AdapterError('TRANSPORT_ERROR', 'Feit TCP write failed', true, delivery()));
              else next?.();
            });
          } catch { finish(new AdapterError('TRANSPORT_ERROR', 'Feit TCP write failed', true, delivery())); }
        };
        // The write callback is local TCP flushing, never a device acknowledgment.
        if (precedingPacket) write(precedingPacket, () => write(packet));
        else write(packet);
      });
      socket.on('data', (chunk: Buffer) => {
        try {
          let offset = 0;
          while (!finished && offset < chunk.length) {
            const count = Math.min(targetLength - buffered.length, chunk.length - offset);
            buffered = Buffer.concat([buffered, chunk.subarray(offset, offset + count)]);
            offset += count;
            if (buffered.length < targetLength) continue;
            if (targetLength === 16) { targetLength = frameLength(buffered); continue; }
            const response = decodeFrame(buffered);
            if (response.sequence === expected.sequence && response.command === expected.command) { finish(undefined, buffered); return; }
            buffered = Buffer.alloc(0);
            targetLength = 16;
          }
        } catch { finish(new AdapterError('TRANSPORT_ERROR', 'Invalid Feit response frame', false, delivery())); }
      });
      if (context.signal.aborted) { canceled(); return; }
      try { socket.connect(6668, ip); }
      catch { finish(new AdapterError('OFFLINE', 'Feit TCP connection failed', true, delivery())); }
    });
  }

  /** Session keys are connection-local and discarded on every completion or disconnect. */
  async requestSession(ip: string, request: SessionRequest, context: { signal: AbortSignal; deadlineAt: number }): Promise<SessionResponse> {
    if (context.signal.aborted) throw new AdapterError('CANCELED', 'Feit request canceled');
    const remaining = context.deadlineAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new AdapterError('TIMEOUT', 'Feit request deadline elapsed', true);
    const { version, localKey, sequence } = request;
    // Every outgoing frame consumes a connection-local uint32 sequence number.
    let nextSequence = sequence;
    const takeSequence = () => { const current = nextSequence; nextSequence = (current + 1) >>> 0; return current; };
    let querySequence: number | undefined;
    let start: ReturnType<typeof handshakeStart>;
    let startPacket: Buffer;
    try {
      if (version !== '3.4' && version !== '3.5') throw new Error();
      if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error();
      start = handshakeStart(version, localKey);
      startPacket = encodeSessionFrame(version, takeSequence(), 0x03, start.payload, localKey);
    } catch { throw new AdapterError('TRANSPORT_ERROR', 'Invalid outgoing Feit session request'); }
    return new Promise<SessionResponse>((resolve, reject) => {
      let socket: Socket;
      try { socket = new Socket(); }
      catch { reject(new AdapterError('OFFLINE', 'Feit TCP connection failed', true)); return; }
      let finished = false, connected = false, sent = false;
      let phase: 'handshake' | 'finishing' | 'query' = 'handshake';
      let sessionKey: Buffer | undefined;
      const headerLength = version === '3.5' ? 18 : 16;
      let buffered = Buffer.alloc(0), targetLength = headerLength;
      const delivery = () => sent ? 'unknown' as const : 'not_sent' as const;
      const finish = (error?: AdapterError, response?: SessionResponse) => {
        if (finished) return;
        finished = true;
        sessionKey = undefined;
        clearTimeout(timer);
        context.signal.removeEventListener('abort', canceled);
        this.pending.delete(closed);
        socket.removeAllListeners('connect'); socket.removeAllListeners('data');
        socket.removeAllListeners('end'); socket.removeAllListeners('close');
        try { socket.destroy(); } catch { /* Cleanup must not prevent settlement. */ }
        if (error) reject(error); else resolve(response!);
      };
      const canceled = () => finish(new AdapterError('CANCELED', 'Feit request canceled', false, delivery()));
      const closed = () => finish(new AdapterError('OFFLINE', 'Feit transport closed', true, delivery()));
      const timer = setTimeout(() => finish(new AdapterError('TIMEOUT', 'Feit device did not respond before the deadline', true, delivery())), Math.min(remaining, 0x7fffffff));
      const write = (bytes: Uint8Array, next?: () => void, application = false) => {
        if (finished) return;
        try {
          if (application) sent = true;
          socket.write(bytes, error => {
            if (finished) return;
            if (error) finish(new AdapterError('TRANSPORT_ERROR', 'Feit TCP write failed', true, delivery()));
            else { try { next?.(); } catch { finish(new AdapterError('TRANSPORT_ERROR', 'Invalid Feit session payload', false, delivery())); } }
          });
        } catch { finish(new AdapterError('TRANSPORT_ERROR', 'Feit TCP write failed', true, delivery())); }
      };
      this.pending.add(closed);
      context.signal.addEventListener('abort', canceled, { once: true });
      socket.on('error', () => finish(new AdapterError(connected ? 'TRANSPORT_ERROR' : 'OFFLINE', connected ? 'Feit TCP socket failed' : 'Feit TCP connection failed', true, delivery())));
      socket.once('end', () => finish(new AdapterError('OFFLINE', 'Feit device closed without a response', true, delivery())));
      socket.once('close', () => finish(new AdapterError('OFFLINE', 'Feit connection closed without a response', true, delivery())));
      socket.once('connect', () => { connected = true; write(startPacket); });
      socket.on('data', (chunk: Buffer) => {
        try {
          let offset = 0;
          while (!finished && offset < chunk.length) {
            const count = Math.min(targetLength - buffered.length, chunk.length - offset);
            buffered = Buffer.concat([buffered, chunk.subarray(offset, offset + count)]); offset += count;
            if (buffered.length < targetLength) continue;
            if (targetLength === headerLength) { targetLength = frameLength(buffered, version); continue; }
            const response = decodeSessionFrame(version, buffered, sessionKey ?? localKey);
            buffered = Buffer.alloc(0); targetLength = headerLength;
            if (phase === 'handshake') {
              if (response.command !== 0x04 || (version === '3.4' && response.sequence !== sequence)) continue;
              if (response.payload.length < 4 || response.payload.readUInt32BE(0) !== 0) throw new Error();
              const negotiated = handshakeFinish(version, localKey, start.clientNonce, response.payload.subarray(4));
              const finishPacket = encodeSessionFrame(version, takeSequence(), 0x05, negotiated.payload, localKey);
              sessionKey = deriveSessionKey(version, localKey, start.clientNonce, negotiated.deviceNonce);
              phase = 'finishing';
              write(finishPacket, () => {
                const key = sessionKey!;
                const sendQuery = () => {
                  querySequence = takeSequence();
                  const query = encodeSessionFrame(version, querySequence, DP_QUERY_NEW, encryptSessionPayload(version, request.queryPayload, key), key);
                  phase = 'query'; write(query, undefined, true);
                };
                // Local flushing is not a device acknowledgment; only DP_QUERY_NEW verifies state.
                if (request.preceding) {
                  const control = encodeSessionFrame(version, takeSequence(), CONTROL_NEW, encryptSessionPayload(version, request.preceding.payload, key), key);
                  write(control, sendQuery, true);
                } else sendQuery();
              });
            } else if (phase === 'query' && response.command === DP_QUERY_NEW && (version === '3.5' || response.sequence === querySequence)) {
              if (response.payload.length < 4 || response.payload.readUInt32BE(0) !== 0) throw new Error();
              const payload = encodeQuery(decryptSessionPayload(version, response.payload.subarray(4), sessionKey!));
              finish(undefined, { sequence: response.sequence, command: response.command, payload });
            }
          }
        } catch { finish(new AdapterError('TRANSPORT_ERROR', 'Invalid Feit response frame', false, delivery())); }
      });
      if (context.signal.aborted) { canceled(); return; }
      try { socket.connect(6668, ip); }
      catch { finish(new AdapterError('OFFLINE', 'Feit TCP connection failed', true, delivery())); }
    });
  }

  async close(): Promise<void> {
    for (const cancel of [...this.pending]) cancel();
  }
}

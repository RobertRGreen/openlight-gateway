import { Socket } from 'node:net';
import { AdapterError } from '../types.js';
import { CONTROL, DP_QUERY, decodeFrame, frameLength } from './protocol.js';

export interface FeitTransport {
  /** Optionally send CONTROL before the query, without awaiting a CONTROL response. */
  request(ip: string, packet: Uint8Array, context: { signal: AbortSignal; deadlineAt: number }, precedingPacket?: Uint8Array): Promise<Buffer>;
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

  async close(): Promise<void> {
    for (const cancel of [...this.pending]) cancel();
  }
}

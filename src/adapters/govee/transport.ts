import { createSocket, type Socket } from 'node:dgram';

export interface GoveeTransport {
  open(): Promise<void>;
  send(payload: Uint8Array, address: string, port: number): Promise<void>;
  onMessage(listener: (payload: Uint8Array, remote: { address: string; port: number }) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

type Session = {
  socket: Socket;
  ready: boolean;
  opening: Promise<void>;
  resolveOpen: () => void;
  rejectOpen: (error: Error) => void;
  pending: Set<(error: Error) => void>;
};

/** One response socket: Govee replies use port 4002, not an ephemeral sender port. */
export class NodeGoveeTransport implements GoveeTransport {
  private session: Session | undefined;
  private closing: Promise<void> | undefined;
  private readonly messages = new Set<Parameters<GoveeTransport['onMessage']>[0]>();
  private readonly errors = new Set<(error: Error) => void>();

  async open(): Promise<void> {
    if (this.closing) await this.closing;
    if (this.session) return this.session.opening;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    let resolveOpen!: () => void;
    let rejectOpen!: (error: Error) => void;
    const opening = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
    const session: Session = { socket, opening, resolveOpen, rejectOpen, ready: false, pending: new Set() };
    this.session = session;
    // Keep an error handler attached even while closing; late socket errors must not
    // become unhandled EventEmitter errors that terminate the gateway.
    socket.on('error', error => {
      if (this.session !== session) return;
      session.rejectOpen(error);
      for (const reject of session.pending) reject(error);
      void this.close();
      for (const listener of this.errors) { try { listener(error); } catch { /* Subscriber isolation. */ } }
    });
    socket.on('message', (payload, remote) => {
      if (this.session !== session || !session.ready) return;
      for (const listener of this.messages) {
        try { listener(payload, { address: remote.address, port: remote.port }); } catch { /* Subscriber isolation. */ }
      }
    });
    socket.once('listening', () => {
      if (this.session !== session) return;
      try {
        // Some devices multicast their discovery responses; also receive unicast replies.
        socket.addMembership('239.255.255.250');
        session.ready = true;
        resolveOpen();
      } catch (error) { socket.emit('error', asError(error)); }
    });
    try { socket.bind(4002, '0.0.0.0'); }
    catch (error) { socket.emit('error', asError(error)); }
    return opening;
  }

  async send(payload: Uint8Array, address: string, port: number): Promise<void> {
    const session = this.session;
    if (!session?.ready) throw new Error('Govee UDP transport is not open');
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { session.pending.delete(fail); reject(error); };
      session.pending.add(fail);
      try {
        session.socket.send(payload, port, address, error => {
          session.pending.delete(fail);
          if (error) reject(error); else resolve();
        });
      } catch (error) { fail(asError(error)); }
    });
  }

  onMessage(listener: Parameters<GoveeTransport['onMessage']>[0]): () => void {
    this.messages.add(listener);
    return () => { this.messages.delete(listener); };
  }

  onError(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => { this.errors.delete(listener); };
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    const error = new Error('Govee UDP transport closed');
    session.rejectOpen(error);
    for (const reject of session.pending) reject(error);
    session.socket.removeAllListeners('message');
    session.socket.removeAllListeners('listening');
    const closing = new Promise<void>(resolve => {
      try { session.socket.close(() => resolve()); }
      catch { resolve(); } // Closing an unbound/already closed socket is harmless.
    });
    this.closing = closing;
    await closing;
    if (this.closing === closing) this.closing = undefined;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Govee UDP transport failed');
}

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeGoveeTransport } from '../src/adapters/govee/transport.js';

const { createSocket } = vi.hoisted(() => ({ createSocket: vi.fn() }));
vi.mock('node:dgram', () => ({ createSocket }));

class FakeSocket extends EventEmitter {
  bind = vi.fn(() => { queueMicrotask(() => this.emit('listening')); });
  addMembership = vi.fn();
  send = vi.fn((_payload: Uint8Array, _port: number, _address: string, callback: (error: Error | null) => void) => callback(null));
  close = vi.fn((callback: () => void) => callback());
}

describe('Govee production UDP transport (mocked node:dgram)', () => {
  let socket: FakeSocket;
  beforeEach(() => {
    vi.clearAllMocks();
    socket = new FakeSocket();
    createSocket.mockReturnValue(socket);
  });

  it('lazily binds port 4002, joins multicast, and sends through the response socket', async () => {
    const transport = new NodeGoveeTransport();
    expect(createSocket).not.toHaveBeenCalled();
    await Promise.all([transport.open(), transport.open()]);
    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(createSocket).toHaveBeenCalledWith({ type: 'udp4', reuseAddr: true });
    expect(socket.bind).toHaveBeenCalledWith(4002, '0.0.0.0');
    expect(socket.addMembership).toHaveBeenCalledWith('239.255.255.250');
    const payload = Buffer.from('{"msg":{"cmd":"scan","data":{"account_topic":"reserve"}}}');
    await transport.send(payload, '239.255.255.250', 4001);
    await transport.send(payload, '192.168.1.20', 4003);
    expect(socket.send).toHaveBeenNthCalledWith(1, payload, 4001, '239.255.255.250', expect.any(Function));
    expect(socket.send).toHaveBeenNthCalledWith(2, payload, 4003, '192.168.1.20', expect.any(Function));
    await Promise.all([transport.close(), transport.close()]);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('isolates subscribers, supports unsubscribe, and ignores stale messages after reconnect', async () => {
    const transport = new NodeGoveeTransport();
    transport.onMessage(() => { throw new Error('subscriber failure'); });
    const receive = vi.fn();
    const unsubscribe = transport.onMessage(receive);
    await transport.open();
    const payload = Buffer.from('reply');
    const remote = { address: '192.168.1.20', port: 4003 };
    socket.emit('message', payload, remote);
    expect(receive).toHaveBeenCalledWith(payload, remote);
    unsubscribe();
    socket.emit('message', payload, remote);
    expect(receive).toHaveBeenCalledTimes(1);
    await transport.close();
    const next = new FakeSocket();
    createSocket.mockReturnValue(next);
    await transport.open();
    const nextReceive = vi.fn();
    transport.onMessage(nextReceive);
    socket.emit('message', payload, remote);
    expect(nextReceive).not.toHaveBeenCalled();
    next.emit('message', payload, remote);
    expect(nextReceive).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('rejects an opening socket on error and safely handles late error events', async () => {
    socket.bind.mockImplementation(() => {});
    const transport = new NodeGoveeTransport();
    transport.onError(() => { throw new Error('subscriber failure'); });
    const onError = vi.fn();
    transport.onError(onError);
    const opening = transport.open();
    const failed = expect(opening).rejects.toThrow('socket failure');
    const error = new Error('socket failure');
    socket.emit('error', error);
    await failed;
    expect(onError).toHaveBeenCalledWith(error);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(() => socket.emit('error', new Error('late failure'))).not.toThrow();
    await transport.close();
  });

  it('rejects pending open on close and allows reopening', async () => {
    socket.bind.mockImplementation(() => {});
    const transport = new NodeGoveeTransport();
    const opening = transport.open();
    const failed = expect(opening).rejects.toThrow('closed');
    await transport.close();
    await failed;
    createSocket.mockReturnValue(new FakeSocket());
    await transport.open();
    await transport.close();
  });

  it('rejects synchronous bind and multicast membership failures', async () => {
    socket.bind.mockImplementation(() => { throw new Error('bind failed'); });
    const transport = new NodeGoveeTransport();
    await expect(transport.open()).rejects.toThrow('bind failed');
    const next = new FakeSocket();
    next.addMembership.mockImplementation(() => { throw new Error('membership failed'); });
    createSocket.mockReturnValue(next);
    await expect(transport.open()).rejects.toThrow('membership failed');
    await transport.close();
  });

  it('rejects socket creation failures and can retry opening', async () => {
    createSocket.mockImplementationOnce(() => { throw new Error('socket creation failed'); });
    const transport = new NodeGoveeTransport();
    await expect(transport.open()).rejects.toThrow('socket creation failed');
    await transport.open();
    await transport.close();
  });

  it('rejects closed sends, callback failures and pending sends on socket error or shutdown', async () => {
    const transport = new NodeGoveeTransport();
    await expect(transport.send(Buffer.from('x'), '192.168.1.20', 4003)).rejects.toThrow('not open');
    await transport.open();
    socket.send.mockImplementationOnce((_payload, _port, _address, callback) => callback(new Error('send failed')));
    await expect(transport.send(Buffer.from('x'), '192.168.1.20', 4003)).rejects.toThrow('send failed');
    socket.send.mockImplementation(() => {});
    const pending = transport.send(Buffer.from('x'), '192.168.1.20', 4003);
    const failed = expect(pending).rejects.toThrow('socket failed');
    socket.emit('error', new Error('socket failed'));
    await failed;
    const next = new FakeSocket();
    next.send.mockImplementation(() => {});
    createSocket.mockReturnValue(next);
    await transport.open();
    const closingSend = transport.send(Buffer.from('x'), '192.168.1.20', 4003);
    const closed = expect(closingSend).rejects.toThrow('closed');
    await transport.close();
    await closed;
  });
});

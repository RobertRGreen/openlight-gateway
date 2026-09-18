import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFeitTransport } from '../src/adapters/feit/transport.js';
import { CONTROL, DP_QUERY, encodeFrame, encodeQuery } from '../src/adapters/feit/protocol.js';
const { Socket } = vi.hoisted(() => ({ Socket: vi.fn() }));
vi.mock('node:net', () => ({ Socket }));
class FakeSocket extends EventEmitter {
  connect = vi.fn();
  write = vi.fn((_packet: Uint8Array, callback: (error?: Error) => void) => { callback(); return true; });
  destroy = vi.fn();
}
const packet = encodeFrame(7, DP_QUERY, encodeQuery({ devId: 'bulb' }));
const response = encodeFrame(7, DP_QUERY, encodeQuery({ dps: { '20': true } }));
const context = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
describe('Feit production TCP transport with mocked node:net', () => {
  let socket: FakeSocket;
  let transport: NodeFeitTransport;
  beforeEach(() => { vi.clearAllMocks(); socket = new FakeSocket(); Socket.mockReturnValue(socket); transport = new NodeFeitTransport(); });
  afterEach(async () => { await transport.close(); vi.useRealTimers(); });
  it('connects only to configured TCP port 6668 and reassembles fragmented/coalesced correlated frames', async () => {
    const pending = transport.request('192.168.1.42', packet, context());
    expect(socket.connect).toHaveBeenCalledWith(6668, '192.168.1.42');
    socket.emit('connect'); expect(socket.write).toHaveBeenCalledWith(packet, expect.any(Function));
    const unrelated = encodeFrame(6, DP_QUERY, encodeQuery({}));
    const wrongCommand = encodeFrame(7, 7, encodeQuery({}));
    const bytes = Buffer.concat([unrelated, wrongCommand, response]);
    socket.emit('data', bytes.subarray(0, 5));
    socket.emit('data', bytes.subarray(5, 17));
    socket.emit('data', bytes.subarray(17));
    await expect(pending).resolves.toEqual(response);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.listenerCount('data')).toBe(0);
    expect(() => socket.emit('error', new Error('late error'))).not.toThrow();
  });
  it('maps an elapsed response deadline to TIMEOUT and cleans up', async () => {
    vi.useFakeTimers();
    const pending = transport.request('192.168.1.42', packet, context());
    const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1001); await failed;
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it('handles cancellation and disconnect with listener cleanup', async () => {
    const controller = new AbortController();
    const pending = transport.request('192.168.1.42', packet, { signal: controller.signal, deadlineAt: Date.now() + 1000 });
    const failed = expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    controller.abort(); await failed;
    const second = transport.request('192.168.1.42', packet, context());
    const closed = expect(second).rejects.toMatchObject({ code: 'OFFLINE' });
    await transport.close(); await closed;
  });
  it.each([0, 7, 65536, 0xffffffff])('rejects invalid advertised payload length %s', async length => {
    const pending = transport.request('192.168.1.42', packet, context());
    const failed = expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    const header = Buffer.from(response.subarray(0, 16)); header.writeUInt32BE(length, 12);
    socket.emit('data', header); await failed;
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it('rejects a truncated peer response on connection close', async () => {
    const pending = transport.request('192.168.1.42', packet, context());
    const failed = expect(pending).rejects.toMatchObject({ code: 'OFFLINE' });
    socket.emit('data', response.subarray(0, 18)); socket.emit('end'); await failed;
  });
  it.each([false, true])('sanitizes socket error messages (connected=%s)', async connected => {
    const pending = transport.request('192.168.1.42', packet, context());
    const failed = expect(pending).rejects.toMatchObject({ code: connected ? 'TRANSPORT_ERROR' : 'OFFLINE', message: connected ? 'Feit TCP socket failed' : 'Feit TCP connection failed' });
    if (connected) socket.emit('connect');
    socket.emit('error', new Error('0123456789abcdef')); await failed;
  });
  it('sanitizes synchronous socket creation and cleanup failures', async () => {
    Socket.mockImplementationOnce(() => { throw new Error('0123456789abcdef'); });
    await expect(transport.request('192.168.1.42', packet, context())).rejects.toMatchObject({ code: 'OFFLINE', message: 'Feit TCP connection failed' });
    const pending = transport.request('192.168.1.42', packet, context());
    const failed = expect(pending).rejects.toMatchObject({ code: 'OFFLINE', message: 'Feit transport closed' });
    socket.destroy.mockImplementationOnce(() => { throw new Error('0123456789abcdef'); });
    await transport.close(); await failed;
  });
  it.each([undefined, Buffer.alloc(0), Buffer.from('arbitrary undocumented ACK'), Buffer.from([0, 0, 0, 9])])('sends CONTROL then DP_QUERY without depending on any CONTROL response (%s)', async ackPayload => {
    const control = encodeFrame(6, CONTROL, Buffer.from('ciphertext placeholder'));
    const pending = transport.request('192.168.1.42', packet, context(), control);
    socket.emit('connect');
    expect(socket.write).toHaveBeenCalledTimes(2);
    expect(socket.write).toHaveBeenNthCalledWith(1, control, expect.any(Function));
    expect(socket.write).toHaveBeenNthCalledWith(2, packet, expect.any(Function));
    if (ackPayload !== undefined) socket.emit('data', encodeFrame(6, CONTROL, ackPayload));
    socket.emit('data', response);
    await expect(pending).resolves.toEqual(response);
  });
  it('waits only for local CONTROL flushing before writing QUERY, and cancels safely during that flush', async () => {
    const control = encodeFrame(6, CONTROL, Buffer.alloc(0));
    let flushed!: (error?: Error) => void;
    socket.write.mockImplementationOnce((_bytes, callback) => { flushed = callback; return true; });
    const pending = transport.request('192.168.1.42', packet, context(), control);
    const failed = expect(pending).rejects.toMatchObject({ code: 'OFFLINE', delivery: 'unknown' });
    socket.emit('connect');
    expect(socket.write).toHaveBeenCalledTimes(1);
    await transport.close(); await failed;
    flushed();
    expect(socket.write).toHaveBeenCalledTimes(1);
  });
  it('sanitizes CONTROL write callback errors and does not send QUERY after failure', async () => {
    const control = encodeFrame(6, CONTROL, Buffer.alloc(0));
    socket.write.mockImplementationOnce((_bytes, callback) => { callback(new Error('0123456789abcdef')); return false; });
    const pending = transport.request('192.168.1.42', packet, context(), control);
    const failed = expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', message: 'Feit TCP write failed', delivery: 'unknown' });
    socket.emit('connect'); await failed;
    expect(socket.write).toHaveBeenCalledTimes(1);
  });
});

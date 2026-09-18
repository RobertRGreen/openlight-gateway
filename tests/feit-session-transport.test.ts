import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFeitTransport } from '../src/adapters/feit/transport.js';
import { CONTROL_NEW, DP_QUERY_NEW, decodeSessionFrame, decryptSessionPayload, decryptHandshake, deriveSessionKey, encodeSessionFrame, encryptHandshake, encryptSessionPayload } from '../src/adapters/feit/protocol.js';
import type { SessionVersion } from '../src/adapters/feit/protocol.js';
const { Socket } = vi.hoisted(() => ({ Socket: vi.fn() }));
vi.mock('node:net', () => ({ Socket }));
class FakeSocket extends EventEmitter {
  connect = vi.fn();
  write = vi.fn((_bytes: Uint8Array, callback: (error?: Error) => void) => { callback(); return true; });
  destroy = vi.fn();
}
const localKey = '0123456789abcdef';
const context = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
const retcode = Buffer.alloc(4);

describe('Feit negotiated TCP sessions', () => {
  let socket: FakeSocket, transport: NodeFeitTransport;
  beforeEach(() => { vi.clearAllMocks(); socket = new FakeSocket(); Socket.mockReturnValue(socket); transport = new NodeFeitTransport(); });
  afterEach(async () => { await transport.close(); vi.useRealTimers(); });
  function authenticate(version: SessionVersion, responseSequence = 7, corrupt = false) {
    socket.emit('connect');
    const start = decodeSessionFrame(version, socket.write.mock.calls[0]![0], localKey);
    expect(start.command).toBe(3);
    expect(start.sequence).toBe(responseSequence === 600 ? 7 : responseSequence);
    const clientNonce = version === '3.4' ? decryptHandshake(version, start.payload, localKey) : start.payload;
    const deviceNonce = Buffer.alloc(16, 0x42);
    const proof = createHmac('sha256', localKey).update(clientNonce).digest();
    if (corrupt) proof[0] = proof[0]! ^ 1;
    const responseBody = Buffer.concat([deviceNonce, proof]);
    const payload = version === '3.4' ? encryptHandshake(version, responseBody, localKey) : responseBody;
    const response = encodeSessionFrame(version, responseSequence, 4, Buffer.concat([retcode, payload]), localKey);
    socket.emit('data', response.subarray(0, 5)); socket.emit('data', response.subarray(5, 17)); socket.emit('data', response.subarray(17));
    return { clientNonce, deviceNonce, key: deriveSessionKey(version, localKey, clientNonce, deviceNonce) };
  }
  it.each(['3.4', '3.5'] as const)('authenticates %s, sends FINISH before CONTROL_NEW+QUERY, and ignores CONTROL_NEW acknowledgments', async version => {
    const pending = transport.requestSession('192.168.1.42', { version, localKey, sequence: 7, queryPayload: {}, preceding: { payload: { protocol: 5, t: 1700000000, data: { dps: { '20': true } } } } }, context());
    const { deviceNonce, key } = authenticate(version, version === '3.5' ? 600 : 7);
    expect(socket.connect).toHaveBeenCalledWith(6668, '192.168.1.42');
    expect(socket.write).toHaveBeenCalledTimes(4);
    const finish = decodeSessionFrame(version, socket.write.mock.calls[1]![0], localKey);
    expect(finish.command).toBe(5);
    expect(finish.sequence).toBe(8);
    expect(version === '3.4' ? decryptHandshake(version, finish.payload, localKey) : finish.payload).toEqual(createHmac('sha256', localKey).update(deviceNonce).digest());
    const control = decodeSessionFrame(version, socket.write.mock.calls[2]![0], key);
    const query = decodeSessionFrame(version, socket.write.mock.calls[3]![0], key);
    expect(control).toMatchObject({ command: 0x0d, sequence: 9 });
    expect(query).toMatchObject({ command: 0x10, sequence: 10 });
    expect(decryptSessionPayload(version, control.payload, key)).toEqual({ protocol: 5, t: 1700000000, data: { dps: { '20': true } } });
    expect(decryptSessionPayload(version, query.payload, key)).toEqual({});
    const ack = encodeSessionFrame(version, 9, CONTROL_NEW, Buffer.from('arbitrary authenticated acknowledgment'), key);
    const querySequence = version === '3.5' ? 601 : 10;
    const response = encodeSessionFrame(version, querySequence, DP_QUERY_NEW, Buffer.concat([retcode, encryptSessionPayload(version, { dps: { '20': true } }, key)]), key);
    socket.emit('data', Buffer.concat([ack, response]));
    await expect(pending).resolves.toMatchObject({ sequence: querySequence, command: DP_QUERY_NEW, payload: Buffer.from('{"dps":{"20":true}}') });
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it.each([
    ['3.4', 7], ['3.5', 7], ['3.4', 0xffffffff], ['3.5', 0xffffffff],
  ] as const)('increments every frame for a query-only %s session starting at %s', async (version, sequence) => {
    const pending = transport.requestSession('192.168.1.42', { version, localKey, sequence, queryPayload: {} }, context());
    const { key } = authenticate(version, sequence);
    expect(socket.write).toHaveBeenCalledTimes(3);
    const finish = decodeSessionFrame(version, socket.write.mock.calls[1]![0], localKey);
    const query = decodeSessionFrame(version, socket.write.mock.calls[2]![0], key);
    expect(finish).toMatchObject({ command: 5, sequence: (sequence + 1) >>> 0 });
    expect(query).toMatchObject({ command: 0x10, sequence: (sequence + 2) >>> 0 });
    expect(decryptSessionPayload(version, query.payload, key)).toEqual({});
    const payload = Buffer.concat([retcode, encryptSessionPayload(version, { dps: { '20': true } }, key)]);
    socket.emit('data', encodeSessionFrame(version, query.sequence, 0x0a, payload, key));
    expect(socket.destroy).not.toHaveBeenCalled();
    socket.emit('data', encodeSessionFrame(version, query.sequence, 0x10, payload, key));
    await expect(pending).resolves.toMatchObject({ sequence: query.sequence, command: 0x10 });
  });
  it.each(['3.4', '3.5'] as const)('rejects %s unauthenticated nonce proofs before sending application data', async version => {
    const pending = transport.requestSession('192.168.1.42', { version, localKey, sequence: 7, queryPayload: {} }, context());
    const failed = expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', delivery: 'not_sent' });
    authenticate(version, 7, true); await failed;
    expect(socket.write).toHaveBeenCalledTimes(1); expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it('requires a new handshake and nonce after a disconnect', async () => {
    const request = { version: '3.5' as const, localKey, sequence: 7, queryPayload: {} };
    const first = transport.requestSession('192.168.1.42', request, context());
    const failed = expect(first).rejects.toMatchObject({ code: 'OFFLINE' });
    const { clientNonce } = authenticate('3.5'); socket.emit('end'); await failed;
    socket = new FakeSocket(); Socket.mockReturnValue(socket);
    const second = transport.requestSession('192.168.1.42', request, context());
    const closed = expect(second).rejects.toMatchObject({ code: 'OFFLINE' });
    socket.emit('connect');
    const start = decodeSessionFrame('3.5', socket.write.mock.calls[0]![0], localKey);
    expect(start.command).toBe(3); expect(start.payload).not.toEqual(clientNonce);
    expect(socket.write).toHaveBeenCalledTimes(1);
    await transport.close(); await closed;
  });
  it('cancels during handshake and never sends subsequent commands', async () => {
    const controller = new AbortController();
    const pending = transport.requestSession('192.168.1.42', { version: '3.5', localKey, sequence: 7, queryPayload: {} }, { ...context(), signal: controller.signal });
    const failed = expect(pending).rejects.toMatchObject({ code: 'CANCELED', delivery: 'not_sent' });
    socket.emit('connect'); controller.abort(); await failed;
    expect(socket.write).toHaveBeenCalledTimes(1); expect(socket.listenerCount('data')).toBe(0);
  });
  it('times out handshakes with no device response', async () => {
    vi.useFakeTimers();
    const pending = transport.requestSession('192.168.1.42', { version: '3.5', localKey, sequence: 7, queryPayload: {} }, context());
    const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', delivery: 'not_sent' });
    socket.emit('connect'); await vi.advanceTimersByTimeAsync(1001); await failed;
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it('keeps v3.4 sequence correlation for authenticated query responses', async () => {
    const pending = transport.requestSession('192.168.1.42', { version: '3.4', localKey, sequence: 7, queryPayload: {} }, context());
    const { key } = authenticate('3.4');
    const payload = Buffer.concat([retcode, encryptSessionPayload('3.4', { dps: { '20': true } }, key)]);
    socket.emit('data', encodeSessionFrame('3.4', 7, DP_QUERY_NEW, payload, key));
    expect(socket.destroy).not.toHaveBeenCalled();
    socket.emit('data', encodeSessionFrame('3.4', 9, DP_QUERY_NEW, payload, key));
    await expect(pending).resolves.toMatchObject({ sequence: 9, command: DP_QUERY_NEW });
  });
  it('does not send CONTROL_NEW or QUERY after cancellation during FINISH flushing', async () => {
    const controller = new AbortController();
    let flush!: (error?: Error) => void;
    socket.write.mockImplementationOnce((_bytes, callback) => { callback(); return true; });
    socket.write.mockImplementationOnce((_bytes, callback) => { flush = callback; return true; });
    const pending = transport.requestSession('192.168.1.42', { version: '3.5', localKey, sequence: 7, queryPayload: {}, preceding: { payload: { protocol: 5, t: 1700000000, data: { dps: { '20': true } } } } }, { ...context(), signal: controller.signal });
    const failed = expect(pending).rejects.toMatchObject({ code: 'CANCELED', delivery: 'not_sent' });
    authenticate('3.5');
    expect(socket.write).toHaveBeenCalledTimes(2);
    controller.abort(); await failed; flush();
    expect(socket.write).toHaveBeenCalledTimes(2);
  });
  it('maps failed GCM authentication to a sanitized transport error', async () => {
    const pending = transport.requestSession('192.168.1.42', { version: '3.5', localKey, sequence: 7, queryPayload: {} }, context());
    const failed = expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', message: 'Invalid Feit response frame' });
    const { key } = authenticate('3.5');
    const response = encodeSessionFrame('3.5', 123, DP_QUERY_NEW, Buffer.concat([retcode, encryptSessionPayload('3.5', { dps: { '20': true } }, key)]), key);
    response[6] = response[6]! ^ 1; socket.emit('data', response); await failed;
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});

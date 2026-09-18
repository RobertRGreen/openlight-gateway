import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONTROL_NEW, DP_QUERY_NEW, SESS_KEY_NEG_START, SESS_KEY_NEG_RESP, SESS_KEY_NEG_FINISH, decodeSessionFrame, decryptHandshake, decryptSessionPayload, deriveSessionKey, encodeSessionFrame, encryptHandshake, encryptSessionPayload, frameLength, handshakeFinish, handshakeStart, hsvJsonToRgb, rgbToHsvJson, rgbToHsvHex, hsvHexToRgb } from '../src/adapters/feit/protocol.js';

const key = '0123456789abcdef';
const client = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const device = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
const json = { dps: { '20': true, '24': { h: 120, s: 1000, v: 1000 } } };

function rawEcb(bytes: Buffer, decrypt = false): Buffer {
  const cipher = decrypt ? createDecipheriv('aes-128-ecb', Buffer.from(key), null) : createCipheriv('aes-128-ecb', Buffer.from(key), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

describe.each(['3.4', '3.5'] as const)('Tuya %s session handshake', version => {
  it('round-trips START, authenticated RESP and FINISH under the static key', () => {
    const start = handshakeStart(version, key, client);
    const startFrame = decodeSessionFrame(version, encodeSessionFrame(version, 1, SESS_KEY_NEG_START, start.payload, key), key);
    expect(startFrame.command).toBe(3);
    expect(start.payload).toEqual(version === '3.4' ? rawEcb(client) : client);
    expect(startFrame.payload).toEqual(version === '3.4' ? rawEcb(client) : client);
    expect(decryptHandshake(version, startFrame.payload, key)).toEqual(client);
    const responseBody = Buffer.concat([device, createHmac('sha256', key).update(client).digest()]);
    const response = version === '3.4' ? rawEcb(responseBody) : responseBody;
    expect(encryptHandshake(version, responseBody, key)).toEqual(response);
    const responseFrame = decodeSessionFrame(version, encodeSessionFrame(version, 2, SESS_KEY_NEG_RESP, Buffer.concat([Buffer.alloc(4), response]), key), key);
    const finish = handshakeFinish(version, key, start.clientNonce, responseFrame.payload.subarray(4));
    expect(finish.deviceNonce).toEqual(device);
    const finishFrame = decodeSessionFrame(version, encodeSessionFrame(version, 3, SESS_KEY_NEG_FINISH, finish.payload, key), key);
    expect(version === '3.4' ? rawEcb(finishFrame.payload, true) : finishFrame.payload).toEqual(createHmac('sha256', key).update(device).digest());
    expect(() => handshakeFinish(version, key, Buffer.alloc(16), response)).toThrow(/authentication/);
    expect(() => handshakeFinish(version, key, client, response.subarray(1))).toThrow();
  });
  it('derives the exact stable sixteen-byte session key from constructed crypto vectors', () => {
    const mixed = Buffer.from(client.map((value, i) => value ^ device[i]!));
    let expected: Buffer;
    if (version === '3.4') expected = rawEcb(mixed);
    else {
      const cipher = createCipheriv('aes-128-gcm', Buffer.from(key), client.subarray(0, 12));
      const ciphertext = Buffer.concat([cipher.update(mixed), cipher.final()]);
      const tag = cipher.getAuthTag();
      const decipher = createDecipheriv('aes-128-gcm', Buffer.from(key), client.subarray(0, 12));
      decipher.setAuthTag(tag);
      expect(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toEqual(mixed);
      expected = ciphertext;
    }
    expect(deriveSessionKey(version, key, client, device)).toEqual(expected);
    expect(deriveSessionKey(version, key, client, device)).toHaveLength(16);
    expect(deriveSessionKey(version, key, client, device)).toEqual(deriveSessionKey(version, key, client, device));
    expect(() => deriveSessionKey(version, key, client.subarray(1), device)).toThrow();
  });
  it('rejects malformed/truncated/oversized frames and corrupted authenticated payloads', () => {
    const session = deriveSessionKey(version, key, client, device);
    const frame = encodeSessionFrame(version, 9, DP_QUERY_NEW, encryptSessionPayload(version, json, session), session);
    for (let size = 0; size < frame.length; size++) expect(() => decodeSessionFrame(version, frame.subarray(0, size), session)).toThrow();
    expect(() => decodeSessionFrame(version, Buffer.concat([frame, Buffer.alloc(1)]), session)).toThrow();
    for (const offset of [0, 8, 16, frame.length - 21, frame.length - 1]) {
      const corrupt = Buffer.from(frame); corrupt[offset] ^= 1;
      expect(() => decodeSessionFrame(version, corrupt, session)).toThrow();
    }
    expect(() => encodeSessionFrame(version, 0, DP_QUERY_NEW, Buffer.alloc(65536), session)).toThrow();
  });
});

describe('authenticated Tuya framing', () => {
  it('uses only GCM for v3.5 START/FINISH and authenticates the raw client nonce in RESP', () => {
    const start = handshakeStart('3.5', key, client);
    const gcmPlaintext = (frame: Buffer): Buffer => {
      const decipher = createDecipheriv('aes-128-gcm', Buffer.from(key), frame.subarray(18, 30));
      decipher.setAAD(frame.subarray(4, 18));
      decipher.setAuthTag(frame.subarray(-20, -4));
      return Buffer.concat([decipher.update(frame.subarray(30, -20)), decipher.final()]);
    };
    expect(gcmPlaintext(encodeSessionFrame('3.5', 1, SESS_KEY_NEG_START, start.payload, key))).toEqual(client);
    expect(start.payload).not.toEqual(rawEcb(client));
    const proof = createHmac('sha256', key).update(client).digest();
    const response = encodeSessionFrame('3.5', 2, SESS_KEY_NEG_RESP, Buffer.concat([Buffer.alloc(4), device, proof]), key);
    const body = decodeSessionFrame('3.5', response, key).payload.subarray(4);
    expect(body).toEqual(Buffer.concat([device, proof]));
    const finish = handshakeFinish('3.5', key, client, body);
    const finishProof = createHmac('sha256', key).update(device).digest();
    expect(finish.deviceNonce).toEqual(device);
    expect(finish.payload).toEqual(finishProof);
    expect(gcmPlaintext(encodeSessionFrame('3.5', 3, SESS_KEY_NEG_FINISH, finish.payload, key))).toEqual(finishProof);
    const ciphertextProof = createHmac('sha256', key).update(rawEcb(client)).digest();
    expect(() => handshakeFinish('3.5', key, client, Buffer.concat([device, ciphertextProof]))).toThrow(/authentication/);
  });
  it('places a v3.4 encrypted version header inside ECB and HMACs with session key', () => {
    const session = deriveSessionKey('3.4', key, client, device);
    const payload = encryptSessionPayload('3.4', json, session);
    const decipher = createDecipheriv('aes-128-ecb', session, null);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    expect(plaintext.subarray(0, 15)).toEqual(Buffer.concat([Buffer.from('3.4'), Buffer.alloc(12)]));
    const frame = encodeSessionFrame('3.4', 7, CONTROL_NEW, Buffer.concat([Buffer.alloc(4), payload]), session);
    expect(frame.readUInt32BE(12)).toBe(frame.length - 16);
    expect(frame.subarray(-36, -4)).toEqual(createHmac('sha256', session).update(frame.subarray(0, -36)).digest());
    expect(() => decodeSessionFrame('3.4', frame, key)).toThrow(/HMAC/);
    expect(decryptSessionPayload('3.4', decodeSessionFrame('3.4', frame, session).payload.subarray(4), session)).toEqual(json);
  });
  it('uses exact 6699 length/AAD, keeps retcode encrypted and rejects AAD/tag tampering', () => {
    const session = deriveSessionKey('3.5', key, client, device);
    const payload = Buffer.concat([Buffer.alloc(4), encryptSessionPayload('3.5', json, session)]);
    const frame = encodeSessionFrame('3.5', 19, DP_QUERY_NEW, payload, session);
    expect(frame.readUInt32BE(0)).toBe(0x6699);
    expect(frame.readUInt16BE(4)).toBe(0);
    expect(frame.readUInt32BE(14)).toBe(12 + payload.length + 16);
    expect(frameLength(frame.subarray(0, 18), '3.5')).toBe(frame.length);
    const decipher = createDecipheriv('aes-128-gcm', session, frame.subarray(18, 30));
    decipher.setAAD(frame.subarray(4, 18)); decipher.setAuthTag(frame.subarray(-20, -4));
    expect(Buffer.concat([decipher.update(frame.subarray(30, -20)), decipher.final()])).toEqual(payload);
    expect(decryptSessionPayload('3.5', decodeSessionFrame('3.5', frame, session).payload.subarray(4), session)).toEqual(json);
    for (const offset of [6, 10, frame.length - 20]) {
      const corrupt = Buffer.from(frame); corrupt[offset] ^= 1;
      expect(() => decodeSessionFrame('3.5', corrupt, session)).toThrow(/GCM authentication/);
    }
    expect(() => decodeSessionFrame('3.5', frame, key)).toThrow(/GCM authentication/);
  });
  it('generates fresh IVs for every frame and fresh client nonces per handshake', () => {
    const ivs = Array.from({ length: 100 }, () => encodeSessionFrame('3.5', 1, CONTROL_NEW, Buffer.alloc(0), key).subarray(18, 30).toString('hex'));
    expect(new Set(ivs).size).toBe(ivs.length);
    expect(handshakeStart('3.5', key).clientNonce).not.toEqual(handshakeStart('3.5', key).clientNonce);
  });
});

describe('JSON HSV colour codec', () => {
  it.each([{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }, { r: 128, g: 128, b: 128 }, { r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }])('shares legacy conversion math for %j', rgb => {
    expect(hsvJsonToRgb(rgbToHsvJson(rgb))).toEqual(rgb);
    expect(hsvJsonToRgb(rgbToHsvJson(rgb))).toEqual(hsvHexToRgb(rgbToHsvHex(rgb)));
  });
  it('validates runtime shape, finite channels and ranges', () => {
    for (const value of [null, [], '000003e803e8', {}, { h: '0', s: 1000, v: 1000 }, { h: NaN, s: 1, v: 1 }, { h: 361, s: 1, v: 1 }, { h: 0, s: -1, v: 1 }, { h: 0, s: 1, v: Infinity }]) expect(() => hsvJsonToRgb(value)).toThrow();
    expect(hsvJsonToRgb({ h: 360, s: 1000, v: 1000 })).toEqual({ r: 255, g: 0, b: 0 });
  });
});

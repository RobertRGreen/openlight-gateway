import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CONTROL, DP_QUERY, decodeFrame, decodeQuery, decryptControl, encodeFrame, encodeQuery, encryptControl, hsvHexToRgb, rgbToHsvHex } from '../src/adapters/feit/protocol.js';

const key = '0123456789abcdef';
describe('Tuya v3.3 protocol', () => {
  it('uses the standard CRC32 vector and independently constructed framing vector', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const packet = encodeFrame(1, DP_QUERY, encodeQuery({ dps: { '20': true } }));
    expect(packet.toString('hex')).toBe('000055aa000000010000000a0000001b7b22647073223a7b223230223a747275657d7da75137290000aa55');
    const parsed = decodeFrame(packet);
    expect(parsed.sequence).toBe(1);
    expect(parsed.command).toBe(DP_QUERY);
    expect(decodeQuery(parsed.payload)).toEqual({ dps: { '20': true } });
  });
  it('matches an OpenSSL AES-128-ECB PKCS7 vector with the clear version prefix first', () => {
    const json = { dps: { '20': true } };
    const payload = encryptControl(json, key);
    // Independently generated with openssl enc -aes-128-ecb using the key's raw bytes.
    expect(payload.toString('hex')).toBe('332e330000000000000000000000006c43740537c46421392c83bfa222a5ee31836d84bd28cb4b20619eb84882ca2a');
    expect(decryptControl(decodeFrame(encodeFrame(42, CONTROL, payload)).payload, key)).toEqual(json);
  });
  it('rejects corrupt, truncated, oversized and malformed frames without unsafe reads', () => {
    const packet = encodeFrame(0, DP_QUERY, encodeQuery({}));
    for (let size = 0; size < packet.length; size++) expect(() => decodeFrame(packet.subarray(0, size))).toThrow();
    for (const offset of [0, 12, 16, packet.length - 8, packet.length - 1]) {
      const corrupt = Buffer.from(packet); corrupt[offset] ^= 1;
      expect(() => decodeFrame(corrupt)).toThrow();
    }
    expect(() => decodeFrame(Buffer.concat([packet, Buffer.alloc(1)]))).toThrow();
    const huge = Buffer.from(packet); huge.writeUInt32BE(0xffffffff, 12);
    expect(() => decodeFrame(huge)).toThrow();
    expect(() => encodeFrame(0, 10, Buffer.alloc(65536))).toThrow();
  });
  it.each([
    [{ r: 255, g: 0, b: 0 }, '000003e803e8'],
    [{ r: 0, g: 255, b: 0 }, '007803e803e8'],
    [{ r: 0, g: 0, b: 255 }, '00f003e803e8'],
    [{ r: 255, g: 255, b: 255 }, '0000000003e8'],
    [{ r: 0, g: 0, b: 0 }, '000000000000'],
    [{ r: 128, g: 128, b: 128 }, '0000000001f6'],
  ])('encodes RGB %j as HSV %s', (rgb, hex) => {
    expect(rgbToHsvHex(rgb)).toBe(hex);
    expect(hsvHexToRgb(hex)).toEqual(rgb);
  });
  it('accepts hue 360 and rejects malformed HSV channels', () => {
    expect(hsvHexToRgb('016803e803e8')).toEqual({ r: 255, g: 0, b: 0 });
    for (const hex of ['016903e803e8', '000003e903e8', '0000000003e9', 'not hex']) expect(() => hsvHexToRgb(hex)).toThrow();
  });
  it('never echoes secrets in malformed JSON, keys or ciphertext errors', () => {
    const checks = [() => decodeQuery(Buffer.from(key)), () => encryptControl({}, `${key}extra`), () => decryptControl(Buffer.from(key), key), () => encryptControl({ toJSON() { throw new Error(key); } }, key)];
    for (const check of checks) {
      expect(check).toThrow();
      try { check(); } catch (error) { expect(String(error)).not.toContain(key); }
    }
  });
});

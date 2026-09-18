import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { RGB } from '../../core/model.js';

export const CONTROL = 0x07;
export const DP_QUERY = 0x0a;
export const CONTROL_NEW = 0x0d;
export const DP_QUERY_NEW = 0x10;
export const MAX_FRAME_BYTES = 65536;
const PREFIX = 0x000055aa;
const FOOTER = 0x0000aa55;
const VERSION_HEADER = Buffer.concat([Buffer.from('3.3'), Buffer.alloc(12)]);

export function encodeFrame(sequence: number, command: number, payload: Uint8Array): Buffer {
  for (const value of [sequence, command]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid Tuya frame integer');
  }
  if (payload.byteLength > MAX_FRAME_BYTES - 24) throw new Error('Tuya frame exceeds size limit');
  const frame = Buffer.alloc(24 + payload.byteLength);
  frame.writeUInt32BE(PREFIX, 0);
  frame.writeUInt32BE(sequence, 4);
  frame.writeUInt32BE(command, 8);
  frame.writeUInt32BE(payload.byteLength + 8, 12);
  frame.set(payload, 16);
  frame.writeUInt32BE(crc32(frame.subarray(0, frame.length - 8)), frame.length - 8);
  frame.writeUInt32BE(FOOTER, frame.length - 4);
  return frame;
}

/** Return the full frame length once a TCP stream contains the complete header. */
export function frameLength(header: Uint8Array, version?: SessionVersion): number {
  if (version === '3.5') {
    if (header.byteLength < 18) throw new Error('Truncated Tuya frame header');
    const bytes = Buffer.from(header);
    if (bytes.readUInt32BE(0) !== 0x00006699 || bytes.readUInt16BE(4) !== 0) throw new Error('Invalid Tuya frame prefix');
    const length = bytes.readUInt32BE(14) + 22;
    if (length < 50 || length > MAX_FRAME_BYTES) throw new Error('Invalid Tuya frame length');
    return length;
  }
  if (header.byteLength < 16) throw new Error('Truncated Tuya frame header');
  const bytes = Buffer.from(header);
  if (bytes.readUInt32BE(0) !== PREFIX) throw new Error('Invalid Tuya frame prefix');
  const length = bytes.readUInt32BE(12) + 16;
  if (length < (version === '3.4' ? 52 : 24) || length > MAX_FRAME_BYTES) throw new Error('Invalid Tuya frame length');
  return length;
}

export function decodeFrame(packet: Uint8Array): { sequence: number; command: number; payload: Buffer } {
  const frame = Buffer.from(packet);
  if (frameLength(frame) !== frame.length) throw new Error('Truncated or oversized Tuya frame');
  if (frame.readUInt32BE(frame.length - 4) !== FOOTER) throw new Error('Invalid Tuya frame footer');
  if (frame.readUInt32BE(frame.length - 8) !== crc32(frame.subarray(0, frame.length - 8))) {
    throw new Error('Invalid Tuya frame CRC32');
  }
  return { sequence: frame.readUInt32BE(4), command: frame.readUInt32BE(8), payload: Buffer.from(frame.subarray(16, -8)) };
}

function keyBytes(localKey: string): Buffer {
  if (typeof localKey !== 'string' || Buffer.byteLength(localKey, 'utf8') !== 16) throw new Error('Tuya local key must contain exactly 16 bytes');
  return Buffer.from(localKey, 'utf8');
}

export function encodeQuery(payload: unknown): Buffer {
  try {
    const json = JSON.stringify(payload);
    if (json === undefined) throw new Error();
    return Buffer.from(json, 'utf8');
  } catch { throw new Error('Invalid Tuya JSON payload'); }
}

export function decodeQuery(payload: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(payload).toString('utf8')) as unknown; }
  catch { throw new Error('Invalid Tuya JSON response'); }
}

/** v3.3 CONTROL: the 15 clear version bytes precede the PKCS7-padded ciphertext. */
export function encryptControl(payload: unknown, localKey: string): Buffer {
  const key = keyBytes(localKey);
  try {
    const cipher = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([VERSION_HEADER, cipher.update(encodeQuery(payload)), cipher.final()]);
  } catch { throw new Error('Unable to encrypt Tuya CONTROL payload'); }
}

export function decryptControl(payload: Uint8Array, localKey: string): unknown {
  const key = keyBytes(localKey);
  try {
    const bytes = Buffer.from(payload);
    if (!bytes.subarray(0, 15).equals(VERSION_HEADER) || bytes.length <= 15 || (bytes.length - 15) % 16 !== 0) throw new Error();
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return decodeQuery(Buffer.concat([decipher.update(bytes.subarray(15)), decipher.final()]));
  } catch { throw new Error('Invalid encrypted Tuya CONTROL payload'); }
}

export interface HsvJson { h: number; s: number; v: number }

export function rgbToHsvHex(rgb: RGB): string {
  const { h, s, v } = rgbToHsvJson(rgb);
  return [h, s, v].map(value => value.toString(16).padStart(4, '0')).join('');
}

export function rgbToHsvJson(rgb: RGB): HsvJson {
  if (![rgb.r, rgb.g, rgb.b].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw new Error('RGB channels must be integers between 0 and 255');
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { h: Math.round(hue), s: Math.round(max === 0 ? 0 : delta / max * 1000), v: Math.round(max * 1000) };
}

export function hsvHexToRgb(hex: string): RGB {
  if (typeof hex !== 'string' || !/^[\da-f]{12}$/i.test(hex)) throw new Error('Invalid Tuya HSV colour data');
  const h = Number.parseInt(hex.slice(0, 4), 16), s = Number.parseInt(hex.slice(4, 8), 16), v = Number.parseInt(hex.slice(8), 16);
  return hsvJsonToRgb({ h, s, v });
}

export function hsvJsonToRgb(value: unknown): RGB {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Tuya HSV colour data');
  const { h, s, v } = value as HsvJson;
  if (![h, s, v].every(channel => typeof channel === 'number' && Number.isFinite(channel)) || h < 0 || h > 360 || s < 0 || s > 1000 || v < 0 || v > 1000) throw new Error('Invalid Tuya HSV colour range');
  const chroma = v / 1000 * s / 1000, sector = h % 360 / 60, x = chroma * (1 - Math.abs(sector % 2 - 1)), m = v / 1000 - chroma;
  const channels = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return { r: Math.round((channels[0]! + m) * 255), g: Math.round((channels[1]! + m) * 255), b: Math.round((channels[2]! + m) * 255) };
}

export type SessionVersion = '3.4' | '3.5';
export const SESS_KEY_NEG_START = 0x03;
export const SESS_KEY_NEG_RESP = 0x04;
export const SESS_KEY_NEG_FINISH = 0x05;
type SessionKey = string | Uint8Array;

function sessionKeyBytes(key: SessionKey): Buffer {
  if (typeof key === 'string') return keyBytes(key);
  if (!(key instanceof Uint8Array) || key.byteLength !== 16) throw new Error('Tuya session key must contain exactly 16 bytes');
  return Buffer.from(key);
}

function ecb(payload: Uint8Array, key: SessionKey, decrypt: boolean, padding: boolean): Buffer {
  try {
    const cipher = decrypt ? createDecipheriv('aes-128-ecb', sessionKeyBytes(key), null) : createCipheriv('aes-128-ecb', sessionKeyBytes(key), null);
    cipher.setAutoPadding(padding);
    return Buffer.concat([cipher.update(payload), cipher.final()]);
  } catch { throw new Error('Invalid Tuya encrypted payload'); }
}

/** v3.4 uses unpadded ECB under the static key; v3.5 uses only frame-level GCM. */
export function encryptHandshake(version: SessionVersion, payload: Uint8Array, localKey: string): Buffer {
  if (![16, 32, 48].includes(payload.byteLength)) throw new Error('Invalid Tuya handshake length');
  return version === '3.4' ? ecb(payload, localKey, false, false) : Buffer.from(payload);
}

export function decryptHandshake(version: SessionVersion, payload: Uint8Array, localKey: string): Buffer {
  if (![16, 32, 48].includes(payload.byteLength)) throw new Error('Invalid Tuya handshake length');
  return version === '3.4' ? ecb(payload, localKey, true, false) : Buffer.from(payload);
}

export function handshakeStart(version: SessionVersion, localKey: string, nonce: Uint8Array = randomBytes(16)): { clientNonce: Buffer; payload: Buffer } {
  if (nonce.byteLength !== 16) throw new Error('Invalid Tuya client nonce');
  const clientNonce = Buffer.from(nonce);
  return { clientNonce, payload: encryptHandshake(version, clientNonce, localKey) };
}

export function handshakeFinish(version: SessionVersion, localKey: string, clientNonce: Uint8Array, response: Uint8Array): { deviceNonce: Buffer; payload: Buffer } {
  if (clientNonce.byteLength !== 16 || response.byteLength !== 48) throw new Error('Invalid Tuya handshake response');
  const decrypted = decryptHandshake(version, response, localKey);
  const expected = createHmac('sha256', keyBytes(localKey)).update(clientNonce).digest();
  if (!timingSafeEqual(expected, decrypted.subarray(16))) throw new Error('Invalid Tuya handshake authentication');
  const deviceNonce = Buffer.from(decrypted.subarray(0, 16));
  return { deviceNonce, payload: encryptHandshake(version, createHmac('sha256', keyBytes(localKey)).update(deviceNonce).digest(), localKey) };
}

export function deriveSessionKey(version: SessionVersion, localKey: string, clientNonce: Uint8Array, deviceNonce: Uint8Array): Buffer {
  if (clientNonce.byteLength !== 16 || deviceNonce.byteLength !== 16) throw new Error('Invalid Tuya session nonces');
  const mixed = Buffer.from(clientNonce.map((byte, index) => byte ^ deviceNonce[index]!));
  if (version === '3.4') return ecb(mixed, localKey, false, false);
  if (version !== '3.5') throw new Error('Unsupported Tuya session version');
  const cipher = createCipheriv('aes-128-gcm', keyBytes(localKey), clientNonce.subarray(0, 12));
  // Hardware-confirmed v3.5 key: raw GCM ciphertext of the XOR'd nonces.
  // Node does not prepend the IV like the Python reference wrapper, so no slice or tag is needed.
  return Buffer.concat([cipher.update(mixed), cipher.final()]);
}

/** v3.4 encrypts the version header with JSON; v3.5 encrypts it at the frame layer. */
export function encryptSessionPayload(version: SessionVersion, payload: unknown, key: SessionKey): Buffer {
  const bytes = Buffer.concat([Buffer.from(version), Buffer.alloc(12), encodeQuery(payload)]);
  return version === '3.4' ? ecb(bytes, key, false, true) : bytes;
}

/** Caller removes the response's four-byte return code first. */
export function decryptSessionPayload(version: SessionVersion, payload: Uint8Array, key: SessionKey): unknown {
  let bytes = version === '3.4' ? ecb(payload, key, true, true) : Buffer.from(payload);
  const header = Buffer.concat([Buffer.from(version), Buffer.alloc(12)]);
  if (bytes.subarray(0, 15).equals(header)) bytes = bytes.subarray(15);
  return decodeQuery(bytes);
}

/** v3.4 payload is ciphertext (with clear retcode on responses); v3.5 is plaintext. */
export function encodeSessionFrame(version: SessionVersion, sequence: number, command: number, payload: Uint8Array, key: SessionKey): Buffer {
  for (const value of [sequence, command]) if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid Tuya frame integer');
  const keyBuffer = sessionKeyBytes(key);
  const overhead = version === '3.4' ? 52 : 50;
  if (payload.byteLength > MAX_FRAME_BYTES - overhead) throw new Error('Tuya frame exceeds size limit');
  if (version === '3.4') {
    const frame = Buffer.alloc(payload.byteLength + 52);
    frame.writeUInt32BE(PREFIX, 0); frame.writeUInt32BE(sequence, 4); frame.writeUInt32BE(command, 8);
    frame.writeUInt32BE(payload.byteLength + 36, 12); frame.set(payload, 16);
    frame.set(createHmac('sha256', keyBuffer).update(frame.subarray(0, -36)).digest(), frame.length - 36);
    frame.writeUInt32BE(FOOTER, frame.length - 4);
    return frame;
  }
  if (version !== '3.5') throw new Error('Unsupported Tuya session version');
  const frame = Buffer.alloc(payload.byteLength + 50);
  frame.writeUInt32BE(0x00006699, 0); frame.writeUInt32BE(sequence, 6); frame.writeUInt32BE(command, 10);
  frame.writeUInt32BE(payload.byteLength + 28, 14);
  const iv = randomBytes(12); frame.set(iv, 18);
  const cipher = createCipheriv('aes-128-gcm', keyBuffer, iv);
  cipher.setAAD(frame.subarray(4, 18));
  frame.set(Buffer.concat([cipher.update(payload), cipher.final()]), 30);
  frame.set(cipher.getAuthTag(), frame.length - 20); frame.writeUInt32BE(0x00009966, frame.length - 4);
  return frame;
}

export function decodeSessionFrame(version: SessionVersion, packet: Uint8Array, key: SessionKey): { sequence: number; command: number; payload: Buffer } {
  const frame = Buffer.from(packet), keyBuffer = sessionKeyBytes(key);
  if (frameLength(frame, version) !== frame.length) throw new Error('Truncated or oversized Tuya frame');
  if (version === '3.4') {
    if (frame.readUInt32BE(frame.length - 4) !== FOOTER) throw new Error('Invalid Tuya frame footer');
    const expected = createHmac('sha256', keyBuffer).update(frame.subarray(0, -36)).digest();
    if (!timingSafeEqual(expected, frame.subarray(-36, -4))) throw new Error('Invalid Tuya frame HMAC');
    return { sequence: frame.readUInt32BE(4), command: frame.readUInt32BE(8), payload: Buffer.from(frame.subarray(16, -36)) };
  }
  if (version !== '3.5') throw new Error('Unsupported Tuya session version');
  if (frame.readUInt32BE(frame.length - 4) !== 0x00009966) throw new Error('Invalid Tuya frame footer');
  try {
    const decipher = createDecipheriv('aes-128-gcm', keyBuffer, frame.subarray(18, 30));
    decipher.setAAD(frame.subarray(4, 18)); decipher.setAuthTag(frame.subarray(-20, -4));
    const payload = Buffer.concat([decipher.update(frame.subarray(30, -20)), decipher.final()]);
    return { sequence: frame.readUInt32BE(6), command: frame.readUInt32BE(10), payload };
  } catch { throw new Error('Invalid Tuya frame GCM authentication'); }
}

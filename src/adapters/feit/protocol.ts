import { createCipheriv, createDecipheriv } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { RGB } from '../../core/model.js';

export const CONTROL = 0x07;
export const DP_QUERY = 0x0a;
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
export function frameLength(header: Uint8Array): number {
  if (header.byteLength < 16) throw new Error('Truncated Tuya frame header');
  const bytes = Buffer.from(header);
  if (bytes.readUInt32BE(0) !== PREFIX) throw new Error('Invalid Tuya frame prefix');
  const length = bytes.readUInt32BE(12) + 16;
  if (length < 24 || length > MAX_FRAME_BYTES) throw new Error('Invalid Tuya frame length');
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

export function rgbToHsvHex(rgb: RGB): string {
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
  return [Math.round(hue), Math.round(max === 0 ? 0 : delta / max * 1000), Math.round(max * 1000)]
    .map(value => value.toString(16).padStart(4, '0')).join('');
}

export function hsvHexToRgb(hex: string): RGB {
  if (typeof hex !== 'string' || !/^[\da-f]{12}$/i.test(hex)) throw new Error('Invalid Tuya HSV colour data');
  const h = Number.parseInt(hex.slice(0, 4), 16), s = Number.parseInt(hex.slice(4, 8), 16), v = Number.parseInt(hex.slice(8), 16);
  if (h > 360 || s > 1000 || v > 1000) throw new Error('Invalid Tuya HSV colour range');
  const chroma = v / 1000 * s / 1000, sector = h % 360 / 60, x = chroma * (1 - Math.abs(sector % 2 - 1)), m = v / 1000 - chroma;
  const channels = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return { r: Math.round((channels[0]! + m) * 255), g: Math.round((channels[1]! + m) * 255), b: Math.round((channels[2]! + m) * 255) };
}

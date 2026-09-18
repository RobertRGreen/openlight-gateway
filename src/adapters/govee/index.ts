import { isIPv4 } from 'node:net';
import { AdapterError } from '../types.js';
import type { AdapterDevice, AdapterEvent, CallContext, Capability, Color, DeviceState, LightingAdapter, Observation, SchedulingProfile, WriteReceipt } from '../types.js';
import type { GoveeTransport } from './transport.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
const packet = (cmd: string, data: ObjectValue) => Buffer.from(JSON.stringify({ msg: { cmd, data } }));

export interface GoveeAdapterOptions {
 transport: GoveeTransport;
 id?: string;
 discoveryTimeoutMs?: number;
 commandTimeoutMs?: number;
 logger?: { warn(message: string): void };
}

/** LAN only. Cloud fallback belongs in a separate, explicitly enabled implementation. */
export class GoveeAdapter implements LightingAdapter {
 readonly id: string;
 readonly scheduling: SchedulingProfile;
 private readonly transport: GoveeTransport;
 private readonly discoveryTimeoutMs: number;
 private readonly commandTimeoutMs: number;
 private readonly logger: { warn(message: string): void };
 private readonly devices = new Map<string, AdapterDevice>();
 private readonly listeners = new Set<(event: AdapterEvent) => void>();
 private readonly pending = new Set<(error: AdapterError) => void>();
 private connected = false;
 private generation = 0;
 private connecting: Promise<void> | undefined;
 private readonly busyDevices = new Set<string>();
 private removeError: (() => void) | undefined;

 constructor(options: GoveeAdapterOptions) {
  this.id = options.id ?? 'govee';
  this.transport = options.transport;
  this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 3000;
  this.commandTimeoutMs = options.commandTimeoutMs ?? 1500;
  this.logger = options.logger ?? { warn: message => console.warn(message) };
  for (const timeout of [this.discoveryTimeoutMs, this.commandTimeoutMs]) if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) throw new RangeError('Invalid Govee timeout');
  // A write uses at most three packets (setter and two status queries).
  this.scheduling = { budgets: [{ scope: 'adapter', key: this.id, maxRequests: 20, windowMs: 1000, burst: 5, maxConcurrent: 2 }], minUpdateIntervalMs: 100, estimatedLatencyMs: 100, recommendedPollIntervalMs: 30000 };
 }
 onEvent(listener: (event: AdapterEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
 private emit(event: AdapterEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* Consumer failures are isolated. */ } } }
 private check(context: CallContext): void {
  if (context.signal.aborted) throw new AdapterError('CANCELED', 'Govee call canceled');
  if (context.deadlineAt <= Date.now()) throw new AdapterError('TIMEOUT', 'Govee deadline exceeded', true);
 }
 private failure(error: unknown): AdapterError { return error instanceof AdapterError ? error : new AdapterError('TRANSPORT_ERROR', 'Govee UDP transport failed', true, 'unknown'); }
 private bounded<T>(context: CallContext, timeout: number, expired: () => T, start: (resolve: (value: T) => void, reject: (error: AdapterError) => void) => (() => void) | void): Promise<T> {
  this.check(context);
  return new Promise<T>((resolve, reject) => {
   let settled = false;
   let cleanup: (() => void) | void;
   const finish = (error?: AdapterError, value?: T) => {
    if (settled) return;
    settled = true; clearTimeout(timer); context.signal.removeEventListener('abort', abort); this.pending.delete(fail); cleanup?.();
    if (error) reject(error); else resolve(value as T);
   };
   const fail = (error: AdapterError) => finish(error);
   const abort = () => fail(new AdapterError('CANCELED', 'Govee call canceled', false, 'unknown'));
   const timer = setTimeout(() => { try { finish(undefined, expired()); } catch (error) { fail(this.failure(error)); } }, Math.min(timeout, context.deadlineAt - Date.now()));
   context.signal.addEventListener('abort', abort, { once: true }); this.pending.add(fail);
   try { cleanup = start(value => finish(undefined, value), fail); if (settled) cleanup?.(); } catch (error) { fail(this.failure(error)); }
  });
 }
 async connect(context: CallContext): Promise<void> {
  this.check(context); if (this.connected) return;
  if (this.connecting) return this.connecting;
  const generation = ++this.generation;
  this.removeError ??= this.transport.onError(() => {
   const error = new AdapterError('TRANSPORT_ERROR', 'Govee UDP transport failed', true, 'unknown');
   for (const fail of [...this.pending]) fail(error);
   this.generation++; this.connected = false; void this.transport.close().catch(() => {}); this.emit({ type: 'error', error }); this.emit({ type: 'connection', connected: false });
  });
  const attempt = (async () => {
   try {
    await this.bounded<void>(context, this.commandTimeoutMs, () => { throw new AdapterError('TIMEOUT', 'Govee connection timed out', true); }, (resolve, reject) => {
     void this.transport.open().then(() => resolve(), error => reject(this.failure(error)));
    });
    if (generation !== this.generation) throw new AdapterError('CANCELED', 'Govee connection superseded');
    this.check(context); this.connected = true; this.emit({ type: 'connection', connected: true });
   } catch (error) {
    if (generation === this.generation) {
     this.generation++; this.connected = false;
     // Production close cancels an in-flight bind and releases its socket.
     void this.transport.close().catch(() => {});
    }
    throw this.failure(error);
   }
  })();
  this.connecting = attempt;
  try { await attempt; } finally { if (this.connecting === attempt) this.connecting = undefined; }
 }
 async disconnect(context: CallContext): Promise<void> {
  this.generation++; this.connected = false;
  for (const fail of [...this.pending]) fail(new AdapterError('CANCELED', 'Govee adapter disconnected', false, 'unknown'));
  // Resource cleanup is initiated even when the caller's deadline has expired.
  let closing: Promise<void>;
  try { closing = this.transport.close(); } catch (error) { closing = Promise.reject(error); }
  const safeClosing = closing.catch(error => { throw this.failure(error); });
  // Attach rejection handling before checking an already canceled context.
  void safeClosing.catch(() => {});
  try {
   await this.bounded<void>(context, this.commandTimeoutMs, () => { throw new AdapterError('TIMEOUT', 'Govee shutdown timed out', true); }, (resolve, reject) => {
    void safeClosing.then(() => resolve(), error => reject(this.failure(error)));
   });
  } finally { this.removeError?.(); this.removeError = undefined; this.emit({ type: 'connection', connected: false }); }
 }
 private parse(payload: Uint8Array): { cmd: string; data: ObjectValue } | undefined {
  try {
   if (payload.byteLength > 8192) throw new Error();
   const body: unknown = JSON.parse(Buffer.from(payload).toString('utf8'));
   if (!object(body) || !object(body.msg) || typeof body.msg.cmd !== 'string' || !object(body.msg.data)) throw new Error();
   return { cmd: body.msg.cmd, data: body.msg.data };
  } catch { this.warn(); return undefined; }
 }
 private warn(): void { try { this.logger.warn('Skipped malformed or unexpected Govee LAN response'); } catch { /* Logger isolation. */ } }
 async *discover(context: CallContext): AsyncIterable<AdapterDevice> {
  await this.connect(context);
  const found = new Map<string, AdapterDevice>();
  // Discovery works only after the user enables LAN Control in Govee Home.
  await this.bounded<void>(context, this.discoveryTimeoutMs, () => undefined, (resolve, reject) => {
   const remove = this.transport.onMessage((payload, remote) => {
    const message = this.parse(payload); if (!message) return;
    if (message.cmd !== 'scan') { this.warn(); return; }
    const { device, sku } = message.data;
    if (typeof device !== 'string' || !/^(?:[0-9a-f]{2}:){5,7}[0-9a-f]{2}$/i.test(device) || typeof sku !== 'string' || !sku.length || sku.length > 128 || !isIPv4(remote.address)) { this.warn(); return; }
    // Use the actual UDP sender rather than an untrusted embedded IP address.
    const entry: AdapterDevice = { nativeId: device.toUpperCase(), name: `Govee ${sku}`, manufacturer: 'Govee', model: sku, address: { transport: 'lan', endpoint: remote.address }, extensions: {} };
    if (found.size >= 10000 && !found.has(entry.nativeId)) return;
    if (this.devices.size + found.size >= 10000 && !this.devices.has(entry.nativeId) && !found.has(entry.nativeId)) return;
    found.set(entry.nativeId, entry);
   });
   void this.transport.send(packet('scan', { account_topic: 'reserve' }), '239.255.255.250', 4001).catch(error => reject(this.failure(error)));
   return remove;
  });
  for (const entry of found.values()) { this.check(context); this.devices.set(entry.nativeId, entry); yield structuredClone(entry); }
 }
 async getDevices(context: CallContext): Promise<readonly AdapterDevice[]> { this.check(context); return structuredClone([...this.devices.values()]); }
 private endpoint(id: string): string { const endpoint = this.devices.get(id)?.address?.endpoint; if (!endpoint || !this.connected) throw new AdapterError('OFFLINE', 'Govee device unavailable', true); return endpoint; }
 async getCapabilities(id: string, context: CallContext): Promise<Capability[]> {
  this.check(context); if (!this.devices.has(id)) throw new AdapterError('OFFLINE', 'Unknown Govee device', true);
  return [{ type: 'power' }, { type: 'brightness', minimum: 0, maximum: 100, step: 1 }, { type: 'rgb' }];
 }
 private observation(data: ObjectValue): Observation | undefined {
  const state: DeviceState = {};
  if (data.onOff === 0 || data.onOff === 1) state.power = data.onOff === 1;
  if (integer(data.brightness, 100)) state.brightness = data.brightness;
  if ((data.colorTemInKelvin === undefined || data.colorTemInKelvin === 0) && object(data.color) && integer(data.color.r, 255) && integer(data.color.g, 255) && integer(data.color.b, 255)) state.rgb = { r: data.color.r, g: data.color.g, b: data.color.b };
  if (!Object.keys(state).length) return undefined;
  return { state, observedAt: new Date().toISOString(), complete: state.power !== undefined && state.brightness !== undefined && state.rgb !== undefined };
 }
 private async status(id: string, context: CallContext, write?: { cmd: string; data: ObjectValue; matches(state: DeviceState): boolean }): Promise<Observation> {
  this.check(context); const address = this.endpoint(id);
  let sent = false;
  let responded = false;
  let queries = 0;
  if (this.busyDevices.has(id)) throw new AdapterError('RATE_LIMITED', 'Govee device already has an active request', true, 'not_sent', this.commandTimeoutMs);
  this.busyDevices.add(id);
  try {
  const observation = await this.bounded<Observation>(context, this.commandTimeoutMs, () => {
   this.emit({ type: 'availability', nativeId: id, status: responded ? 'online' : 'offline' });
   throw new AdapterError(write ? 'TIMEOUT' : 'OFFLINE', write ? 'Govee write verification timed out' : 'Govee device did not respond', true, sent ? 'unknown' : 'not_sent');
  }, (resolve, reject) => {
   let active = true;
   let retry: ReturnType<typeof setTimeout> | undefined;
   const remove = this.transport.onMessage((payload, remote) => {
    if (!active || queries === 0 || remote.address !== address) return;
    const message = this.parse(payload); if (!message) return;
    if (message.cmd !== 'devStatus') { this.warn(); return; }
    const observed = this.observation(message.data); if (!observed) { this.warn(); return; }
    responded = true;
    this.emit({ type: 'observation', nativeId: id, observation: observed });
    if (!write || write.matches(observed.state)) resolve(observed);
   });
   const query = async () => {
    if (!active) return;
    this.check(context); queries++;
    await this.transport.send(packet('devStatus', {}), address, 4003);
   };
   void (async () => {
    // Govee setters have no reliable ACK. Never replay a setter; verify by status.
    if (write) { sent = true; await this.transport.send(packet(write.cmd, write.data), address, 4003); }
    await query();
    if (active) retry = setTimeout(() => { void query().catch(error => reject(this.failure(error))); }, Math.max(1, Math.min(this.commandTimeoutMs, context.deadlineAt - Date.now()) / 2));
   })().catch(error => reject(this.failure(error)));
   return () => { active = false; remove(); if (retry) clearTimeout(retry); };
  });
  this.emit({ type: 'availability', nativeId: id, status: 'online' }); return observation;
  } finally { this.busyDevices.delete(id); }
 }
 getState(id: string, context: CallContext): Promise<Observation> { return this.status(id, context); }
 private async write(id: string, cmd: string, data: ObjectValue, matches: (state: DeviceState) => boolean, context: CallContext): Promise<WriteReceipt> {
  const observation = await this.status(id, context, { cmd, data, matches });
  return { transport: 'lan', acknowledgment: 'applied', observation };
 }
 async setPower(id: string, on: boolean, context: CallContext): Promise<WriteReceipt> {
  if (typeof on !== 'boolean') throw new AdapterError('OUT_OF_RANGE', 'Power must be boolean');
  return this.write(id, 'turn', { value: on ? 1 : 0 }, state => state.power === on, context);
 }
 async setBrightness(id: string, percent: number, context: CallContext): Promise<WriteReceipt> {
  if (!integer(percent, 100)) throw new AdapterError('OUT_OF_RANGE', 'Brightness must be an integer from 0 to 100');
  return this.write(id, 'brightness', { value: percent }, state => state.brightness === percent, context);
 }
 async setColor(id: string, color: Color, context: CallContext): Promise<WriteReceipt> {
  if (!object(color)) throw new AdapterError('OUT_OF_RANGE', 'Color must be an object');
  if (color.mode !== 'rgb') throw new AdapterError('UNSUPPORTED_CAPABILITY', 'Govee LAN supports RGB only');
  if (!object(color.value)) throw new AdapterError('OUT_OF_RANGE', 'RGB must be an object');
  if (![color.value.r, color.value.g, color.value.b].every(value => integer(value, 255))) throw new AdapterError('OUT_OF_RANGE', 'RGB channels must be integer bytes');
  const rgb = { r: color.value.r, g: color.value.g, b: color.value.b };
  // Expected community Govee-LAN-Control shape: zero kelvin selects RGB.
  // Remote source/hardware verification is still required; no wire capture exists here.
  return this.write(id, 'colorwc', { color: rgb, colorTemInKelvin: 0 }, state => state.rgb?.r === rgb.r && state.rgb?.g === rgb.g && state.rgb?.b === rgb.b, context);
 }
 async setTemperature(_id: string, _kelvin: number, _context: CallContext): Promise<WriteReceipt> { throw new AdapterError('UNSUPPORTED_CAPABILITY', 'Govee LAN color temperature is not supported'); }
}

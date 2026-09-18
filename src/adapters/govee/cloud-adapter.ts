import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { AdapterError } from '../types.js';
import type { AdapterDevice, AdapterEvent, CallContext, Capability, Color, DeviceState, LightingAdapter, Observation, SchedulingProfile, WriteReceipt } from '../types.js';

type ObjectValue = Record<string, unknown>;
type CloudDevice = { device: AdapterDevice; capabilities: Capability[] };
type AccountQuota = { touched: number; tokens: number; refilled: number; discovery: number[]; state: Map<string, number[]>; active: Map<string, number>; next: Map<string, number> };
type Admission = { release(): void; rateLimited(retryAfterMs: number): void };
// Opaque hashes never leave this module. Instances sharing a credential share quotas.
const accounts = new Map<string, AccountQuota>();
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum;
const base = 'https://openapi.api.govee.com/router/api/v1';
const mapping = {
 power: { type: 'devices.capabilities.on_off', instance: 'powerSwitch' },
 brightness: { type: 'devices.capabilities.range', instance: 'brightness' },
 rgb: { type: 'devices.capabilities.color_setting', instance: 'colorRgb' },
 colorTemperature: { type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK' },
} as const;
type Field = keyof typeof mapping;

export interface GoveeCloudAdapterOptions {
 apiKey: string;
 commandTimeoutMs?: number;
 logger?: { warn(message: string): void };
}

/** Developer API v1; independent of LAN discovery and its hardware requirements. */
export class GoveeCloudAdapter implements LightingAdapter {
 readonly id = 'govee-cloud';
 readonly scheduling: SchedulingProfile;
 private readonly apiKey: string;
 private readonly commandTimeoutMs: number;
 private readonly accountKey: string;
 private readonly logger: { warn(message: string): void };
 private readonly devices = new Map<string, CloudDevice>();
 private readonly listeners = new Set<(event: AdapterEvent) => void>();
 private readonly pending = new Set<() => void>();
 private connected = false;
 constructor(options: GoveeCloudAdapterOptions) {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new AdapterError('AUTH_FAILED', 'Govee Cloud requires a valid API key');
  this.apiKey = options.apiKey.trim();
  this.accountKey = createHash('sha256').update(this.apiKey).digest('hex');
  this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
  if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs <= 0 || this.commandTimeoutMs > 2147483647) throw new RangeError('Invalid Govee Cloud timeout');
  this.logger = options.logger ?? { warn: message => console.warn(message) };
  this.scheduling = {
   budgetManagement: 'adapter',
   budgets: [
    { scope: 'account', key: 'govee-cloud-control', maxRequests: 12, windowMs: 1000, burst: 80, maxConcurrent: 12 },
    { scope: 'device', key: 'govee-cloud-state', maxRequests: 30, windowMs: 60000, burst: 30, maxConcurrent: 1 },
    { scope: 'account', key: 'govee-cloud-discovery', maxRequests: 30, windowMs: 60000, burst: 30, maxConcurrent: 1 },
   ],
   minUpdateIntervalMs: 0, estimatedLatencyMs: 1000, recommendedPollIntervalMs: 30000,
  };
 }
 onEvent(listener: (event: AdapterEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
 private emit(event: AdapterEvent): void { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* Consumer isolation. */ } } }
 private warn(): void { try { this.logger.warn('Skipped malformed Govee Cloud device or capability'); } catch { /* Logger isolation. */ } }
 private check(context: CallContext): void {
  if (context.signal.aborted) throw new AdapterError('CANCELED', 'Govee Cloud call canceled');
  if (context.deadlineAt <= Date.now()) throw new AdapterError('TIMEOUT', 'Govee Cloud deadline exceeded', true);
 }
 async connect(context: CallContext): Promise<void> { this.check(context); if (!this.connected) { this.connected = true; this.emit({ type: 'connection', connected: true }); } }
 async disconnect(_context: CallContext): Promise<void> { this.connected = false; for (const cancel of [...this.pending]) cancel(); this.emit({ type: 'connection', connected: false }); }
 private retryAfter(headers: Headers): number {
  const retry = headers.get('Retry-After');
  if (retry !== null) {
   const seconds = Number(retry); if (retry.trim() && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
   const date = Date.parse(retry); if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  for (const name of ['X-RateLimit-Reset', 'RateLimit-Reset', 'X-Rate-Limit-Reset']) {
   const reset = headers.get(name); if (!reset?.trim()) continue;
   const value = Number(reset);
   if (Number.isFinite(value) && value >= 0) return Math.ceil(value > 1e12 ? Math.max(0, value - Date.now()) : value > 1e9 ? Math.max(0, value * 1000 - Date.now()) : value * 1000);
   const date = Date.parse(reset); if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 5000;
 }
 private responseError(code: number, headers: Headers): AdapterError {
  if (code === 401 || code === 403) return new AdapterError('AUTH_FAILED', 'Govee Cloud authentication failed', false, 'acknowledged');
  if (code === 429) return new AdapterError('RATE_LIMITED', 'Govee Cloud rate limit exceeded', true, 'acknowledged', this.retryAfter(headers));
  if (code === 404) return new AdapterError('OFFLINE', 'Govee Cloud device unavailable', true, 'acknowledged');
  return new AdapterError('TRANSPORT_ERROR', 'Govee Cloud request failed', code >= 500, 'acknowledged');
 }
 private async acquire(path: string, nativeId: string | undefined, signal: AbortSignal): Promise<Admission> {
  while (true) {
   signal.throwIfAborted(); const now = performance.now();
   let quota = accounts.get(this.accountKey);
   if (!quota) {
    for (const [key, entry] of accounts) if (now - entry.touched >= 60000 && ![...entry.active.values()].some(count => count > 0) && ![...entry.next.values()].some(until => until > now)) accounts.delete(key);
    if (accounts.size >= 1000) throw new AdapterError('RATE_LIMITED', 'Govee Cloud quota capacity reached', true, 'not_sent', 60000);
    quota = { touched: now, tokens: 80, refilled: now, discovery: [], state: new Map(), active: new Map(), next: new Map() }; accounts.set(this.accountKey, quota);
   }
   quota.touched = now;
   const bucket = path === 'device/state' ? `state:${nativeId}` : path;
   let wait = Math.max(0, (quota.next.get(bucket) ?? 0) - now);
   if ((quota.active.get(bucket) ?? 0) >= (path === 'device/control' ? 12 : 1)) wait = Math.max(wait, 5);
   const admit = (): Admission => {
    quota.active.set(bucket, (quota.active.get(bucket) ?? 0) + 1);
    let released = false;
    return {
     release: () => { if (!released) { released = true; quota.active.set(bucket, (quota.active.get(bucket) ?? 1) - 1); quota.touched = performance.now(); } },
     rateLimited: retryAfterMs => { quota.next.set(bucket, Math.max(quota.next.get(bucket) ?? 0, performance.now() + retryAfterMs)); },
    };
   };
   if (path === 'device/control') {
    quota.tokens = Math.min(80, quota.tokens + (now - quota.refilled) * 12 / 1000); quota.refilled = now;
    if (quota.tokens >= 1 && wait <= 0) { quota.tokens--; return admit(); }
    wait = Math.max(wait, (1 - quota.tokens) * 1000 / 12);
   } else {
    const isState = path === 'device/state';
    for (const [id, times] of quota.state) if ((!times.length || now - times[times.length - 1]! >= 60000) && !(quota.active.get(`state:${id}`) ?? 0) && (quota.next.get(`state:${id}`) ?? 0) <= now) { quota.state.delete(id); quota.active.delete(`state:${id}`); quota.next.delete(`state:${id}`); }
    if (isState && !quota.state.has(nativeId!) && quota.state.size >= 10000) throw new AdapterError('RATE_LIMITED', 'Govee Cloud device quota capacity reached', true, 'not_sent', 60000);
    const times = (isState ? quota.state.get(nativeId!) ?? [] : quota.discovery).filter(time => time > now - 60000);
    if (isState) quota.state.set(nativeId!, times); else quota.discovery = times;
    if (times.length < 30 && wait <= 0) { times.push(now); return admit(); }
    if (times.length >= 30) wait = Math.max(wait, times[0]! + 60000 - now);
   }
   await delay(Math.max(1, Math.ceil(wait)), undefined, { signal });
  }
 }
 /** Race the entire request, including JSON body consumption, even if a fetch mock ignores abort. */
 private request(path: string, context: CallContext, payload?: ObjectValue): Promise<ObjectValue> {
  this.check(context);
  if (!this.connected) throw new AdapterError('OFFLINE', 'Govee Cloud adapter disconnected', true);
  const controller = new AbortController();
  return new Promise<ObjectValue>((resolve, reject) => {
   let settled = false; let dispatched = false; let admission: Admission | undefined;
   const finish = (error?: AdapterError, value?: ObjectValue) => {
    if (settled) return;
    settled = true; clearTimeout(timer); context.signal.removeEventListener('abort', cancel); this.pending.delete(cancel);
    admission?.release(); controller.abort(); if (error) reject(error); else resolve(value!);
   };
   const cancel = () => finish(new AdapterError('CANCELED', 'Govee Cloud call canceled', false, dispatched ? 'unknown' : 'not_sent'));
   const timer = setTimeout(() => finish(new AdapterError('TIMEOUT', 'Govee Cloud request timed out', true, dispatched ? 'unknown' : 'not_sent')), Math.min(this.commandTimeoutMs, context.deadlineAt - Date.now()));
   this.pending.add(cancel); context.signal.addEventListener('abort', cancel, { once: true });
   if (context.signal.aborted) { cancel(); return; }
   void (async () => {
    try { admission = await this.acquire(path, typeof payload?.device === 'string' ? payload.device : undefined, controller.signal); }
    catch (error) { if (error instanceof AdapterError) return finish(error); throw error; }
    if (settled) { admission.release(); return; }
    controller.signal.throwIfAborted(); dispatched = true;
    const response = await fetch(`${base}/${path}`, {
     method: payload ? 'POST' : 'GET',
     headers: { 'Content-Type': 'application/json', 'Govee-API-Key': this.apiKey },
     ...(payload ? { body: JSON.stringify({ requestId: randomUUID(), payload }) } : {}),
     signal: controller.signal, redirect: 'error',
    });
    if (settled) { void response.body?.cancel().catch(() => {}); return; }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); const error = this.responseError(response.status, response.headers); if (error.code === 'RATE_LIMITED') admission.rateLimited(error.retryAfterMs!); return finish(error); }
    const body: unknown = await response.json();
    if (settled) return;
    if (!object(body) || typeof body.code !== 'number') return finish(new AdapterError('TRANSPORT_ERROR', 'Invalid Govee Cloud response', true, 'acknowledged'));
    if (body.code !== 200) { const error = this.responseError(body.code, response.headers); if (error.code === 'RATE_LIMITED') admission.rateLimited(error.retryAfterMs!); return finish(error); }
    finish(undefined, body);
   })().catch(() => finish(new AdapterError('TRANSPORT_ERROR', 'Govee Cloud transport failed', true, 'unknown')));
  });
 }
 private parseCapabilities(values: unknown[]): Capability[] {
  const found = new Map<string, Capability>();
  for (const value of values) {
   if (!object(value)) { this.warn(); continue; }
   for (const field of Object.keys(mapping) as Field[]) {
    const match = mapping[field]; if (value.type !== match.type || value.instance !== match.instance) continue;
    if (field === 'power' || field === 'rgb') { found.set(field, { type: field }); continue; }
    const range = object(value.parameters) && object(value.parameters.range) ? value.parameters.range : undefined;
    const min = range?.min; const max = range?.max; const step = range?.step ?? range?.precision ?? 1;
    if (typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number' || !Number.isInteger(min) || !Number.isInteger(max) || !Number.isInteger(step) || min < 1 || max < min || step <= 0 || (field === 'brightness' && max > 100)) { this.warn(); continue; }
    found.set(field, { type: field, minimum: min, maximum: max, step });
   }
  }
  return [...found.values()];
 }
 async *discover(context: CallContext): AsyncIterable<AdapterDevice> {
  await this.connect(context);
  const body = await this.request('user/devices', context);
  if (!Array.isArray(body.data)) throw new AdapterError('TRANSPORT_ERROR', 'Invalid Govee Cloud device list', true, 'acknowledged');
  const found = new Map<string, CloudDevice>();
  for (const value of body.data) {
   if (!object(value) || typeof value.device !== 'string' || !value.device || value.device.length > 256 || typeof value.sku !== 'string' || !value.sku || value.sku.length > 128 || !Array.isArray(value.capabilities)) { this.warn(); continue; }
   if (found.size >= 10000 && !found.has(value.device)) break;
   const device: AdapterDevice = { nativeId: value.device, name: typeof value.deviceName === 'string' ? value.deviceName : `Govee ${value.sku}`, manufacturer: 'Govee', model: value.sku, address: { transport: 'cloud', endpoint: null }, extensions: {} };
   found.set(device.nativeId, { device, capabilities: this.parseCapabilities(value.capabilities) });
  }
  this.check(context); this.devices.clear(); for (const [id, device] of found) this.devices.set(id, device);
  for (const { device } of found.values()) { this.check(context); yield structuredClone(device); }
 }
 async getDevices(context: CallContext): Promise<readonly AdapterDevice[]> { this.check(context); return structuredClone([...this.devices.values()].map(entry => entry.device)); }
 private device(id: string): CloudDevice { const entry = this.devices.get(id); if (!entry) throw new AdapterError('OFFLINE', 'Unknown Govee Cloud device', true); return entry; }
 async getCapabilities(id: string, context: CallContext): Promise<Capability[]> { this.check(context); return structuredClone(this.device(id).capabilities); }
 private capability(id: string, field: Field, context: CallContext): Capability {
  this.check(context); const capability = this.device(id).capabilities.find(value => value.type === field);
  if (!capability) throw new AdapterError('UNSUPPORTED_CAPABILITY', 'Govee Cloud device does not support this capability');
  return capability;
 }
 async getState(id: string, context: CallContext): Promise<Observation> {
  this.check(context); const entry = this.device(id);
  const body = await this.request('device/state', context, { sku: entry.device.model, device: id });
  if (!object(body.payload) || body.payload.device !== id || body.payload.sku !== entry.device.model || !Array.isArray(body.payload.capabilities)) throw new AdapterError('TRANSPORT_ERROR', 'Invalid Govee Cloud device state', true, 'acknowledged');
  const state: DeviceState = {}; let availability: 'online' | 'offline' | 'unknown' = 'unknown';
  for (const raw of body.payload.capabilities) {
   if (!object(raw) || !object(raw.state)) continue;
   const value = raw.state.value;
   if (raw.type === 'devices.capabilities.online') { if (value === true || value === 1) availability = 'online'; else if (value === false || value === 0) availability = 'offline'; }
   for (const capability of entry.capabilities) {
    const field = capability.type as Field; const match = mapping[field]; if (!match || raw.type !== match.type || raw.instance !== match.instance) continue;
    if (field === 'power' && (value === 0 || value === 1)) state.power = value === 1;
    else if (field === 'rgb' && integer(value, 16777215)) state.rgb = { r: (value >>> 16) & 255, g: (value >>> 8) & 255, b: value & 255 };
    else if ((capability.type === 'brightness' || capability.type === 'colorTemperature') && typeof value === 'number' && Number.isInteger(value) && value >= capability.minimum && value <= capability.maximum && (value - capability.minimum) % capability.step === 0) state[capability.type] = value;
   }
  }
  const observation: Observation = { state, observedAt: new Date().toISOString(), complete: entry.capabilities.every(capability => state[capability.type as keyof DeviceState] !== undefined) };
  this.emit({ type: 'availability', nativeId: id, status: availability });
  if (availability === 'offline') throw new AdapterError('OFFLINE', 'Govee Cloud device is offline', true, 'acknowledged');
  return structuredClone(observation);
 }
 private async control(id: string, field: Field, value: number, context: CallContext): Promise<WriteReceipt> {
  this.capability(id, field, context); const entry = this.device(id);
  await this.request('device/control', context, { sku: entry.device.model, device: id, capability: { ...mapping[field], value } });
  return { transport: 'cloud', acknowledgment: 'accepted' };
 }
 async setPower(id: string, on: boolean, context: CallContext): Promise<WriteReceipt> { if (typeof on !== 'boolean') throw new AdapterError('OUT_OF_RANGE', 'Power must be boolean'); return this.control(id, 'power', on ? 1 : 0, context); }
 async setBrightness(id: string, percent: number, context: CallContext): Promise<WriteReceipt> {
  const capability = this.capability(id, 'brightness', context);
  if (!integer(percent, 100)) throw new AdapterError('OUT_OF_RANGE', 'Brightness must be an integer from 0 to 100');
  // The cloud brightness range starts at one: normalized zero requests power-off.
  if (percent === 0) return this.setPower(id, false, context);
  this.validateRange(capability, percent); return this.control(id, 'brightness', percent, context);
 }
 async setColor(id: string, color: Color, context: CallContext): Promise<WriteReceipt> {
  if (!object(color)) throw new AdapterError('OUT_OF_RANGE', 'Color must be an object');
  if (color.mode !== 'rgb') throw new AdapterError('UNSUPPORTED_CAPABILITY', 'Govee Cloud supports RGB only');
  if (!object(color.value) || ![color.value.r, color.value.g, color.value.b].every(value => integer(value, 255))) throw new AdapterError('OUT_OF_RANGE', 'RGB channels must be integer bytes');
  return this.control(id, 'rgb', (color.value.r << 16) | (color.value.g << 8) | color.value.b, context);
 }
 private validateRange(capability: Capability, value: number): void {
  if (!('minimum' in capability) || !Number.isInteger(value) || value < capability.minimum || value > capability.maximum || (value - capability.minimum) % capability.step !== 0) throw new AdapterError('OUT_OF_RANGE', 'Value is outside the Govee Cloud device range');
 }
 async setTemperature(id: string, kelvin: number, context: CallContext): Promise<WriteReceipt> { this.validateRange(this.capability(id, 'colorTemperature', context), kelvin); return this.control(id, 'colorTemperature', kelvin, context); }
}

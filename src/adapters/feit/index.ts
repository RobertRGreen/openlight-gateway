import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AdapterError } from '../types.js';
import type { AdapterDevice, AdapterEvent, CallContext, Capability, Color, DeviceState, LightingAdapter, Observation, SchedulingProfile, WriteReceipt } from '../types.js';
import { CONTROL, DP_QUERY, decodeFrame, decodeQuery, encodeFrame, encodeQuery, encryptControl, hsvHexToRgb, rgbToHsvHex } from './protocol.js';
import type { FeitTransport } from './transport.js';

export interface FeitDpsMap {
 power?: string;
 workMode?: string;
 brightness?: { id?: string; minimum?: number; maximum?: number; step?: number };
 colour?: string | null;
 colorTemperature?: { id?: string; rawMinimum?: number; rawMaximum?: number; minimumKelvin?: number; maximumKelvin?: number; step?: number } | null;
}
export interface FeitDeviceConfig { id: string; name: string; ip: string; localKey: string; version: string; dpsMap?: FeitDpsMap }
export interface FeitAdapterOptions { devices: readonly FeitDeviceConfig[]; transport: FeitTransport; commandTimeoutMs?: number; logger?: { warn(message: string): void } }
type Range = { id: string; minimum: number; maximum: number; step: number };
type Temperature = Range & { minimumKelvin: number; maximumKelvin: number };
type Entry = { config: FeitDeviceConfig; device: AdapterDevice; power: string; workMode: string; brightness: Range; colour: string | null; temperature: Temperature | undefined };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const dp = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,4}$/.test(value);
const within = (value: unknown, range: Range): value is number => typeof value === 'number' && Number.isInteger(value) && value >= range.minimum && value <= range.maximum && (value - range.minimum) % range.step === 0;
const validRange = (range: Range) => dp(range.id) && [range.minimum, range.maximum, range.step].every(Number.isSafeInteger) && range.minimum >= 0 && range.maximum > range.minimum && range.step > 0 && (range.maximum - range.minimum) % range.step === 0;
const invalid = (): never => { throw new AdapterError('OUT_OF_RANGE', 'Invalid Feit manual device configuration'); };
const quantize = (value: number, range: Range) => Math.max(range.minimum, Math.min(range.maximum, range.minimum + Math.round((value - range.minimum) / range.step) * range.step));

/** Manually configured Tuya v3.3 devices only; no discovery traffic or cloud credentials. */
export class FeitAdapter implements LightingAdapter {
 readonly id = 'feit';
 readonly scheduling: SchedulingProfile = { budgets: [{ scope: 'adapter', key: 'feit', maxRequests: 20, windowMs: 1000, burst: 5, maxConcurrent: 2 }], minUpdateIntervalMs: 100, estimatedLatencyMs: 100, recommendedPollIntervalMs: 30000 };
 private readonly entries = new Map<string, Entry>();
 private readonly listeners = new Set<(event: AdapterEvent) => void>();
 private readonly pending = new Set<() => void>();
 private readonly busy = new Set<string>();
 private readonly timeout: number;
 private connected = false;
 private sequence = 0;
 private readonly transport: FeitTransport;
 private readonly logger: { warn(message: string): void } | undefined;
 constructor(options: FeitAdapterOptions) {
  this.transport = options.transport; this.logger = options.logger;
  this.timeout = options.commandTimeoutMs ?? 1500;
  if (!Number.isFinite(this.timeout) || this.timeout <= 0 || this.timeout > 2147483647) invalid();
  if (!Array.isArray(options.devices) || !options.devices.length || options.devices.length > 10000) invalid();
  for (const raw of options.devices) {
   if (!object(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 256 || typeof raw.name !== 'string' || !raw.name || raw.name.length > 256 || typeof raw.ip !== 'string' || !isIP(raw.ip) || typeof raw.localKey !== 'string' || Buffer.byteLength(raw.localKey) !== 16 || typeof raw.version !== 'string' || !raw.version || raw.version.length > 32 || this.entries.has(raw.id)) invalid();
   const config: FeitDeviceConfig = (() => { try { return structuredClone(raw) as unknown as FeitDeviceConfig; } catch { return invalid(); } })();
   // Public inventory and diagnostic version values must not contain any configured credential.
   if (options.devices.some(other => typeof other?.localKey === 'string' && other.localKey && [config.id, config.name, config.ip, config.version].some(value => value.includes(other.localKey)))) invalid();
   if (config.dpsMap !== undefined && !object(config.dpsMap)) invalid();
   const map: FeitDpsMap = config.dpsMap ?? {};
   if (map.brightness !== undefined && !object(map.brightness)) invalid();
   if (map.power !== undefined && !dp(map.power) || map.workMode !== undefined && !dp(map.workMode)) invalid();
   if (map.brightness) {
    if (map.brightness.id !== undefined && !dp(map.brightness.id)) invalid();
    for (const field of ['minimum', 'maximum', 'step'] as const) if (map.brightness[field] !== undefined && !Number.isSafeInteger(map.brightness[field])) invalid();
   }
   const power = map.power ?? '20'; const workMode = map.workMode ?? '21';
   const brightness: Range = { id: map.brightness?.id ?? '22', minimum: map.brightness?.minimum ?? 10, maximum: map.brightness?.maximum ?? 1000, step: map.brightness?.step ?? 1 };
   const colour = map.colour === undefined ? '24' : map.colour;
   if (!dp(power) || !dp(workMode) || !validRange(brightness) || (colour !== null && !dp(colour))) invalid();
   let temperature: Temperature | undefined;
   const ct = map.colorTemperature;
   if (ct !== undefined && ct !== null) {
    if (!object(ct)) invalid();
    if (ct.id !== undefined && !dp(ct.id)) invalid();
    for (const key of ['rawMinimum', 'rawMaximum', 'minimumKelvin', 'maximumKelvin', 'step'] as const) if (ct[key] !== undefined && !Number.isSafeInteger(ct[key])) invalid();
    if (ct.rawMinimum !== undefined && ct.rawMaximum !== undefined && ct.minimumKelvin !== undefined && ct.maximumKelvin !== undefined) {
     temperature = { id: ct.id ?? '23', minimum: ct.rawMinimum, maximum: ct.rawMaximum, minimumKelvin: ct.minimumKelvin, maximumKelvin: ct.maximumKelvin, step: ct.step ?? 1 };
     if (!validRange(temperature) || temperature.minimumKelvin < 1 || temperature.maximumKelvin <= temperature.minimumKelvin) invalid();
    }
   }
   const ids = [power, workMode, brightness.id, ...(colour ? [colour] : []), ...(temperature ? [temperature.id] : [])];
   if (new Set(ids).size !== ids.length) invalid();
   this.entries.set(config.id, { config, power, workMode, brightness, colour, temperature, device: { nativeId: config.id, name: config.name, manufacturer: 'Feit Electric', model: null, address: { transport: 'lan', endpoint: config.ip }, extensions: {} } });
  }
 }
 onEvent(listener: (event: AdapterEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
 private emit(event: AdapterEvent): void { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* Consumer isolation. */ } } }
 private check(context: CallContext): void { if (!Number.isFinite(context.deadlineAt)) throw new AdapterError('OUT_OF_RANGE', 'Invalid Feit call deadline'); if (context.signal.aborted) throw new AdapterError('CANCELED', 'Feit call canceled'); if (context.deadlineAt <= Date.now()) throw new AdapterError('TIMEOUT', 'Feit deadline exceeded', true); }
 private version(entry: Entry): void {
  if (entry.config.version !== '3.3') throw new AdapterError('UNSUPPORTED_CAPABILITY', `Unsupported Feit Tuya protocol version ${/^[0-9]+(?:\.[0-9]+){1,2}$/.test(entry.config.version) ? entry.config.version : '[redacted]'}; only 3.3 is supported`);
 }
 private entry(id: string, context: CallContext): Entry { this.check(context); const entry = this.entries.get(id); if (!entry) throw new AdapterError('OFFLINE', 'Unknown Feit device', true); this.version(entry); return entry; }
 async connect(context: CallContext): Promise<void> { this.check(context); this.connected = true; this.emit({ type: 'connection', connected: true }); }
 async disconnect(context: CallContext): Promise<void> {
  this.connected = false; for (const cancel of [...this.pending]) cancel();
  let closing: Promise<void>; try { closing = this.transport.close(); } catch { closing = Promise.reject(new Error()); }
  void closing.catch(() => {});
  try { await this.bounded(context, () => closing); } finally { this.emit({ type: 'connection', connected: false }); }
 }
 async *discover(context: CallContext): AsyncIterable<AdapterDevice> { this.check(context); for (const entry of this.entries.values()) this.version(entry); await this.connect(context); for (const entry of this.entries.values()) { this.check(context); yield structuredClone(entry.device); } }
 async getDevices(context: CallContext): Promise<readonly AdapterDevice[]> { this.check(context); for (const entry of this.entries.values()) this.version(entry); return structuredClone([...this.entries.values()].map(entry => entry.device)); }
 async getCapabilities(id: string, context: CallContext): Promise<Capability[]> {
  const entry = this.entry(id, context); const capabilities: Capability[] = [{ type: 'power' }, { type: 'brightness', minimum: 0, maximum: 100, step: 1 }];
  if (entry.colour) capabilities.push({ type: 'rgb' });
  if (entry.temperature) capabilities.push({ type: 'colorTemperature', minimum: entry.temperature.minimumKelvin, maximum: entry.temperature.maximumKelvin, step: 1 });
  return structuredClone(capabilities);
 }
 private failure(error: unknown): AdapterError {
  // Never forward injected transport errors/messages/causes, even typed errors.
  const code = error instanceof AdapterError && ['OFFLINE', 'TIMEOUT', 'CANCELED', 'TRANSPORT_ERROR'].includes(error.code) ? error.code : 'TRANSPORT_ERROR';
  return new AdapterError(code, code === 'TIMEOUT' ? 'Feit request timed out' : code === 'CANCELED' ? 'Feit call canceled' : code === 'OFFLINE' ? 'Feit device unavailable' : 'Feit TCP transport failed', code !== 'CANCELED', 'unknown');
 }
 private bounded<T>(context: CallContext, start: (signal: AbortSignal) => Promise<T>, expired: () => AdapterError = () => new AdapterError('TIMEOUT', 'Feit request timed out', true, 'unknown')): Promise<T> {
  this.check(context); const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
   let settled = false;
   const finish = (error?: AdapterError, value?: T) => { if (settled) return; settled = true; clearTimeout(timer); context.signal.removeEventListener('abort', cancel); this.pending.delete(cancel); controller.abort(); if (error) reject(error); else resolve(value as T); };
   const cancel = () => finish(new AdapterError('CANCELED', 'Feit call canceled', false, 'unknown'));
   const timer = setTimeout(() => finish(expired()), Math.min(this.timeout, context.deadlineAt - Date.now()));
   this.pending.add(cancel); context.signal.addEventListener('abort', cancel, { once: true });
   if (context.signal.aborted) { cancel(); return; }
   try { void start(controller.signal).then(value => finish(undefined, value), error => finish(this.failure(error))); } catch (error) { finish(this.failure(error)); }
  });
 }
 private async status(entry: Entry, context: CallContext, expected?: Record<string, unknown>): Promise<Observation> {
  this.check(context); if (!this.connected) throw new AdapterError('OFFLINE', 'Feit adapter disconnected', true);
  if (this.busy.has(entry.config.id)) throw new AdapterError('RATE_LIMITED', 'Feit device already has an active request', true, 'not_sent', this.timeout);
  this.busy.add(entry.config.id);
  // Leave time for the runtime to receive the classified result before its outer deadline.
  const remaining = context.deadlineAt - Date.now();
  const margin = Math.min(25, Math.max(0, Math.floor(remaining / 2)));
  const deadlineAt = Math.min(context.deadlineAt - margin, Date.now() + this.timeout);
  const halfway = Date.now() + Math.max(1, Math.floor((deadlineAt - Date.now()) / 2));
  let responded = false;
  const expired = () => new AdapterError(responded ? 'TIMEOUT' : 'OFFLINE', responded ? 'Feit write verification timed out' : 'Feit device did not respond', true, 'unknown');
  try {
   return await this.bounded({ ...context, deadlineAt }, async signal => {
    const id = entry.config.id;
    const preceding = expected ? encodeFrame(this.sequence = (this.sequence + 1) >>> 0, CONTROL, encryptControl({ devId: id, uid: id, t: String(Math.floor(Date.now() / 1000)), dps: expected }, entry.config.localKey)) : undefined;
    for (let attempt = 0; attempt < (expected ? 2 : 1); attempt++) {
     const queryContext = { ...context, signal, deadlineAt: expected && attempt === 0 ? halfway : deadlineAt };
     const sequence = this.sequence = (this.sequence + 1) >>> 0;
     const packet = encodeFrame(sequence, DP_QUERY, encodeQuery({ devId: id, uid: id, t: String(Math.floor(Date.now() / 1000)) }));
     try {
      const response = await this.bounded(queryContext, querySignal => this.transport.request(entry.config.ip, packet, { signal: querySignal, deadlineAt: queryContext.deadlineAt }, attempt === 0 ? preceding : undefined));
      if (signal.aborted) throw new AdapterError('CANCELED', 'Feit call canceled');
      const frame = decodeFrame(response); if (frame.command !== DP_QUERY || frame.sequence !== sequence) throw new Error();
      responded = true;
      const { observation, dps } = this.parse(entry, frame.payload);
      this.emit({ type: 'availability', nativeId: id, status: 'online' });
      this.emit({ type: 'observation', nativeId: id, observation });
      if (!expected || Object.entries(expected).every(([dpId, value]) => dps[dpId] === value)) return structuredClone(observation);
     } catch (error) {
      const failure = this.failure(error);
      if (!['TIMEOUT', 'OFFLINE'].includes(failure.code)) throw failure;
     }
     // Retry only the query, halfway through the original window; never replay CONTROL.
     await delay(Math.max(0, (attempt === 0 && expected ? halfway : deadlineAt) - Date.now()), undefined, { signal });
    }
    throw expired();
   }, expired);
  } catch (error) { const failure = this.failure(error); if (!responded && (failure.code === 'OFFLINE' || failure.code === 'TIMEOUT')) this.emit({ type: 'availability', nativeId: entry.config.id, status: 'offline' }); throw failure; }
  finally { this.busy.delete(entry.config.id); }
 }
 async getState(id: string, context: CallContext): Promise<Observation> { return this.status(this.entry(id, context), context); }
 private parse(entry: Entry, payload: Uint8Array): { observation: Observation; dps: Record<string, unknown> } {
  try {
   const body = decodeQuery(payload); if (!object(body) || !object(body.dps)) throw new Error();
   const dps = body.dps; const state: DeviceState = {};
   if (typeof dps[entry.power] === 'boolean') state.power = dps[entry.power] as boolean;
   const brightness = dps[entry.brightness.id];
   if (within(brightness, entry.brightness)) state.brightness = Math.round((brightness - entry.brightness.minimum) * 100 / (entry.brightness.maximum - entry.brightness.minimum));
   const mode = dps[entry.workMode];
   if (entry.colour && mode === 'colour' && typeof dps[entry.colour] === 'string') state.rgb = hsvHexToRgb(dps[entry.colour] as string);
   if (entry.temperature && mode === 'white') {
    const range = entry.temperature; const raw = dps[range.id];
    if (within(raw, range)) state.colorTemperature = Math.round(range.minimumKelvin + (raw - range.minimum) * (range.maximumKelvin - range.minimumKelvin) / (range.maximum - range.minimum));
   }
   if (!Object.keys(state).length) throw new Error();
   const observation: Observation = { state, observedAt: new Date().toISOString(), complete: state.power !== undefined && state.brightness !== undefined && (!entry.colour && !entry.temperature || mode === 'colour' && state.rgb !== undefined || mode === 'white' && (!entry.temperature || state.colorTemperature !== undefined)) };
   return { observation, dps };
  } catch { try { this.logger?.warn('Skipped malformed Feit device response'); } catch { /* Logger isolation. */ } throw new AdapterError('TRANSPORT_ERROR', 'Invalid Feit device response', true, 'acknowledged'); }
 }
 private async control(entry: Entry, dps: Record<string, unknown>, context: CallContext): Promise<WriteReceipt> {
  const observation = await this.status(entry, context, dps);
  return structuredClone({ transport: 'lan', acknowledgment: 'applied', observation });
 }
 async setPower(id: string, on: boolean, context: CallContext): Promise<WriteReceipt> { const entry = this.entry(id, context); if (typeof on !== 'boolean') throw new AdapterError('OUT_OF_RANGE', 'Power must be boolean'); return this.control(entry, { [entry.power]: on }, context); }
 async setBrightness(id: string, percent: number, context: CallContext): Promise<WriteReceipt> {
  const entry = this.entry(id, context); if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new AdapterError('OUT_OF_RANGE', 'Brightness must be an integer from 0 to 100');
  const raw = quantize(entry.brightness.minimum + percent * (entry.brightness.maximum - entry.brightness.minimum) / 100, entry.brightness);
  return this.control(entry, { [entry.workMode]: 'white', [entry.brightness.id]: raw }, context);
 }
 async setColor(id: string, color: Color, context: CallContext): Promise<WriteReceipt> {
  const entry = this.entry(id, context); if (!entry.colour || !object(color) || color.mode !== 'rgb') throw new AdapterError('UNSUPPORTED_CAPABILITY', 'Feit device supports no requested color capability');
  if (!object(color.value) || ![color.value.r, color.value.g, color.value.b].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw new AdapterError('OUT_OF_RANGE', 'RGB channels must be integer bytes');
  return this.control(entry, { [entry.workMode]: 'colour', [entry.colour]: rgbToHsvHex(color.value) }, context);
 }
 async setTemperature(id: string, kelvin: number, context: CallContext): Promise<WriteReceipt> {
  const entry = this.entry(id, context); const range = entry.temperature;
  if (!range) throw new AdapterError('UNSUPPORTED_CAPABILITY', 'Feit color temperature requires explicit raw and Kelvin calibration ranges');
  if (!Number.isInteger(kelvin) || kelvin < range.minimumKelvin || kelvin > range.maximumKelvin) throw new AdapterError('OUT_OF_RANGE', 'Color temperature is outside the calibrated Kelvin range');
  // Linear calibrated approximation, quantized to the product's raw DP step; confirm on hardware.
  const raw = quantize(range.minimum + (kelvin - range.minimumKelvin) * (range.maximum - range.minimum) / (range.maximumKelvin - range.minimumKelvin), range);
  return this.control(entry, { [entry.workMode]: 'white', [range.id]: raw }, context);
 }
}

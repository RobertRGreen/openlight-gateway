import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AdapterError } from '../types.js';
import type { AdapterDevice, AdapterEvent, CallContext, Capability, Color, DeviceState, LightingAdapter, Observation, SchedulingProfile, WriteReceipt } from '../types.js';

// Unofficial Afero (Hubspace) cloud API, reverse-engineered by aioafero. The flow can change without notice.
const authBase = 'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token';
const accountHost = 'api2.afero.net';
const dataHost = 'semantics2.afero.net';
const userAgent = 'Mozilla/5.0 (Linux; Android 15; openlight Build/test; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.63 Mobile Safari/537.36';

type Json = Record<string, unknown>;
type Fetch = typeof fetch;
interface Entry { device: AdapterDevice; capabilities: Capability[] }
export interface HubspaceAdapterOptions {
  /** JSON file holding {"refresh_token": "..."}; created by scripts/hubspace-login.mjs. Never holds the password. */
  tokenFile: string;
  fetch?: Fetch;
  logger?: { warn(message: string): void };
}

const object = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(object) : []);

export class HubspaceAdapter implements LightingAdapter {
  readonly id = 'hubspace';
  // ponytail: conservative guess; Afero publishes no limits. Tune from observed 429s.
  readonly scheduling: SchedulingProfile = { budgets: [{ scope: 'adapter', key: 'hubspace', maxRequests: 5, windowMs: 1000, burst: 3, maxConcurrent: 2 }], minUpdateIntervalMs: 250, estimatedLatencyMs: 600, recommendedPollIntervalMs: 30000 };
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private readonly entries = new Map<string, Entry>();
  private readonly fetchImpl: Fetch;
  private idToken: string | undefined;
  private idTokenExpiresAt = 0;
  private accountId: string | undefined;
  constructor(private readonly options: HubspaceAdapterOptions) { this.fetchImpl = options.fetch ?? fetch; }

  onEvent(listener: (event: AdapterEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: AdapterEvent): void { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* Consumer isolation. */ } } }
  private check(context: CallContext): void {
    if (context.signal.aborted) throw new AdapterError('CANCELED', 'Hubspace call canceled');
    if (context.deadlineAt <= Date.now()) throw new AdapterError('TIMEOUT', 'Hubspace deadline exceeded', true);
  }

  /** One HTTP call bounded by the caller's signal and deadline; never forwards upstream bodies or tokens in errors. */
  private async http(url: string, init: RequestInit, context: CallContext, write: boolean): Promise<unknown> {
    this.check(context);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, Math.ceil(context.deadlineAt - Date.now())))]);
    let response: Response;
    try { response = await this.fetchImpl(url, { ...init, signal }); } catch {
      if (context.signal.aborted) throw new AdapterError('CANCELED', 'Hubspace call canceled');
      if (signal.aborted) throw new AdapterError('TIMEOUT', 'Hubspace request timed out', true, write ? 'unknown' : 'not_sent');
      throw new AdapterError('TRANSPORT_ERROR', 'Hubspace request failed', true, write ? 'unknown' : 'not_sent');
    }
    if (response.status === 401 || response.status === 403) throw new AdapterError('AUTH_FAILED', 'Hubspace authentication failed; rerun scripts/hubspace-login.mjs', false, 'acknowledged');
    if (response.status === 429) throw new AdapterError('RATE_LIMITED', 'Hubspace rate limit exceeded', true, 'acknowledged', Number(response.headers.get('retry-after')) * 1000 || undefined);
    if (response.status === 404) throw new AdapterError('OFFLINE', 'Hubspace device not found', true, 'acknowledged');
    if (!response.ok) throw new AdapterError('TRANSPORT_ERROR', `Hubspace request failed (HTTP ${response.status})`, response.status >= 500, 'acknowledged');
    try { return await response.json(); } catch { throw new AdapterError('TRANSPORT_ERROR', 'Invalid Hubspace response', true, 'acknowledged'); }
  }

  private async token(context: CallContext): Promise<string> {
    if (this.idToken && Date.now() < this.idTokenExpiresAt) return this.idToken;
    let refresh: unknown;
    try { refresh = (JSON.parse(await readFile(this.options.tokenFile, 'utf8')) as Json).refresh_token; } catch { /* handled below */ }
    if (typeof refresh !== 'string' || !refresh) throw new AdapterError('AUTH_FAILED', 'Hubspace token file missing or invalid; run scripts/hubspace-login.mjs', false);
    const body = await this.http(authBase, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, scope: 'openid email offline_access profile', client_id: 'hubspace_android' }) }, context, false);
    if (!object(body) || typeof body.id_token !== 'string') throw new AdapterError('AUTH_FAILED', 'Hubspace token refresh rejected; rerun scripts/hubspace-login.mjs', false, 'acknowledged');
    this.idToken = body.id_token; this.idTokenExpiresAt = Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 118) * 1000 - 5000;
    // The refresh token can rotate; losing the new one would force a full re-login.
    if (typeof body.refresh_token === 'string' && body.refresh_token !== refresh) await writeFile(this.options.tokenFile, JSON.stringify({ refresh_token: body.refresh_token }), { mode: 0o600 }).catch(() => this.options.logger?.warn('Could not persist rotated Hubspace refresh token'));
    return this.idToken;
  }

  private async api(method: 'GET' | 'PUT', host: string, path: string, context: CallContext, json?: unknown): Promise<unknown> {
    const authorization = `Bearer ${await this.token(context)}`;
    const headers: Record<string, string> = { authorization, host, 'user-agent': userAgent };
    if (json !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
    return this.http(`https://${host}${path}`, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) }, context, method === 'PUT');
  }

  private async account(context: CallContext): Promise<string> {
    if (this.accountId) return this.accountId;
    const me = await this.api('GET', accountHost, '/v1/users/me', context);
    const id = object(me) ? (list((me as Json).accountAccess)[0]?.account as Json | undefined)?.accountId : undefined;
    if (typeof id !== 'string' || !id) throw new AdapterError('TRANSPORT_ERROR', 'Hubspace account id missing', true, 'acknowledged');
    return (this.accountId = id);
  }

  /** Lights only; capability ranges come from the device description, not the state endpoint. */
  private async load(context: CallContext): Promise<void> {
    const metadevices = await this.api('GET', dataHost, `/v1/accounts/${await this.account(context)}/metadevices`, context);
    if (!Array.isArray(metadevices)) throw new AdapterError('TRANSPORT_ERROR', 'Invalid Hubspace device list', true, 'acknowledged');
    this.entries.clear();
    for (const meta of list(metadevices)) {
      const info = (object(meta.description) && object(meta.description.device) ? meta.description.device : {}) as Json;
      if (meta.typeId !== 'metadevice.device' || info.deviceClass !== 'light' || typeof meta.id !== 'string') continue;
      const functions = object(meta.description) ? list(meta.description.functions) : [];
      const range = (name: string): Json | undefined => { const values = list(functions.find(f => f.functionClass === name)?.values)[0]; return values && object(values.range) && Object.keys(values.range).length ? values.range : undefined; };
      const has = (name: string): boolean => functions.some(f => f.functionClass === name);
      const capabilities: Capability[] = [{ type: 'power' }];
      if (has('brightness')) capabilities.push({ type: 'brightness', minimum: 0, maximum: 100, step: 1 });
      if (has('color-rgb')) capabilities.push({ type: 'rgb' });
      const ct = range('color-temperature');
      if (ct && typeof ct.min === 'number' && typeof ct.max === 'number') capabilities.push({ type: 'colorTemperature', minimum: ct.min, maximum: ct.max, step: typeof ct.step === 'number' ? ct.step : 1 });
      const name = typeof meta.friendlyName === 'string' && meta.friendlyName ? meta.friendlyName : meta.id;
      this.entries.set(meta.id, { device: { nativeId: meta.id, name, manufacturer: typeof info.manufacturerName === 'string' && info.manufacturerName ? info.manufacturerName : 'Hubspace', model: typeof info.model === 'string' && info.model ? info.model : null, address: { transport: 'cloud', endpoint: null }, extensions: {} }, capabilities });
    }
  }

  private async entry(id: string, context: CallContext): Promise<Entry> {
    this.check(context);
    if (!this.entries.has(id)) await this.load(context);
    const entry = this.entries.get(id);
    if (!entry) throw new AdapterError('OFFLINE', 'Unknown Hubspace device', true);
    return entry;
  }

  async connect(context: CallContext): Promise<void> { await this.token(context); this.emit({ type: 'connection', connected: true }); }
  async disconnect(): Promise<void> { this.idToken = undefined; this.emit({ type: 'connection', connected: false }); }
  async *discover(context: CallContext): AsyncIterable<AdapterDevice> { await this.load(context); for (const entry of this.entries.values()) yield structuredClone(entry.device); }
  async getDevices(context: CallContext): Promise<readonly AdapterDevice[]> { await this.load(context); return structuredClone([...this.entries.values()].map(entry => entry.device)); }
  async getCapabilities(id: string, context: CallContext): Promise<Capability[]> { return structuredClone((await this.entry(id, context)).capabilities); }

  async getState(id: string, context: CallContext): Promise<Observation> {
    const entry = await this.entry(id, context);
    const body = await this.api('GET', dataHost, `/v1/accounts/${await this.account(context)}/metadevices/${id}/state`, context);
    const values = object(body) ? list(body.values) : [];
    const get = (name: string): unknown => values.find(v => v.functionClass === name)?.value;
    const state: DeviceState = {};
    const power = get('power'); if (power === 'on' || power === 'off') state.power = power === 'on';
    const brightness = get('brightness'); if (typeof brightness === 'number' && Number.isInteger(brightness)) state.brightness = brightness;
    const rgb = get('color-rgb'); const channels = object(rgb) && object(rgb['color-rgb']) ? rgb['color-rgb'] : undefined;
    if (channels && [channels.r, channels.g, channels.b].every(c => typeof c === 'number')) state.rgb = { r: channels.r as number, g: channels.g as number, b: channels.b as number };
    const kelvin = get('color-temperature'); if (typeof kelvin === 'number') state.colorTemperature = kelvin;
    const available = get('available'); const status = available === true ? 'online' : available === false ? 'offline' : 'unknown';
    this.emit({ type: 'availability', nativeId: id, status });
    if (status === 'offline') throw new AdapterError('OFFLINE', 'Hubspace device is offline', true, 'acknowledged');
    const complete = entry.capabilities.every(c => state[c.type as keyof DeviceState] !== undefined);
    return { state, observedAt: new Date().toISOString(), complete };
  }

  private async put(id: string, values: Array<[string, unknown]>, context: CallContext): Promise<WriteReceipt> {
    const now = Date.now();
    await this.api('PUT', dataHost, `/v1/accounts/${await this.account(context)}/metadevices/${id}/state`, context, { metadeviceId: id, values: values.map(([functionClass, value]) => ({ functionClass, functionInstance: null, value, lastUpdateTime: now })) });
    // ponytail: fixed settle delay; Afero's state read lags the write (brightness read back stale), so core's verify saw old values. Poll getState instead if this proves too short.
    await delay(Number(process.env.HUBSPACE_SETTLE_MS ?? 700), undefined, { signal: context.signal });
    return { transport: 'cloud', acknowledgment: 'accepted' };
  }
  private async capability(id: string, type: Capability['type'], context: CallContext): Promise<Capability> {
    const found = (await this.entry(id, context)).capabilities.find(c => c.type === type);
    if (!found) throw new AdapterError('UNSUPPORTED_CAPABILITY', 'Hubspace device does not support this capability');
    return found;
  }

  async setPower(id: string, on: boolean, context: CallContext): Promise<WriteReceipt> {
    if (typeof on !== 'boolean') throw new AdapterError('OUT_OF_RANGE', 'Power must be boolean');
    await this.entry(id, context); return this.put(id, [['power', on ? 'on' : 'off']], context);
  }
  async setBrightness(id: string, percent: number, context: CallContext): Promise<WriteReceipt> {
    await this.capability(id, 'brightness', context);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new AdapterError('OUT_OF_RANGE', 'Brightness must be an integer from 0 to 100');
    // The device minimum is 1: normalized zero means power-off.
    return percent === 0 ? this.put(id, [['power', 'off']], context) : this.put(id, [['brightness', percent]], context);
  }
  async setColor(id: string, color: Color, context: CallContext): Promise<WriteReceipt> {
    await this.capability(id, 'rgb', context);
    if (!object(color) || color.mode !== 'rgb') throw new AdapterError('UNSUPPORTED_CAPABILITY', 'Hubspace supports RGB only');
    const { r, g, b } = color.value;
    if (![r, g, b].every(c => Number.isInteger(c) && c >= 0 && c <= 255)) throw new AdapterError('OUT_OF_RANGE', 'RGB channels must be integer bytes');
    // color-mode must change with the value or the bulb stays in white mode.
    return this.put(id, [['color-mode', 'color'], ['color-rgb', { 'color-rgb': { r, g, b } }]], context);
  }
  async setTemperature(id: string, kelvin: number, context: CallContext): Promise<WriteReceipt> {
    const range = await this.capability(id, 'colorTemperature', context);
    if (!('minimum' in range) || !Number.isInteger(kelvin) || kelvin < range.minimum || kelvin > range.maximum || (kelvin - range.minimum) % range.step !== 0) throw new AdapterError('OUT_OF_RANGE', 'Color temperature is outside the Hubspace device range');
    return this.put(id, [['color-mode', 'white'], ['color-temperature', kelvin]], context);
  }
}

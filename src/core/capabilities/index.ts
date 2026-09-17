import type { Capability, DeviceState } from '../model.js';
import { GatewayError } from '../errors.js';
/** Validate the normalized command schema without consulting device support. */
export function validateSyntax(state: unknown, requestId = 'core', transitionMs?: number): asserts state is DeviceState {
  const invalid = (path: string, message: string): never => { throw new GatewayError(422, 'validation_error', 'Invalid request', [{ path, code: 'invalid_value', message }], requestId); };
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const check = (input: unknown, base: string, segment: boolean): void => {
    if (!record(input)) invalid(base, 'Expected state object');
    const value = input as Record<string, unknown>;
    if (!Object.keys(value).length) invalid(base, 'Expected nonempty state');
    const colors = ['rgb', 'rgbw', 'rgbww', 'colorTemperature'].filter(key => key in value);
    if (colors.length > 1 || ('effect' in value && (colors.length > 0 || 'segments' in value)) || ('segments' in value && colors.length > 0)) invalid(base, 'Color, effect and segment modes are mutually exclusive');
    for (const [key, field] of Object.entries(value)) {
      const path = `${base}/${key}`;
      if (!['power', 'brightness', 'rgb', 'rgbw', 'rgbww', 'colorTemperature', 'effect', 'segments'].includes(key)) invalid(path, 'Unknown state field');
      if (key === 'power' && typeof field !== 'boolean') invalid(path, 'Expected boolean');
      if (key === 'brightness' && (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || field > 100)) invalid(path, 'Expected brightness between 0 and 100');
      if (key === 'colorTemperature' && (typeof field !== 'number' || !Number.isInteger(field) || field < 1)) invalid(path, 'Expected positive integer kelvin');
      if (key === 'effect' && field !== null && typeof field !== 'string') invalid(path, 'Expected effect identifier or null');
      if (key === 'rgb' || key === 'rgbw' || key === 'rgbww') {
        const channels = key === 'rgb' ? ['r', 'g', 'b'] : key === 'rgbw' ? ['r', 'g', 'b', 'w'] : ['r', 'g', 'b', 'warmWhite', 'coolWhite'];
        if (!record(field)) invalid(path, 'Expected channel object');
        const values = field as Record<string, unknown>;
        if (Object.keys(values).length !== channels.length || Object.keys(values).some(channel => !channels.includes(channel))) invalid(path, 'Unexpected color channels');
        for (const channel of channels) { const intensity = values[channel]; if (typeof intensity !== 'number' || !Number.isInteger(intensity) || intensity < 0 || intensity > 255) invalid(`${path}/${channel}`, 'Expected integer byte'); }
      }
      if (key === 'segments') {
        if (segment) invalid(path, 'Nested segments are not permitted');
        if (!Array.isArray(field)) invalid(path, 'Expected segment array');
        const items = field as unknown[];
        const ids = new Set<string>();
        items.forEach((item, index) => {
          const itemPath = `${path}/${index}`;
          if (!record(item)) invalid(itemPath, 'Expected segment object');
          const entry = item as Record<string, unknown>;
          if (Object.keys(entry).some(property => property !== 'id' && property !== 'state')) invalid(itemPath, 'Unknown segment field');
          if (typeof entry.id !== 'string' || entry.id.length === 0) invalid(`${itemPath}/id`, 'Expected segment identifier');
          const id = entry.id as string;
          if (ids.has(id)) invalid(`${itemPath}/id`, 'Duplicate segment identifier');
          ids.add(id); check(entry.state, `${itemPath}/state`, true);
        });
      }
    }
  };
  check(state, '/state', false);
  if (transitionMs !== undefined && (!Number.isInteger(transitionMs) || transitionMs < 0)) invalid('/transitionMs', 'Expected nonnegative integer duration in milliseconds');
}
export function validateState(capabilities: readonly Capability[], state: DeviceState, deviceId: string, requestId = 'core', transitionMs?: number): void {
  validateSyntax(state, requestId, transitionMs);
  const invalid = (path: string, message: string) => { throw new GatewayError(422, 'validation_error', 'Invalid request', [{path,code:'out_of_range',message}], requestId); };
  const requireCap = (type: Capability['type'], path: string): Capability => {
    const cap = capabilities.find(c => c.type === type);
    if (!cap) throw new GatewayError(422,'capability_mismatch',`Device does not support ${type}`,[{path,code:'unsupported_capability',message:`Required capability ${type} is absent`,deviceId,capability:type}],requestId);
    return cap;
  };
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Object.keys(state).length) invalid('/state','Expected nonempty state');
  const colors = ['rgb','rgbw','rgbww','colorTemperature'].filter(k => k in state);
  if (colors.length > 1) invalid('/state','Color modes are mutually exclusive');
  if (('effect' in state && (colors.length > 0 || 'segments' in state)) || ('segments' in state && colors.length > 0)) invalid('/state','Effect, segment and color modes are mutually exclusive');
  for (const [field,value] of Object.entries(state)) {
    const path = `/state/${field}`;
    if (!['power','brightness','rgb','rgbw','rgbww','colorTemperature','effect','segments'].includes(field)) invalid(path,'Unknown state field');
    const cap = requireCap((field === 'effect' ? 'effects' : field) as Capability['type'],path);
    if (field === 'power' && typeof value !== 'boolean') invalid(path,'Expected boolean');
    if (cap.type === 'brightness' || cap.type === 'colorTemperature') {
      if (typeof value !== 'number' || (field === 'brightness' && (value < 0 || value > 100)) || (field === 'colorTemperature' && value < 1) || !Number.isFinite(value) || value < cap.minimum || value > cap.maximum || Math.abs((value-cap.minimum)/cap.step-Math.round((value-cap.minimum)/cap.step)) > 1e-8 || (field === 'colorTemperature' && !Number.isInteger(value))) invalid(path,'Value outside supported minimum, maximum or step');
    }
    if (field === 'rgb' || field === 'rgbw' || field === 'rgbww') {
      const keys = field === 'rgb' ? ['r','g','b'] : field === 'rgbw' ? ['r','g','b','w'] : ['r','g','b','warmWhite','coolWhite'];
      if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(k => !Number.isInteger((value as Record<string,number>)[k]) || ((value as Record<string,number>)[k] ?? -1) < 0 || ((value as Record<string,number>)[k] ?? 256) > 255)) invalid(path,'Expected integer byte channels');
    }
    if (cap.type === 'effects' && value !== null && (typeof value !== 'string' || !cap.effectIds.includes(value))) invalid(path,'Unsupported effect identifier');
    if (cap.type === 'segments') {
      if (!Array.isArray(value)) invalid(path,'Expected segments array');
      const seen = new Set<string>();
      for (const segment of value as {id:string;state:DeviceState}[]) {
        if (!segment || typeof segment !== 'object' || Object.keys(segment).some(k=>!['id','state'].includes(k)) || !segment.state || typeof segment.state !== 'object' || !cap.segmentIds.includes(segment.id) || seen.has(segment.id) || 'segments' in segment.state) invalid(path,'Invalid or duplicate segment');
        seen.add(segment.id); try {validateState(capabilities, segment.state, deviceId,requestId);} catch(error) {if(error instanceof GatewayError) {for(const detail of error.detail.details) detail.path = `/state/segments/${(value as unknown[]).indexOf(segment)}${detail.path}`;} throw error;}
      }
    }
  }
  if (transitionMs !== undefined) {
    const cap = requireCap('transitions','/transitionMs');
    if (cap.type !== 'transitions' || !Number.isInteger(transitionMs) || transitionMs < 0 || transitionMs > cap.maxDurationMs) invalid('/transitionMs','Unsupported transition duration');
  }
}

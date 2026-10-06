import { randomUUID } from 'node:crypto';
import { GatewayError } from '../errors.js';
import type { DomainBus } from '../events.js';
import type { CoreStore } from '../operations/storage.js';

export type PresetMode = 'gradient' | 'jump' | 'static';
/**
 * A named animated palette that a device plays by itself (native effect). Not a scene: a scene is a set of
 * device states applied once, a preset is one looping animation the hardware runs. Applied with the normal
 * command `{"state":{"effect":"<preset id>"}}`; only devices advertising `effects` for that id accept it.
 */
export interface Preset { id: string; name: string; mode: PresetMode; speed: number; colors: string[]; createdAt: string; updatedAt: string }
export type PresetInput = { name: string; colors: string[]; mode?: PresetMode; speed?: number };
export type PresetPatch = Partial<PresetInput>;

export const MAX_PRESET_COLORS = 8;
const modes: readonly PresetMode[] = ['gradient', 'jump', 'static'];
const invalid = (message: string): never => { throw new GatewayError(422, 'validation_error', message); };

/** Normalizes colors to lowercase "#rrggbb" and applies defaults; throws a 422 validation_error. */
function normalize(input: PresetInput): Omit<Preset, 'id' | 'createdAt' | 'updatedAt'> {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64) invalid('Name must be 1-64 characters and not blank');
  if (!Array.isArray(input.colors) || input.colors.length < 1 || input.colors.length > MAX_PRESET_COLORS) invalid(`Colors must list 1-${MAX_PRESET_COLORS} entries`);
  const colors = input.colors.map(color => {
    const match = typeof color === 'string' ? /^#?([0-9a-f]{6})$/i.exec(color) : null;
    return match ? `#${match[1]!.toLowerCase()}` : invalid('Each color must be a "#rrggbb" hex string');
  });
  const mode = input.mode ?? 'gradient'; const speed = input.speed ?? 50;
  if (!modes.includes(mode)) invalid('Mode must be gradient, jump, or static');
  if (!Number.isInteger(speed) || speed < 1 || speed > 100) invalid('Speed must be an integer from 1 to 100');
  return { name: input.name.trim(), mode, speed, colors };
}

export class PresetService {
  private readonly listeners = new Set<(presets: readonly Preset[]) => void>();
  constructor(private readonly store: CoreStore, private readonly bus: DomainBus) {}
  list(): Preset[] { return this.store.list<Preset>('presets'); }
  get(id: string): Preset { const value = this.store.get<Preset>('presets', id); if (!value) throw new GatewayError(404, 'not_found', 'Preset not found'); return value; }
  create(input: PresetInput): Preset {
    const now = new Date().toISOString();
    const preset: Preset = { id: randomUUID(), ...normalize(input), createdAt: now, updatedAt: now };
    this.store.put('presets', preset.id, preset); this.changed('preset.created', preset); return preset;
  }
  /** Replaces only the supplied fields (colors is replaced whole). Devices already playing the old version keep it until restarted. */
  update(id: string, patch: PresetPatch): Preset {
    const current = this.get(id);
    const preset: Preset = { ...current, ...normalize({ name: current.name, colors: current.colors, mode: current.mode, speed: current.speed, ...patch }), updatedAt: new Date().toISOString() };
    this.store.put('presets', id, preset); this.changed('preset.updated', preset); return preset;
  }
  /** Devices currently playing it keep looping the last payload they received; stop them with `effect: null`. */
  delete(id: string): void { const preset = this.get(id); this.store.delete('presets', id); this.changed('preset.deleted', preset); }
  /** Called after every change with the full list; the gateway uses it to refresh advertised device effects. */
  onChange(listener: (presets: readonly Preset[]) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(type: 'preset.created' | 'preset.updated' | 'preset.deleted', preset: Preset): void {
    this.bus.publish(type, { type: 'preset', id: preset.id }, { preset });
    const all = this.list();
    for (const listener of this.listeners) { try { listener(all); } catch { /* A consumer failure must not fail the API write. */ } }
  }
}

import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayStore } from '../src/persistence/index.js';
import { DomainBus } from '../src/core/events.js';
import type { DomainEvent } from '../src/core/events.js';
import { PresetService } from '../src/core/presets/index.js';
import type { Preset } from '../src/core/presets/index.js';

describe('PresetService', () => {
 let store: GatewayStore, presets: PresetService, events: DomainEvent[];
 beforeEach(() => { store = new GatewayStore(':memory:'); const bus = new DomainBus(store.gatewayId); events = []; bus.subscribe(event => events.push(event)); presets = new PresetService(store, bus); });
 afterEach(() => store.close());

 it('creates with defaults, normalizes colors, and persists', () => {
  const preset = presets.create({ name: '  Cyber  ', colors: ['#00FFF2', 'ff2079'] });
  expect(preset).toMatchObject({ name: 'Cyber', mode: 'gradient', speed: 50, colors: ['#00fff2', '#ff2079'] });
  expect(preset.createdAt).toBe(preset.updatedAt);
  expect(presets.get(preset.id)).toEqual(preset); expect(presets.list()).toEqual([preset]);
 });
 it.each([
  { name: '', colors: ['#ffffff'] }, { name: ' ', colors: ['#ffffff'] }, { name: 'x'.repeat(65), colors: ['#ffffff'] },
  { name: 'a', colors: [] }, { name: 'a', colors: Array(9).fill('#ffffff') }, { name: 'a', colors: ['red'] }, { name: 'a', colors: ['#fff'] }, { name: 'a', colors: [5] },
  { name: 'a', colors: ['#ffffff'], speed: 0 }, { name: 'a', colors: ['#ffffff'], speed: 101 }, { name: 'a', colors: ['#ffffff'], speed: 1.5 }, { name: 'a', colors: ['#ffffff'], mode: 'fade' },
 ] as never[])('rejects invalid input %j with 422 validation_error', input => {
  expect(() => presets.create(input)).toThrowError(expect.objectContaining({ statusCode: 422, code: 'validation_error' }));
  expect(presets.list()).toEqual([]);
 });
 it('updates only supplied fields, replaces colors whole, and validates the merged result', () => {
  const preset = presets.create({ name: 'Cyber', colors: ['#00fff2', '#ff2079'], speed: 30 });
  const renamed = presets.update(preset.id, { name: 'Neon' });
  expect(renamed).toMatchObject({ name: 'Neon', colors: ['#00fff2', '#ff2079'], speed: 30, mode: 'gradient', createdAt: preset.createdAt });
  expect(presets.update(preset.id, { colors: ['#ffffff'], mode: 'jump' })).toMatchObject({ name: 'Neon', colors: ['#ffffff'], mode: 'jump', speed: 30 });
  expect(() => presets.update(preset.id, { speed: 500 })).toThrowError(expect.objectContaining({ code: 'validation_error' }));
  expect(presets.get(preset.id).speed).toBe(30);
 });
 it('deletes, and unknown ids are 404', () => {
  const preset = presets.create({ name: 'a', colors: ['#ffffff'] }); presets.delete(preset.id);
  expect(presets.list()).toEqual([]);
  for (const act of [() => presets.get(preset.id), () => presets.update(preset.id, { name: 'b' }), () => presets.delete(preset.id)]) expect(act).toThrowError(expect.objectContaining({ statusCode: 404, code: 'not_found' }));
 });
 it('publishes created/updated/deleted events and calls change listeners with the full list', () => {
  const seen: Preset[][] = []; presets.onChange(list => seen.push([...list]));
  const preset = presets.create({ name: 'a', colors: ['#ffffff'] }); presets.update(preset.id, { name: 'b' }); presets.delete(preset.id);
  expect(events.map(e => [e.type, e.subject])).toEqual([['preset.created', { type: 'preset', id: preset.id }], ['preset.updated', { type: 'preset', id: preset.id }], ['preset.deleted', { type: 'preset', id: preset.id }]]);
  expect(seen.map(list => list.map(p => p.name))).toEqual([['a'], ['b'], []]);
 });
 it('a throwing change listener does not fail the write', () => {
  presets.onChange(() => { throw new Error('boom'); });
  expect(presets.create({ name: 'a', colors: ['#ffffff'] }).name).toBe('a');
  expect(presets.list()).toHaveLength(1);
 });
});

describe('presets storage migration', () => {
 it('adds the presets table to a version-1 database without losing data', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'presets-')), 'old.sqlite');
  const first = new GatewayStore(path); first.put('rooms', 'r1', { id: 'r1', name: 'Den' }); first.close();
  const raw = new DatabaseSync(path); raw.exec('DROP TABLE presets; PRAGMA user_version = 1'); raw.close(); // what a pre-presets database looks like
  const upgraded = new GatewayStore(path);
  try {
   const service = new PresetService(upgraded, new DomainBus(upgraded.gatewayId));
   expect(service.create({ name: 'a', colors: ['#ffffff'] }).name).toBe('a');
   expect(upgraded.get('rooms', 'r1')).toEqual({ id: 'r1', name: 'Den' });
  } finally { upgraded.close(); }
  const check = new DatabaseSync(path); expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 }); check.close();
 });
});

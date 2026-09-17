import { z } from 'zod';
export const uuid = z.string().uuid();
const name = z.string().min(1).refine(value => value.trim().length > 0);
const byte = z.number().int().min(0).max(255);
const rgb = z.object({ r: byte, g: byte, b: byte }).strict();
const fields = {
  power: z.boolean().optional(), brightness: z.number().min(0).max(100).optional(),
  rgb: rgb.optional(), rgbw: rgb.extend({ w: byte }).strict().optional(),
  rgbww: rgb.extend({ warmWhite: byte, coolWhite: byte }).strict().optional(),
  colorTemperature: z.number().int().min(1).optional(), effect: z.string().nullable().optional(),
};
const segment = z.object(fields).strict();
export const state = z.object({ ...fields, segments: z.array(z.object({ id: z.string().min(1), state: segment }).strict()).optional() }).strict().refine(value => Object.keys(value).length > 0, 'State must not be empty');
export const target = z.object({ type: z.enum(['device', 'group']), id: uuid }).strict();
export const command = z.object({ state, transitionMs: z.number().int().min(0).optional() }).strict();
const ids = z.array(uuid).refine(value => new Set(value).size === value.length, 'Duplicate membership');
const nonempty = (value: object) => Object.keys(value).length > 0;
export const devicePatch = z.object({ name: name.optional(), room: uuid.nullable().optional(), groups: ids.optional() }).strict().refine(nonempty, 'Patch must not be empty');
export const roomCreate = z.object({ name }).strict();
export const roomPatch = roomCreate.partial().strict().refine(nonempty, 'Patch must not be empty');
export const groupCreate = z.object({ name, deviceIds: ids }).strict();
export const groupPatch = groupCreate.partial().strict().refine(nonempty, 'Patch must not be empty');
export const sceneCreate = z.object({ name, entries: z.array(command.extend({ target }).strict()).min(1) }).strict();
export const scenePatch = sceneCreate.partial().strict().refine(nonempty, 'Patch must not be empty');
export const sceneActivate = z.object({ allowDegraded: z.boolean().optional() }).strict();
export const effectStart = z.object({ target, parameters: z.record(z.unknown()).optional() }).strict();
export const discoveryStart = z.object({ adapterIds: z.array(z.string().min(1)).min(1).refine(value => new Set(value).size === value.length).optional() }).strict();
export const empty = z.object({}).strict();

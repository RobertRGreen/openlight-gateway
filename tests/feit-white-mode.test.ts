import { expect, it } from 'vitest';
import { FeitAdapter } from '../src/adapters/feit/index.js';
import { decodeFrame, decryptControl, encodeFrame, encodeQuery } from '../src/adapters/feit/protocol.js';
import type { CallContext } from '../src/adapters/types.js';

it('reports white/color mode despite retained RGB, and carries brightness into white mode', async () => {
 const key = '0123456789abcdef';
 const dps: Record<string, unknown> = { '20': true, '21': 'colour', '22': 406, '23': 0, '24': '000003e803e8' };
 const adapter = new FeitAdapter({ devices: [{ id: 'bulb', name: 'Test lamp', ip: '192.0.2.1', localKey: key, version: '3.3',
  dpsMap: { colorTemperature: { id: '23', rawMinimum: 0, rawMaximum: 1000, minimumKelvin: 2700, maximumKelvin: 6500 } } }],
  transport: {
   close: async () => {},
   request: async (_ip, packet, _context, preceding) => {
    if (preceding) Object.assign(dps, (decryptControl(decodeFrame(preceding).payload, key) as { dps: Record<string, unknown> }).dps);
    const frame = decodeFrame(packet); return encodeFrame(frame.sequence, frame.command, encodeQuery({ dps }));
   },
  },
 });
 const context = (): CallContext => ({ operationId: 'white-test', correlationId: null, signal: new AbortController().signal, deadlineAt: Date.now() + 5000 });
 await adapter.connect(context());
 const colored = await adapter.getState('bulb', context());
 expect(colored.state.colorMode).toBe('color');
 await adapter.setBrightness('bulb', 100, context());
 const white = await adapter.setTemperature('bulb', 4000, context());
 expect(dps['21']).toBe('white');
 expect(dps['22']).toBe(1000);
 expect(white.observation?.state).toMatchObject({ colorMode: 'white', brightness: 100, colorTemperature: 4000 });
 const merged = { ...colored.state, ...white.observation?.state };
 expect(merged.rgb).toBeDefined();
 expect(merged.colorMode).toBe('white');
 await adapter.setColor('bulb', { mode: 'rgb', value: { r: 0, g: 255, b: 0 } }, context());
 expect((await adapter.getState('bulb', context())).state.colorMode).toBe('color');
 await adapter.disconnect(context());
});

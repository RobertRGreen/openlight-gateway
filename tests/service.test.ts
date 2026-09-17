import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, type Gateway } from '../src/service/index.js';
import { loadConfig } from '../src/config/index.js';

let gateway: Gateway | undefined;
let directory: string | undefined;
afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('composes the core, preserves identities across restart, and never replays interrupted intent', async () => {
  directory = mkdtempSync(join(tmpdir(), 'openlight-service-'));
  const config = loadConfig({
    DATABASE_PATH: join(directory, 'gateway.sqlite'),
    MOCK_LATENCY_MS: '0', LOG_LEVEL: 'silent', MDNS_ENABLED: 'false',
  });
  gateway = await createGateway({ config });
  expect(gateway.registry.list()).toHaveLength(5);
  const device = gateway.registry.list().find(value => value.model === 'rgb')!;
  const gatewayId = gateway.store.gatewayId;
  const operation = gateway.operations.submitCommand({ type: 'device', id: device.id }, { power: true });
  expect(operation.status).toBe('queued');
  expect((await gateway.operations.wait(operation.id)).status).toBe('succeeded');
  const unfinishedId = '00000000-0000-4000-8000-000000000099';
  gateway.store.saveOperation({
    id: unfinishedId, kind: 'device.command', status: 'queued',
    createdAt: new Date().toISOString(), completedAt: null,
    request: { state: { power: true } }, targetDeviceIds: [device.id], results: [],
  });
  await gateway.stop();
  gateway = await createGateway({ config });
  expect(gateway.store.gatewayId).toBe(gatewayId);
  expect(gateway.registry.get(device.id).state.power).toBe(false);
  expect(gateway.operations.get(unfinishedId)).toMatchObject({
    status: 'failed', results: [{ confirmation: 'unconfirmed', error: { code: 'gateway_restarted' } }],
  });
  expect(gateway.operations.get(operation.id).status).toBe('succeeded');
  await Promise.all([gateway.stop(), gateway.stop()]);
});

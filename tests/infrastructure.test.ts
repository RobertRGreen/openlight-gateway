import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayStore, MIN_RETENTION_MS } from '../src/persistence/index.js';
import { TokenService, redactSecrets, defaultCorsPolicy, isOriginAllowed } from '../src/security/index.js';
import { ManualDiscoveryProvider, GoveeLanDiscoveryProvider, TuyaDiscoveryProvider, MatterDiscoveryProvider, CloudAccountDiscoveryProvider } from '../src/discovery/index.js';
import { loadConfig } from '../src/config/index.js';

describe('infrastructure', () => {
  it('persists stable UUIDs, fails interrupted work and retains original idempotency responses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openlight-test-'));
    try {
      const path = join(dir, 'gateway.db'); let store = new GatewayStore(path);
      const deviceId = store.identity('mock', 'native'); const gatewayId = store.gatewayId;
      const queued = { id: 'operation', status: 'queued', createdAt: new Date().toISOString(), completedAt: null, targetDeviceIds: [deviceId], results: [] };
      store.saveOperation(queued);
      store.saveIdempotency('principal:POST:/devices/id/commands', 'key', { state: { power: true } }, { status: 202, operation: queued });
      store.close(); store = new GatewayStore(path);
      expect(store.identity('mock', 'native')).toBe(deviceId); expect(store.gatewayId).toBe(gatewayId);
      expect(store.recoverOperations()).toEqual([deviceId]);
      expect(store.getOperation('operation')).toMatchObject({ status: 'failed', results: [{ confirmation: 'unconfirmed', error: { code: 'gateway_restarted' } }] });
      expect(store.lookupIdempotency('principal:POST:/devices/id/commands', 'key', { state: { power: true } })).toMatchObject({ operation: { status: 'queued' } });
      expect(() => store.lookupIdempotency('principal:POST:/devices/id/commands', 'key', { state: { power: false } })).toThrowError('different body');
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('retains terminals for 24 hours without evicting at capacity, then expires them', () => {
    const store = new GatewayStore(':memory:', { maxRecords: 1 });
    const now = Date.now(); const op = { id: 'one', status: 'succeeded', createdAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString() };
    store.saveOperation(op);
    expect(() => store.saveOperation({ ...op, id: 'two' })).toThrowError('capacity');
    expect(() => store.saveOperation({ ...op, status: 'failed' })).toThrowError('immutable');
    store.purgeExpired(now + MIN_RETENTION_MS - 1); expect(store.getOperation('one')).toBeDefined();
    store.purgeExpired(now + MIN_RETENTION_MS + 1); expect(store.getOperation('one')).toBeUndefined(); store.close();
  });
  it('stores only verifiers, authenticates and rotates/revokes tokens', () => {
    const store = new GatewayStore(); const tokens = new TokenService(store, 'test-salt');
    const created = tokens.create(); expect(created.record.verifier).not.toContain(created.token);
    expect(tokens.verify(created.token)?.id).toBe(created.record.id);
    expect(tokens.verify('wrong')).toBeUndefined();
    const replacement = tokens.rotate(created.record.id); expect(tokens.verify(created.token)).toBeUndefined(); expect(tokens.verify(replacement.token)).toBeDefined();
    tokens.revoke(replacement.record.id); expect(tokens.verify(replacement.token)).toBeUndefined(); store.close();
  });
  it('redacts nested provider credentials and URL credentials without changing the source', () => {
    const input = { config: { GOVEE_API_KEY: 'secret', goveeApiKey: 'secret', refresh_token: 'secret' }, nested: { authorization: 'Bearer secret', url: 'https://user:password@example.invalid/tokenpath?token=secret' }, error: new Error('secret') };
    expect(JSON.stringify(redactSecrets(input))).not.toContain('secret');
    expect(JSON.stringify(redactSecrets(input))).not.toContain('tokenpath');
    expect(input.config.GOVEE_API_KEY).toBe('secret');
  });
  it('uses loopback by default and requires explicit TLS/proxy/CORS policy', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1'); expect(() => loadConfig({ BIND_MODE: 'lan' })).toThrow();
    expect(() => loadConfig({ CORS_ORIGINS: '*' })).toThrow(); expect(isOriginAllowed('https://example.invalid', defaultCorsPolicy)).toBe(false);
  });
  it('discovers static configured devices and surfaces unfinished provider implementations', async () => {
    const context = { operationId: 'op', correlationId: null, signal: new AbortController().signal, deadlineAt: Date.now() + 1000 };
    const entry = { nativeId: 'native', name: 'Lamp', manufacturer: 'Generic', model: null, address: null, extensions: {} };
    const found = []; for await (const item of new ManualDiscoveryProvider([entry]).discover(context)) found.push(item);
    expect(found).toEqual([entry]);
    for (const provider of [new GoveeLanDiscoveryProvider(), new TuyaDiscoveryProvider(), new MatterDiscoveryProvider(), new CloudAccountDiscoveryProvider()]) {
      await expect(provider.discover(context)[Symbol.asyncIterator]().next()).rejects.toThrow('not implemented');
    }
  });
});

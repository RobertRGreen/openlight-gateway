import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const MIN_RETENTION_MS = 24 * 60 * 60 * 1000;
export type Collection = 'device_snapshots' | 'rooms' | 'groups' | 'scenes' | 'effects' | 'effect_runs' | 'adapter_configs';
const collections: readonly Collection[] = ['device_snapshots', 'rooms', 'groups', 'scenes', 'effects', 'effect_runs', 'adapter_configs'];
export class StorageError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode: number, message: string) { super(message); this.code = code; this.statusCode = statusCode; }
}
export interface TokenRecord { id: string; verifier: string; createdAt: string; expiresAt: string | null; revokedAt: string | null }
interface StoredOperation { id: string; status: string; createdAt: string; completedAt: string | null; targetDeviceIds?: string[]; results?: unknown[]; [key: string]: unknown }
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') { const json = JSON.stringify(value); if (json === undefined) throw new TypeError('Expected JSON value'); return json; }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
/** Short synchronous transactions only; never pass an async callback. */
export class GatewayStore {
  private readonly db: DatabaseSync;
  private depth = 0;
  readonly retentionMs: number;
  readonly maxRecords: number;
  readonly gatewayId: string;
  constructor(path = ':memory:', options: { retentionMs?: number; maxRecords?: number } = {}) {
    if (options.retentionMs !== undefined && (!Number.isFinite(options.retentionMs) || options.retentionMs < MIN_RETENTION_MS)) throw new RangeError('Retention must be at least 24 hours');
    this.retentionMs = Math.max(MIN_RETENTION_MS, options.retentionMs ?? MIN_RETENTION_MS);
    this.maxRecords = Math.min(10_000, options.maxRecords ?? 10_000);
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1) throw new RangeError('Invalid record limit');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;');
    this.migrate();
    this.gatewayId = this.getConfig<string>('gatewayId') ?? randomUUID();
    this.setConfig('gatewayId', this.gatewayId);
  }
  private migrate(): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.['user_version']);
    if (version > 1) throw new Error('Database schema is newer than this gateway');
    if (version === 0) this.transaction(() => {
      this.db.exec(`CREATE TABLE device_identities(adapter_id TEXT NOT NULL,native_id TEXT NOT NULL,device_id TEXT NOT NULL UNIQUE,PRIMARY KEY(adapter_id,native_id));
        CREATE TABLE gateway_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE api_tokens(id TEXT PRIMARY KEY,verifier TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT,revoked_at TEXT);
        CREATE TABLE operations(id TEXT PRIMARY KEY,status TEXT NOT NULL,completed_at INTEGER,body TEXT NOT NULL);
        CREATE INDEX operations_expiry ON operations(completed_at);
        CREATE TABLE idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,body_hash TEXT NOT NULL,response TEXT NOT NULL,admitted_at INTEGER NOT NULL,PRIMARY KEY(scope,key));
        CREATE INDEX idempotency_expiry ON idempotency(admitted_at);`);
      for (const table of collections) this.db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,body TEXT NOT NULL,expires_at INTEGER)`);
      this.db.exec('PRAGMA user_version = 1');
    });
  }
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); if (result instanceof Promise) throw new TypeError('SQLite transactions must be synchronous'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; } finally { this.depth--; }
  }
  private table(collection: Collection): Collection { if (!collections.includes(collection)) throw new TypeError('Unknown collection'); return collection; }
  private capacity(table: string, statusCode = 422): void {
    if (Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.['count']) >= this.maxRecords) throw new StorageError(statusCode === 429 ? 'rate_limited' : 'resource_limit', statusCode, 'Resource capacity reached');
  }
  identity(adapterId: string, nativeId: string): string {
    const existing = this.db.prepare('SELECT device_id FROM device_identities WHERE adapter_id=? AND native_id=?').get(adapterId, nativeId);
    if (existing) return String(existing['device_id']);
    this.capacity('device_identities'); const id = randomUUID();
    this.db.prepare('INSERT INTO device_identities VALUES(?,?,?)').run(adapterId, nativeId, id); return id;
  }
  identities(): { adapterId: string; nativeId: string; deviceId: string }[] {
    return this.db.prepare('SELECT * FROM device_identities').all().map(row => ({ adapterId: String(row['adapter_id']), nativeId: String(row['native_id']), deviceId: String(row['device_id']) }));
  }
  get<T>(collection: Collection, id: string): T | undefined {
    const row = this.db.prepare(`SELECT body FROM ${this.table(collection)} WHERE id=?`).get(id); return row ? JSON.parse(String(row['body'])) as T : undefined;
  }
  list<T>(collection: Collection): T[] { if (collection === 'effect_runs') this.purgeExpired(); return this.db.prepare(`SELECT body FROM ${this.table(collection)} ORDER BY rowid`).all().map(row => JSON.parse(String(row['body'])) as T); }
  put(collection: Collection, id: string, value: unknown): void {
    const table = this.table(collection); this.purgeExpired();
    if (!this.get(table, id)) this.capacity(table, table === 'effect_runs' ? 429 : 422);
    const run = value as { status?: string; stoppedAt?: string | null };
    const expiry = table === 'effect_runs' && (run.status === 'stopped' || run.status === 'failed') ? Date.parse(run.stoppedAt ?? new Date().toISOString()) + this.retentionMs : null;
    this.db.prepare(`INSERT INTO ${table}(id,body,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at`).run(id, JSON.stringify(value), expiry);
  }
  delete(collection: Collection, id: string): void { this.db.prepare(`DELETE FROM ${this.table(collection)} WHERE id=?`).run(id); }
  getConfig<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM gateway_config WHERE key=?').get(key); return row ? JSON.parse(String(row['value'])) as T : undefined; }
  setConfig(key: string, value: unknown): void { this.db.prepare('INSERT INTO gateway_config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  saveOperation<T extends { id: string; status: string; createdAt: string; completedAt: string | null }>(op: T): void {
    const terminal = ['succeeded', 'partial', 'failed'].includes(op.status);
    if (!['queued', 'running', 'succeeded', 'partial', 'failed'].includes(op.status) || !Number.isFinite(Date.parse(op.createdAt)) || (terminal ? op.completedAt === null || !Number.isFinite(Date.parse(op.completedAt)) : op.completedAt !== null)) throw new TypeError('Invalid operation lifecycle or timestamp');
    this.purgeExpired(); const old = this.getOperation<T>(op.id);
    if (old?.status === 'running' && op.status === 'queued') throw new StorageError('operation_transition', 409, 'Operation cannot return to queued');
    if (!old) this.capacity('operations', 429);
    if (old && ['succeeded', 'partial', 'failed'].includes(old.status) && canonicalJson(old) !== canonicalJson(op)) throw new StorageError('operation_terminal', 409, 'Terminal operations are immutable');
    this.db.prepare('INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,body=excluded.body').run(op.id, op.status, op.completedAt === null ? null : Date.parse(op.completedAt), JSON.stringify(op));
  }
  getOperation<T>(id: string): T | undefined { this.purgeExpired(); const row = this.db.prepare('SELECT body FROM operations WHERE id=?').get(id); return row ? JSON.parse(String(row['body'])) as T : undefined; }
  listOperations<T>(): T[] { this.purgeExpired(); return this.db.prepare('SELECT body FROM operations ORDER BY rowid').all().map(row => JSON.parse(String(row['body'])) as T); }
  recoverOperations(): string[] {
    const affected = new Set<string>();
    for (const op of this.listOperations<StoredOperation>()) {
      if (op.status !== 'queued' && op.status !== 'running') continue;
      const error = { code: 'gateway_restarted', message: 'Gateway restarted before completion', requestId: op.id, details: [] };
      const results = (op.targetDeviceIds ?? []).map(deviceId => { affected.add(deviceId); return { deviceId, status: 'failed', confirmation: 'unconfirmed', warnings: [], transport: null, fallback: null, fieldResults: [], error }; });
      const adapterResults = Array.isArray(op['adapterResults']) ? (op['adapterResults'] as {adapterId:string}[]).map(result => ({ adapterId: result.adapterId, status: 'failed', discoveredDeviceIds: [], error })) : undefined;
      this.saveOperation({ ...op, status: 'failed', completedAt: new Date().toISOString(), results, error, ...(adapterResults ? {adapterResults} : {}) });
    }
    for (const run of this.list<{id:string;status:string;deviceIds:string[];deviceExecutions:Record<string,unknown>[];[key:string]:unknown}>('effect_runs')) {
      if (run.status === 'stopped' || run.status === 'failed') continue;
      for (const id of run.deviceIds) affected.add(id);
      this.put('effect_runs', run.id, { ...run, status: 'failed', stoppedAt: new Date().toISOString(), reason: 'gateway_restarted', deviceExecutions: run.deviceExecutions.map(execution => ({ ...execution, status: 'failed', error: { code: 'gateway_restarted', message: 'Gateway restarted', requestId: run.id, details: [] } })) });
    }
    return [...affected];
  }
  purgeExpired(now = Date.now()): void {
    this.db.prepare('DELETE FROM operations WHERE completed_at IS NOT NULL AND completed_at < ?').run(now - this.retentionMs);
    this.db.prepare('DELETE FROM idempotency WHERE admitted_at < ?').run(now - this.retentionMs);
    this.db.prepare('DELETE FROM effect_runs WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  }
  lookupIdempotency<T>(scope: string, key: string, body: unknown): T | undefined {
    this.purgeExpired(); const row = this.db.prepare('SELECT body_hash,response FROM idempotency WHERE scope=? AND key=?').get(scope, key);
    if (!row) return undefined;
    if (row['body_hash'] !== createHash('sha256').update(canonicalJson(body)).digest('hex')) throw new StorageError('idempotency_conflict', 409, 'Idempotency key already used with a different body');
    return JSON.parse(String(row['response'])) as T;
  }
  ensureIdempotencyCapacity(): void { this.purgeExpired(); this.capacity('idempotency', 429); }
  saveIdempotency(scope: string, key: string, body: unknown, response: unknown): void {
    if (this.lookupIdempotency(scope, key, body) !== undefined) return;
    this.capacity('idempotency', 429);
    this.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(scope, key, createHash('sha256').update(canonicalJson(body)).digest('hex'), JSON.stringify(response), Date.now());
  }
  saveToken(token: TokenRecord): void { this.db.prepare('INSERT INTO api_tokens VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET verifier=excluded.verifier,expires_at=excluded.expires_at,revoked_at=excluded.revoked_at').run(token.id, token.verifier, token.createdAt, token.expiresAt, token.revokedAt); }
  getToken(id: string): TokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE id=?').get(id);
    return row ? { id: String(row['id']), verifier: String(row['verifier']), createdAt: String(row['created_at']), expiresAt: row['expires_at'] === null ? null : String(row['expires_at']), revokedAt: row['revoked_at'] === null ? null : String(row['revoked_at']) } : undefined;
  }
  close(): void { this.db.close(); }
}

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { GatewayStore, TokenRecord } from '../persistence/index.js';

const sensitiveSuffix = /(apikey|localkey|devicekey|accesstoken|refreshtoken|token|secret|password|credentials|encryptionkey|privatekey)$/i;
const sensitive = /^(authorization|proxyAuthorization|cookie|setCookie|password|passwd|apiKey|localKey|deviceKey|accessToken|refreshToken|token|secret|clientSecret|credentials|encryptionKey|privateKey|payload|raw|body|verifier|apiTokenSalt)$/i;
function sanitizeString(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try { const url = new URL(raw); if (url.username || url.password || url.search || url.hash) return '[REDACTED URL]'; } catch { return '[REDACTED URL]'; } return raw;
  });
}
/** Copy before logging; never mutate a caller's credentials/configuration. */
export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function visit(input: unknown, depth: number): unknown {
    if (typeof input === 'string') return sanitizeString(input);
    if (input === null || typeof input !== 'object') return input;
    if (depth > 20 || seen.has(input)) return '[TRUNCATED]'; seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 1000).map(item => visit(item, depth + 1));
    if (input instanceof Error) return { name: input.name, message: 'Internal error (details redacted)' };
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input).slice(0, 1000)) output[key] = (sensitive.test(key.replace(/[-_]/g, '')) || sensitiveSuffix.test(key.replace(/[-_]/g, ''))) ? '[REDACTED]' : visit(item, depth + 1);
    return output;
  }
  return visit(value, 0);
}

export class TokenService {
  private readonly store: GatewayStore;
  private readonly salt: string;
  constructor(store: GatewayStore, salt: string) { this.store = store; this.salt = salt; }
  private verifier(token: string): string { return createHmac('sha256', this.salt).update(token).digest('hex'); }
  create(expiresAt: string | null = null): { token: string; record: TokenRecord } {
    if (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new RangeError('Token expiry must be in the future');
    const id = randomUUID(); const token = `${id}.${randomBytes(32).toString('base64url')}`;
    const record = { id, verifier: this.verifier(token), createdAt: new Date().toISOString(), expiresAt, revokedAt: null };
    this.store.saveToken(record); return { token, record };
  }
  verify(token: string, now = Date.now()): TokenRecord | undefined {
    if (token.length > 256) return undefined;
    const id = token.split('.')[0]; if (!id) return undefined;
    const record = this.store.getToken(id);
    const supplied = Buffer.from(this.verifier(token), 'hex');
    const expected = Buffer.from(record?.verifier ?? '0'.repeat(64), 'hex');
    const valid = expected.length === supplied.length && timingSafeEqual(expected, supplied);
    return valid && record && !record.revokedAt && (record.expiresAt === null || Date.parse(record.expiresAt) > now) ? record : undefined;
  }
  revoke(id: string): void { const record = this.store.getToken(id); if (record && !record.revokedAt) this.store.saveToken({ ...record, revokedAt: new Date().toISOString() }); }
  /** API sessions must periodically verify validity; expiry/revocation then closes sessions. */
  rotate(id: string, overlapMs = 0): { token: string; record: TokenRecord } {
    if (!Number.isFinite(overlapMs) || overlapMs < 0 || overlapMs > 24 * 60 * 60 * 1000) throw new RangeError('Rotation overlap must be at most 24 hours');
    const old = this.store.getToken(id); if (!old || old.revokedAt || (old.expiresAt !== null && Date.parse(old.expiresAt) <= Date.now())) throw new Error('Unknown or revoked token');
    return this.store.transaction(() => {
      const replacement = this.create();
      if (overlapMs === 0) this.revoke(id);
      else this.store.saveToken({ ...old, expiresAt: new Date(Math.min(Date.now() + overlapMs, old.expiresAt === null ? Infinity : Date.parse(old.expiresAt))).toISOString() });
      return replacement;
    });
  }
}
export interface CorsPolicy { enabled: boolean; allowedOrigins: readonly string[]; allowedMethods: readonly string[]; allowedHeaders: readonly string[]; credentials: false }
export const defaultCorsPolicy: CorsPolicy = { enabled: false, allowedOrigins: [], allowedMethods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'If-Match'], credentials: false };
export function isOriginAllowed(origin: string | undefined, policy: CorsPolicy): boolean { return origin === undefined || (policy.enabled && policy.allowedOrigins.includes(origin)); }
export type RateLimitCategory = 'unauthenticated' | 'request' | 'command' | 'scene' | 'effect' | 'discovery' | 'websocket';
export interface RateLimitInput { ip: string; principalId: string | null; category: RateLimitCategory; cost: number }
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };
export interface RateLimitHook { consume(input: RateLimitInput): Promise<RateLimitDecision> }

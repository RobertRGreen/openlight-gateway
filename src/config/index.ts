import { z } from 'zod';
import { defaultCorsPolicy } from '../security/index.js';
import type { CorsPolicy } from '../security/index.js';
const booleanEnv = z.enum(['true', 'false']).transform(value => value === 'true');
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BIND_MODE: z.enum(['localhost', 'lan']).default('localhost'),
  TLS_MODE: z.enum(['disabled', 'gateway', 'proxy']).default('disabled'),
  TLS_CERT_PATH: z.string().default(''), TLS_KEY_PATH: z.string().default(''),
  TRUSTED_PROXIES: z.string().default(''), ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1,[::1]'),
  API_TOKEN_SALT: z.string().default(''), GOVEE_API_KEY: z.string().default(''),
  DATABASE_PATH: z.string().min(1).default('./data/openlight.sqlite'),
  GATEWAY_NAME: z.string().min(1).max(63).default('OpenLight Gateway'),
  MDNS_ENABLED: booleanEnv.default('false'),
  GOVEE_ADAPTER_ENABLED: booleanEnv.default('false'),
  GOVEE_CLOUD_ADAPTER_ENABLED: booleanEnv.default('false'),
  GOVEE_DISCOVERY_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(1500),
  CORS_ORIGINS: z.string().default(''), LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MOCK_LATENCY_MS: z.coerce.number().int().min(0).max(60_000).default(5),
  ADAPTER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5_000),
}).superRefine((env, ctx) => {
  if (env.BIND_MODE === 'lan' && env.TLS_MODE === 'disabled') ctx.addIssue({ code: 'custom', path: ['TLS_MODE'], message: 'LAN mode requires gateway TLS or a configured TLS proxy' });
  if (env.TLS_MODE === 'proxy' && !env.TRUSTED_PROXIES.trim()) ctx.addIssue({ code: 'custom', path: ['TRUSTED_PROXIES'], message: 'TLS proxy mode requires explicit trusted proxy addresses' });
  if (env.TLS_MODE === 'gateway' && (!env.TLS_CERT_PATH || !env.TLS_KEY_PATH)) ctx.addIssue({ code: 'custom', path: ['TLS_CERT_PATH'], message: 'Gateway TLS requires certificate and key paths' });
  for (const origin of env.CORS_ORIGINS.split(',').map(x => x.trim()).filter(Boolean)) {
    try { const url = new URL(origin); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error(); }
    catch { ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Origins must be explicit HTTP(S) origins without paths or wildcards' }); }
  }
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(env);
  const split = (input: string) => input.split(',').map(x => x.trim()).filter(Boolean);
  const allowedOrigins = split(value.CORS_ORIGINS);
  const cors: CorsPolicy = { ...defaultCorsPolicy, enabled: allowedOrigins.length > 0, allowedOrigins };
  return { port: value.PORT, bindMode: value.BIND_MODE, host: value.BIND_MODE === 'localhost' ? '127.0.0.1' : '0.0.0.0', tlsMode: value.TLS_MODE,
    tlsCertPath: value.TLS_CERT_PATH, tlsKeyPath: value.TLS_KEY_PATH, trustedProxies: split(value.TRUSTED_PROXIES), allowedHosts: split(value.ALLOWED_HOSTS),
    apiTokenSalt: value.API_TOKEN_SALT, goveeApiKey: value.GOVEE_API_KEY, databasePath: value.DATABASE_PATH, gatewayName: value.GATEWAY_NAME,
    mdnsEnabled: value.MDNS_ENABLED, goveeAdapterEnabled: value.GOVEE_ADAPTER_ENABLED,
    goveeCloudAdapterEnabled: value.GOVEE_CLOUD_ADAPTER_ENABLED,
    goveeDiscoveryTimeoutMs: value.GOVEE_DISCOVERY_TIMEOUT_MS,
    cors, logLevel: value.LOG_LEVEL, mockLatencyMs: value.MOCK_LATENCY_MS, adapterTimeoutMs: value.ADAPTER_TIMEOUT_MS };
}
export type GatewayConfig = ReturnType<typeof loadConfig>;
